import type { ChunkPolicy } from './ingestion/chunker.ts'
import type { EmbeddingProvider, ExtractionProvider, RerankerProvider } from './providers/types.ts'
import type { MessageRole } from './types.ts'

import { ValidationError } from './errors.ts'
import { DEFAULT_CHUNK_POLICY } from './ingestion/chunker.ts'
import { HashEmbeddingProvider } from './providers/hash-embedding.ts'
import { LexicalReranker } from './providers/lexical-reranker.ts'
import { RuleExtractionProvider } from './providers/rule-extraction.ts'

export type VectorIndexMode = 'auto' | 'sqlite-vec' | 'exact'

export interface NamisoOptions {
  databasePath: string
  workspace?: { id?: string; name?: string }
  memorySpace?: { id?: string; name?: string }
  embedding?: EmbeddingProvider
  extraction?: ExtractionProvider
  reranker?: RerankerProvider
  extractRoles?: readonly MessageRole[]
  vectorIndex?: VectorIndexMode
  chunking?: Partial<ChunkPolicy>
}

export interface ResolvedNamisoOptions {
  databasePath: string
  workspace: { id: string | undefined; name: string }
  memorySpace: { id: string | undefined; name: string }
  embedding: EmbeddingProvider
  extraction: ExtractionProvider
  reranker: RerankerProvider
  extractRoles: readonly MessageRole[]
  vectorIndex: VectorIndexMode
  chunkPolicy: ChunkPolicy
}

export function resolveOptions(options: NamisoOptions): ResolvedNamisoOptions {
  if (typeof options.databasePath !== 'string' || options.databasePath.trim().length === 0) {
    throw new ValidationError('databasePath must be a non-empty string')
  }
  const embedding = options.embedding ?? new HashEmbeddingProvider()
  assertProvider('embedding', embedding, ['embed'])
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0) {
    throw new ValidationError('embedding.dimensions must be a positive integer')
  }
  if (embedding.model.trim().length === 0) {
    throw new ValidationError('embedding.model must be non-empty')
  }
  const extraction = options.extraction ?? new RuleExtractionProvider()
  assertProvider('extraction', extraction, ['extract'])
  const reranker = options.reranker ?? new LexicalReranker()
  assertProvider('reranker', reranker, ['rerank'])
  const extractRoles = options.extractRoles ?? ['user', 'assistant']
  if (extractRoles.length === 0) {
    throw new ValidationError('extractRoles must contain at least one role')
  }
  const validRoles = new Set<MessageRole>(['user', 'assistant', 'system', 'tool'])
  for (const role of extractRoles) {
    if (!validRoles.has(role)) {
      throw new ValidationError(`unsupported extractRole: ${role}`)
    }
  }
  const uniqueExtractRoles = [...new Set(extractRoles)]
  const vectorIndex = options.vectorIndex ?? 'auto'
  if (!['auto', 'sqlite-vec', 'exact'].includes(vectorIndex)) {
    throw new ValidationError(`unsupported vectorIndex: ${vectorIndex}`)
  }
  const size = options.chunking?.size ?? DEFAULT_CHUNK_POLICY.size
  const overlap = options.chunking?.overlap ?? DEFAULT_CHUNK_POLICY.overlap
  if (!Number.isInteger(size) || size < 1 || size > 64) {
    throw new ValidationError('chunking.size must be an integer between 1 and 64')
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new ValidationError('chunking.overlap must be an integer below chunking.size')
  }
  return {
    databasePath: options.databasePath,
    workspace: {
      id: options.workspace?.id,
      name: options.workspace?.name ?? 'default',
    },
    memorySpace: {
      id: options.memorySpace?.id,
      name: options.memorySpace?.name ?? 'default',
    },
    embedding,
    extraction,
    reranker,
    extractRoles: uniqueExtractRoles,
    vectorIndex,
    chunkPolicy: { size, overlap },
  }
}

function assertProvider(label: string, provider: object, methods: readonly string[]): void {
  for (const method of methods) {
    const value: unknown = Reflect.get(provider, method)
    if (typeof value !== 'function') {
      throw new ValidationError(`${label} provider must implement ${method}()`)
    }
  }
}
