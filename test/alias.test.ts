import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider } from '../src/index.ts'

import { USER, setup } from './helpers.ts'

test('an alias owned by another entity is not attached', async () => {
  const extraction: ExtractionProvider = {
    version: 'alias-collision',
    async extract(input) {
      const id = input.focusMessageIds[0]
      return {
        entities: [
          { name: '阿禾', type: 'person', evidenceMessageIds: [id] },
          { name: '阿木', type: 'person', aliases: ['阿禾'], evidenceMessageIds: [id] },
        ],
        claims: [],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '阿禾和阿木都来了。')
  await drain()

  const other = namiso.getEntityDetails('阿木')
  assert.ok(other !== null)
  assert.equal(other.aliases.includes('阿禾'), false)
  namiso.close()
})
