import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractedClaim, ExtractionProvider, MessageId } from '../src/index.ts'

import { AI, USER, setup } from './helpers.ts'

function nameClaim(
  subject: string,
  predicate: string,
  value: string,
  evidence: MessageId,
): ExtractedClaim {
  return {
    subject: { name: subject, type: 'person' as const },
    predicate,
    attribute: predicate,
    cardinality: 'one' as const,
    change: 'new' as const,
    object: { kind: 'literal' as const, value },
    modality: 'asserted' as const,
    confidence: 0.9,
    evidenceMessageIds: [evidence],
  }
}

test('a self-given name becomes an alias of the speaker entity', async () => {
  const extraction: ExtractionProvider = {
    version: 'identity-test',
    async extract(input) {
      const messages = new Map(input.messages.map((message) => [message.id, message]))
      const claims: ExtractedClaim[] = []
      for (const id of input.focusMessageIds) {
        const content = messages.get(id)?.content ?? ''
        if (content.includes('我叫')) {
          claims.push(nameClaim('阿渡', '姓名', '阿渡（渡口的渡）', id))
        } else if (content.includes('叫你')) {
          claims.push(nameClaim(AI, '称呼', '阿渡', id))
        } else {
          claims.push(nameClaim('阿渡', '职业', '写悬疑小说', id))
        }
      }
      return { entities: [], claims, events: [] }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '我叫阿渡，渡口的渡。')
  await say(USER, 'user', '我平时写悬疑小说。')
  await say(AI, 'assistant', '以后叫你阿渡。')
  await drain()

  const user = namiso.getEntityDetails(USER)
  assert.ok(user !== null)
  assert.ok(user.aliases.includes('阿渡'))
  const subjectIds = new Set(user.claims.map((claim) => claim.subjectId))
  assert.equal(subjectIds.size, 1)
  assert.ok(user.claims.some((claim) => claim.predicate === '职业'))
  assert.equal(namiso.getEntityDetails('阿渡')?.entity.id, user.entity.id)

  const assistant = namiso.getEntityDetails(AI)
  assert.ok(assistant !== null)
  assert.equal(assistant.aliases.includes('阿渡'), false)
  namiso.close()
})

test('a private name claim does not become an alias', async () => {
  const extraction: ExtractionProvider = {
    version: 'identity-private',
    async extract(input) {
      const id = input.focusMessageIds[0]
      return {
        entities: [],
        claims: [
          {
            ...nameClaim('阿渡', '姓名', '阿渡', id),
            sensitivity: 'private' as const,
            disclosure: 'do_not_volunteer' as const,
          },
          nameClaim('阿渡', '职业', '写悬疑小说', id),
        ],
        events: [],
      }
    },
  }
  const { namiso, say, drain } = await setup({ extraction })
  await say(USER, 'user', '我叫阿渡，这事别往外说。')
  await drain()

  const user = namiso.getEntityDetails(USER)
  assert.ok(user !== null)
  assert.equal(user.aliases.includes('阿渡'), false)
  namiso.close()
})
