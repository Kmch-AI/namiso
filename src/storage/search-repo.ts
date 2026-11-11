import type { DocumentId, MemorySourceType, MemorySpaceId } from '../types.ts'
import type { Database } from './database.ts'

import { asDocumentId, asMemorySpaceId } from '../ids.ts'
import { hashText, toFtsQuery, toIndexText, toNgramQuery, toNgramText } from '../text.ts'
import { count, oneOf, readNumber, text } from './database.ts'
import { blobToVector } from './vector-store.ts'

const SOURCE_TYPES = ['chunk', 'entity', 'claim', 'event'] as const

export interface EmbeddingDocument {
  id: DocumentId
  memorySpaceId: MemorySpaceId
  sourceType: MemorySourceType
  sourceId: string
  content: string
  contentHash: string
  modelName: string
  modelVersion: string
  dimensions: number
  vector: number[] | null
  createdAt: number
  updatedAt: number
}

function mapDocument(row: Record<string, unknown>): EmbeddingDocument {
  return {
    id: asDocumentId(text(row, 'id')),
    memorySpaceId: asMemorySpaceId(text(row, 'memory_space_id')),
    sourceType: oneOf(row, 'source_type', SOURCE_TYPES),
    sourceId: text(row, 'source_id'),
    content: text(row, 'content'),
    contentHash: text(row, 'content_hash'),
    modelName: text(row, 'model_name'),
    modelVersion: text(row, 'model_version'),
    dimensions: readNumber(row, 'dimensions'),
    vector: blobToVector(row['vector']),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

export interface UpsertDocumentInput {
  spaceId: MemorySpaceId
  sourceType: MemorySourceType
  sourceId: string
  content: string
  modelName: string
  modelVersion: string
  dimensions: number
  now: number
}

export interface UpsertDocumentResult {
  document: EmbeddingDocument
  needsEmbedding: boolean
  removedIds: DocumentId[]
}

export function upsertDocument(db: Database, input: UpsertDocumentInput): UpsertDocumentResult {
  const contentHash = hashText(input.content)
  const removedIds = db
    .all(
      `SELECT id FROM embedding_documents
       WHERE source_type = ? AND source_id = ? AND model_name <> ?`,
      input.sourceType,
      input.sourceId,
      input.modelName,
    )
    .map((row) => asDocumentId(text(row, 'id')))
  for (const id of removedIds) {
    deleteFtsDocument(db, id)
  }
  db.run(
    `DELETE FROM embedding_documents
     WHERE source_type = ? AND source_id = ? AND model_name <> ?`,
    input.sourceType,
    input.sourceId,
    input.modelName,
  )
  const existingRow = db.get(
    `SELECT * FROM embedding_documents
     WHERE source_type = ? AND source_id = ? AND model_name = ?`,
    input.sourceType,
    input.sourceId,
    input.modelName,
  )
  if (existingRow !== undefined) {
    const existing = mapDocument(existingRow)
    const upToDate =
      existing.contentHash === contentHash &&
      existing.modelVersion === input.modelVersion &&
      existing.dimensions === input.dimensions &&
      existing.vector !== null
    if (upToDate) {
      return { document: existing, needsEmbedding: false, removedIds }
    }
    db.run(
      `UPDATE embedding_documents
       SET content = ?, content_hash = ?, model_version = ?, dimensions = ?,
           vector = NULL, updated_at = ?
       WHERE id = ?`,
      input.content,
      contentHash,
      input.modelVersion,
      input.dimensions,
      input.now,
      existing.id,
    )
    deleteFtsDocument(db, existing.id)
    return {
      document: {
        ...existing,
        content: input.content,
        contentHash,
        modelVersion: input.modelVersion,
        dimensions: input.dimensions,
        vector: null,
        updatedAt: input.now,
      },
      needsEmbedding: true,
      removedIds,
    }
  }
  const id = asDocumentId(crypto.randomUUID())
  db.run(
    `INSERT INTO embedding_documents (
      id, memory_space_id, source_type, source_id, content, content_hash,
      model_name, model_version, dimensions, vector, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    id,
    input.spaceId,
    input.sourceType,
    input.sourceId,
    input.content,
    contentHash,
    input.modelName,
    input.modelVersion,
    input.dimensions,
    input.now,
    input.now,
  )
  return {
    document: {
      id,
      memorySpaceId: input.spaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      content: input.content,
      contentHash,
      modelName: input.modelName,
      modelVersion: input.modelVersion,
      dimensions: input.dimensions,
      vector: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    needsEmbedding: true,
    removedIds,
  }
}

export function setDocumentVector(
  db: Database,
  documentId: DocumentId,
  contentHash: string,
  vector: readonly number[],
): boolean {
  const changed = db.run(
    `UPDATE embedding_documents SET vector = ?, updated_at = ?
     WHERE id = ? AND content_hash = ? AND vector IS NULL`,
    new Uint8Array(new Float32Array(vector).buffer),
    Math.floor(Date.now() / 1000),
    documentId,
    contentHash,
  )
  return changed === 1
}

export function getDocument(db: Database, documentId: DocumentId): EmbeddingDocument | null {
  const row = db.get('SELECT * FROM embedding_documents WHERE id = ?', documentId)
  return row === undefined ? null : mapDocument(row)
}

export function findDocument(
  db: Database,
  sourceType: MemorySourceType,
  sourceId: string,
  modelName: string,
): EmbeddingDocument | null {
  const row = db.get(
    `SELECT * FROM embedding_documents
     WHERE source_type = ? AND source_id = ? AND model_name = ?`,
    sourceType,
    sourceId,
    modelName,
  )
  return row === undefined ? null : mapDocument(row)
}

export function listDocuments(
  db: Database,
  spaceId: MemorySpaceId,
  sourceType?: MemorySourceType,
): EmbeddingDocument[] {
  const rows =
    sourceType === undefined
      ? db.all(
          'SELECT * FROM embedding_documents WHERE memory_space_id = ? ORDER BY created_at ASC',
          spaceId,
        )
      : db.all(
          `SELECT * FROM embedding_documents
           WHERE memory_space_id = ? AND source_type = ? ORDER BY created_at ASC`,
          spaceId,
          sourceType,
        )
  return rows.map(mapDocument)
}

export function removeDocument(
  db: Database,
  sourceType: MemorySourceType,
  sourceId: string,
): DocumentId[] {
  const rows = db.all(
    'SELECT id FROM embedding_documents WHERE source_type = ? AND source_id = ?',
    sourceType,
    sourceId,
  )
  const ids = rows.map((row) => asDocumentId(text(row, 'id')))
  for (const id of ids) {
    deleteFtsDocument(db, id)
  }
  db.run(
    'DELETE FROM embedding_documents WHERE source_type = ? AND source_id = ?',
    sourceType,
    sourceId,
  )
  return ids
}

export function indexDocument(db: Database, document: EmbeddingDocument): void {
  deleteFtsDocument(db, document.id)
  db.run(
    `INSERT INTO fts_documents (document_key, memory_space_id, kind, source_id, text)
     VALUES (?, ?, ?, ?, ?)`,
    document.id,
    document.memorySpaceId,
    document.sourceType,
    document.sourceId,
    toIndexText(document.content),
  )
  recordFtsKey(db, 'fts_documents', document.id)
  db.run(
    `INSERT INTO fts_ngrams (document_key, memory_space_id, kind, source_id, text)
     VALUES (?, ?, ?, ?, ?)`,
    document.id,
    document.memorySpaceId,
    document.sourceType,
    document.sourceId,
    toNgramText(document.content),
  )
  recordFtsKey(db, 'fts_ngrams', document.id)
}

function recordFtsKey(
  db: Database,
  table: 'fts_documents' | 'fts_ngrams',
  documentId: DocumentId,
): void {
  const row = db.get('SELECT last_insert_rowid() AS row_key')
  if (row === undefined) return
  db.run(
    `INSERT INTO fts_keys (table_name, document_key, row_key) VALUES (?, ?, ?)
     ON CONFLICT(table_name, document_key) DO UPDATE SET row_key = excluded.row_key`,
    table,
    documentId,
    readNumber(row, 'row_key'),
  )
}

export function deleteFtsDocument(db: Database, documentId: DocumentId): void {
  for (const table of ['fts_documents', 'fts_ngrams'] as const) {
    const row = db.get(
      'SELECT row_key FROM fts_keys WHERE table_name = ? AND document_key = ?',
      table,
      documentId,
    )
    if (row === undefined) {
      db.run(`DELETE FROM ${table} WHERE document_key = ?`, documentId)
    } else {
      const changed = db.run(`DELETE FROM ${table} WHERE rowid = ?`, readNumber(row, 'row_key'))
      if (changed === 0) db.run(`DELETE FROM ${table} WHERE document_key = ?`, documentId)
      db.run('DELETE FROM fts_keys WHERE table_name = ? AND document_key = ?', table, documentId)
    }
  }
}

export function clearFts(db: Database, spaceId: MemorySpaceId): void {
  db.run('DELETE FROM fts_documents WHERE memory_space_id = ?', spaceId)
  db.run('DELETE FROM fts_ngrams WHERE memory_space_id = ?', spaceId)
  db.run(
    `DELETE FROM fts_keys
     WHERE table_name = 'fts_documents'
       AND document_key NOT IN (SELECT document_key FROM fts_documents)`,
  )
  db.run(
    `DELETE FROM fts_keys
     WHERE table_name = 'fts_ngrams'
       AND document_key NOT IN (SELECT document_key FROM fts_ngrams)`,
  )
}

export interface FtsHit {
  documentId: DocumentId
  sourceId: string
  kind: MemorySourceType
  score: number
}

export function searchFts(
  db: Database,
  spaceId: MemorySpaceId,
  query: string,
  limit: number,
  kinds?: readonly MemorySourceType[],
): FtsHit[] {
  return searchFtsTable(db, 'fts_documents', toFtsQuery(query), spaceId, limit, kinds)
}

export function searchFtsNgrams(
  db: Database,
  spaceId: MemorySpaceId,
  query: string,
  limit: number,
  kinds?: readonly MemorySourceType[],
): FtsHit[] {
  return searchFtsTable(db, 'fts_ngrams', toNgramQuery(query), spaceId, limit, kinds)
}

function searchFtsTable(
  db: Database,
  table: 'fts_documents' | 'fts_ngrams',
  ftsQuery: string,
  spaceId: MemorySpaceId,
  limit: number,
  kinds: readonly MemorySourceType[] | undefined,
): FtsHit[] {
  if (ftsQuery.length === 0) return []
  if (kinds?.length === 0) return []
  const kindClause = kinds === undefined ? '' : ` AND kind IN (${kinds.map(() => '?').join(', ')})`
  return db
    .all(
      `SELECT document_key, source_id, kind, bm25(${table}) AS rank
       FROM ${table}
       WHERE ${table} MATCH ? AND memory_space_id = ?${kindClause}
       ORDER BY rank ASC LIMIT ?`,
      ftsQuery,
      spaceId,
      ...(kinds ?? []),
      limit,
    )
    .map((row) => ({
      documentId: asDocumentId(text(row, 'document_key')),
      sourceId: text(row, 'source_id'),
      kind: oneOf(row, 'kind', SOURCE_TYPES),
      score: -Number(row['rank']),
    }))
}

export function documentCount(db: Database, spaceId: MemorySpaceId): number {
  return count(
    db.get('SELECT COUNT(*) AS n FROM embedding_documents WHERE memory_space_id = ?', spaceId),
    'n',
  )
}

export function missingVectorCount(db: Database, spaceId: MemorySpaceId): number {
  return count(
    db.get(
      `SELECT COUNT(*) AS n FROM embedding_documents
       WHERE memory_space_id = ? AND vector IS NULL`,
      spaceId,
    ),
    'n',
  )
}

export function listMissingVectors(
  db: Database,
  spaceId: MemorySpaceId,
  limit: number,
): EmbeddingDocument[] {
  return db
    .all(
      `SELECT * FROM embedding_documents
       WHERE memory_space_id = ? AND vector IS NULL
       ORDER BY created_at ASC LIMIT ?`,
      spaceId,
      limit,
    )
    .map(mapDocument)
}
