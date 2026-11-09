import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionInput, ExtractionMessage, ExtractionUsage } from '../src/index.ts'

import { asEntityId, asMemorySpaceId, asMessageId } from '../src/ids.ts'
import {
  HttpEmbeddingProvider,
  HttpExtractionProvider,
  HttpRerankerProvider,
  HashEmbeddingProvider,
  LexicalReranker,
  Namiso,
  RuleExtractionProvider,
  ValidationError,
  providersFromEnv,
} from '../src/index.ts'
import { cosineSimilarity } from '../src/text.ts'

const embeddingFetch: typeof fetch = async (_input, init) => {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body')
  const body = JSON.parse(init.body) as { input: string[] }
  return new Response(
    JSON.stringify({
      data: body.input.map(() => ({ embedding: [1, 0] })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const extractionFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                { name: 'IndexTTS2', type: 'artifact' },
                { name: '四时小路', type: 'self' },
              ],
              claims: [
                {
                  subject: { name: '用户A', type: 'person' },
                  predicate: 'uses',
                  attribute: 'uses',
                  cardinality: 'one',
                  change: 'replaces',
                  object: { kind: 'entity', name: 'IndexTTS2', type: 'artifact' },
                  modality: 'asserted',
                  confidence: 0.9,
                },
              ],
              events: [
                {
                  type: 'usage_change',
                  summary: '用户开始使用 IndexTTS2',
                  participants: [{ name: '用户A', type: 'person', role: 'actor' }],
                  modality: 'asserted',
                  confidence: 0.9,
                },
              ],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 34,
        total_tokens: 46,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const timeValueFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [],
              claims: [
                {
                  subject: { name: '用户A', type: 'person' },
                  predicate: '生日',
                  object: { kind: 'literal', value: '3月2日' },
                  validFrom: 1_790_000_000_000,
                  sensitivity: 'private',
                  disclosure: 'alias_only',
                },
                {
                  subject: { name: '用户A', type: 'person' },
                  predicate: '年龄',
                  object: { kind: 'literal', value: '30' },
                  validFrom: -1,
                  sensitivity: 'secret',
                },
              ],
              events: [
                {
                  type: 'meeting',
                  summary: '见面',
                  occurredAt: 1_790_000_060_500,
                  disclosure: 'do_not_volunteer',
                },
                { type: 'meeting', summary: '旧事', occurredAt: '2026-03-02' },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const compactFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              e: [{ n: '阿桐', t: 'p', d: '驻唱歌手', z: 'private' }],
              c: [
                {
                  s: '阿桐',
                  p: '住在',
                  a: '居住地',
                  o: { k: 'l', v: '苏州' },
                  ev: [0],
                  k: 'one',
                  ch: 'replaces',
                  vf: 1_790_000_050,
                },
                {
                  s: '阿桐',
                  p: '月薪',
                  a: '月薪',
                  o: { k: 'l', v: '三千' },
                  ev: [0],
                  v: 1_790_000_100,
                },
              ],
              v: [
                {
                  t: 'meeting',
                  sum: '见面',
                  at: 1_790_000_060,
                  pr: 'day',
                  who: [['阿桐', 'actor']],
                  m: 'uncertain',
                  ev: [0],
                },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const compactEvidenceFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              e: [],
              c: [
                { s: '用户A', p: '甲', o: { k: 'l', v: '一' }, ev: [0] },
                { s: '用户A', p: '乙', o: { k: 'l', v: '二' }, ev: [1] },
                { s: '用户A', p: '丙', o: { k: 'l', v: '三' } },
              ],
              v: [],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

function extractionMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  occurredAt: number,
  messageIndex: number,
): ExtractionMessage {
  return {
    id: asMessageId(id),
    role,
    speakerId: '用户A',
    speakerName: '用户A',
    content,
    occurredAt,
    messageIndex,
  }
}

function wireInput(): ExtractionInput {
  const messages = Array.from({ length: 16 }, (_, index) =>
    extractionMessage(
      `0b8f6e3a-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `第${index + 1}条消息，这里有一些实际内容用于估算。`,
      1_790_000_000 + index * 60,
      index,
    ),
  )
  const focus = messages[15]
  assert.ok(focus !== undefined)
  return {
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [focus.id],
    messages,
    knownEntities: Array.from({ length: 20 }, (_, index) => ({
      id: asEntityId(`entity-${index}`),
      name: `人物${index}`,
      type: 'person' as const,
      aliases: [`别名${index}`, `昵称${index}`],
    })),
    knownFacts: [{ subject: '人物0', attribute: '居住地', value: '苏州' }],
  }
}

const rerankFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const fencedFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: `\`\`\`json\n${JSON.stringify({ entities: [], claims: [], events: [] })}\n\`\`\``,
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const cacheUsageFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ entities: [], claims: [], events: [] }) } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 60,
        prompt_cache_miss_tokens: 40,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const detailUsageFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ entities: [], claims: [], events: [] }) } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 25 },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

test('hash embeddings are deterministic, normalized, and fixed width', async () => {
  const provider = new HashEmbeddingProvider({ dimensions: 64 })
  const [left, right] = await provider.embed(['我在使用 TTS-A。', '我在使用 TTS-A。'])
  assert.ok(left !== undefined && right !== undefined)
  assert.equal(left.length, 64)
  assert.deepEqual(left, right)
  const norm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9)
  assert.ok(cosineSimilarity(left, right) > 0.999)
})

