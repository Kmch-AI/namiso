import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider } from '../src/index.ts'

import { Namiso } from '../src/index.ts'
import { AI, USER, setup } from './helpers.ts'

test('hybrid retrieval returns raw evidence and all three channels', async () => {
  const { namiso, say, drain } = await setup()
  const performer = '小岑'
  await say(USER, 'user', '我上周去苏州听了评弹。')
  await say(AI, 'assistant', '你喜欢哪位演员？')
  await say(USER, 'user', `我喜欢${performer}。`)
  await say(USER, 'user', '下周我准备去杭州看展览。')
  await say(USER, 'user', '展览的主题是宋代点茶。')
  await drain()

  const result = await namiso.retrieve({ query: '我在苏州做了什么？', topK: 8 })
  assert.ok(result.candidates.length > 0)
  const channels = new Map(result.trace.channels.map((channel) => [channel.channel, channel.count]))
  assert.ok((channels.get('fts') ?? 0) > 0)
  assert.ok((channels.get('vector') ?? 0) > 0)
  assert.ok(result.candidates.some((candidate) => candidate.kind === 'chunk'))

  const context = await namiso.getContext({ query: '我在苏州做了什么？' })
  assert.match(context.text, /苏州/)
  assert.ok(context.evidence.some((message) => message.content.includes('评弹')))
  assert.equal(context.trace.intent, 'general')
  namiso.close()
})

test('current-state queries use structured claims ahead of raw chunks', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '我是一名设计师。')
  await say(USER, 'user', '我在使用 TTS-A。')
  await say(USER, 'user', '我决定重新开始使用 IndexTTS2 了。')
  await drain()

  const result = await namiso.retrieve({ query: '我现在使用什么模型？' })
  assert.equal(result.trace.intent, 'current_fact')
  assert.ok(result.trace.entityIds.length > 0)
  const sqlChannel = result.trace.channels.find((channel) => channel.channel === 'sql')
  assert.ok((sqlChannel?.count ?? 0) > 0)
  assert.ok(
    result.candidates.some(
      (candidate) => candidate.kind === 'claim' && candidate.status === 'active',
    ),
  )
  const context = await namiso.getContext({ query: '我现在使用什么模型？' })
  assert.match(context.text, /IndexTTS2/)
})

test('time range filters structured events', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '我换成了 TTS-A。')
  await say(USER, 'user', '我换回了 IndexTTS2。')
  await drain()

  const future = await namiso.retrieve({
    query: '我的模型变化',
    timeRange: { from: 2_000_000_000 },
    rerank: false,
  })
  const eventCandidates = future.candidates.filter((candidate) => candidate.kind === 'event')
  assert.equal(eventCandidates.length, 0)
  namiso.close()
})

test('a small budget compresses text without dropping items', async () => {
  const { namiso, say, drain } = await setup()
  for (let index = 0; index < 12; index += 1) {
    await say(USER, 'user', `第 ${index} 天我记录了很长的日记，主题是旅行和读书。`)
    await say(AI, 'assistant', '我记下了。')
  }
  await drain()
  const context = await namiso.getContext({
    query: '我记录了哪些旅行和读书的事情？',
    maxTokens: 120,
  })
  assert.ok(context.text.length > 0)
  assert.equal(context.compressed, true)
  const refs = new Map(
    Object.entries(context.refs).map(([ref, value]) => [`${value.kind}:${value.id}`, ref]),
  )
  for (const item of context.items) {
    const ref = refs.get(item.key)
    assert.ok(ref !== undefined, `missing ref for ${item.key}`)
    assert.ok(context.text.includes(`[${item.kind}:${ref}]`), `context dropped ${item.key}`)
  }
  for (const message of context.evidence) {
    const ref = refs.get(`message:${message.id}`)
    assert.ok(ref !== undefined, `missing ref for message ${message.id}`)
    assert.ok(context.text.includes(`[message:${ref}]`), `context dropped ${message.id}`)
  }
  namiso.close()
})

test('compressed evidence keeps the span around the query terms', async () => {
  const { namiso, say, drain } = await setup()
  const password = '4821'
  await say(
    USER,
    'user',
    `${'前几天都在整理书架，'.repeat(20)}我的储物柜密码是 ${password}，请记好。${'后来又聊了些别的。'.repeat(20)}`,
  )
  await drain()
  const context = await namiso.getContext({
    query: '我的储物柜密码是什么？',
    maxTokens: 120,
  })
  assert.equal(context.compressed, true)
  assert.match(context.text, new RegExp(password))
  namiso.close()
})

test('query-matching evidence survives crowded contexts', async () => {
  const { namiso, say, drain } = await setup()
  const password = '4821'
  for (let index = 0; index < 16; index += 1) {
    await say(USER, 'user', `第 ${index} 天，后台的灯和椅子都正常，没有特别的事情。`)
    await say(AI, 'assistant', '收到，我继续记录。')
  }
  await say(USER, 'user', `我的储物柜密码是 ${password}。`)
  await drain()
  const context = await namiso.getContext({ query: '我的储物柜密码是什么？' })
  assert.ok(
    context.evidence.some((message) => message.content.includes(password)),
    'the matching message should be selected even when earlier chunks crowd the ranking',
  )
  namiso.close()
})

