import type { ClaimCardinality, MemorySpaceId } from '../types.ts'
import type { Database, Row } from './database.ts'

import { nowSeconds } from '../ids.ts'
import { oneOf, text } from './database.ts'

export interface AttributeRecord {
  key: string
  label: string
  cardinality: ClaimCardinality
}

export interface EnsureAttributeInput {
  key: string
  label: string
  cardinality: ClaimCardinality
}

export function ensureAttribute(
  db: Database,
  spaceId: MemorySpaceId,
  input: EnsureAttributeInput,
): AttributeRecord {
  const existing = db.get(
    'SELECT * FROM attributes WHERE memory_space_id = ? AND key = ?',
    spaceId,
    input.key,
  )
  if (existing !== undefined) return mapAttribute(existing)
  const timestamp = nowSeconds()
  db.run(
    `INSERT INTO attributes (memory_space_id, key, label, cardinality, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    spaceId,
    input.key,
    input.label,
    input.cardinality,
    timestamp,
    timestamp,
  )
  return { key: input.key, label: input.label, cardinality: input.cardinality }
}

export function listAttributes(
  db: Database,
  spaceId: MemorySpaceId,
  limit = 200,
): AttributeRecord[] {
  return db
    .all(
      `SELECT * FROM attributes WHERE memory_space_id = ?
       ORDER BY updated_at DESC, key ASC LIMIT ?`,
      spaceId,
      limit,
    )
    .map(mapAttribute)
}

function mapAttribute(row: Row): AttributeRecord {
  return {
    key: text(row, 'key'),
    label: text(row, 'label'),
    cardinality: oneOf(row, 'cardinality', ['one', 'many'] as const),
  }
}
