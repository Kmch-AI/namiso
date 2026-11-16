import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { EvidenceJudgeProvider } from '../src/index.ts'

import { AI, USER, setup } from './helpers.ts'

test('multi-hop expansion bridges two messages', async () => {
  const { namiso, say } = await setup()
  await say(USER, 'user', '蓝鲸计划由老周负责。')
  await say(AI, 'assistant', '收到。')
  await say(USER, 'user', '老周把接口文档交给小满了。')
  await say(AI, 'assistant', '好。')

  const result = await namiso.retrieve({
    query: '蓝鲸计划后续找谁对接？',
    memoryTypes: ['conversation'],
    rerank: false,
    multiHop: true,
  })

  const trace = result.trace.channels.find((channel) => channel.channel === 'multihop')
  assert.ok(trace !== undefined && trace.count > 0)
  assert.ok(result.candidates.some((candidate) => candidate.text.includes('小满')))
  namiso.close()
})

test('multi-hop calls the evidence judge when configured', async () => {
  let calls = 0
  const judge: EvidenceJudgeProvider = {
    model: 'test-judge',
    async judge(input) {
      calls += 1
      return input.candidates.map((candidate) => ({ id: candidate.id, score: 1 }))
    },
  }
  const { namiso, say } = await setup({ evidenceJudge: judge })
  await say(USER, 'user', '蓝鲸计划由老周负责。')
  await say(AI, 'assistant', '收到。')
  await say(USER, 'user', '老周把接口文档交给了小满。')
  await say(AI, 'assistant', '好。')

  const result = await namiso.retrieve({
    query: '蓝鲸计划后续找谁对接？',
    memoryTypes: ['conversation'],
    rerank: false,
    multiHop: true,
  })

  assert.ok(calls > 0)
  const trace = result.trace.channels.find((channel) => channel.channel === 'multihop')
  assert.ok(trace !== undefined && trace.count > 0)
  namiso.close()
})
