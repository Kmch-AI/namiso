import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { Database, readNumber } from '../src/storage/database.ts'

test('schema migration backfills consolidation state from completed annotate jobs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'namiso-migration-'))
  const databasePath = join(directory, 'memory.db')
  let db: Database | undefined
  try {
    db = new Database(databasePath)
    db.run(
      'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)',
      'workspace',
      'workspace',
      1,
    )
    db.run(
      `INSERT INTO memory_spaces (id, workspace_id, name, created_at)
       VALUES (?, ?, ?, ?)`,
      'space',
      'workspace',
      'space',
      1,
    )
    db.run(
      `INSERT INTO conversations (id, memory_space_id, started_at)
       VALUES (?, ?, ?)`,
      'conversation',
      'space',
      1,
    )
    db.run(
      `INSERT INTO messages (
        id, memory_space_id, conversation_id, speaker_id, role, content,
        message_index, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'message-1',
      'space',
      'conversation',
      'user',
      'user',
      '已整理的消息',
      0,
      1,
      1,
    )
    db.run(
      `INSERT INTO messages (
        id, memory_space_id, conversation_id, speaker_id, role, content,
        message_index, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'message-2',
      'space',
      'conversation',
      'user',
      'user',
      '未整理的消息',
      1,
      2,
      2,
    )
    db.run(
      `INSERT INTO jobs (
        id, memory_space_id, type, dedupe_key, payload, status, attempts,
        max_attempts, run_after, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'job:annotate:message-1',
      'space',
      'annotate',
      'annotate:message-1',
      '{"messageId":"message-1"}',
      'completed',
      1,
      3,
      1,
      1,
      1,
    )
    db.exec('DROP INDEX IF EXISTS idx_messages_consolidated')
    db.exec('ALTER TABLE messages DROP COLUMN consolidated_at')
    db.exec('PRAGMA user_version = 3')
    db.close()
    db = undefined

    db = new Database(databasePath)
    const rows = db.all('SELECT id, consolidated_at FROM messages ORDER BY message_index')
    assert.deepEqual(
      rows.map((row) => [row['id'], row['consolidated_at']]),
      [
        ['message-1', 1],
        ['message-2', null],
      ],
    )
    assert.equal(db.get("SELECT COUNT(*) AS n FROM jobs WHERE type = 'annotate'")?.['n'], 0)
    assert.equal(readNumber(db.get('PRAGMA user_version'), 'user_version'), 4)
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('schema migration maps legacy entity types', () => {
  const directory = mkdtempSync(join(tmpdir(), 'namiso-migration-'))
  const databasePath = join(directory, 'memory.db')
  let db: Database | undefined
  try {
    db = new Database(databasePath)
    db.run(
      'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)',
      'workspace',
      'workspace',
      1,
    )
    db.run(
      `INSERT INTO memory_spaces (id, workspace_id, name, created_at)
       VALUES (?, ?, ?, ?)`,
      'space',
      'workspace',
      'space',
      1,
    )
    for (const [id, type] of [
      ['entity-1', 'organization'],
      ['entity-2', 'project'],
      ['entity-3', 'product'],
      ['entity-4', 'place'],
    ] as const) {
      db.run(
        `INSERT INTO entities (id, memory_space_id, type, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        'space',
        type,
        id,
        1,
        1,
      )
    }
    db.run(
      `INSERT INTO entities (id, memory_space_id, type, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'entity-5',
      'space',
      'ai',
      'entity-5',
      1,
      1,
    )
    db.run(
      `INSERT INTO entities (id, memory_space_id, type, name, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'entity-6',
      'space',
      'ai',
      'entity-6',
      1,
      1,
      '{"self":true}',
    )
    db.exec('PRAGMA user_version = 1')
    db.close()
    db = undefined

    db = new Database(databasePath)
    const types = db.all('SELECT type FROM entities ORDER BY id').map((row) => row['type'])
    assert.deepEqual(types, ['group', 'artifact', 'artifact', 'place', 'artifact', 'self'])
    assert.equal(readNumber(db.get('PRAGMA user_version'), 'user_version'), 4)
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
