declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type MemorySpaceId = Brand<string, 'MemorySpaceId'>
export type ConversationId = Brand<string, 'ConversationId'>
export type MessageId = Brand<string, 'MessageId'>
export type EntityId = Brand<string, 'EntityId'>
export type ClaimId = Brand<string, 'ClaimId'>
export type EventId = Brand<string, 'EventId'>
export type AnnotationId = Brand<string, 'AnnotationId'>
export type EvidenceId = Brand<string, 'EvidenceId'>
export type MemoryLinkId = Brand<string, 'MemoryLinkId'>
export type ChunkId = Brand<string, 'ChunkId'>
export type DocumentId = Brand<string, 'DocumentId'>
export type JobId = Brand<string, 'JobId'>

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export const ENTITY_TYPES = [
  'person',
  'group',
  'place',
  'animal',
  'object',
  'artifact',
  'activity',
  'topic',
  'other',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const ENTITY_KINDS = [...ENTITY_TYPES, 'self'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

export interface SelfIdentity {
  name: string
  aliases?: readonly string[]
  description?: string
}
export type ClaimStatus = 'active' | 'superseded' | 'disputed' | 'retracted' | 'invalid'
export type EventStatus = 'active' | 'retracted' | 'invalid'
export type TimePrecision = 'exact' | 'day' | 'month' | 'approximate' | 'unknown'
export type ClaimObjectKind = 'literal' | 'entity'
export type AnnotationTargetType = 'entity' | 'claim' | 'event'
export type MemoryType = 'claim' | 'event'
export type MemorySourceType = 'chunk' | 'entity' | 'claim' | 'event'
export type Relation =
  | 'supersedes'
  | 'updates'
  | 'contradicts'
  | 'continues'
  | 'caused_by'
  | 'derived_from'
  | 'related_to'
  | 'same_as'

export interface Workspace {
  id: WorkspaceId
  name: string
  createdAt: number
}

export interface MemorySpace {
  id: MemorySpaceId
  workspaceId: WorkspaceId
  name: string
  config: Record<string, unknown> | null
  createdAt: number
}

export interface Conversation {
  id: ConversationId
  memorySpaceId: MemorySpaceId
  externalId: string | null
  title: string | null
  startedAt: number
  endedAt: number | null
  metadata: Record<string, unknown> | null
}

export interface Message {
  id: MessageId
  memorySpaceId: MemorySpaceId
  conversationId: ConversationId
  externalMessageId: string | null
  speakerId: string
  role: MessageRole
  content: string
  messageIndex: number
  occurredAt: number
  createdAt: number
  metadata: Record<string, unknown> | null
}

export interface Entity {
  id: EntityId
  memorySpaceId: MemorySpaceId
  type: EntityKind
  name: string
  description: string | null
  createdAt: number
  updatedAt: number
  metadata: Record<string, unknown> | null
}

export interface EntityAlias {
  id: string
  entityId: EntityId
  alias: string
  sourceMessageId: MessageId | null
  confidence: number
}

export type ClaimObject =
  | { kind: 'literal'; value: string }
  | { kind: 'entity'; entityId: EntityId }

export interface Claim {
  id: ClaimId
  memorySpaceId: MemorySpaceId
  subjectId: EntityId
  predicate: string
  object: ClaimObject
  status: ClaimStatus
  validFrom: number | null
  validUntil: number | null
  confidence: number
  createdAt: number
  updatedAt: number
  metadata: Record<string, unknown> | null
}

export interface Event {
  id: EventId
  memorySpaceId: MemorySpaceId
  type: string
  summary: string
  description: string | null
  occurredAt: number | null
  timePrecision: TimePrecision
  status: EventStatus
  confidence: number
  createdAt: number
  updatedAt: number
  metadata: Record<string, unknown> | null
}

export interface EventParticipant {
  eventId: EventId
  entityId: EntityId
  role: string
}

export interface Annotation {
  id: AnnotationId
  messageId: MessageId
  targetType: AnnotationTargetType
  targetId: string
  role: string
  confidence: number
  extractorVersion: string | null
  createdAt: number
  metadata: Record<string, unknown> | null
}

export interface Evidence {
  id: EvidenceId
  memorySpaceId: MemorySpaceId
  sourceType: string
  sourceId: string
  evidenceType: string
  contentSnapshot: string | null
  confidence: number
  createdAt: number
  metadata: Record<string, unknown> | null
}

export interface MemoryLink {
  id: MemoryLinkId
  memorySpaceId: MemorySpaceId
  sourceType: MemoryType | 'entity'
  sourceId: string
  relation: Relation
  targetType: MemoryType | 'entity'
  targetId: string
  confidence: number
  createdAt: number
  metadata: Record<string, unknown> | null
}

export interface Chunk {
  id: ChunkId
  memorySpaceId: MemorySpaceId
  conversationId: ConversationId
  ordinal: number
  firstMessageIndex: number
  lastMessageIndex: number
  startedAt: number
  endedAt: number
  participants: string[]
  content: string
  contentHash: string
  createdAt: number
  messageIds: MessageId[]
}

export type JobType = 'annotate' | 'chunk'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Job {
  id: JobId
  memorySpaceId: MemorySpaceId
  type: JobType
  payload: Record<string, unknown>
  status: JobStatus
  attempts: number
  maxAttempts: number
  runAfter: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface RetrievalTimeRange {
  from?: number
  to?: number
}

export type RetrievalChannel = 'sql' | 'fts' | 'vector' | 'graph' | 'timeline'

export type CandidateRecord =
  | { kind: 'message'; message: Message }
  | { kind: 'chunk'; chunk: Chunk }
  | { kind: 'entity'; entity: Entity; aliases: string[] }
  | { kind: 'claim'; claim: Claim; subject: Entity; objectEntity: Entity | null }
  | {
      kind: 'event'
      event: Event
      participants: Array<{ entity: Entity; role: string }>
    }

export interface MemoryRelationView {
  relation: Relation
  direction: 'outgoing' | 'incoming'
  targetKind: string
  targetId: string
}

export interface MemoryCandidate {
  key: string
  kind: CandidateRecord['kind']
  title: string
  text: string
  score: number
  channels: RetrievalChannel[]
  occurredAt: number | null
  status: string | null
  evidenceMessageIds: MessageId[]
  relations: MemoryRelationView[]
  record: CandidateRecord
}

export interface ChannelTrace {
  channel: RetrievalChannel
  count: number
  topKeys: string[]
}

export interface RetrievalTrace {
  id: string
  query: string
  intent: string
  entityIds: string[]
  channels: ChannelTrace[]
  fusedCount: number
  rerankedCount: number
  expandedCount: number
  elapsedMs: number
  notes: string[]
}

export interface RetrieveResult {
  candidates: MemoryCandidate[]
  total: number
  trace: RetrievalTrace
}

export interface MemoryContext {
  text: string
  items: MemoryCandidate[]
  evidence: Message[]
  tokenEstimate: number
  compressed: boolean
  overBudget: boolean
  uncertainties: string[]
  trace: RetrievalTrace
}
