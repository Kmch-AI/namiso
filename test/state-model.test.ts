import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, KnownFact } from '../src/providers/types.ts'
import type {
  Claim,
  ClaimCardinality,
  ClaimChange,
  MemoryDisclosure,
  MemoryModality,
  MemorySensitivity,
  MessageId,
} from '../src/types.ts'

import { normalizeAttribute } from '../src/text.ts'
import { AI, USER, setup } from './helpers.ts'

interface ClaimSpec {
  predicate: string
  attribute: string
  cardinality: ClaimCardinality
  change: ClaimChange
  value: string
  modality?: MemoryModality
  validFrom?: number
  sensitivity?: MemorySensitivity
  disclosure?: MemoryDisclosure
}

function claimProvider(
  make: (content: string, id: MessageId) => ClaimSpec,
  subject = '用户',
): ExtractionProvider {
  return {
    version: 'state-test',
    async extract(input) {
      const id = input.focusMessageIds[0]
      const message = input.messages.find((item) => item.id === id)
      const spec = make(message?.content ?? '', id)
      return {
        entities: [{ name: subject, type: 'person', evidenceMessageIds: [id] }],
        claims: [
          {
            subject: { name: subject, type: 'person' },
            predicate: spec.predicate,
            attribute: spec.attribute,
            cardinality: spec.cardinality,
            change: spec.change,
            object: { kind: 'literal', value: spec.value },
            modality: spec.modality ?? 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [id],
            ...(spec.validFrom === undefined ? {} : { validFrom: spec.validFrom }),
            ...(spec.sensitivity === undefined ? {} : { sensitivity: spec.sensitivity }),
            ...(spec.disclosure === undefined ? {} : { disclosure: spec.disclosure }),
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
  const context = await namiso.getContext({ query: '我住在哪里？', timeZone: 'UTC' })
  assert.match(context.text, /记录于 2026-09-21（周一）/)
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

test('uncertain claims render in the unconfirmed section', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '旅行计划',
    attribute: '旅行计划',
    cardinality: 'many',
    change: 'adds',
    value: content,
    modality: 'uncertain',
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '明年去大理')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.equal(details.claims[0]?.modality, 'uncertain')
  const context = await namiso.getContext({ query: '我明年有什么计划？' })
  assert.equal(context.text.includes('[Current Claims]'), false)
  const section = context.text.indexOf('[Unconfirmed]')
  const value = context.text.indexOf('明年去大理')
  assert.ok(section !== -1 && value > section)
  namiso.close()
})

test('a negated claim retracts the positive value and stays as a negative fact', async () => {
  const extraction = claimProvider((content) =>
    content.startsWith('否定:')
      ? {
          predicate: '使用模型',
          attribute: '使用模型',
          cardinality: 'one',
          change: 'new',
          value: content.slice(3),
          modality: 'negated',
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
  await say(USER, 'user', '否定:TTS-A')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  const active = details.claims.filter((claim) => claim.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0]?.polarity, 'negative')
  assert.equal(active[0]?.modality, 'asserted')
  const positive = details.claims.find((claim) => claim.polarity === 'positive')
  assert.equal(positive?.status, 'retracted')
  const context = await namiso.getContext({ query: '我现在使用什么模型？' })
  assert.match(context.text, /≠ TTS-A/)
  namiso.close()
})

test('assistant-only evidence about another person is stored as quoted', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '居住地',
    attribute: '居住地',
    cardinality: 'one',
    change: 'replaces',
    value: content,
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(AI, 'assistant', '用户住在苏州')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.equal(details.claims[0]?.modality, 'quoted')
  const context = await namiso.getContext({ query: '用户住在哪里？' })
  assert.match(context.text, /\[Unconfirmed\]/)
  namiso.close()
})

test('a claim date comes from validFrom rather than the evidence date', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '居住地',
    attribute: '居住地',
    cardinality: 'one',
    change: 'replaces',
    value: content,
    validFrom: Date.parse('2026-03-02T04:00:00Z') / 1000,
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '上海')
  await drain()
  const context = await namiso.getContext({ query: '我住在哪里？', timeZone: 'UTC' })
  assert.match(context.text, /始于 2026-03-02（周一）/)
  assert.doesNotMatch(context.text, /始于 2026-09-/)
  namiso.close()
})

test('private claims render only in the private section and mark their evidence', async () => {
  const extraction = claimProvider(() => ({
    predicate: '住址',
    attribute: '住址',
    cardinality: 'one',
    change: 'replaces',
    value: '上海',
    sensitivity: 'private',
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '我住在上海，这事别告诉别人。')
  await drain()
  const details = namiso.getEntityDetails('用户')
  assert.ok(details !== null)
  assert.equal(details.claims[0]?.sensitivity, 'private')
  assert.equal(details.claims[0]?.disclosure, 'do_not_volunteer')
  const context = await namiso.getContext({ query: '我住在哪里？' })
  assert.equal(context.text.includes('[Current Claims]'), false)
  assert.match(context.text, /\[Private\]/)
  assert.match(context.text, /私密，当前有效/)
  assert.match(context.text, /私密原文/)
  namiso.close()
})

test('a private entity description stays out of the public entity line', async () => {
  const extraction: ExtractionProvider = {
    version: 'privacy-entity',
    async extract(input) {
      const id = input.focusMessageIds[0]
      return {
        entities: [
          {
            name: '阿桐',
            type: 'person',
            description: '家里不知道她晚上唱歌',
            sensitivity: 'private',
            disclosure: 'do_not_volunteer',
            evidenceMessageIds: [id],
          },
        ],
        claims: [],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '阿桐在我们店里驻唱，家里不知道她晚上唱歌，介绍她时只用艺名。')
  await drain()
  const context = await namiso.getContext({ query: '阿桐是谁？' })
  const privateIndex = context.text.indexOf('[Private]')
  const descriptionIndex = context.text.indexOf('家里不知道')
  assert.ok(privateIndex !== -1 && descriptionIndex > privateIndex)
  const publicEntities = context.text.slice(
    context.text.indexOf('[Relevant Entities]'),
    privateIndex,
  )
  assert.equal(publicEntities.includes('家里不知道'), false)
  namiso.close()
})

test('alias-only records carry the alias marker', async () => {
  const extraction = claimProvider(() => ({
    predicate: '称呼',
    attribute: '称呼',
    cardinality: 'one',
    change: 'replaces',
    value: '艺名阿桐',
    disclosure: 'alias_only',
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '介绍她的时候只用艺名阿桐。')
  await drain()
  const context = await namiso.getContext({ query: '阿桐的称呼是什么？' })
  assert.match(context.text, /仅用别名/)
  namiso.close()
})

test('privacy upgrades on restatement and never downgrades', async () => {
  const extraction = claimProvider((content) => ({
    predicate: '项目',
    attribute: '项目',
    cardinality: 'one',
    change: 'replaces',
    value: '项目A',
    ...(content === '保密' ? { sensitivity: 'private' as const } : {}),
  }))
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '普通')
  await drain()
  assert.equal(namiso.getEntityDetails('用户')?.claims[0]?.sensitivity, 'normal')
  await say(USER, 'user', '保密')
  await drain()
  assert.equal(namiso.getEntityDetails('用户')?.claims[0]?.sensitivity, 'private')
  await say(USER, 'user', '普通')
  await drain()
  assert.equal(namiso.getEntityDetails('用户')?.claims[0]?.sensitivity, 'private')
  namiso.close()
})

test('private events render in the private section', async () => {
  const extraction: ExtractionProvider = {
    version: 'privacy-event',
    async extract(input) {
      const id = input.focusMessageIds[0]
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: 'meeting',
            summary: '和医生谈检查结果',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            sensitivity: 'private',
            evidenceMessageIds: [id],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '昨天和医生谈了检查结果，先别告诉家里。')
  await drain()
  const context = await namiso.getContext({ query: '发生过什么和医生有关的事？' })
  assert.match(context.text, /\[Private\]/)
  assert.match(context.text, /私密，/)
  assert.match(context.text, /私密原文/)
  namiso.close()
})

test('known facts are off by default and sent when enabled', async () => {
  const base = claimProvider(
    (content) => ({
      predicate: '居住地',
      attribute: '居住地',
      cardinality: 'one',
      change: 'replaces',
      value: content,
    }),
    USER,
  )
  const seen: Array<readonly KnownFact[] | undefined> = []
  const recording: ExtractionProvider = {
    version: 'facts',
    async extract(input) {
      seen.push(input.knownFacts)
      return base.extract(input)
    },
  }
  const { namiso, say, drain } = await setup({ extraction: recording, knownFacts: true })
  await say(USER, 'user', '苏州')
  await drain()
  await say(USER, 'user', '上海')
  await drain()
  assert.deepEqual(seen[0], [])
  assert.deepEqual(seen[1], [{ subject: USER, attribute: '居住地', value: '苏州' }])
  namiso.close()

  const defaults: Array<readonly KnownFact[] | undefined> = []
  const plain: ExtractionProvider = {
    version: 'facts-default',
    async extract(input) {
      defaults.push(input.knownFacts)
      return base.extract(input)
    },
  }
  const second = await setup({ extraction: plain })
  await second.say(USER, 'user', '苏州')
  await second.drain()
  assert.equal(defaults[0], undefined)
  second.namiso.close()
})

test('the known-facts digest is capped and excludes private facts', async () => {
  let call = 0
  let facts: readonly KnownFact[] | undefined
  const extraction: ExtractionProvider = {
    version: 'facts-cap',
    async extract(input) {
      call += 1
      if (call === 1) {
        const id = input.focusMessageIds[0]
        return {
          entities: [{ name: USER, type: 'person', evidenceMessageIds: [id] }],
          claims: Array.from({ length: 14 }, (_, index) => ({
            subject: { name: USER, type: 'person' as const },
            predicate: `属性${index}`,
            attribute: `属性${index}`,
            cardinality: 'many' as const,
            change: 'adds' as const,
            object: {
              kind: 'literal' as const,
              value: index === 13 ? '秘密' : `值${index}`,
            },
            modality: 'asserted' as const,
            confidence: 0.9,
            ...(index === 13 ? { sensitivity: 'private' as const } : {}),
            evidenceMessageIds: [id],
          })),
          events: [],
        }
      }
      facts = input.knownFacts
      return { entities: [], claims: [], events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction, knownFacts: true })
  await say(USER, 'user', '记录一些属性')
  await drain()
  await say(USER, 'user', '再记一条')
  await drain()
  assert.equal(facts?.length, 12)
  assert.equal(
    facts?.some((fact) => fact.value === '秘密'),
    false,
  )
  namiso.close()
})

test('attribute keys are normalized before they are stored', () => {
  assert.equal(normalizeAttribute('  居住地。 '), '居住地')
  assert.equal(normalizeAttribute('Residence  City'), 'residence city')
  assert.equal(normalizeAttribute('「喜好」'), '喜好')
})
