import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider } from '../src/index.ts'

import { AI, BASE_TIME, USER, setup } from './helpers.ts'

test('raw evidence prefers a focused numeric message', async () => {
  const { namiso, say } = await setup()
  await say(
    USER,
    'user',
    '今天天气还行，路上有点堵，到工作室以后先把窗户打开透了透气，又烧了壶水，坐下来把昨天剩下的图纸收了个尾。',
  )
  await say(USER, 'user', '对了，那本书我读到142页了，全书260页，越看越慢。')

  const result = await namiso.retrieve({
    query: '老孙问我把书借给他的时候读到了第几页，我想告诉他。',
    memoryTypes: ['conversation'],
    rerank: false,
  })

  assert.ok(result.evidence?.some((message) => message.content.includes('142页')))
  assert.ok(result.evidence?.some((message) => message.content.includes('260页')))
  namiso.close()
})

test('context renders due events for the query day', async () => {
  const extraction: ExtractionProvider = {
    version: 'due-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '购物',
            summary: '去驿站取猫饮水机',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '猫饮水机到驿站了，今天要去取。')
  await drain()

  const off = await namiso.getContext({ query: '今天好累', now: BASE_TIME })
  assert.doesNotMatch(off.text, /\[今天到期\]/)

  const context = await namiso.getContext({ query: '今天好累', now: BASE_TIME, dueReminders: true })
  assert.match(context.text, /\[今天到期\]/)
  assert.match(context.text, /用户当前没有明确询问别的事时，先用一句自然的话提醒今天到期的事项/)
  assert.match(context.text, /以 \[Evidence\] 原文为准/)
  assert.doesNotMatch(context.text, /第一次/)
  assert.match(context.text, /去驿站取猫饮水机/)
  assert.equal(
    context.items.some((candidate) => candidate.kind === 'event'),
    true,
  )

  const specific = await namiso.getContext({
    query: '妈第一次送汤过来那回，是什么汤？李晶是什么反应，我妈那天又是什么样？',
    now: BASE_TIME,
    dueReminders: true,
  })
  assert.doesNotMatch(specific.text, /\[今天到期\]/)
  namiso.close()
})