test('rule extraction keeps full product names and detects state changes', async () => {
  const provider = new RuleExtractionProvider()
  const messageId = asMessageId('message-1')
  const base = {
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [messageId] as const,
    knownEntities: [],
  }
  const usage = await provider.extract({
    ...base,
    messages: [
      {
        id: messageId,
        role: 'user',
        speakerId: '用户A',
        speakerName: '用户A',
        content: '我在使用 TTS-A。',
        occurredAt: 1_790_000_000,
        messageIndex: 0,
      },
    ],
  })
  assert.equal(usage.claims.length, 1)
  assert.equal(usage.claims[0]?.predicate, 'uses')
  assert.equal(usage.claims[0]?.object.kind, 'entity')
  assert.equal(
    usage.claims[0]?.object.kind === 'entity' ? usage.claims[0].object.name : '',
    'TTS-A',
  )

  const change = await provider.extract({
    ...base,
    focusMessageIds: [asMessageId('message-2')],
    messages: [
      {
        id: asMessageId('message-2'),
        role: 'user',
        speakerId: '用户A',
        speakerName: '用户A',
        content: '我决定重新开始使用 IndexTTS2 了。',
        occurredAt: 1_790_000_060,
        messageIndex: 1,
      },
    ],
  })
  assert.equal(change.claims.length, 0)
  assert.equal(change.events[0]?.type, 'usage_change')
  assert.equal(change.events[0]?.modality, 'asserted')

  const uncertain = await provider.extract({
    ...base,
    focusMessageIds: [asMessageId('message-3')],
    messages: [
      {
        id: asMessageId('message-3'),
        role: 'user',
        speakerId: '用户A',
        speakerName: '用户A',
        content: '我可能还是会换回 IndexTTS2。',
        occurredAt: 1_790_000_120,
        messageIndex: 2,
      },
    ],
  })
  assert.equal(uncertain.claims.length, 0)
  assert.equal(uncertain.events[0]?.modality, 'uncertain')
})

test('entity types reserve self for the assistant itself', async () => {
  const provider = new RuleExtractionProvider()
  const base = {
    memorySpaceId: asMemorySpaceId('space-1'),
    knownEntities: [],
  }
  const user = await provider.extract({
    ...base,
    focusMessageIds: [asMessageId('message-1')],
    messages: [
      {
        id: asMessageId('message-1'),
        role: 'user',
        speakerId: '用户A',
        speakerName: '用户A',
        content: '我在 OpenAI 工作。我在使用 IndexTTS2。',
        occurredAt: 1,
        messageIndex: 0,
      },
    ],
  })
  const types = new Map(user.entities.map((entity) => [entity.name, entity.type]))
  assert.equal(types.get('用户A'), 'person')
  assert.equal(types.get('OpenAI'), 'group')
  assert.equal(types.get('IndexTTS2'), 'artifact')

  const assistant = await provider.extract({
    ...base,
    focusMessageIds: [asMessageId('message-2')],
    messages: [
      {
        id: asMessageId('message-2'),
        role: 'assistant',
        speakerId: '四时小路',
        speakerName: '四时小路',
        content: '我是四时小路。',
        occurredAt: 2,
        messageIndex: 1,
      },
    ],
  })
  assert.equal(assistant.entities[0]?.type, 'self')
})

