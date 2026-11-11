import assert from 'node:assert/strict'
import { test } from 'vitest'

import { HttpEmbeddingProvider } from '../src/index.ts'
import { BASE_TIME, USER, setup } from './helpers.ts'

const reversedOrderFetch: typeof fetch = async (_input, init) => {
  const raw = init?.body
  const body = JSON.parse(typeof raw === 'string' ? raw : '{}') as { input: string[] }
  const data = body.input.map((text, index) => ({
    index,
    embedding: text === 'a' ? [1, 0] : [0, 1],
  }))
  return new Response(JSON.stringify({ data: data.toReversed() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('a time range keeps claims that stay valid after its start', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '我住在杭州。')
  await drain()

  const result = await namiso.retrieve({
    query: '我住在哪里？',
    rerank: false,
    timeRange: { from: BASE_TIME + 365 * 86_400 },
  })
  assert.ok(
    result.candidates.some(
      (candidate) => candidate.kind === 'claim' && candidate.text.includes('杭州'),
    ),
  )
  namiso.close()
})

test('HTTP embeddings reject a zero batch size and restore provider order', async () => {
  assert.throws(
    () =>
      new HttpEmbeddingProvider({
        endpoint: 'https://example.test/embeddings',
        model: 'test-embedding',
        dimensions: 2,
        batchSize: 0,
      }),
    /batchSize/,
  )

  const provider = new HttpEmbeddingProvider({
    endpoint: 'https://example.test/embeddings',
    model: 'test-embedding',
    dimensions: 2,
    batchSize: 4,
    fetch: reversedOrderFetch,
  })
  assert.deepEqual(await provider.embed(['a', 'b']), [
    [1, 0],
    [0, 1],
  ])
})
