import type { ForgetInput, ForgetReport } from './admin/forget.ts'
import type { NamisoOptions, ResolvedNamisoOptions } from './config.ts'
import type { DrainReport } from './ingestion/job-worker.ts'
import type { ExtractionUsage } from './providers/types.ts'
import type {
  Claim,
  Conversation,
  Entity,
  EntityType,
  Event,
  MemoryContext,
  MemorySpace,
  Message,
  MessageId,
  MessageRole,
  RetrievalTimeRange,
  RetrieveResult,
  SelfIdentity,
  Workspace,
} from './types.ts'

import { forget as forgetMemories } from './admin/forget.ts'
import { EntityResolver } from './annotation/entity-resolver.ts'
import { AnnotationPipeline } from './annotation/pipeline.ts'
import { normalizeSelfIdentity, resolveOptions } from './config.ts'
import { buildContext } from './context/builder.ts'
import { NotFoundError, ValidationError } from './errors.ts'
import {
  asConversationId,
  asEntityId,
  asEventId,
  asJobId,
  asMessageId,
  nowSeconds,
  timestampOf,
} from './ids.ts'
import { entityDocumentText } from './indexing/documents.ts'
import { Indexer } from './indexing/indexer.ts'
import { rebuildIndexes } from './indexing/rebuild.ts'
import { ChunkService } from './ingestion/chunk-service.ts'
import { JobWorker } from './ingestion/job-worker.ts'
import { Retriever } from './retrieval/retriever.ts'
import { chunkCount } from './storage/chunk-repo.ts'
import {
  appendMessage,
  createConversation as insertConversation,
  ensureMemorySpace,
  ensureWorkspace,
  findMessageByExternalId,
  getConversation as findConversation,
  getMessage,
  listConversations,
  listMessages,
  messageCount,
} from './storage/conversation-repo.ts'
import { Database } from './storage/database.ts'
import {
  enqueueAnnotate,
  enqueueChunk,
  getJob,
  jobCounts,
  pendingJobCount,
  retryFailedJobs,
} from './storage/job-repo.ts'
import {
  addMemoryLink,
  claimCount,
  entityCount,
  eventCount,
  evidenceMessageIds,
  findEntityByAlias,
  findEntityByName,
  getClaim,
  getEntitiesByIds,
  getEntity,
  getEvent,
  listAliases,
  listClaimsByEntity,
  listEventParticipants,
  listEventsForEntity,
  listLinksFrom,
  listLinksTo,
} from './storage/memory-repo.ts'
import { documentCount, missingVectorCount } from './storage/search-repo.ts'
import { VectorStore } from './storage/vector-store.ts'

export interface CreateConversationInput {
  externalId?: string
  title?: string
  startedAt?: number | Date
  metadata?: Record<string, unknown>
}

export interface IngestMessageInput {
  conversationId: string
  externalMessageId?: string
  speakerId: string
  speakerName?: string
  role: MessageRole
  content: string
  occurredAt?: number | Date
  metadata?: Record<string, unknown>
}

export interface IngestResult {
  messageId: string
  conversationId: string
  accepted: boolean
  processingStatus: 'pending' | 'completed'
}

export interface RetrieveInput {
  query: string
  entityIds?: readonly string[]
  memoryTypes?: readonly ('conversation' | 'entity' | 'claim' | 'event')[]
  timeRange?: RetrievalTimeRange
  topK?: number
  rerank?: boolean
  rerankPool?: number
  includeEvidence?: boolean
  includeRelations?: boolean
}

export interface ContextInput extends RetrieveInput {
  maxTokens?: number
}

export interface TimelineInput {
  entityId?: string
  entityName?: string
  from?: number
  to?: number
  eventTypes?: readonly string[]
  includeSuperseded?: boolean
}

export interface TimelineEntry {
  event: Event
  participants: Array<{ entity: Entity; role: string }>
  evidenceMessageIds: MessageId[]
}

export interface EntityDetails {
  entity: Entity
  aliases: string[]
  claims: Claim[]
  events: Event[]
}

export interface EventDetails {
  event: Event
  participants: Array<{ entity: Entity; role: string }>
  evidenceMessageIds: MessageId[]
  relations: ReturnType<typeof listLinksFrom>
}

export interface ClaimDetails {
  claim: Claim
  subject: Entity
  objectEntity: Entity | null
  evidenceMessageIds: MessageId[]
  relations: ReturnType<typeof listLinksFrom>
}

