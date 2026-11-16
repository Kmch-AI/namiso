import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Event, ExtractionProvider, MemoryCandidate, MessageId } from '../src/index.ts'

import { BASE_TIME, USER, setup } from './helpers.ts'

const PARTICIPANT = '小林'

function eventCandidates(candidates: readonly MemoryCandidate[]): Event[] {
  return candidates.flatMap((item) => (item.record.kind === 'event' ? [item.record.event] : []))
}

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

function eventFrom(
  type: string,
  summary: string,
  participants: readonly string[],
  evidenceMessageIds: readonly MessageId[],
  occurredAt?: number,
) {
  return {
    type,
    summary,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    timePrecision: 'day' as const,
    participants: participants.map((name) => ({
      name,
      type: 'person' as const,
      role: 'participant',
    })),
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

test('same-day synonym events merge into one occurrence', async () => {
  const extraction: ExtractionProvider = {
    version: 'event-merge-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const events = input.focusMessageIds.flatMap((id) => {
        const message = messages.get(id)
        if (message === undefined) return []
        if (!message.content.includes('冬瓜排骨汤')) return []
        return [
          eventFrom(
            '送汤',
            message.content.includes('直夸')
              ? '妈妈送来冬瓜排骨汤，李晶直夸清爽'
              : '妈妈送来冬瓜排骨汤，李晶夸清爽',
            ['妈妈', '李晶'],
            [id],
            message.occurredAt,
          ),
        ]
      })
      return { entities: [], claims: [], events }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '今天妈妈送来冬瓜排骨汤，李晶夸清爽。')
  await say(USER, 'user', '今天妈妈又送来冬瓜排骨汤，李晶直夸清爽。')
  await drain()

  const events = eventCandidates(
    (
      await namiso.retrieve({
        query: '冬瓜排骨汤 送汤',
        memoryTypes: ['event'],
        rerank: false,
        topK: 50,
      })
    ).candidates,
  ).filter((event) => event.type === '送汤')
  assert.equal(events.length, 1)
  assert.equal(namiso.getEventDetails(events[0]?.id ?? '')?.evidenceMessageIds.length, 2)
  namiso.close()
})

test('cross-type synonym events merge into one occurrence', async () => {
  const extraction: ExtractionProvider = {
    version: 'event-cross-type-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const events = input.focusMessageIds.flatMap((id) => {
        const message = messages.get(id)
        if (message === undefined || !message.content.includes('冬瓜排骨汤')) return []
        const repeat = message.content.includes('又送')
        return [
          eventFrom(
            repeat ? '送汤' : '家庭互动',
            repeat ? '妈妈又送冬瓜排骨汤来，李晶喝完直夸清爽' : '妈妈送来冬瓜排骨汤，李晶夸清爽',
            repeat ? [] : ['妈妈', '李晶'],
            [id],
            message.occurredAt,
          ),
        ]
      })
      return { entities: [], claims: [], events }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '今天妈妈送来冬瓜排骨汤，李晶夸清爽。')
  await say(USER, 'user', '今天妈妈又送冬瓜排骨汤来，李晶喝完直夸清爽。')
  await drain()

  const events = eventCandidates(
    (
      await namiso.retrieve({
        query: '冬瓜排骨汤',
        memoryTypes: ['event'],
        rerank: false,
        topK: 50,
      })
    ).candidates,
  ).filter((event) => event.summary.includes('冬瓜排骨汤'))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, '家庭互动')
  assert.equal(namiso.getEventDetails(events[0]?.id ?? '')?.evidenceMessageIds.length, 2)
  namiso.close()
})