test('lexical reranker ranks lexically overlapping documents higher', async () => {
  const reranker = new LexicalReranker()
  const scores = await reranker.rerank({
    query: '我之前和谁讨论过 TTS-A？',
    documents: ['今天天气不错。', '用户曾与 B 讨论 TTS-A 的情感控制。'],
  })
  const ordered = scores.toSorted((left, right) => right.score - left.score)
  assert.equal(ordered[0]?.index, 1)
})

test('HTTP providers parse boundary payloads', async () => {
  const embedding = new HttpEmbeddingProvider({
    endpoint: 'https://example.test/embeddings',
    model: 'test-embedding',
    dimensions: 2,
    fetch: embeddingFetch,
  })
  const vectors = await embedding.embed(['a', 'b'])
  assert.deepEqual(vectors, [
    [1, 0],
    [1, 0],
  ])

  const requests: Array<Record<string, unknown>> = []
  const usageEvents: ExtractionUsage[] = []
  const recordingFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') {
      requests.push(JSON.parse(init.body) as Record<string, unknown>)
    }
    return extractionFetch(input, init)
  }
  const extraction = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    reasoningEffort: 'low',
    onUsage: (usage) => usageEvents.push(usage),
    fetch: recordingFetch,
  })
  const result = await extraction.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-9')],
    messages: [],
    knownEntities: [],
  })
  assert.equal(result.claims[0]?.predicate, 'uses')
  assert.equal(result.claims[0]?.attribute, 'uses')
  assert.equal(result.claims[0]?.cardinality, 'one')
  assert.equal(result.claims[0]?.change, 'replaces')
  assert.deepEqual(result.claims[0]?.evidenceMessageIds, ['message-9'])
  assert.equal(result.events[0]?.type, 'usage_change')
  assert.equal(result.entities[0]?.type, 'artifact')
  assert.equal(result.entities[1]?.type, 'self')
  assert.equal(requests[0]?.['reasoning_effort'], 'low')
  assert.deepEqual(extraction.lastUsage, {
    promptTokens: 12,
    completionTokens: 34,
    totalTokens: 46,
    reasoningTokens: 5,
  })
  assert.deepEqual(extraction.usage, {
    promptTokens: 12,
    completionTokens: 34,
    totalTokens: 46,
    reasoningTokens: 5,
  })
  assert.equal(usageEvents.length, 1)

  const reranker = new HttpRerankerProvider({
    endpoint: 'https://example.test/rerank',
    model: 'test-rerank',
    fetch: rerankFetch,
  })
  const scores = await reranker.rerank({ query: 'q', documents: ['a', 'b'] })
  assert.deepEqual(scores, [
    { index: 0, score: 0.1 },
    { index: 1, score: 0.9 },
  ])
})

test('HTTP extraction stores times as seconds and drops unresolved times', async () => {
  const provider = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: timeValueFetch,
  })
  const result = await provider.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-1')],
    messages: [],
    knownEntities: [],
  })
  assert.equal(result.claims[0]?.validFrom, 1_790_000_000)
  assert.equal(result.claims[0]?.sensitivity, 'private')
  assert.equal(result.claims[0]?.disclosure, 'alias_only')
  assert.equal(result.claims[1]?.validFrom, undefined)
  assert.equal(result.claims[1]?.sensitivity, undefined)
  assert.equal(result.events[0]?.occurredAt, 1_790_000_060)
  assert.equal(result.events[0]?.disclosure, 'do_not_volunteer')
  assert.equal(result.events[1]?.occurredAt, undefined)
})

test('compact extraction parses short keys and type codes', async () => {
  const provider = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: compactFetch,
  })
  const result = await provider.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-1')],
    messages: [extractionMessage('message-1', 'user', '阿桐住在苏州。', 1_790_000_000, 0)],
    knownEntities: [],
  })
  assert.equal(result.entities[0]?.name, '阿桐')
  assert.equal(result.entities[0]?.type, 'person')
  assert.equal(result.entities[0]?.description, '驻唱歌手')
  assert.equal(result.entities[0]?.sensitivity, 'private')
  assert.equal(result.claims[0]?.subject.type, 'person')
  assert.equal(result.claims[0]?.attribute, '居住地')
  assert.equal(result.claims[0]?.cardinality, 'one')
  assert.equal(result.claims[0]?.change, 'replaces')
  assert.equal(result.claims[0]?.modality, 'asserted')
  assert.equal(result.claims[0]?.validFrom, 1_790_000_050)
  assert.equal(result.claims[1]?.validFrom, 1_790_000_100)
  assert.deepEqual(result.claims[0]?.evidenceMessageIds, ['message-1'])
  assert.equal(result.events[0]?.timePrecision, 'day')
  assert.equal(result.events[0]?.modality, 'uncertain')
  assert.deepEqual(result.events[0]?.participants, [
    { name: '阿桐', type: 'person', role: 'actor' },
  ])
  assert.deepEqual(result.diagnostics, { evidenceFallbacks: 0, evidenceDropped: 0 })
})

