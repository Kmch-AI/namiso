import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExtractionProvider } from '../src/index.ts'

import { USER, setup } from './helpers.ts'

test('self is canonical and other self entities are stored as artifacts', async () => {
  const extraction: ExtractionProvider = {
    version: 'test-self',
    async extract(input) {
      return {
        entities: [
          {
            name: 'GPT-5',
            type: 'self',
            evidenceMessageIds: [input.focusMessageId],
          },
        ],
        claims: [
          {
            subject: { name: '四时小路', type: 'person' },
            predicate: 'personality',
            object: { kind: 'literal', value: '温和' },
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageId],
          },
        ],
        events: [
          {
            type: 'conversation',
            summary: '用户和助手聊天',
            participants: [
              { name: '用户A', type: 'person', role: 'actor' },
              { name: '四时小路', type: 'person', role: 'participant' },
            ],
            modality: 'asserted',
            confidence: 0.9,
            evidenceMessageIds: [input.focusMessageId],
          },
        ],
      }
    },
  }
  const { namiso, say, drain } = await setup({
    self: { name: '四时小路', aliases: ['小路'], description: '常驻助手' },
    extraction,
  })
  const self = namiso.getEntityDetails('四时小路')
  assert.ok(self !== null)
  assert.equal(self.entity.type, 'self')
  assert.equal(self.entity.metadata?.['self'], true)

  await say('assistant-1', 'assistant', '我是四时小路。')
  await drain()

  const speaker = namiso.getEntityDetails('assistant-1')
  assert.ok(speaker !== null)
  assert.equal(speaker.entity.id, self.entity.id)

  const model = namiso.getEntityDetails('GPT-5')
  assert.ok(model !== null)
  assert.equal(model.entity.type, 'artifact')
  assert.notEqual(model.entity.id, self.entity.id)

  const persona = namiso.getEntityDetails('四时小路')
  assert.ok(persona !== null)
  assert.ok(persona.claims.some((claim) => claim.predicate === 'personality'))

  const timeline = namiso.timeline({ entityName: '四时小路' })
  assert.equal(timeline.length, 1)
  assert.ok(
    timeline[0]?.participants.some(
      (participant) =>
        participant.entity.id === self.entity.id && participant.entity.type === 'self',
    ),
  )
  namiso.close()
})

test('ensureSelf updates identity without creating another entity', async () => {
  const { namiso } = await setup({ self: { name: '四时小路', description: '旧人设' } })
  const before = namiso.getEntityDetails('四时小路')
  assert.ok(before !== null)

  const updated = await namiso.ensureSelf({
    name: '小路',
    aliases: ['小助'],
    description: '新人设',
  })
  assert.equal(updated.id, before.entity.id)
  assert.equal(updated.name, '小路')
  assert.equal(updated.description, '新人设')
  assert.equal(namiso.getEntityDetails('四时小路')?.entity.id, before.entity.id)
  assert.equal(namiso.getEntityDetails('小助')?.entity.id, before.entity.id)
  namiso.close()
})

test('second-person queries retrieve the self entity and its persona', async () => {
  const { namiso, say, drain } = await setup({
    self: { name: '四时小路', description: '性格温和，喜欢帮助人。' },
  })
  await say(USER, 'user', '你好。')
  await drain()

  const context = await namiso.getContext({ query: '你的性格是什么？' })
  assert.match(context.text, /四时小路/)
  assert.match(context.text, /性格温和/)
  namiso.close()
})
