import { NamisoError } from "../errors.ts";
import { cosineSimilarity } from "../text.ts";
import type { Database } from "./database.ts";
import { text } from "./database.ts";

export type VectorBackend = "sqlite-vec" | "exact";

export function vectorToBlob(vector: readonly number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function blobToVector(value: unknown): number[] | null {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value);
    return Array.from(new Float32Array(copy.buffer));
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }
  return null;
}

export class VectorStore {
  readonly backend: VectorBackend;
  readonly dimensions: number;
  private readonly db: Database;

  constructor(db: Database, dimensions: number, mode: "auto" | "sqlite-vec" | "exact") {
    this.db = db;
    this.dimensions = dimensions;
    const loaded = mode === "exact" ? false : db.loadVectorExtension();
    if (mode === "sqlite-vec" && !loaded) {
      throw new NamisoError("vector", "sqlite-vec could not be loaded");
    }
    this.backend = loaded ? "sqlite-vec" : "exact";
    if (loaded) {
      this.ensureTable();
    }
  }

  private ensureTable(): void {
    const stored = this.db.get("SELECT value FROM schema_meta WHERE key = 'vector_dimensions'");
    const storedDimensions = stored === undefined ? null : Number(text(stored, "value"));
    if (storedDimensions !== null && storedDimensions !== this.dimensions) {
      this.db.exec("DROP TABLE IF EXISTS vec_documents");
      this.db.run("DELETE FROM schema_meta WHERE key = 'vector_dimensions'");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
        document_id TEXT PRIMARY KEY,
        embedding FLOAT[${this.dimensions}]
      )`,
    );
    this.db.run(
      `INSERT INTO schema_meta (key, value) VALUES ('vector_dimensions', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(this.dimensions),
    );
  }

  upsert(documentId: string, vector: readonly number[]): void {
    if (this.backend !== "sqlite-vec") return;
    if (vector.length !== this.dimensions) {
      throw new NamisoError(
        "vector",
        `vector has ${vector.length} dimensions, expected ${this.dimensions}`,
      );
    }
    this.db.run("DELETE FROM vec_documents WHERE document_id = ?", documentId);
    this.db.run(
      "INSERT INTO vec_documents (document_id, embedding) VALUES (?, ?)",
      documentId,
      vectorToBlob(vector),
    );
  }

  remove(documentId: string): void {
    if (this.backend !== "sqlite-vec") return;
    this.db.run("DELETE FROM vec_documents WHERE document_id = ?", documentId);
  }

  clear(): void {
    if (this.backend !== "sqlite-vec") return;
    this.db.exec("DELETE FROM vec_documents");
  }

  search(
    vector: readonly number[],
    memorySpaceId: string,
    limit: number,
  ): Array<{ documentId: string; score: number }> {
    if (this.backend === "sqlite-vec") {
      return this.searchSqliteVec(vector, memorySpaceId, limit);
    }
    return this.searchExact(vector, memorySpaceId, limit);
  }

  private searchSqliteVec(
    vector: readonly number[],
    memorySpaceId: string,
    limit: number,
  ): Array<{ documentId: string; score: number }> {
    const rows = this.db.all(
      `SELECT v.document_id AS document_id, v.distance AS distance
       FROM vec_documents v
       JOIN embedding_documents d ON d.id = v.document_id
       WHERE v.embedding MATCH ? AND k = ? AND d.memory_space_id = ?
       ORDER BY v.distance ASC`,
      vectorToBlob(vector),
      Math.max(limit * 4, limit),
      memorySpaceId,
    );
    return rows
      .map((row) => ({
        documentId: text(row, "document_id"),
        score: 1 / (1 + Number(row["distance"])),
      }))
      .slice(0, limit);
  }

  private searchExact(
    vector: readonly number[],
    memorySpaceId: string,
    limit: number,
  ): Array<{ documentId: string; score: number }> {
    const rows = this.db.all(
      `SELECT id, vector FROM embedding_documents
       WHERE memory_space_id = ? AND vector IS NOT NULL`,
      memorySpaceId,
    );
    const scored: Array<{ documentId: string; score: number }> = [];
    for (const row of rows) {
      const candidate = blobToVector(row["vector"]);
      if (candidate === null) continue;
      scored.push({
        documentId: text(row, "id"),
        score: cosineSimilarity(vector, candidate),
      });
    }
    return scored.toSorted((left, right) => right.score - left.score).slice(0, limit);
  }
}
