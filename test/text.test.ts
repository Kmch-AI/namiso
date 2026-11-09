import assert from 'node:assert/strict'
import { test } from 'vitest'

import { estimateTokens } from '../src/text.ts'

test('token estimate separates CJK, punctuation, ASCII, and ids', () => {
  assert.equal(estimateTokens('春'.repeat(100)), 70)
  assert.equal(estimateTokens('a'.repeat(100)), 25)
  assert.equal(estimateTokens('，'.repeat(10)), 10)
  assert.equal(estimateTokens('3f2a9c1e-8b4d-4e6f-9a7c-111111111111'), 29)
  assert.equal(estimateTokens('用户A在2026-09-21说'), 11)
})

test('token estimate is monotonic and empty text costs nothing', () => {
  assert.equal(estimateTokens(''), 0)
  const base = estimateTokens('用户喜欢喝咖啡。')
  assert.ok(estimateTokens('用户喜欢喝咖啡。今天天气不错。') > base)
})
