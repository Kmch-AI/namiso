import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider } from '../src/providers/types.ts'
import type { Claim, ClaimCardinality, ClaimChange, MessageId } from '../src/types.ts'

import { normalizeAttribute } from '../src/text.ts'
import { USER, setup } from './helpers.ts'

interface ClaimSpec {
  predicate: string
  attribute: string
  cardinality: ClaimCardinality
  change: ClaimChange
  value: string
}

function claimProvider(make: (content: string, id: MessageId) => ClaimSpec): ExtractionProvider {
  return {
    version: 'state-test',
    async extract(input) {
      const id = input.focusMessageIds[0]
      const message = input.messages.find((item) => item.id === id)
      const spec = make(message?.content ?? '', id)
      return {
        entities: [{ name: '用户', type: 'person', evidenceMessageIds: [id] }],
        claims: [
          {
            subject: { name: '用户', type: 'person' },
            predicate: spec.predicate,
            attribute: spec.attribute,
            cardinality: spec.cardinality,
            change: spec.change,
            object: { kind: 'literal', value: spec.value },
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [id],
          },
        ],
        events: [],
      }
    },
  }
}

function valuesOf(claims: readonly Claim[], status: string): string[] {
  return claims
    .filter((claim) => claim.status === status)
    .flatMap((claim) => (claim.object.kind === 'literal' ? [claim.object.value] : []))
}

test('a one-valued attribute supersedes the previous value', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '居住地',
    attribute: '居住地',
    cardinality: 'one',
    change: 'replaces',
    value: content,
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '苏州')
  await drain()
  await say(USER, 'user', '上海')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.deepEqual(valuesOf(details.claims, 'active'), ['上海'])
  assert.deepEqual(valuesOf(details.claims, 'superseded'), ['苏州'])
  namiso.close()
})

test('a many-valued attribute accumulates values', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '喜好',
    attribute: '喜好',
    cardinality: 'many',
    change: 'adds',
    value: content,
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '评弹')
  await drain()
  await say(USER, 'user', '越剧')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.deepEqual(valuesOf(details.claims, 'active').toSorted(), ['评弹', '越剧'])
  namiso.close()
})

test('retracting a value never falls back to another active value', async () => {
  const extraction = claimProvider((content) =>
    content.startsWith('撤回:')
      ? {
          predicate: '使用模型',
          attribute: '使用模型',
          cardinality: 'one',
          change: 'retracts',
          value: content.slice(3),
        }
      : {
          predicate: '使用模型',
          attribute: '使用模型',
          cardinality: 'one',
          change: 'replaces',
          value: content,
        },
  )
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', 'TTS-A')
  await drain()
  await say(USER, 'user', '撤回:TTS-B')
  await drain()
  const afterMiss = namiso.getEntityDetails('用户')
  assert.ok(afterMiss !== null)
  assert.deepEqual(valuesOf(afterMiss.claims, 'active'), ['TTS-A'])
  assert.deepEqual(valuesOf(afterMiss.claims, 'retracted'), ['TTS-B'])

  await say(USER, 'user', '撤回:TTS-A')
  await drain()
  const afterHit = namiso.getEntityDetails('用户')
  assert.ok(afterHit !== null)
  assert.deepEqual(valuesOf(afterHit.claims, 'active'), [])
  assert.deepEqual(valuesOf(afterHit.claims, 'retracted').toSorted(), ['TTS-A', 'TTS-B'])
  namiso.close()
})

test('replaces on a many-valued attribute does not remove other values', async () => {
  const extraction = claimProvider((content) =>
    content.startsWith('变更:')
      ? {
          predicate: '喜好',
          attribute: '喜好',
          cardinality: 'many',
          change: 'replaces',
          value: content.slice(3),
        }
      : {
          predicate: '喜好',
          attribute: '喜好',
          cardinality: 'many',
          change: 'adds',
          value: content,
        },
  )
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '评弹')
  await drain()
  await say(USER, 'user', '越剧')
  await drain()
  await say(USER, 'user', '变更:昆曲')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.deepEqual(valuesOf(details.claims, 'active').toSorted(), ['昆曲', '评弹', '越剧'])
  namiso.close()
})

test('attribute keys are normalized before they are stored', () => {
  assert.equal(normalizeAttribute('  居住地。 '), '居住地')
  assert.equal(normalizeAttribute('Residence  City'), 'residence city')
  assert.equal(normalizeAttribute('「喜好」'), '喜好')
})
