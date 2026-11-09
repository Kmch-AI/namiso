import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

import { NamisoError } from '../errors.ts'
import {
  CLAIM_ATTRIBUTE_BACKFILL_SQL,
  CLAIM_ATTRIBUTE_COLUMN_SQL,
  CLAIM_ATTRIBUTE_INDEX_SQL,
  CLAIM_CARDINALITY_COLUMN_SQL,
  CLAIM_MODALITY_COLUMN_SQL,
  CLAIM_POLARITY_COLUMN_SQL,
  ENTITY_TYPE_MIGRATION_SQL,
  EVENT_MODALITY_COLUMN_SQL,
  MESSAGE_CONSOLIDATION_INDEX_SQL,
  MESSAGE_CONSOLIDATION_MIGRATION_SQL,
  MODALITY_BACKFILL_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  SELF_TYPE_MIGRATION_SQL,
} from './schema.ts'

export type Row = Record<string, unknown>
export type SqlParam = string | number | bigint | null | Uint8Array

export class Database {
  readonly raw: DatabaseSync
  private transactionDepth = 0
  private vectorExtensionLoaded = false

  constructor(path: string) {
    this.raw = new DatabaseSync(path, { allowExtension: true })
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL')
    }
    this.migrate()
  }

  private migrate(): void {
    const row = this.raw.prepare('PRAGMA user_version').get()
    const version = readNumber(row, 'user_version')
    if (version > SCHEMA_VERSION) {
      throw new NamisoError(
        'schema',
        `database schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      )
    }
    this.raw.exec(SCHEMA_SQL)
    if (version < 2) {
      this.raw.exec(ENTITY_TYPE_MIGRATION_SQL)
    }
    if (version < 3) {
      this.raw.exec(SELF_TYPE_MIGRATION_SQL)
    }
    if (version < 4 && !this.hasColumn('messages', 'consolidated_at')) {
      this.raw.exec(MESSAGE_CONSOLIDATION_MIGRATION_SQL)
    }
    this.raw.exec(MESSAGE_CONSOLIDATION_INDEX_SQL)
    if (version < 5) {
      if (!this.hasColumn('claims', 'attribute')) {
        this.raw.exec(CLAIM_ATTRIBUTE_COLUMN_SQL)
      }
      if (!this.hasColumn('claims', 'cardinality')) {
        this.raw.exec(CLAIM_CARDINALITY_COLUMN_SQL)
      }
      this.raw.exec(CLAIM_ATTRIBUTE_BACKFILL_SQL)
    }
    if (version < 6) {
      if (!this.hasColumn('claims', 'modality')) {
        this.raw.exec(CLAIM_MODALITY_COLUMN_SQL)
      }
      if (!this.hasColumn('claims', 'polarity')) {
        this.raw.exec(CLAIM_POLARITY_COLUMN_SQL)
      }
      if (!this.hasColumn('events', 'modality')) {
        this.raw.exec(EVENT_MODALITY_COLUMN_SQL)
      }
      this.raw.exec(MODALITY_BACKFILL_SQL)
    }
    this.raw.exec(CLAIM_ATTRIBUTE_INDEX_SQL)
    if (version < SCHEMA_VERSION) {
      this.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.raw
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => text(row, 'name') === column)
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  run(sql: string, ...params: SqlParam[]): number {
    const result = this.raw.prepare(sql).run(...params)
    return Number(result.changes)
  }

  get(sql: string, ...params: SqlParam[]): Row | undefined {
    return this.raw.prepare(sql).get(...params)
  }

  all(sql: string, ...params: SqlParam[]): Row[] {
    return this.raw.prepare(sql).all(...params)
  }

  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      return work()
    }
    this.raw.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = work()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  loadVectorExtension(): boolean {
    if (this.vectorExtensionLoaded) return true
    try {
      const path = getVectorExtensionPath()
      this.raw.loadExtension(path)
      this.vectorExtensionLoaded = true
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.raw.close()
  }
}

function getVectorExtensionPath(): string {
  const require = createRequire(import.meta.url)
  const sqliteVec = require('sqlite-vec') as {
    getLoadablePath?: () => string
  }
  if (typeof sqliteVec.getLoadablePath !== 'function') {
    throw new NamisoError('vector', 'sqlite-vec does not expose getLoadablePath')
  }
  return sqliteVec.getLoadablePath()
}

export function text(row: Row | undefined, key: string): string {
  const value = row?.[key]
  if (typeof value !== 'string') {
    throw new NamisoError('schema', `expected text column ${key}`)
  }
  return value
}

export function textOrNull(row: Row | undefined, key: string): string | null {
  const value = row?.[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new NamisoError('schema', `expected nullable text column ${key}`)
  }
  return value
}

export function oneOf<T extends string>(
  row: Row | undefined,
  key: string,
  allowed: readonly T[],
): T {
  const value = text(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new NamisoError('schema', `unexpected value for ${key}: ${value}`)
  }
  return value as T
}

export function count(row: Row | undefined, key: string): number {
  return readNumber(row, key)
}

export function readNumber(row: Row | undefined, key: string): number {
  const value = row?.[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new NamisoError('schema', `expected numeric column ${key}`)
}

export function numberOrNull(row: Row | undefined, key: string): number | null {
  const value = row?.[key]
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new NamisoError('schema', `expected nullable numeric column ${key}`)
}

export function booleanFromInteger(row: Row | undefined, key: string): boolean {
  return readNumber(row, key) !== 0
}

export function jsonOrNull(row: Row | undefined, key: string): Record<string, unknown> | null {
  const raw = textOrNull(row, key)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function jsonArrayOrNull(row: Row | undefined, key: string): string[] | null {
  const raw = textOrNull(row, key)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return null
  }
}
