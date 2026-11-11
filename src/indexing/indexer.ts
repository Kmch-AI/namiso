import type { EmbeddingProvider } from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type { EmbeddingDocument } from '../storage/search-repo.ts'
import type { VectorStore } from '../storage/vector-store.ts'
import type { MemorySourceType, MemorySpaceId } from '../types.ts'

import { nowSeconds } from '../ids.ts'
import {
  indexDocument,
  listMissingVectors,
  removeDocument,
  setDocumentVector,
  upsertDocument,
} from '../storage/search-repo.ts'

export interface IndexItem {
  sourceType: MemorySourceType
  sourceId: string
  content: string
}

export class Indexer {
  private readonly db: Database
  private readonly vectors: VectorStore
  private readonly embedding: EmbeddingProvider

  constructor(db: Database, vectors: VectorStore, embedding: EmbeddingProvider) {
    this.db = db
    this.vectors = vectors
    this.embedding = embedding
  }

  async sync(spaceId: MemorySpaceId, items: readonly IndexItem[]): Promise<void> {
    if (items.length === 0) return
    const now = nowSeconds()
    const pending: EmbeddingDocument[] = []
    this.db.transaction(() => {
      for (const item of items) {
        const result = upsertDocument(this.db, {
          spaceId,
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          content: item.content,
          modelName: this.embedding.model,
          modelVersion: this.embedding.version,
          dimensions: this.embedding.dimensions,
          now,
        })
        for (const removed of result.removedIds) {
          this.vectors.remove(removed)
        }
        indexDocument(this.db, result.document)
        if (result.needsEmbedding) {
          this.vectors.remove(result.document.id)
          pending.push(result.document)
        }
      }
    })
    await this.embedDocuments(pending)
  }

  async embedMissing(spaceId: MemorySpaceId, limit = 200): Promise<number> {
    const documents = listMissingVectors(this.db, spaceId, limit)
    await this.embedDocuments(documents)
    return documents.length
  }

  private async embedDocuments(documents: readonly EmbeddingDocument[]): Promise<void> {
    if (documents.length === 0) return
    const vectors = await this.embedding.embed(documents.map((document) => document.content))
    if (vectors.length !== documents.length) {
      throw new Error(
        `embedding provider returned ${vectors.length} vectors for ${documents.length} documents`,
      )
    }
    this.db.transaction(() => {
      for (const [index, document] of documents.entries()) {
        const vector = vectors[index]
        if (vector === undefined) continue
        if (vector.length !== this.embedding.dimensions) {
          throw new Error(
            `embedding ${document.id} has ${vector.length} dimensions, expected ${this.embedding.dimensions}`,
          )
        }
        setDocumentVector(this.db, document.id, document.contentHash, vector)
        this.vectors.upsert(document.memorySpaceId, document.id, vector)
      }
    })
  }

  remove(sourceType: MemorySourceType, sourceId: string): void {
    const ids = removeDocument(this.db, sourceType, sourceId)
    for (const id of ids) {
      this.vectors.remove(id)
    }
  }
}
