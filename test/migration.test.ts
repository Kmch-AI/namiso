import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { Database, readNumber } from '../src/storage/database.ts'

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
    assert.equal(readNumber(db.get('PRAGMA user_version'), 'user_version'), 3)
  } finally {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