export interface LinkInput {
  sourceType: 'entity' | 'claim' | 'event'
  sourceId: string
  relation:
    | 'supersedes'
    | 'updates'
    | 'contradicts'
    | 'continues'
    | 'caused_by'
    | 'derived_from'
    | 'related_to'
    | 'same_as'
  targetType: 'entity' | 'claim' | 'event'
  targetId: string
  confidence?: number
}

export interface HealthReport {
  ok: boolean
  database: 'ok'
  vectorBackend: 'sqlite-vec' | 'exact'
  embedding: { model: string; version: string; dimensions: number }
  extraction: { version: string; usage?: ExtractionUsage }
  reranker: { model: string }
  counts: {
    messages: number
    entities: number
    claims: number
    events: number
    chunks: number
    documents: number
    missingVectors: number
  }
  jobs: Record<string, number>
  pendingJobs: number
  warnings: string[]
}

export class Namiso {
  readonly workspace: Workspace
  readonly memorySpace: MemorySpace
  private readonly db: Database
  private readonly config: ResolvedNamisoOptions
  private readonly vectors: VectorStore
  private readonly resolver: EntityResolver
  private readonly indexer: Indexer
  private readonly worker: JobWorker
  private readonly retriever: Retriever
  private readonly chunks: ChunkService
  private closed = false

  private constructor(
    db: Database,
    config: ResolvedNamisoOptions,
    workspace: Workspace,
    memorySpace: MemorySpace,
  ) {
    this.db = db
    this.config = config
    this.workspace = workspace
    this.memorySpace = memorySpace
    this.vectors = new VectorStore(db, config.embedding.dimensions, config.vectorIndex)
    this.resolver = new EntityResolver(db)
    this.indexer = new Indexer(db, this.vectors, config.embedding)
    const pipeline = new AnnotationPipeline(
      db,
      config.extraction,
      this.indexer,
      this.resolver,
      config.extractRoles,
    )
    this.chunks = new ChunkService(db, this.indexer, config.chunkPolicy)
    this.worker = new JobWorker(db, pipeline, this.chunks, memorySpace.id)
    this.retriever = new Retriever(
      db,
      this.vectors,
      config.embedding,
      config.reranker,
      this.resolver,
    )
  }

  static async open(options: NamisoOptions): Promise<Namiso> {
    const config = resolveOptions(options)
    const db = new Database(config.databasePath)
    try {
      const workspace = ensureWorkspace(db, {
        name: config.workspace.name,
        ...(config.workspace.id === undefined ? {} : { id: config.workspace.id }),
      })
      const memorySpace = ensureMemorySpace(db, workspace.id, {
        name: config.memorySpace.name,
        ...(config.memorySpace.id === undefined ? {} : { id: config.memorySpace.id }),
      })
      if (memorySpace.workspaceId !== workspace.id) {
        throw new ValidationError(`memory space ${memorySpace.id} belongs to a different workspace`)
      }
      const namiso = new Namiso(db, config, workspace, memorySpace)
      if (config.self !== undefined) {
        await namiso.ensureSelf(config.self)
      }
      return namiso
    } catch (error) {
      db.close()
      throw error
    }
  }

