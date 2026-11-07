import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, ExtractionResult, KnownEntity } from '../src/index.ts'

import { AI, USER, setup } from './helpers.ts'

function countingProvider(counter: { calls: number; focusCounts: number[] }): ExtractionProvider {
  return {
    version: 'test-v1',
    async extract(input): Promise<ExtractionResult> {
      counter.calls += 1
      counter.focusCounts.push(input.focusMessageIds.length)
      return {
        entities: [
          {
            name: `实体${counter.calls}`,
            type: 'other',
            evidenceMessageIds: [input.focusMessageIds[0]],
          },
        ],
        claims: [],
        events: [],
      }
    },
  }
}

test('one consolidation call covers every message in the batch', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, say, drain } = await setup({ extraction: countingProvider(counter) })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 1)
  assert.deepEqual(counter.focusCounts, [2])
  assert.ok(namiso.getEntityDetails(AI) !== null)
  namiso.close()
})

test('extractRoles can restrict extraction to user messages', async () => {
  const counter = { calls: 0, focusCounts: [] as number[] }
  const { namiso, say, drain } = await setup({
    extraction: countingProvider(counter),
    extractRoles: ['user'],
  })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 1)
  assert.deepEqual(counter.focusCounts, [1])
  assert.ok(namiso.getEntityDetails(AI) !== null)
  namiso.close()
})

test('known entities include only names mentioned in the focus or recent context', async () => {
  const seen: KnownEntity[][] = []
  const extraction: ExtractionProvider = {
    version: 'test-v1',
    async extract(input): Promise<ExtractionResult> {
      seen.push([...input.knownEntities])
      return { entities: [], claims: [], events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await namiso.ensureEntity({ name: 'Alpha', type: 'other' })
  await namiso.ensureEntity({ name: 'Beta', type: 'other' })
  await namiso.ensureEntity({ name: 'Gamma', type: 'other' })

  await say(USER, 'user', 'Alpha 在这里。')
  await say(USER, 'user', 'Beta 也在这里。')
  await say(USER, 'user', '这句话没有提到别的实体。')
  await drain()

  assert.equal(seen.length, 1)
  assert.deepEqual((seen[0] ?? []).map((entity) => entity.name).toSorted(), ['Alpha', 'Beta'])
  namiso.close()
})

test('known entities are capped at 50', async () => {
  let count = 0
  const extraction: ExtractionProvider = {
    version: 'test-v1',
    async extract(input): Promise<ExtractionResult> {
      count = input.knownEntities.length
      return { entities: [], claims: [], events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  const names = Array.from({ length: 60 }, (_, index) => `Entity${String(index).padStart(2, '0')}`)
  for (const name of names) {
    await namiso.ensureEntity({ name, type: 'other' })
  }

  await say(USER, 'user', names.join('、'))
  await drain()

  assert.equal(count, 50)
  namiso.close()
})
