import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider, ExtractionResult, KnownEntity } from '../src/index.ts'

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

test('extraction includes user and assistant messages by default', async () => {
  const counter = { calls: 0 }
  const { namiso, say, drain } = await setup({ extraction: countingProvider(counter) })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 2)
  assert.ok(namiso.getEntityDetails(AI) !== null)
  namiso.close()
})

test('extractRoles can restrict extraction to user messages', async () => {
  const counter = { calls: 0 }
  const { namiso, say, drain } = await setup({
    extraction: countingProvider(counter),
    extractRoles: ['user'],
  })

  await say(USER, 'user', '用户消息。')
  await say(AI, 'assistant', '助手消息。')
  await drain()

  assert.equal(counter.calls, 1)
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

  assert.deepEqual(
    (seen[0] ?? []).map((entity) => entity.name),
    ['Alpha'],
  )
  const names = (seen.at(-1) ?? []).map((entity) => entity.name).toSorted()
  assert.deepEqual(names, ['Alpha', 'Beta'])
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