  createConversation(input: CreateConversationInput = {}): Conversation {
    this.assertOpen()
    return insertConversation(this.db, this.memorySpace.id, {
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.startedAt === undefined ? {} : { startedAt: timestampOf(input.startedAt) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
  }

  getConversation(conversationId: string): Conversation | null {
    this.assertOpen()
    const conversation = findConversation(this.db, asConversationId(conversationId))
    return conversation?.memorySpaceId === this.memorySpace.id ? conversation : null
  }

  listConversations(): Conversation[] {
    this.assertOpen()
    return listConversations(this.db, this.memorySpace.id)
  }

  getMessages(
    query: {
      conversationId?: string
      fromIndex?: number
      toIndex?: number
      fromTime?: number
      toTime?: number
      limit?: number
    } = {},
  ): Message[] {
    this.assertOpen()
    return listMessages(this.db, {
      memorySpaceId: this.memorySpace.id,
      ...(query.conversationId === undefined
        ? {}
        : { conversationId: asConversationId(query.conversationId) }),
      ...(query.fromIndex === undefined ? {} : { fromIndex: query.fromIndex }),
      ...(query.toIndex === undefined ? {} : { toIndex: query.toIndex }),
      ...(query.fromTime === undefined ? {} : { fromTime: query.fromTime }),
      ...(query.toTime === undefined ? {} : { toTime: query.toTime }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
  }

  async ingest(input: IngestMessageInput): Promise<IngestResult> {
    this.assertOpen()
    if (input.content.trim().length === 0) {
      throw new ValidationError('content cannot be empty')
    }
    if (!['user', 'assistant', 'system', 'tool'].includes(input.role)) {
      throw new ValidationError(`unsupported role: ${input.role}`)
    }
    if (input.speakerId.trim().length === 0) {
      throw new ValidationError('speakerId cannot be empty')
    }
    const conversation = findConversation(this.db, asConversationId(input.conversationId))
    if (conversation === null || conversation.memorySpaceId !== this.memorySpace.id) {
      throw new NotFoundError('conversation', input.conversationId)
    }
    if (input.externalMessageId !== undefined) {
      const existing = findMessageByExternalId(
        this.db,
        this.memorySpace.id,
        input.externalMessageId,
      )
      if (existing !== null) {
        return {
          messageId: existing.id,
          conversationId: existing.conversationId,
          accepted: true,
          processingStatus: this.annotationStatus(existing.id),
        }
      }
    }
    const occurredAt = input.occurredAt === undefined ? nowSeconds() : timestampOf(input.occurredAt)
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      ...(input.speakerName === undefined ? {} : { speakerName: input.speakerName }),
    }
    const message = this.db.transaction(() => {
      const stored = appendMessage(this.db, {
        memorySpaceId: this.memorySpace.id,
        conversationId: conversation.id,
        speakerId: input.speakerId,
        role: input.role,
        content: input.content,
        occurredAt,
        metadata,
        ...(input.externalMessageId === undefined
          ? {}
          : { externalMessageId: input.externalMessageId }),
      })
      enqueueAnnotate(this.db, this.memorySpace.id, stored.id)
      enqueueChunk(this.db, this.memorySpace.id, stored.conversationId)
      return stored
    })
    return {
      messageId: message.id,
      conversationId: message.conversationId,
      accepted: true,
      processingStatus: this.annotationStatus(message.id),
    }
  }

  private annotationStatus(messageId: string): 'pending' | 'completed' {
    const job = getJob(this.db, asJobId(`job:annotate:${messageId}`))
    return job?.status === 'completed' ? 'completed' : 'pending'
  }

  async drain(options: { limit?: number } = {}): Promise<DrainReport> {
    this.assertOpen()
    return this.worker.drain(options.limit ?? 200)
  }

  async annotate(messageId: string): Promise<DrainReport> {
    this.assertOpen()
    const message = getMessage(this.db, asMessageId(messageId))
    if (message === null || message.memorySpaceId !== this.memorySpace.id) {
      throw new NotFoundError('message', messageId)
    }
    this.db.transaction(() => {
      enqueueAnnotate(this.db, this.memorySpace.id, message.id)
      enqueueChunk(this.db, this.memorySpace.id, message.conversationId)
    })
    return this.worker.drain()
  }

  async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    this.assertOpen()
    this.validateQuery(input.query)
    if (
      input.timeRange?.from !== undefined &&
      input.timeRange.to !== undefined &&
      input.timeRange.from > input.timeRange.to
    ) {
      throw new ValidationError('timeRange.from must not be after timeRange.to')
    }
    return this.retriever.retrieve({
      memorySpaceId: this.memorySpace.id,
      query: input.query,
      ...(input.entityIds === undefined ? {} : { entityIds: input.entityIds }),
      ...(input.memoryTypes === undefined ? {} : { memoryTypes: input.memoryTypes }),
      ...(input.timeRange === undefined ? {} : { timeRange: input.timeRange }),
      ...(input.topK === undefined ? {} : { topK: input.topK }),
      ...(input.rerank === undefined ? {} : { rerank: input.rerank }),
      ...(input.rerankPool === undefined ? {} : { rerankPool: input.rerankPool }),
      ...(input.includeEvidence === undefined ? {} : { includeEvidence: input.includeEvidence }),
      ...(input.includeRelations === undefined ? {} : { includeRelations: input.includeRelations }),
    })
  }

  async getContext(input: ContextInput): Promise<MemoryContext> {
    const result = await this.retrieve({
      ...input,
      topK: input.topK ?? 12,
      includeRelations: input.includeRelations ?? true,
      includeEvidence: input.includeEvidence ?? true,
    })
    return buildContext(this.db, {
      memorySpaceId: this.memorySpace.id,
      query: input.query,
      candidates: result.candidates,
      trace: result.trace,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      includeEvidence: input.includeEvidence ?? true,
    })
  }

  timeline(input: TimelineInput): TimelineEntry[] {
    this.assertOpen()
    const entity = this.lookupEntity(input.entityId, input.entityName)
    if (entity === null) {
      throw new NotFoundError('entity', input.entityId ?? input.entityName ?? '')
    }
    const events = listEventsForEntity(this.db, this.memorySpace.id, entity.id, {
      includeInactive: input.includeSuperseded ?? false,
      limit: 500,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    }).filter((event) =>
      input.eventTypes === undefined || input.eventTypes.length === 0
        ? true
        : input.eventTypes.includes(event.type),
    )
    const chronological = events.toReversed()
    return chronological.map((event) => {
      const participants = this.participantsOf(event.id)
      return {
        event,
        participants,
        evidenceMessageIds: evidenceMessageIds(this.db, 'event', event.id),
      }
    })
  }

  getEntityDetails(idOrName: string): EntityDetails | null {
    this.assertOpen()
    const entity = this.lookupEntity(idOrName)
    if (entity === null) return null
    return {
      entity,
      aliases: listAliases(this.db, entity.id).map((alias) => alias.alias),
      claims: listClaimsByEntity(this.db, entity.id, { includeInactive: true }),
      events: listEventsForEntity(this.db, this.memorySpace.id, entity.id, {
        includeInactive: true,
        limit: 200,
      }),
    }
  }

  getEventDetails(eventId: string): EventDetails | null {
    this.assertOpen()
    const event = getEvent(this.db, asEventId(eventId))
    if (event === null || event.memorySpaceId !== this.memorySpace.id) return null
    return {
      event,
      participants: this.participantsOf(event.id),
      evidenceMessageIds: evidenceMessageIds(this.db, 'event', event.id),
      relations: [
        ...listLinksFrom(this.db, 'event', event.id),
        ...listLinksTo(this.db, 'event', event.id),
      ],
    }
  }

  getClaimDetails(claimId: string): ClaimDetails | null {
    this.assertOpen()
    const claim = getClaim(this.db, claimId)
    if (claim === null || claim.memorySpaceId !== this.memorySpace.id) return null
    const entities = getEntitiesByIds(this.db, [
      claim.subjectId,
      ...(claim.object.kind === 'entity' ? [claim.object.entityId] : []),
    ])
    const subject = entities.get(claim.subjectId)
    if (subject === undefined) return null
    return {
      claim,
      subject,
      objectEntity:
        claim.object.kind === 'entity' ? (entities.get(claim.object.entityId) ?? null) : null,
      evidenceMessageIds: evidenceMessageIds(this.db, 'claim', claim.id),
      relations: [
        ...listLinksFrom(this.db, 'claim', claim.id),
        ...listLinksTo(this.db, 'claim', claim.id),
      ],
    }
  }

  async ensureEntity(input: {
    name: string
    type: EntityType
    aliases?: readonly string[]
    description?: string
  }): Promise<Entity> {
    this.assertOpen()
    if ((input.type as string) === 'self' || (input.type as string) === 'ai') {
      throw new ValidationError('use ensureSelf() for the assistant entity')
    }
    const entity = this.db.transaction(() =>
      this.resolver.resolve({
        spaceId: this.memorySpace.id,
        name: input.name,
        type: input.type,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      }),
    )
    await this.indexEntity(entity)
    return entity
  }

  async ensureSelf(input: SelfIdentity): Promise<Entity> {
    this.assertOpen()
    const identity = normalizeSelfIdentity(input)
    const entity = this.db.transaction(() =>
      this.resolver.ensureSelf(this.memorySpace.id, identity),
    )
    await this.indexEntity(entity)
    return entity
  }

  private async indexEntity(entity: Entity): Promise<void> {
    await this.indexer.sync(this.memorySpace.id, [
      {
        sourceType: 'entity',
        sourceId: entity.id,
        content: entityDocumentText(
          entity,
          listAliases(this.db, entity.id).map((alias) => alias.alias),
        ),
      },
    ])
  }

  link(input: LinkInput): void {
    this.assertOpen()
    if (!this.existsInSpace(input.sourceType, input.sourceId)) {
      throw new NotFoundError(input.sourceType, input.sourceId)
    }
    if (!this.existsInSpace(input.targetType, input.targetId)) {
      throw new NotFoundError(input.targetType, input.targetId)
    }
    this.db.transaction(() => {
      addMemoryLink(this.db, {
        spaceId: this.memorySpace.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        relation: input.relation,
        targetType: input.targetType,
        targetId: input.targetId,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      })
    })
  }

  async forget(input: ForgetInput): Promise<ForgetReport> {
    this.assertOpen()
    const report = await forgetMemories(
      this.db,
      this.indexer,
      this.chunks,
      this.memorySpace.id,
      input,
    )
    await rebuildIndexes(this.db, this.vectors, this.indexer, this.resolver, this.memorySpace.id)
    return report
  }

  async reindex(): Promise<{ documents: number }> {
    this.assertOpen()
    return rebuildIndexes(this.db, this.vectors, this.indexer, this.resolver, this.memorySpace.id)
  }

  async retryJobs(): Promise<DrainReport> {
    this.assertOpen()
    retryFailedJobs(this.db, this.memorySpace.id)
    return this.worker.drain()
  }

  health(): HealthReport {
    this.assertOpen()
    const counts = {
      messages: messageCount(this.db, this.memorySpace.id),
      entities: entityCount(this.db, this.memorySpace.id),
      claims: claimCount(this.db, this.memorySpace.id),
      events: eventCount(this.db, this.memorySpace.id),
      chunks: chunkCount(this.db, this.memorySpace.id),
      documents: documentCount(this.db, this.memorySpace.id),
      missingVectors: missingVectorCount(this.db, this.memorySpace.id),
    }
    const jobs = jobCounts(this.db, this.memorySpace.id)
    const warnings: string[] = []
    if (counts.missingVectors > 0) {
      warnings.push(`${counts.missingVectors} 个索引文档缺少向量，可运行 reindex()。`)
    }
    if ((jobs['failed'] ?? 0) > 0) {
      warnings.push(`${jobs['failed']} 个任务失败，可运行 retryJobs()。`)
    }
    if (this.vectors.backend === 'exact') {
      warnings.push('sqlite-vec 未加载，向量检索使用精确扫描。')
    }
    return {
      ok: true,
      database: 'ok',
      vectorBackend: this.vectors.backend,
      embedding: {
        model: this.config.embedding.model,
        version: this.config.embedding.version,
        dimensions: this.config.embedding.dimensions,
      },
      extraction: {
        version: this.config.extraction.version,
        ...(this.config.extraction.usage === undefined
          ? {}
          : { usage: { ...this.config.extraction.usage } }),
      },
      reranker: { model: this.config.reranker.model },
      counts,
      jobs,
      pendingJobs: pendingJobCount(this.db, this.memorySpace.id),
      warnings,
    }
  }

  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }

  private lookupEntity(idOrName: string | undefined, name?: string): Entity | null {
    if (idOrName !== undefined) {
      const byId = getEntity(this.db, asEntityId(idOrName))
      if (byId !== null && byId.memorySpaceId === this.memorySpace.id) return byId
      return (
        findEntityByName(this.db, this.memorySpace.id, idOrName) ??
        findEntityByAlias(this.db, this.memorySpace.id, idOrName)
      )
    }
    if (name !== undefined) {
      return (
        findEntityByName(this.db, this.memorySpace.id, name) ??
        findEntityByAlias(this.db, this.memorySpace.id, name)
      )
    }
    return null
  }

  private participantsOf(eventId: Event['id']): Array<{ entity: Entity; role: string }> {
    const participants = listEventParticipants(this.db, eventId)
    const entities = getEntitiesByIds(
      this.db,
      participants.map((participant) => participant.entityId),
    )
    return participants.flatMap((participant) => {
      const entity = entities.get(participant.entityId)
      return entity === undefined ? [] : [{ entity, role: participant.role }]
    })
  }

  private existsInSpace(type: 'entity' | 'claim' | 'event', id: string): boolean {
    if (type === 'entity') {
      const entity = getEntity(this.db, asEntityId(id))
      return entity !== null && entity.memorySpaceId === this.memorySpace.id
    }
    if (type === 'claim') {
      const claim = getClaim(this.db, id)
      return claim !== null && claim.memorySpaceId === this.memorySpace.id
    }
    const event = getEvent(this.db, asEventId(id))
    return event !== null && event.memorySpaceId === this.memorySpace.id
  }

  private validateQuery(query: string): void {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ValidationError('query cannot be empty')
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ValidationError('Namiso instance is closed')
  }
}