test('same summary on the next day stays a separate occurrence', async () => {
  const extraction: ExtractionProvider = {
    version: 'event-recurring-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const events = input.focusMessageIds.flatMap((id) => {
        const message = messages.get(id)
        if (message === undefined || !message.content.includes('冬瓜排骨汤')) return []
        return [
          eventFrom(
            '送汤',
            '妈妈送来冬瓜排骨汤，李晶夸清爽',
            ['妈妈', '李晶'],
            [id],
            message.occurredAt,
          ),
        ]
      })
      return { entities: [], claims: [], events }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '妈妈送来冬瓜排骨汤，李晶夸清爽。')
  await namiso.ingest({
    conversationId: namiso.listConversations()[0]?.id ?? '',
    speakerId: USER,
    role: 'user',
    content: '妈妈送来冬瓜排骨汤，李晶夸清爽。',
    occurredAt: BASE_TIME + 86_400,
  })
  await drain()

  const events = namiso.getEntityDetails('李晶')?.events.filter((event) => event.type === '送汤')
  assert.equal(events?.length, 2)
  namiso.close()
})

test('same day but disjoint participants stays separate', async () => {
  const extraction: ExtractionProvider = {
    version: 'event-participant-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const events = input.focusMessageIds.flatMap((id) => {
        const message = messages.get(id)
        if (message === undefined || !message.content.includes('冬瓜排骨汤')) return []
        return [
          eventFrom(
            '送汤',
            '妈妈送来冬瓜排骨汤，大家夸清爽',
            [message.content.includes('小赵') ? '小赵' : '李晶'],
            [id],
            message.occurredAt,
          ),
        ]
      })
      return { entities: [], claims: [], events }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '今天妈妈送来冬瓜排骨汤，李晶夸清爽。')
  await say(USER, 'user', '今天妈妈送来冬瓜排骨汤，小赵夸清爽。')
  await drain()

  const events = eventCandidates(
    (
      await namiso.retrieve({
        query: '冬瓜排骨汤 送汤',
        memoryTypes: ['event'],
        rerank: false,
        topK: 50,
      })
    ).candidates,
  ).filter((event) => event.type === '送汤')
  assert.equal(events.length, 2)
  namiso.close()
})

test('a correction event updates the earlier occurrence its ordinal clause names', async () => {
  const extraction: ExtractionProvider = {
    version: 'occurrence-event-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const events = input.focusMessageIds.flatMap((id) => {
        const message = messages.get(id)
        const content = message?.content ?? ''
        if (content.includes('南岗是第二次')) {
          return [
            eventFrom(
              '纠正',
              `用户纠正试读会顺序：第一次在中央大街咖啡馆（只来${PARTICIPANT}），南岗是第二次`,
              [USER],
              [id],
            ),
          ]
        }
        if (content.includes('菜市场')) {
          return [eventFrom('买菜', `第二次去南岗菜市场，只来${PARTICIPANT}`, [PARTICIPANT], [id])]
        }
        if (content.includes('到场')) {
          return [
            eventFrom(
              '试读',
              `在中央大街的咖啡馆试读，${PARTICIPANT}到场`,
              [PARTICIPANT],
              [id],
              message?.occurredAt,
            ),
          ]
        }
        return []
      })
      return { entities: [], claims: [], events }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', `第一次试读会在中央大街的咖啡馆举行，${PARTICIPANT}到场。`)
  await say(USER, 'user', `我记错了。第一次是在中央大街咖啡馆，只来${PARTICIPANT}，南岗是第二次。`)
  await say(USER, 'user', `第二次去南岗菜市场，只来${PARTICIPANT}。`)
  await drain()

  const original = namiso.getEntityDetails(PARTICIPANT)?.events.find((item) => item.type === '试读')
  const correction = namiso.getEntityDetails(USER)?.events.find((item) => item.type === '纠正')
  assert.ok(original !== undefined)
  assert.ok(correction !== undefined)
  const relation = namiso
    .getEventDetails(correction.id)
    ?.relations.find((item) => item.relation === 'updates')
  assert.ok(relation !== undefined)
  assert.equal(relation.targetType, 'event')
  assert.equal(relation.targetId, original.id)

  const market = namiso.getEntityDetails(PARTICIPANT)?.events.find((item) => item.type === '买菜')
  assert.ok(market !== undefined)
  const marketRelations = namiso.getEventDetails(market.id)?.relations ?? []
  assert.equal(
    marketRelations.some((item) => item.relation === 'updates'),
    false,
  )
  namiso.close()
})
