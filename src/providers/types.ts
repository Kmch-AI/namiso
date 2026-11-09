import type {
  ClaimCardinality,
  ClaimChange,
  EntityId,
  EntityKind,
  MemorySpaceId,
  MessageId,
  MessageRole,
  TimePrecision,
} from '../types.ts'

export interface EmbeddingProvider {
  readonly model: string
  readonly version: string
  readonly dimensions: number
  embed(texts: readonly string[]): Promise<number[][]>
}

export interface RerankInput {
  query: string
  documents: readonly string[]
}

export interface RerankScore {
  index: number
  score: number
}

export interface RerankerProvider {
  readonly model: string
  rerank(input: RerankInput): Promise<RerankScore[]>
}

export type ExtractionModality = 'asserted' | 'uncertain' | 'negated' | 'hypothetical' | 'quoted'

export interface ExtractionMessage {
  id: MessageId
  role: MessageRole
  speakerId: string
  speakerName: string
  content: string
  occurredAt: number
  messageIndex: number
}

export interface KnownEntity {
  id: EntityId
  name: string
  type: EntityKind
  aliases: string[]
}

export interface KnownAttribute {
  key: string
  label: string
  cardinality: ClaimCardinality
}

export interface ExtractionInput {
  memorySpaceId: MemorySpaceId
  focusMessageIds: readonly [MessageId, ...MessageId[]]
  messages: readonly ExtractionMessage[]
  knownEntities: readonly KnownEntity[]
  knownAttributes?: readonly KnownAttribute[]
}

export interface ExtractedEntity {
  name: string
  type: EntityKind
  aliases?: readonly string[]
  description?: string
  evidenceMessageIds: readonly MessageId[]
}

export type ExtractedObject =
  | { kind: 'literal'; value: string }
  | { kind: 'entity'; name: string; type: EntityKind }

export interface ExtractedClaim {
  subject: { name: string; type: EntityKind }
  predicate: string
  attribute?: string
  cardinality?: ClaimCardinality
  change?: ClaimChange
  object: ExtractedObject
  modality: ExtractionModality
  confidence: number
  validFrom?: number
  evidenceMessageIds: readonly MessageId[]
}

export interface ExtractedParticipant {
  name: string
  type: EntityKind
  role: string
}

export interface ExtractedEvent {
  type: string
  summary: string
  description?: string
  occurredAt?: number
  timePrecision?: TimePrecision
  participants: readonly ExtractedParticipant[]
  modality: ExtractionModality
  confidence: number
  evidenceMessageIds: readonly MessageId[]
}

export interface ExtractionResult {
  entities: readonly ExtractedEntity[]
  claims: readonly ExtractedClaim[]
  events: readonly ExtractedEvent[]
}

export interface ExtractionUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly reasoningTokens: number
  readonly cacheHitTokens?: number
  readonly cacheMissTokens?: number
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export interface ExtractionProvider {
  readonly version: string
  readonly usage?: ExtractionUsage
  extract(input: ExtractionInput): Promise<ExtractionResult>
}
