import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, ExtractionResult } from '../src/index.ts'

import { AI, USER, setup } from './helpers.ts'

function countingProvider(counter: { calls: number }): ExtractionProvider {
  return {
    version: 'test-v1',
    async extract(input): Promise<ExtractionResult> {
      counter.calls += 1
      return {
        entities: [
          {
            name: `实体${counter.calls}`,
            type: 'other',
            evidenceMessageIds: [input.focusMessageId],
          },
        ],
        claims: [],
        events: [],
      }
    },
  }
}

test('extraction skips assistant messages by default', async () => {
  const counter = { calls: 0 }
  const { namiso, say, drain } = await setup({ extraction: countingProvider(counter) })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 1)
  assert.ok(namiso.getEntityDetails(AI) !== null)
  namiso.close()
})

test('extractRoles can include assistant messages', async () => {
  const counter = { calls: 0 }
  const { namiso, say, drain } = await setup({
    extraction: countingProvider(counter),
    extractRoles: ['user', 'assistant'],
  })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 2)
  namiso.close()
})
