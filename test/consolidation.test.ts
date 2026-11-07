import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, ExtractionResult } from '../src/index.ts'

import { USER, setup } from './helpers.ts'

function countingProvider(counter: { calls: number; focusCounts: number[] }): ExtractionProvider {
  return {
    version: 'test-consolidate',
    async extract(input): Promise<ExtractionResult> {
      counter.calls += 1
      counter.focusCounts.push(input.focusMessageIds.length)
      return { entities: [], claims: [], events: [] }
    },
  }
}

test('ingest does not call the extraction model until consolidate runs', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, say, drain } = await setup({ extraction: countingProvider(counter) })

  const first = await say(USER, 'user', '第一句话。')
  await say(USER, 'user', '第二句话。')
  await say(USER, 'user', '第三句话。')

  assert.equal(first.consolidated, false)
  assert.equal(counter.calls, 0)
  assert.equal(namiso.health().counts.pendingMessages, 3)

  const report = await drain()
  assert.deepEqual(report, { messages: 3, batches: 1 })
  assert.deepEqual(counter.focusCounts, [3])
  assert.equal(namiso.health().counts.pendingMessages, 0)

  const repeated = await namiso.consolidate()
  assert.deepEqual(repeated, { messages: 0, batches: 0 })
  assert.equal(counter.calls, 1)
  namiso.close()
})

test('batchSize splits one session into bounded extraction calls', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, say } = await setup({ extraction: countingProvider(counter) })

  for (let index = 0; index < 5; index += 1) {
    await say(USER, 'user', `第 ${index} 条消息。`)
  }
  await namiso.drain()
  const report = await namiso.consolidate({ batchSize: 2 })

  assert.deepEqual(report, { messages: 5, batches: 3 })
  assert.deepEqual(counter.focusCounts, [2, 2, 1])
  namiso.close()
})

test('consolidating one conversation leaves another pending', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, conversation, say } = await setup({
    extraction: countingProvider(counter),
  })
  const other = namiso.createConversation({ title: 'other' })
  await say(USER, 'user', '这里是第一个会话。')
  await namiso.ingest({
    conversationId: other.id,
    speakerId: USER,
    role: 'user',
    content: '这里是第二个会话。',
    occurredAt: 1_790_100_000,
  })
  await namiso.drain()

  const report = await namiso.consolidate({ conversationId: conversation.id })
  assert.deepEqual(report, { messages: 1, batches: 1 })
  assert.equal(namiso.health().counts.pendingMessages, 1)

  const remaining = await namiso.consolidate()
  assert.deepEqual(remaining, { messages: 1, batches: 1 })
  assert.equal(namiso.health().counts.pendingMessages, 0)
  namiso.close()
})

test('a second consolidation covers only messages added since the first', async () => {
  const seen: Array<{ focus: number; total: number }> = []
  const extraction: ExtractionProvider = {
    version: 'test-consolidate',
    async extract(input): Promise<ExtractionResult> {
      seen.push({ focus: input.focusMessageIds.length, total: input.messages.length })
      return { entities: [], claims: [], events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })

  await say(USER, 'user', '前半段第一句。')
  await say(USER, 'user', '前半段第二句。')
  const first = await drain()
  assert.deepEqual(first, { messages: 2, batches: 1 })

  await say(USER, 'user', '后半段第一句。')
  await say(USER, 'user', '后半段第二句。')
  await say(USER, 'user', '后半段第三句。')
  const second = await namiso.consolidate()
  assert.deepEqual(second, { messages: 3, batches: 1 })

  assert.deepEqual(seen, [
    { focus: 2, total: 2 },
    { focus: 3, total: 5 },
  ])
  assert.equal(namiso.health().counts.pendingMessages, 0)
  namiso.close()
})

test('overlapping consolidation calls run one after the other', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, say } = await setup({ extraction: countingProvider(counter) })
  await say(USER, 'user', '第一句话。')
  await say(USER, 'user', '第二句话。')
  await say(USER, 'user', '第三句话。')
  await namiso.drain()

  const [first, second] = await Promise.all([namiso.consolidate(), namiso.consolidate()])
  assert.deepEqual(first, { messages: 3, batches: 1 })
  assert.deepEqual(second, { messages: 0, batches: 0 })
  assert.deepEqual(counter.focusCounts, [3])
  namiso.close()
})

test('rejected consolidation inputs leave messages pending', async () => {
  const { namiso, say } = await setup()
  await say(USER, 'user', '需要整理的消息。')
  await assert.rejects(() => namiso.consolidate({ batchSize: 0 }), /batchSize/)
  await assert.rejects(() => namiso.consolidate({ conversationId: 'missing' }), /conversation/)
  assert.equal(namiso.health().counts.pendingMessages, 1)
  namiso.close()
})
