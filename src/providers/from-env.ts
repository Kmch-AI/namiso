import type {
  EmbeddingProvider,
  ExtractionProvider,
  ReasoningEffort,
  RerankerProvider,
} from './types.ts'

import { ValidationError } from '../errors.ts'
import { HttpEmbeddingProvider, HttpExtractionProvider, HttpRerankerProvider } from './http.ts'

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>

export interface ProviderSet {
  embedding?: EmbeddingProvider
  extraction?: ExtractionProvider
  reranker?: RerankerProvider
}

interface EndpointConfig {
  endpoint: string
  model: string
  apiKey?: string
  version?: string
  timeoutMs?: number
}

export function providersFromEnv(env: ProviderEnvironment = process.env): ProviderSet {
  const timeoutMs = optionalPositiveInteger(env, 'NAMISO_MODEL_TIMEOUT_MS')
  const result: ProviderSet = {}

  const extraction = readEndpoint(env, 'NAMISO_EXTRACTION', timeoutMs)
  if (extraction !== undefined) {
    const reasoningEffort = optionalReasoningEffort(env, 'NAMISO_EXTRACTION_REASONING_EFFORT')
    result.extraction = new HttpExtractionProvider({
      endpoint: extraction.endpoint,
      model: extraction.model,
      ...(extraction.apiKey === undefined ? {} : { apiKey: extraction.apiKey }),
      ...(extraction.version === undefined ? {} : { version: extraction.version }),
      ...(extraction.timeoutMs === undefined ? {} : { timeoutMs: extraction.timeoutMs }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
  }

  const embedding = readEndpoint(env, 'NAMISO_EMBEDDING', timeoutMs)
  if (embedding !== undefined) {
    const dimensions = requiredPositiveInteger(env, 'NAMISO_EMBEDDING_DIMENSIONS')
    const batchSize = optionalPositiveInteger(env, 'NAMISO_EMBEDDING_BATCH_SIZE')
    result.embedding = new HttpEmbeddingProvider({
      endpoint: embedding.endpoint,
      model: embedding.model,
      dimensions,
      ...(embedding.apiKey === undefined ? {} : { apiKey: embedding.apiKey }),
      ...(embedding.version === undefined ? {} : { version: embedding.version }),
      ...(embedding.timeoutMs === undefined ? {} : { timeoutMs: embedding.timeoutMs }),
      ...(batchSize === undefined ? {} : { batchSize }),
    })
  }

  const reranker = readEndpoint(env, 'NAMISO_RERANK', timeoutMs)
  if (reranker !== undefined) {
    result.reranker = new HttpRerankerProvider({
      endpoint: reranker.endpoint,
      model: reranker.model,
      ...(reranker.apiKey === undefined ? {} : { apiKey: reranker.apiKey }),
      ...(reranker.timeoutMs === undefined ? {} : { timeoutMs: reranker.timeoutMs }),
    })
  }

  return result
}

function readEndpoint(
  env: ProviderEnvironment,
  prefix: string,
  timeoutMs: number | undefined,
): EndpointConfig | undefined {
  const endpoint = clean(env[`${prefix}_URL`])
  const model = clean(env[`${prefix}_MODEL`])
  if (endpoint === undefined && model === undefined) return undefined
  if (endpoint === undefined || model === undefined) {
    throw new ValidationError(`${prefix}_URL and ${prefix}_MODEL must be set together`)
  }
  const apiKey = clean(env[`${prefix}_API_KEY`])
  const version = clean(env[`${prefix}_VERSION`])
  return {
    endpoint,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(version === undefined ? {} : { version }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function optionalPositiveInteger(env: ProviderEnvironment, key: string): number | undefined {
  const raw = clean(env[key])
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${key} must be a positive integer`)
  }
  return parsed
}

function requiredPositiveInteger(env: ProviderEnvironment, key: string): number {
  const value = optionalPositiveInteger(env, key)
  if (value === undefined) {
    throw new ValidationError(`${key} is required when an embedding endpoint is set`)
  }
  return value
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high']

function optionalReasoningEffort(
  env: ProviderEnvironment,
  key: string,
): ReasoningEffort | undefined {
  const raw = clean(env[key])
  if (raw === undefined) return undefined
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    throw new ValidationError(`${key} must be one of ${REASONING_EFFORTS.join(', ')}`)
  }
  return raw as ReasoningEffort
}