test('compact evidence never points at a context message', async () => {
  const provider = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: compactEvidenceFetch,
  })
  const result = await provider.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-focus')],
    messages: [
      extractionMessage('message-context', 'user', '上下文', 1_790_000_000, 0),
      extractionMessage('message-focus', 'user', '焦点', 1_790_000_060, 1),
    ],
    knownEntities: [],
  })
  assert.deepEqual(result.claims[0]?.evidenceMessageIds, [])
  assert.deepEqual(result.claims[1]?.evidenceMessageIds, ['message-focus'])
  assert.deepEqual(result.claims[2]?.evidenceMessageIds, ['message-focus'])
  assert.deepEqual(result.diagnostics, { evidenceFallbacks: 1, evidenceDropped: 1 })
})

test('compact requests drop message ids and are smaller than legacy requests', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const capture: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    }
    return extractionFetch(input, init)
  }
  const input = wireInput()
  const compact = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: capture,
  })
  await compact.extract(input)
  const legacy = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    wireFormat: 'legacy',
    fetch: capture,
  })
  await legacy.extract(input)

  const compactMessages = bodies[0]?.['messages'] as Array<{ content: string }>
  const compactUser = compactMessages[1]
  assert.ok(compactUser !== undefined)
  const compactPayload = JSON.parse(compactUser.content) as Record<string, unknown>
  assert.deepEqual(Object.keys(compactPayload).slice(0, 3), [
    'knownEntities',
    'knownAttributes',
    'knownFacts',
  ])
  assert.deepEqual(compactPayload['focus'], [15])
  const messageTuples = compactPayload['messages'] as unknown[][]
  const entityTuples = compactPayload['knownEntities'] as unknown[][]
  assert.deepEqual(messageTuples[15], [
    'a',
    '用户A',
    '第16条消息，这里有一些实际内容用于估算。',
    1_790_000_900,
  ])
  assert.deepEqual(entityTuples[0], ['人物0', 'p', ['别名0', '昵称0']])
  assert.deepEqual(compactPayload['knownFacts'], [['人物0', '居住地', '苏州']])
  assert.equal(JSON.stringify(compactPayload).includes('0b8f6e3a'), false)

  const compactSystem = compactMessages[0]
  assert.ok(compactSystem !== undefined)
  assert.match(compactSystem.content, /knownFacts are current values/)

  const legacyMessages = bodies[1]?.['messages'] as Array<{ content: string }>
  const legacyUser = legacyMessages[1]
  assert.ok(legacyUser !== undefined)
  const legacyPayload = JSON.parse(legacyUser.content) as Record<string, unknown>
  assert.deepEqual(legacyPayload['focusMessageIds'], ['0b8f6e3a-0000-4000-8000-000000000015'])

  const compactBody = bodies[0]
  const legacyBody = bodies[1]
  assert.ok(compactBody !== undefined && legacyBody !== undefined)
  assert.ok(JSON.stringify(compactBody).length < JSON.stringify(legacyBody).length * 0.65)
})

test('HTTP reranker caps documents and excerpt length', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const capture: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    }
    return rerankFetch(input, init)
  }
  const reranker = new HttpRerankerProvider({
    endpoint: 'https://example.test/rerank',
    model: 'test-rerank',
    maxDocuments: 2,
    maxDocumentChars: 40,
    fetch: capture,
  })
  const scores = await reranker.rerank({
    query: '储物柜密码',
    documents: [
      `${'无关内容'.repeat(40)}储物柜密码是 4821。${'更多内容'.repeat(40)}`,
      '第二份文档，同样很长，需要被截断。'.repeat(20),
      '第三份文档不会被发送。',
    ],
  })
  assert.equal(scores.length, 2)
  const sent = bodies[0]?.['documents'] as string[]
  assert.equal(sent.length, 2)
  for (const document of sent) {
    assert.ok(document.length <= 42, `document of ${document.length} chars was not capped`)
  }
  assert.match(sent[0] ?? '', /储物柜密码/)
})

