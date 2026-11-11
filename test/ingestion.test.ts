import assert from 'node:assert/strict'
import { test } from 'vitest'

import { asMemorySpaceId } from '../src/ids.ts'
import { Namiso } from '../src/index.ts'
import { Database } from '../src/storage/database.ts'
import { claimNextJob, enqueueChunk, pendingJobCount } from '../src/storage/job-repo.ts'
import { AI, USER, setup } from './helpers.ts'

test('ingest stores raw messages in order and deduplicates external ids', async () => {
  const { namiso, conversation, say, drain } = await setup()
  await say(USER, 'user', '第一句话。')
  await say(AI, 'assistant', '第二句话。')
  const duplicate = await namiso.ingest({
    conversationId: conversation.id,
    externalMessageId: 'external-1',
    speakerId: USER,
    role: 'user',
    content: '带外部 ID 的消息。',
    occurredAt: 1_790_000_500,
  })
  const repeated = await namiso.ingest({
    conversationId: conversation.id,
    externalMessageId: 'external-1',
    speakerId: USER,
    role: 'user',
    content: '重复内容不应写入。',
    occurredAt: 1_790_000_600,
  })
  assert.equal(repeated.messageId, duplicate.messageId)

  const messages = namiso.getMessages({ conversationId: conversation.id })
  assert.equal(messages.length, 3)
  assert.deepEqual(
    messages.map((message) => message.content),
    ['第一句话。', '第二句话。', '带外部 ID 的消息。'],
  )
  assert.deepEqual(
    messages.map((message) => message.messageIndex),
    [0, 1, 2],
  )

  await drain()
  const health = namiso.health()
  assert.equal(health.counts.messages, 3)
  assert.equal(health.counts.chunks, 1)
  assert.ok(health.counts.documents >= 1)
  namiso.close()
})

test('drain is idempotent and retrying completed work adds no duplicates', async () => {
  const { namiso, say, drain } = await setup()
  await say(USER, 'user', '我喜欢在雨天读书。')
  await drain()
  const first = namiso.health()
  await drain()
  const second = namiso.health()
  assert.deepEqual(second.counts, first.counts)

  const entity = namiso.getEntityDetails(USER)
  assert.ok(entity !== null)
  assert.equal(entity.claims.filter((claim) => claim.predicate === 'likes').length, 1)
  namiso.close()
})

test('multiple memory spaces stay isolated', async () => {
  const first = await setup({ memorySpace: { name: 'space-a' } })
  const second = await Namiso.open({
    databasePath: ':memory:',
    vectorIndex: 'exact',
    memorySpace: { name: 'space-b' },
  })
  await first.say(USER, 'user', '我只属于空间 A。')
  await first.drain()
  const otherConversation = second.createConversation()
  await second.ingest({
    conversationId: otherConversation.id,
    speakerId: USER,
    role: 'user',
    content: '我只属于空间 B。',
    occurredAt: 1_790_000_000,
  })
  await second.drain()
  assert.equal(second.getMessages().length, 1)
  assert.equal(second.getMessages()[0]?.content, '我只属于空间 B。')
  assert.equal(second.getConversation(first.conversation.id), null)
  first.namiso.close()
  second.close()
})

test('job claims and requeues stay inside one memory space', () => {
  const db = new Database(':memory:')
  try {
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', 'workspace', 'w', 1)
    db.run(
      'INSERT INTO memory_spaces (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)',
      'space-a',
      'workspace',
      'a',
      1,
    )
    db.run(
      'INSERT INTO memory_spaces (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)',
      'space-b',
      'workspace',
      'b',
      1,
    )
    const first = asMemorySpaceId('space-a')
    const second = asMemorySpaceId('space-b')
    enqueueChunk(db, first, 'conversation-a')
    enqueueChunk(db, second, 'conversation-b')

    const now = Math.floor(Date.now() / 1000)
    const claimed = claimNextJob(db, first, now)
    assert.equal(claimed?.memorySpaceId, first)

    enqueueChunk(db, first, 'conversation-a')
    assert.equal(pendingJobCount(db, first), 1)
    assert.equal(pendingJobCount(db, second), 1)
    const reclaimed = claimNextJob(db, first, now)
    assert.equal(reclaimed?.id, claimed?.id)
    assert.equal(reclaimed?.status, 'running')
  } finally {
    db.close()
  }
})
