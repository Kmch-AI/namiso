import { asDocumentId, asMemorySpaceId } from "../ids.ts";
import type { DocumentId, MemorySourceType, MemorySpaceId } from "../types.ts";
import { hashText, toFtsQuery, toIndexText } from "../text.ts";
import type { Database } from "./database.ts";
import { count, oneOf, readNumber, text } from "./database.ts";
import { blobToVector } from "./vector-store.ts";

const SOURCE_TYPES = ["chunk", "entity", "claim", "event"] as const;

export interface EmbeddingDocument {
  id: DocumentId;
  memorySpaceId: MemorySpaceId;
  sourceType: MemorySourceType;
  sourceId: string;
  content: string;
  contentHash: string;
  modelName: string;
  modelVersion: string;
  dimensions: number;
  vector: number[] | null;
  createdAt: number;
  updatedAt: number;
}

function mapDocument(row: Record<string, unknown>): EmbeddingDocument {
  return {
    id: asDocumentId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    sourceType: oneOf(row, "source_type", SOURCE_TYPES),
    sourceId: text(row, "source_id"),
    content: text(row, "content"),
    contentHash: text(row, "content_hash"),
    modelName: text(row, "model_name"),
    modelVersion: text(row, "model_version"),
    dimensions: readNumber(row, "dimensions"),
    vector: blobToVector(row["vector"]),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export interface UpsertDocumentInput {
  spaceId: MemorySpaceId;
  sourceType: MemorySourceType;
  sourceId: string;
  content: string;
  modelName: string;
  modelVersion: string;
  dimensions: number;
  now: number;
}

export interface UpsertDocumentResult {
  document: EmbeddingDocument;
  needsEmbedding: boolean;
}

export function upsertDocument(db: Database, input: UpsertDocumentInput): UpsertDocumentResult {
  const contentHash = hashText(input.content);
  const existingRow = db.get(
    `SELECT * FROM embedding_documents
     WHERE source_type = ? AND source_id = ? AND model_name = ?`,
    input.sourceType,
    input.sourceId,
    input.modelName,
  );
  if (existingRow !== undefined) {
    const existing = mapDocument(existingRow);
    db.run(
      `DELETE FROM embedding_documents
       WHERE source_type = ? AND source_id = ? AND model_name <> ?`,
      input.sourceType,
      input.sourceId,
      input.modelName,
    );
    const upToDate =
      existing.contentHash === contentHash &&
      existing.modelVersion === input.modelVersion &&
      existing.dimensions === input.dimensions &&
      existing.vector !== null;
    if (upToDate) {
      return { document: existing, needsEmbedding: false };
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
    );
    deleteFtsDocument(db, existing.id);
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
    };
  }
  const id = asDocumentId(crypto.randomUUID());
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
  );
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
  };
}

export function setDocumentVector(
  db: Database,
  documentId: DocumentId,
  vector: readonly number[],
): void {
  db.run(
    "UPDATE embedding_documents SET vector = ?, updated_at = ? WHERE id = ?",
    new Uint8Array(new Float32Array(vector).buffer),
    Math.floor(Date.now() / 1000),
    documentId,
  );
}

export function getDocument(db: Database, documentId: DocumentId): EmbeddingDocument | null {
  const row = db.get("SELECT * FROM embedding_documents WHERE id = ?", documentId);
  return row === undefined ? null : mapDocument(row);
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
  );
  return row === undefined ? null : mapDocument(row);
}

export function listDocuments(
  db: Database,
  spaceId: MemorySpaceId,
  sourceType?: MemorySourceType,
): EmbeddingDocument[] {
  const rows =
    sourceType === undefined
      ? db.all(
          "SELECT * FROM embedding_documents WHERE memory_space_id = ? ORDER BY created_at ASC",
          spaceId,
        )
      : db.all(
          `SELECT * FROM embedding_documents
           WHERE memory_space_id = ? AND source_type = ? ORDER BY created_at ASC`,
          spaceId,
          sourceType,
        );
  return rows.map(mapDocument);
}

export function removeDocument(
  db: Database,
  sourceType: MemorySourceType,
  sourceId: string,
): DocumentId[] {
  const rows = db.all(
    "SELECT id FROM embedding_documents WHERE source_type = ? AND source_id = ?",
    sourceType,
    sourceId,
  );
  const ids = rows.map((row) => asDocumentId(text(row, "id")));
  for (const id of ids) {
    deleteFtsDocument(db, id);
  }
  db.run(
    "DELETE FROM embedding_documents WHERE source_type = ? AND source_id = ?",
    sourceType,
    sourceId,
  );
  return ids;
}

export function indexDocument(db: Database, document: EmbeddingDocument): void {
  deleteFtsDocument(db, document.id);
  db.run(
    `INSERT INTO fts_documents (document_key, memory_space_id, kind, source_id, text)
     VALUES (?, ?, ?, ?, ?)`,
    document.id,
    document.memorySpaceId,
    document.sourceType,
    document.sourceId,
    toIndexText(document.content),
  );
}

export function deleteFtsDocument(db: Database, documentId: DocumentId): void {
  db.run("DELETE FROM fts_documents WHERE document_key = ?", documentId);
}

export interface FtsHit {
  documentId: DocumentId;
  sourceId: string;
  kind: MemorySourceType;
  score: number;
}

export function searchFts(
  db: Database,
  spaceId: MemorySpaceId,
  query: string,
  limit: number,
): FtsHit[] {
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery.length === 0) return [];
  return db
    .all(
      `SELECT document_key, source_id, kind, bm25(fts_documents) AS rank
       FROM fts_documents
       WHERE fts_documents MATCH ? AND memory_space_id = ?
       ORDER BY rank ASC LIMIT ?`,
      ftsQuery,
      spaceId,
      limit,
    )
    .map((row) => ({
      documentId: asDocumentId(text(row, "document_key")),
      sourceId: text(row, "source_id"),
      kind: oneOf(row, "kind", SOURCE_TYPES),
      score: -Number(row["rank"]),
    }));
}

export function documentCount(db: Database, spaceId: MemorySpaceId): number {
  return count(
    db.get("SELECT COUNT(*) AS n FROM embedding_documents WHERE memory_space_id = ?", spaceId),
    "n",
  );
}

export function missingVectorCount(db: Database, spaceId: MemorySpaceId): number {
  return count(
    db.get(
      `SELECT COUNT(*) AS n FROM embedding_documents
       WHERE memory_space_id = ? AND vector IS NULL`,
      spaceId,
    ),
    "n",
  );
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
    .map(mapDocument);
}
