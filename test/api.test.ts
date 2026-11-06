import assert from 'node:assert/strict'
import { test } from 'vitest'

import { Namiso, NotFoundError, ValidationError } from '../src/index.ts'
import { setup } from './helpers.ts'

test('invalid options fail at the boundary', async () => {
  await assert.rejects(
    Namiso.open({ databasePath: '' }),
    (error: unknown) => error instanceof ValidationError,
  )
  await assert.rejects(
    Namiso.open({
      databasePath: ':memory:',
      chunking: { size: 4, overlap: 4 },
    }),
    (error: unknown) => error instanceof ValidationError,
  )
})

test('ingesting into an unknown conversation throws NotFoundError', async () => {
  const { namiso } = await setup()
  await assert.rejects(
    namiso.ingest({
      conversationId: 'missing',
      speakerId: '用户A',
      role: 'user',
      content: 'hello',
    }),
    (error: unknown) => error instanceof NotFoundError,
  )
  namiso.close()
})

test('aliases resolve to one entity and manual links survive', async () => {
  const { namiso } = await setup()
  const entity = await namiso.ensureEntity({
    name: '四时小路',
    type: 'ai',
    aliases: ['小路', 'Komichi'],
    description: '常驻 AI 角色',
  })
  const byAlias = await namiso.ensureEntity({ name: 'Komichi', type: 'ai' })
  assert.equal(byAlias.id, entity.id)
  const details = namiso.getEntityDetails('小路')
  assert.ok(details !== null)
  assert.equal(details.entity.id, entity.id)
  assert.ok(details.aliases.includes('Komichi'))

  const other = await namiso.ensureEntity({ name: '用户A', type: 'person' })
  assert.throws(
    () =>
      namiso.link({
        sourceType: 'entity',
        sourceId: entity.id,
        relation: 'related_to',
        targetType: 'entity',
        targetId: 'missing',
      }),
    (error: unknown) => error instanceof NotFoundError,
  )
  namiso.link({
    sourceType: 'entity',
    sourceId: entity.id,
    relation: 'related_to',
    targetType: 'entity',
    targetId: other.id,
  })
  namiso.close()
})

test('reindex rebuilds every derived index', async () => {
  const { namiso, say, drain } = await setup()
  const modelName = 'IndexTTS2'
  await say('用户A', 'user', `我在使用 ${modelName}。`)
  await drain()
  const before = await namiso.retrieve({ query: '我在使用什么？', rerank: false })
  assert.ok(before.candidates.length > 0)
  const report = await namiso.reindex()
  assert.ok(report.documents >= 3)
  const health = namiso.health()
  assert.equal(health.counts.missingVectors, 0)
  assert.equal(health.counts.chunks, 1)
  const after = await namiso.retrieve({ query: '我在使用什么？', rerank: false })
  assert.ok(after.candidates.length > 0)
  namiso.close()
})

test('queries are validated before retrieval', async () => {
  const { namiso } = await setup()
  await assert.rejects(
    namiso.retrieve({ query: '   ' }),
    (error: unknown) => error instanceof ValidationError,
  )
  await assert.rejects(
    namiso.retrieve({
      query: 'what happened',
      timeRange: { from: 100, to: 50 },
    }),
    (error: unknown) => error instanceof ValidationError,
  )
  namiso.close()
})

test('closed instances reject further work', async () => {
  const { namiso } = await setup()
  namiso.close()
  assert.throws(
    () => namiso.getMessages(),
    (error: unknown) => error instanceof ValidationError,
  )
})