test('due section skips events that are not obligations', async () => {
  const extraction: ExtractionProvider = {
    version: 'due-filter-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '生活事件',
            summary: '下班路上喝豆浆烫到舌头',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
          {
            type: 'purchase',
            summary: '猫饮水机今天到驿站',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
          {
            type: 'event',
            summary: '快递9月21日到驿站',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '饮水机今天到驿站，下班路上喝豆浆烫到舌头。')
  await drain()

  const context = await namiso.getContext({ query: '今天好累', now: BASE_TIME, dueReminders: true })
  const due = context.text.split('[今天到期]')[1]?.split('[Historical Events]')[0] ?? ''
  assert.match(due, /猫饮水机9月21日到驿站/)
  assert.match(due, /快递9月21日到驿站/)
  assert.doesNotMatch(due, /喝豆浆烫到舌头/)
  namiso.close()
})

test('event date resolves from evidence content when the summary has no date', async () => {
  const extraction: ExtractionProvider = {
    version: 'evidence-date-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '送汤',
            summary: '远舟的母亲送来冬瓜排骨汤，李晶喝完夸清爽',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '对了，上周四妈又来送汤，冬瓜排骨汤，李晶喝完直夸。')
  await drain()

  const result = await namiso.retrieve({
    query: '冬瓜排骨汤',
    memoryTypes: ['event'],
    rerank: false,
    topK: 10,
  })
  const event = result.candidates.find(
    (candidate) => candidate.record.kind === 'event' && candidate.record.event.type === '送汤',
  )
  assert.equal(
    event?.record.kind === 'event' ? event.record.event.occurredDay : undefined,
    20260917,
  )
  namiso.close()
})

test('event date prefers the evidence with the strongest summary overlap', async () => {
  const extraction: ExtractionProvider = {
    version: 'evidence-date-rank-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '送汤',
            summary: '远舟的母亲送来冬瓜排骨汤，李晶喝完夸清爽',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: input.focusMessageIds.slice(0, 2),
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '今天李晶说周三约球。')
  await say(USER, 'user', '对了，上周四妈又来送汤，冬瓜排骨汤，李晶喝完直夸。')
  await drain()

  const result = await namiso.retrieve({
    query: '冬瓜排骨汤',
    memoryTypes: ['event'],
    rerank: false,
    topK: 10,
  })
  const event = result.candidates.find(
    (candidate) => candidate.record.kind === 'event' && candidate.record.event.type === '送汤',
  )
  assert.equal(
    event?.record.kind === 'event' ? event.record.event.occurredDay : undefined,
    20260917,
  )
  namiso.close()
})

test('event FTS text includes participant aliases', async () => {
  const extraction: ExtractionProvider = {
    version: 'alias-fts-test',
    async extract(input) {
      return {
        entities: [
          {
            name: '岳姨',
            type: 'person',
            aliases: ['我妈'],
            description: '远舟的母亲',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [
          {
            type: '送汤',
            summary: '岳姨送来冬瓜排骨汤，李晶直夸',
            timePrecision: 'day',
            participants: [{ name: '岳姨', type: 'person', role: '送汤' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '岳姨今天送来冬瓜排骨汤，李晶直夸。')
  await drain()

  const result = await namiso.retrieve({
    query: '我妈 冬瓜排骨汤',
    memoryTypes: ['event'],
    rerank: false,
    topK: 10,
  })
  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'event' && candidate.record.event.summary.includes('冬瓜排骨汤'),
    ),
    true,
  )
  namiso.close()
})

test('a strong entity match brings its recent events into context', async () => {
  const extraction: ExtractionProvider = {
    version: 'salient-profile-test',
    async extract(input) {
      return {
        entities: [
          {
            name: '父亲',
            type: 'person',
            description: '退休钳工，珍视旧游标卡尺',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [
          {
            type: '修理',
            summary: '父亲修复客厅老台钟，用旧塞尺片磨成0.1毫米钢片，约三小时修好',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [{ name: '父亲', type: 'person', role: '修理' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '父亲把客厅老台钟修好了。')
  await drain()

  const off = await namiso.retrieve({
    query: '老钳工干活时的样子',
    memoryTypes: ['entity', 'event'],
    rerank: false,
    topK: 10,
  })
  assert.equal(
    off.trace.notes.some((note) => note.includes('显著实体')),
    false,
  )

  const result = await namiso.retrieve({
    query: '老钳工干活时的样子',
    memoryTypes: ['entity', 'event'],
    rerank: false,
    salientProfile: true,
    topK: 10,
  })
  assert.equal(
    result.candidates.some(
      (candidate) => candidate.record.kind === 'entity' && candidate.record.entity.name === '父亲',
    ),
    true,
  )
  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'event' && candidate.record.event.summary.includes('老台钟'),
    ),
    true,
  )
  namiso.close()
})

test('a process question prefers a detailed event over the latest event', async () => {
  const extraction: ExtractionProvider = {
    version: 'salient-process-test',
    async extract(input) {
      return {
        entities: [
          {
            name: '父亲',
            type: 'person',
            description: '退休钳工，珍视旧游标卡尺',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [
          {
            type: '送礼',
            summary: '父亲给远舟寄来一把旧卡尺。',
            occurredAt: BASE_TIME + 86_400,
            occurredDay: 20260922,
            timePrecision: 'day',
            participants: [{ name: '父亲', type: 'person', role: '寄送' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
          {
            type: '修理',
            summary: '父亲修复客厅老台钟，用旧塞尺片磨成0.1毫米钢片，约三小时修好。',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [{ name: '父亲', type: 'person', role: '修理' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '父亲最近寄了东西，也修好了老台钟。')
  await drain()

  const result = await namiso.retrieve({
    query: '老钳工干活时的样子',
    memoryTypes: ['entity', 'event'],
    rerank: false,
    salientProfile: true,
    topK: 10,
  })
  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'event' && candidate.record.event.summary.includes('老台钟'),
    ),
    true,
  )
  namiso.close()
})

test('an event mentioned in the summary links to its entity', async () => {
  const extraction: ExtractionProvider = {
    version: 'salient-summary-test',
    async extract(input) {
      return {
        entities: [
          {
            name: '父亲',
            type: 'person',
            description: '退休钳工，珍视旧游标卡尺',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [
          {
            type: '修理',
            summary: '远舟陪父亲修好客厅老台钟，用旧塞尺片磨成0.1毫米钢片，约三个钟头。',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '父亲今天修好了客厅的老台钟。')
  await drain()

  const result = await namiso.retrieve({
    query: '老钳工干活时的样子',
    memoryTypes: ['entity', 'event'],
    rerank: false,
    salientProfile: true,
    topK: 10,
  })
  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'event' && candidate.record.event.summary.includes('老台钟'),
    ),
    true,
  )
  namiso.close()
})

test('pinned evidence follows query relevance instead of age', async () => {
  const extraction: ExtractionProvider = {
    version: 'pinned-evidence-relevance-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '故事',
            summary: '面馆老板的猫夜里蹲灶台守着火',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [...input.focusMessageIds],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '面馆老板说这锅汤只下一碗。')
  await say(USER, 'user', '面馆的灶台一直亮着火。')
  await say(USER, 'user', '面馆门口有块旧木牌。')
  await say(USER, 'user', '面馆的桌子擦得很干净。')
  await say(USER, 'user', '面馆的汤锅从不空着。')
  await say(USER, 'user', '面馆的猫夜里蹲灶台上守着，火不灭它不走。')
  await drain()

  const context = await namiso.getContext({
    query: '面馆老板的猫夜里在做什么',
    memoryTypes: ['event'],
    rerank: false,
    topK: 10,
    maxTokens: 2000,
  })
  assert.match(context.text, /夜里蹲灶台上守着/)
  assert.ok(context.items.some((candidate) => candidate.kind === 'event'))
  namiso.close()
})

test('a process query prefers the procedural profile over a mentioned writer', async () => {
  const extraction: ExtractionProvider = {
    version: 'salient-hijack-test',
    async extract(input) {
      return {
        entities: [
          {
            name: '薇薇',
            type: 'person',
            description: '网络作家，正在写新书',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
          {
            name: '父亲',
            type: 'person',
            description: '退休钳工，珍视旧游标卡尺',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [
          {
            type: '写作取材',
            summary: '薇薇想以远舟为原型写结构工程师，在客厅比划打斗动作。',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [{ name: '薇薇', type: 'person', role: '写作者' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
          {
            type: '修理',
            summary: '远舟陪父亲修好客厅老台钟，用旧塞尺片磨成0.1毫米钢片，约三个钟头。',
            occurredAt: BASE_TIME,
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '薇薇在写新书，父亲今天修好了客厅的老台钟。')
  await drain()

  const result = await namiso.retrieve({
    query: '薇薇写老钳工干活时的样子',
    memoryTypes: ['entity', 'event'],
    rerank: false,
    salientProfile: true,
    topK: 10,
  })
  assert.equal(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'event' && candidate.record.event.summary.includes('老台钟'),
    ),
    true,
  )
  namiso.close()
})

test('relative event phrases are normalized to the event day', async () => {
  const extraction: ExtractionProvider = {
    version: 'relative-date-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: 'purchase',
            summary: '快递后天到驿站',
            occurredAt: BASE_TIME + 2 * 86_400,
            occurredDay: 20260923,
            timePrecision: 'day',
            participants: [],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '给汤团下单了台猫饮水机，快递后天到驿站。')
  await drain()

  const result = await namiso.retrieve({ query: '饮水机', memoryTypes: ['event'] })
  const event = result.candidates.find((candidate) => candidate.kind === 'event')?.record
  assert.ok(event?.kind === 'event')
  assert.match(event.event.summary, /快递9月23日到驿站/)
  namiso.close()
})

test('relinked evidence dates an event from the matching message', async () => {
  const extraction: ExtractionProvider = {
    version: 'relink-test',
    async extract(input) {
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '送汤',
            summary: '远舟的母亲送来冬瓜排骨汤，李晶夸清爽',
            occurredDay: 20260921,
            timePrecision: 'day',
            participants: [{ name: '妈', type: 'person', role: 'actor' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '老孙今天办完辞职手续了。')
  await say(USER, 'user', '昨天妈又来送汤，冬瓜排骨汤，李晶直夸清爽。')
  await drain()

  const context = await namiso.getContext({ query: '冬瓜排骨汤' })
  assert.match(context.text, /2026-09-20（周日）/)
  assert.match(context.text, /冬瓜排骨汤/)
  namiso.close()
})

test('relinked evidence prefers the user source over an assistant paraphrase', async () => {
  const extraction: ExtractionProvider = {
    version: 'relink-role-test',
    async extract(input) {
      const assistantId = input.focusMessageIds[1]
      if (assistantId === undefined) throw new Error('expected a second focus message')
      return {
        entities: [],
        claims: [],
        events: [
          {
            type: '送汤',
            summary: '上周四妈送冬瓜排骨汤，李晶直夸清爽',
            timePrecision: 'unknown',
            participants: [{ name: '妈', type: 'person', role: 'actor' }],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [assistantId],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '对了，上周四妈又来送汤，冬瓜排骨汤，李晶喝完直夸，说比家里炖的清爽。')
  await say(AI, 'assistant', '你妈送汤真准时，冬瓜排骨汤，李晶夸清爽。')
  await drain()

  const context = await namiso.getContext({ query: '冬瓜排骨汤' })
  assert.match(context.text, /2026-09-17（周四）/)
  assert.match(context.text, /直夸/)
  namiso.close()
})

test('conversation retrieval emits message candidates from chunk hits', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '项目代号是蓝鲸计划，下周启动。')
  await say(AI, 'assistant', '蓝鲸计划的预算还没定。')
  await drain()

  const result = await namiso.retrieve({
    query: '蓝鲸计划',
    memoryTypes: ['conversation'],
    rerank: false,
  })
  const channels = new Map(result.trace.channels.map((channel) => [channel.channel, channel.count]))
  assert.ok((channels.get('message') ?? 0) > 0)
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'message' &&
        candidate.record.message.content.includes('蓝鲸计划'),
    ),
  )
  namiso.close()
})

test('raw message FTS is searchable before chunking', async () => {
  const { namiso, say } = await setup()
  await say(USER, 'user', 'Project Blue Whale starts next week.')
  const result = await namiso.retrieve({
    query: 'Blue Whale',
    memoryTypes: ['conversation'],
    rerank: false,
  })
  const channels = new Map(result.trace.channels.map((channel) => [channel.channel, channel.count]))
  assert.ok((channels.get('fts') ?? 0) > 0)
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.record.kind === 'message' &&
        candidate.record.message.content.includes('Blue Whale'),
    ),
  )
  assert.ok(result.evidence?.some((message) => message.content.includes('Blue Whale')))
  const context = await namiso.getContext({ query: 'Blue Whale starts next week' })
  assert.match(context.text, /Blue Whale/)
  namiso.close()
})
