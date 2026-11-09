import assert from 'node:assert/strict'
import { test } from 'vitest'

import { asMemorySpaceId } from '../src/ids.ts'
import { Database } from '../src/storage/database.ts'
import {
  findDocument,
  indexDocument,
  searchFts,
  upsertDocument,
} from '../src/storage/search-repo.ts'

test('changing the embedding model removes the previous FTS rows', () => {
  const db = new Database(':memory:')
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
  const spaceId = asMemorySpaceId('space')
  const base = {
    spaceId,
    sourceType: 'entity' as const,
    sourceId: 'entity-1',
    modelVersion: '1',
    dimensions: 8,
    now: 1,
  }
  const first = upsertDocument(db, { ...base, content: '描述：杭州西湖', modelName: 'model-a' })
  indexDocument(db, first.document)
  assert.ok(searchFts(db, spaceId, '杭州西湖', 10).length > 0)

  const second = upsertDocument(db, {
    ...base,
    content: '描述：苏州园林',
    modelName: 'model-b',
  })
  assert.deepEqual(second.removedIds, [first.document.id])
  indexDocument(db, second.document)
  assert.equal(searchFts(db, spaceId, '杭州西湖', 10).length, 0)
  assert.ok(searchFts(db, spaceId, '苏州园林', 10).length > 0)
  assert.equal(findDocument(db, 'entity', 'entity-1', 'model-a'), null)
  assert.equal(findDocument(db, 'entity', 'entity-1', 'model-b')?.id, second.document.id)
  db.close()
})
