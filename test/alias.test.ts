import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractedClaim, ExtractionProvider, MessageId } from '../src/index.ts'

import { USER, setup } from './helpers.ts'

function likeClaim(
  subject: string,
  type: ExtractedClaim['subject']['type'],
  evidence: MessageId,
): ExtractedClaim {
  return {
    subject: { name: subject, type },
    predicate: '喜欢',
    attribute: '喜欢',
    cardinality: 'many',
    change: 'new',
    object: { kind: 'literal', value: '下雨天' },
    modality: 'asserted',
    confidence: 0.9,
    evidenceMessageIds: [evidence],
  }
}

test('two entities can own the same alias', async () => {
  const extraction: ExtractionProvider = {
    version: 'alias-duplicate',
    async extract(input) {
      const id = input.focusMessageIds[0]
      return {
        entities: [
          { name: '阿禾', type: 'person', evidenceMessageIds: [id] },
          { name: '阿木', type: 'person', aliases: ['阿禾'], evidenceMessageIds: [id] },
        ],
        claims: [],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '阿禾和阿木都来了。')
  await drain()

  const named = namiso.getEntityDetails('阿禾')
  const aliasOwner = namiso.getEntityDetails('阿木')
  assert.ok(named !== null && aliasOwner !== null)
  assert.notEqual(named.entity.id, aliasOwner.entity.id)
  assert.ok(aliasOwner.aliases.includes('阿禾'))
  namiso.close()
})

test("a canonical name resolves before another entity's alias", async () => {
  const extraction: ExtractionProvider = {
    version: 'alias-canonical',
    async extract(input) {
      const id = input.focusMessageIds[0]
      if (input.messages.some((message) => message.id === id && message.content.includes('喜欢'))) {
        return { entities: [], claims: [likeClaim('阿禾', 'person', id)], events: [] }
      }
      return {
        entities: [
          { name: '阿禾', type: 'person', evidenceMessageIds: [id] },
          { name: '阿木', type: 'person', aliases: ['阿禾'], evidenceMessageIds: [id] },
        ],
        claims: [],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '阿禾和阿木都来了。')
  await drain()
  await say(USER, 'user', '阿禾喜欢下雨天。')
  await drain()

  const named = namiso.getEntityDetails('阿禾')
  const aliasOwner = namiso.getEntityDetails('阿木')
  assert.ok(named !== null && aliasOwner !== null)
  assert.equal(named.claims.length, 1)
  assert.equal(aliasOwner.claims.length, 0)
  namiso.close()
})

test('a shared alias resolves by the requested entity type', async () => {
  const extraction: ExtractionProvider = {
    version: 'alias-type',
    async extract(input) {
      const id = input.focusMessageIds[0]
      if (input.messages.some((message) => message.id === id && message.content.includes('计划'))) {
        return {
          entities: [
            { name: '方舟', type: 'person', aliases: ['小A'], evidenceMessageIds: [id] },
            { name: '小A计划', type: 'artifact', aliases: ['小A'], evidenceMessageIds: [id] },
          ],
          claims: [],
          events: [],
        }
      }
      return { entities: [], claims: [likeClaim('小A', 'artifact', id)], events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '方舟和小A计划都提到了小A。')
  await drain()
  await say(USER, 'user', '小A喜欢下雨天。')
  await drain()

  const person = namiso.getEntityDetails('方舟')
  const artifact = namiso.getEntityDetails('小A计划')
  assert.ok(person !== null && artifact !== null)
  assert.equal(person.claims.length, 0)
  assert.equal(artifact.claims.length, 1)
  namiso.close()
})