test('HTTP extraction tolerates fenced JSON', async () => {
  const provider = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: fencedFetch,
  })
  const result = await provider.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-1')],
    messages: [],
    knownEntities: [],
  })
  assert.deepEqual(result, { entities: [], claims: [], events: [] })
})

test('health reports extraction usage from the HTTP provider', async () => {
  const extraction = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: extractionFetch,
  })
  const namiso = await Namiso.open({
    databasePath: ':memory:',
    vectorIndex: 'exact',
    extraction,
  })
  const conversation = namiso.createConversation()
  await namiso.ingest({
    conversationId: conversation.id,
    speakerId: '用户A',
    role: 'user',
    content: '我在使用 TTS-A。',
  })
  const drain = await namiso.drain()
  const consolidated = await namiso.consolidate()

  assert.equal(drain.failed, 0)
  assert.equal(consolidated.messages, 1)
  assert.deepEqual(namiso.health().extraction.usage, {
    promptTokens: 12,
    completionTokens: 34,
    totalTokens: 46,
    reasoningTokens: 5,
  })
  namiso.close()
})

test('extraction usage reports cache hit and miss tokens', async () => {
  const extraction = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: cacheUsageFetch,
  })
  await extraction.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-1')],
    messages: [],
    knownEntities: [],
  })
  assert.deepEqual(extraction.usage, {
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    reasoningTokens: 0,
    cacheHitTokens: 60,
    cacheMissTokens: 40,
  })

  const detailExtraction = new HttpExtractionProvider({
    endpoint: 'https://example.test/chat',
    model: 'test-chat',
    fetch: detailUsageFetch,
  })
  await detailExtraction.extract({
    memorySpaceId: asMemorySpaceId('space-1'),
    focusMessageIds: [asMessageId('message-1')],
    messages: [],
    knownEntities: [],
  })
  assert.equal(detailExtraction.usage?.cacheHitTokens, 25)
  assert.equal(detailExtraction.usage?.cacheMissTokens, 75)
})

test('provider environment parsing is all-or-nothing', () => {
  assert.deepEqual(providersFromEnv({}), {})
  assert.throws(
    () => providersFromEnv({ NAMISO_EMBEDDING_URL: 'https://example.test/embeddings' }),
    (error: unknown) => error instanceof ValidationError,
  )
  assert.throws(
    () =>
      providersFromEnv({
        NAMISO_EMBEDDING_URL: 'https://example.test/embeddings',
        NAMISO_EMBEDDING_MODEL: 'test-embedding',
      }),
    (error: unknown) => error instanceof ValidationError,
  )
  assert.throws(
    () =>
      providersFromEnv({
        NAMISO_EXTRACTION_URL: 'https://example.test/chat',
        NAMISO_EXTRACTION_MODEL: 'test-chat',
        NAMISO_EXTRACTION_REASONING_EFFORT: 'extreme',
      }),
    (error: unknown) => error instanceof ValidationError,
  )
  assert.throws(
    () =>
      providersFromEnv({
        NAMISO_EXTRACTION_URL: 'https://example.test/chat',
        NAMISO_EXTRACTION_MODEL: 'test-chat',
        NAMISO_EXTRACTION_WIRE_FORMAT: 'binary',
      }),
    (error: unknown) => error instanceof ValidationError,
  )

  const providers = providersFromEnv({
    NAMISO_EMBEDDING_URL: 'https://example.test/embeddings',
    NAMISO_EMBEDDING_MODEL: 'test-embedding',
    NAMISO_EMBEDDING_DIMENSIONS: '8',
    NAMISO_EXTRACTION_URL: 'https://example.test/chat',
    NAMISO_EXTRACTION_MODEL: 'test-chat',
    NAMISO_EXTRACTION_REASONING_EFFORT: 'low',
    NAMISO_RERANK_URL: 'https://example.test/rerank',
    NAMISO_RERANK_MODEL: 'test-rerank',
  })
  assert.ok(providers.embedding instanceof HttpEmbeddingProvider)
  assert.equal(providers.embedding.dimensions, 8)
  assert.ok(providers.extraction instanceof HttpExtractionProvider)
  assert.ok(providers.reranker instanceof HttpRerankerProvider)
})
