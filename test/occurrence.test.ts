import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, MessageId } from '../src/index.ts'

import { USER, setup } from './helpers.ts'

const PARTICIPANT = '小林'

function claimFrom(
  subject: string,
  predicate: string,
  value: string,
  evidenceMessageIds: readonly MessageId[],
) {
  return {
    subject: { name: subject, type: 'other' as const },
    predicate,
    attribute: predicate,
    cardinality: 'many' as const,
    change: 'adds' as const,
    object: { kind: 'literal' as const, value },
    modality: 'asserted' as const,
    confidence: 0.9,
    evidenceMessageIds,
  }
}

test('an occurrence claim links to an earlier participant event but an unrelated claim does not', async () => {
  const extraction: ExtractionProvider = {
    version: 'occurrence-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const first = input.focusMessageIds[0]
      const occurredAt = messages.get(first)?.occurredAt
      const claims = input.focusMessageIds.flatMap((id) => {
        const content = messages.get(id)?.content ?? ''
        if (content.includes('到场')) {
          return [claimFrom('第一次试读会', '到场', PARTICIPANT, [id])]
        }
        if (content.includes('地点')) {
          return [claimFrom('第二次试读会', '地点', '杭州', [id])]
        }
        return []
      })
      return {
        entities: [
          { name: PARTICIPANT, type: 'person', evidenceMessageIds: [first] },
          {
            name: '第一次试读会',
            type: 'other',
            evidenceMessageIds: [input.focusMessageIds[1] ?? first],
          },
          {
            name: '第二次试读会',
            type: 'other',
            evidenceMessageIds: [input.focusMessageIds[2] ?? first],
          },
        ],
        claims,
        events: [
          {
            type: '试读',
            summary: `在中央大街的咖啡馆试读，${PARTICIPANT}到场`,
            ...(occurredAt === undefined ? {} : { occurredAt }),
            timePrecision: 'day',
            participants: [{ name: PARTICIPANT, type: 'person', role: '听众' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [first],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', `第一次试读会在中央大街的咖啡馆举行，${PARTICIPANT}到了。`)
  await say(USER, 'user', `${PARTICIPANT}到场，指出了时间线的问题。`)
  await say(USER, 'user', '第二次试读会的地点在杭州。')
  await drain()

  const event = namiso
    .getEntityDetails(PARTICIPANT)
    ?.events.find((item) => item.summary.includes('到场'))
  assert.ok(event !== undefined)
  const linked = namiso
    .getEntityDetails('第一次试读会')
    ?.claims.find((claim) => claim.predicate === '到场')
  assert.ok(linked !== undefined)
  const relation = namiso
    .getClaimDetails(linked.id)
    ?.relations.find((item) => item.relation === 'same_occurrence')
  assert.ok(relation !== undefined)
  assert.equal(relation.targetType, 'event')
  assert.equal(relation.targetId, event.id)
  assert.ok(relation.confidence >= 0.1)

  const unrelated = namiso
    .getEntityDetails('第二次试读会')
    ?.claims.find((claim) => claim.predicate === '地点')
  assert.ok(unrelated !== undefined)
  const unrelatedRelations = namiso.getClaimDetails(unrelated.id)?.relations ?? []
  assert.equal(
    unrelatedRelations.some((item) => item.relation === 'same_occurrence'),
    false,
  )
  namiso.close()
})