test('rerankPool limits reranker documents without shrinking topK', async () => {
  let rerankedDocuments = 0
  const { namiso, say, drain } = await setup({
    reranker: {
      model: 'test-rerank',
      async rerank(input) {
        rerankedDocuments = input.documents.length
        return input.documents.map((_, index) => ({
          index,
          score: 1 - index / input.documents.length,
        }))
      },
    },
  })
  for (let index = 0; index < 8; index += 1) {
    await say(USER, 'user', `我在使用 TTS-${index}。`)
  }
  await drain()

  const result = await namiso.retrieve({
    query: '我现在使用什么模型？',
    topK: 5,
    rerankPool: 2,
    includeRelations: false,
  })

  assert.equal(rerankedDocuments, 2)
  assert.equal(result.trace.rerankedCount, 2)
  assert.equal(result.candidates.length, 5)
  namiso.close()
})

test('sqlite-vec and exact backends both return candidates', async () => {
  const auto = await Namiso.open({
    databasePath: ':memory:',
    vectorIndex: 'auto',
    memorySpace: { name: 'auto' },
  })
  const conversation = auto.createConversation()
  await auto.ingest({
    conversationId: conversation.id,
    speakerId: USER,
    role: 'user',
    content: '我的猫叫团子，喜欢趴在窗台上。',
    occurredAt: 1_790_000_000,
  })
  await auto.drain()
  const autoResult = await auto.retrieve({ query: '我的猫叫什么？' })
  assert.ok(autoResult.candidates.length > 0)
  assert.equal(auto.health().counts.missingVectors, 0)
  auto.close()

  const exact = await setup({ memorySpace: { name: 'exact' } })
  await exact.say(USER, 'user', '我的猫叫团子，喜欢趴在窗台上。')
  await exact.drain()
  const exactResult = await exact.namiso.retrieve({ query: '我的猫叫什么？' })
  assert.ok(exactResult.candidates.length > 0)
  assert.equal(exact.namiso.health().vectorBackend, 'exact')
  exact.namiso.close()
})

test('context uses short refs by default and full ids on request', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '我住在苏州，喜欢评弹。')
  await drain()
  const short = await namiso.getContext({ query: '我住在哪里？' })
  assert.ok(Object.keys(short.refs).length > 0)
  assert.doesNotMatch(short.text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
  const full = await namiso.getContext({ query: '我住在哪里？', idMode: 'full' })
  assert.match(full.text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
  namiso.close()
})

test('context renders dates in the requested time zone', async () => {
  const { namiso, conversation, drain } = await setup()
  await namiso.ingest({
    conversationId: conversation.id,
    speakerId: USER,
    role: 'user',
    content: '我的储物柜密码是 4821。',
    occurredAt: Date.parse('2026-04-15T16:30:00Z') / 1000,
  })
  await drain()
  const shanghai = await namiso.getContext({
    query: '我的储物柜密码是什么？',
    timeZone: 'Asia/Shanghai',
  })
  assert.match(shanghai.text, /2026-04-16（周四）/)
  const utc = await namiso.getContext({
    query: '我的储物柜密码是什么？',
    timeZone: 'UTC',
  })
  assert.match(utc.text, /2026-04-15（周三）/)
  namiso.close()
})

test('conflicting active claims render both values without choosing', async () => {
  const extraction: ExtractionProvider = {
    version: 'conflict-test',
    async extract(input) {
      const evidence = input.focusMessageIds[0]
      return {
        entities: [{ name: '用户', type: 'person', evidenceMessageIds: [evidence] }],
        claims: [
          {
            subject: { name: '用户', type: 'person' },
            predicate: '储物柜密码',
            object: { kind: 'literal', value: '4821' },
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [evidence],
          },
          {
            subject: { name: '用户', type: 'person' },
            predicate: '储物柜密码',
            object: { kind: 'literal', value: '9137' },
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [evidence],
          },
        ],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '储物柜密码的事我说过两个版本。')
  await drain()
  const context = await namiso.getContext({ query: '储物柜密码是什么？' })
  assert.match(context.text, /\[Unresolved Conflicts\]/)
  assert.match(context.text, /4821/)
  assert.match(context.text, /9137/)
  assert.match(context.text, /不要自行选择/)
  namiso.close()
})

test('retrieval diagnostics stay out of the model context', async () => {
  const { namiso, say, drain } = await setup({
    reranker: {
      model: 'broken-reranker',
      async rerank() {
        throw new Error('window exceeded')
      },
    },
  })
  await say(USER, 'user', '我喜欢评弹。')
  await drain()
  const context = await namiso.getContext({ query: '我喜欢什么？' })
  assert.doesNotMatch(context.text, /Reranker/)
  assert.doesNotMatch(context.text, /window exceeded/)
  assert.ok(context.trace.notes.some((note) => note.includes('Reranker')))
  namiso.close()
})
