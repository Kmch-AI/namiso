import type { Indexer, IndexItem } from '../indexing/indexer.ts'
import type { ExtractionMessage, ExtractionProvider, ExtractionResult } from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type {
  Claim,
  EntityId,
  Event,
  MemorySpaceId,
  Message,
  MessageId,
  MessageRole,
} from '../types.ts'
import type { EntityResolver } from './entity-resolver.ts'

import { asEventId } from '../ids.ts'
import { claimDocumentText, entityDocumentText, eventDocumentText } from '../indexing/documents.ts'
import { getMessagesByIds, recentMessages } from '../storage/conversation-repo.ts'
import {
  addAnnotation,
  getClaim,
  getEntitiesByIds,
  getEvent,
  getOrCreateEvidence,
  linkMemoryEvidence,
  listEventParticipants,
} from '../storage/memory-repo.ts'
import { MemoryLinker } from './linker.ts'

const CONTEXT_WINDOW = 8
const KNOWN_ENTITY_LIMIT = 50

export class AnnotationPipeline {
  private readonly db: Database
  private readonly resolver: EntityResolver
  private readonly linker: MemoryLinker
  private readonly extractor: ExtractionProvider
  private readonly indexer: Indexer
  private readonly extractRoles: ReadonlySet<MessageRole>

  constructor(
    db: Database,
    extractor: ExtractionProvider,
    indexer: Indexer,
    resolver: EntityResolver,
    extractRoles: readonly MessageRole[],
  ) {
    this.db = db
    this.extractor = extractor
    this.indexer = indexer
    this.resolver = resolver
    this.extractRoles = new Set(extractRoles)
    this.linker = new MemoryLinker(db, resolver)
  }

  async run(message: Message): Promise<void> {
    const spaceId = message.memorySpaceId
    const speakerName = speakerNameOf(message)
    const speaker = this.resolver.resolveSpeaker({
      spaceId,
      speakerId: message.speakerId,
      speakerName,
      role: message.role,
    })

    if (!this.extractRoles.has(message.role)) {
      this.db.transaction(() => {
        addAnnotation(this.db, {
          spaceId,
          messageId: message.id,
          targetType: 'entity',
          targetId: speaker.id,
          role: 'speaker',
          extractorVersion: this.extractor.version,
        })
      })
      await this.indexer.sync(
        spaceId,
        this.indexItems(spaceId, new Set([speaker.id]), new Set(), new Set()),
      )
      return
    }

    const context = recentMessages(
      this.db,
      message.conversationId,
      message.messageIndex,
      CONTEXT_WINDOW,
    )
    const messages: ExtractionMessage[] = [...context, message].map((item) => ({
      id: item.id,
      role: item.role,
      speakerId: item.speakerId,
      speakerName: item.id === message.id ? speaker.name : speakerNameOf(item),
      content: item.content,
      occurredAt: item.occurredAt,
      messageIndex: item.messageIndex,
    }))

    const extraction = await this.extractor.extract({
      memorySpaceId: spaceId,
      focusMessageId: message.id,
      messages,
      knownEntities: this.resolver.knownEntities(
        spaceId,
        [message.content, ...context.map((item) => item.content)],
        KNOWN_ENTITY_LIMIT,
      ),
    })

    const validEvidence = this.validEvidenceMap(spaceId, extraction, message)
    const entityIds = new Set<EntityId>()
    const claimIds = new Set<string>()
    const eventIds = new Set<string>()

    this.db.transaction(() => {
      addAnnotation(this.db, {
        spaceId,
        messageId: message.id,
        targetType: 'entity',
        targetId: speaker.id,
        role: 'speaker',
        extractorVersion: this.extractor.version,
      })
      entityIds.add(speaker.id)

      for (const entity of extraction.entities) {
        const resolved = this.resolver.resolve({
          spaceId,
          name: entity.name,
          type: entity.type,
          ...(entity.description === undefined ? {} : { description: entity.description }),
          ...(entity.aliases === undefined ? {} : { aliases: entity.aliases }),
          sourceMessageId: message.id,
        })
        entityIds.add(resolved.id)
        addAnnotation(this.db, {
          spaceId,
          messageId: message.id,
          targetType: 'entity',
          targetId: resolved.id,
          role: 'mentioned',
          confidence: 0.8,
          extractorVersion: this.extractor.version,
        })
      }

      for (const claim of extraction.claims) {
        const evidenceIds = evidenceFor(claim.evidenceMessageIds, message.id, validEvidence)
        const result = this.linker.applyClaim(spaceId, claim, {
          extractorVersion: this.extractor.version,
          evidenceIds,
        })
        if (result === null) continue
        entityIds.add(result.subject.id)
        if (result.objectEntity !== null) entityIds.add(result.objectEntity.id)
        claimIds.add(result.claim.id)
        for (const previous of result.superseded) claimIds.add(previous.id)
        this.attachClaimEvidence(spaceId, result.claim, evidenceIds, validEvidence)
        addAnnotation(this.db, {
          spaceId,
          messageId: message.id,
          targetType: 'claim',
          targetId: result.claim.id,
          role: 'evidence',
          confidence: claim.confidence,
          extractorVersion: this.extractor.version,
        })
      }

      for (const event of extraction.events) {
        const evidenceIds = evidenceFor(event.evidenceMessageIds, message.id, validEvidence)
        const result = this.linker.applyEvent(spaceId, event, {
          extractorVersion: this.extractor.version,
          evidenceIds,
        })
        eventIds.add(result.event.id)
        for (const participant of result.participants) entityIds.add(participant.entity.id)
        this.attachEventEvidence(spaceId, result.event, evidenceIds, validEvidence)
        addAnnotation(this.db, {
          spaceId,
          messageId: message.id,
          targetType: 'event',
          targetId: result.event.id,
          role: 'evidence',
          confidence: event.confidence,
          extractorVersion: this.extractor.version,
        })
        for (const claim of result.affectedClaims) {
          claimIds.add(claim.id)
          this.attachClaimEvidence(spaceId, claim, evidenceIds, validEvidence)
          if (claim.object.kind === 'entity') entityIds.add(claim.object.entityId)
          entityIds.add(claim.subjectId)
        }
      }
    })

    await this.indexer.sync(spaceId, this.indexItems(spaceId, entityIds, claimIds, eventIds))
  }

  private validEvidenceMap(
    spaceId: MemorySpaceId,
    extraction: ExtractionResult,
    focus: Message,
  ): Map<MessageId, Message> {
    const ids = new Set<MessageId>([focus.id])
    for (const claim of extraction.claims) {
      for (const id of claim.evidenceMessageIds) ids.add(id)
    }
    for (const event of extraction.events) {
      for (const id of event.evidenceMessageIds) ids.add(id)
    }
    const valid = new Map<MessageId, Message>()
    for (const message of getMessagesByIds(this.db, [...ids])) {
      if (message.memorySpaceId === spaceId) valid.set(message.id, message)
    }
    if (!valid.has(focus.id)) valid.set(focus.id, focus)
    return valid
  }

  private attachClaimEvidence(
    spaceId: MemorySpaceId,
    claim: Claim,
    evidenceIds: readonly MessageId[],
    validEvidence: Map<MessageId, Message>,
  ): void {
    const messages =
      evidenceIds.length === 0
        ? []
        : evidenceIds.flatMap((id) => {
            const message = validEvidence.get(id)
            return message === undefined ? [] : [message]
          })
    for (const message of messages) {
      const evidenceId = getOrCreateEvidence(this.db, {
        spaceId,
        sourceType: 'message',
        sourceId: message.id,
        evidenceType: evidenceTypeOf(message),
        contentSnapshot: message.content.slice(0, 1000),
      })
      linkMemoryEvidence(this.db, 'claim', claim.id, evidenceId)
    }
  }

  private attachEventEvidence(
    spaceId: MemorySpaceId,
    event: Event,
    evidenceIds: readonly MessageId[],
    validEvidence: Map<MessageId, Message>,
  ): void {
    for (const id of evidenceIds) {
      const message = validEvidence.get(id)
      if (message === undefined) continue
      const evidenceId = getOrCreateEvidence(this.db, {
        spaceId,
        sourceType: 'message',
        sourceId: message.id,
        evidenceType: evidenceTypeOf(message),
        contentSnapshot: message.content.slice(0, 1000),
      })
      linkMemoryEvidence(this.db, 'event', event.id, evidenceId)
    }
  }

  private indexItems(
    spaceId: MemorySpaceId,
    entityIds: Set<EntityId>,
    claimIds: Set<string>,
    eventIds: Set<string>,
  ): IndexItem[] {
    const items = new Map<string, IndexItem>()
    const entities = getEntitiesByIds(this.db, [...entityIds])
    const aliases = this.resolver.aliasMap(spaceId)
    for (const entity of entities.values()) {
      items.set(`entity:${entity.id}`, {
        sourceType: 'entity',
        sourceId: entity.id,
        content: entityDocumentText(entity, aliases.get(entity.id) ?? []),
      })
    }

    const claims: Claim[] = []
    for (const claimId of claimIds) {
      const claim = getClaim(this.db, claimId)
      if (claim !== null) claims.push(claim)
    }
    const claimEntities = getEntitiesByIds(
      this.db,
      claims.flatMap((claim) => [
        claim.subjectId,
        ...(claim.object.kind === 'entity' ? [claim.object.entityId] : []),
      ]),
    )
    for (const claim of claims) {
      const subject = claimEntities.get(claim.subjectId)
      if (subject === undefined) continue
      const objectEntity =
        claim.object.kind === 'entity' ? (claimEntities.get(claim.object.entityId) ?? null) : null
      items.set(`claim:${claim.id}`, {
        sourceType: 'claim',
        sourceId: claim.id,
        content: claimDocumentText(claim, subject, objectEntity),
      })
    }

    const events: Event[] = []
    for (const eventId of eventIds) {
      const event = getEvent(this.db, asEventId(eventId))
      if (event !== null) events.push(event)
    }
    const eventParticipants = events.map((event) => {
      const participants = listEventParticipants(this.db, event.id).map((participant) => ({
        entityId: participant.entityId,
        role: participant.role,
      }))
      return { event, participants }
    })
    const participantEntities = getEntitiesByIds(
      this.db,
      eventParticipants.flatMap((item) =>
        item.participants.map((participant) => participant.entityId),
      ),
    )
    for (const item of eventParticipants) {
      const participants = item.participants.flatMap((participant) => {
        const entity = participantEntities.get(participant.entityId)
        return entity === undefined ? [] : [{ entity, role: participant.role }]
      })
      items.set(`event:${item.event.id}`, {
        sourceType: 'event',
        sourceId: item.event.id,
        content: eventDocumentText(item.event, participants),
      })
    }
    return [...items.values()]
  }
}

function speakerNameOf(message: Message): string {
  const value = message.metadata?.['speakerName']
  return typeof value === 'string' && value.length > 0 ? value : message.speakerId
}

function evidenceTypeOf(message: Message): string {
  if (message.role === 'user') return 'user_statement'
  if (message.role === 'assistant') return 'assistant_statement'
  return 'external'
}

function evidenceFor(
  ids: readonly MessageId[],
  focusId: MessageId,
  valid: Map<MessageId, Message>,
): MessageId[] {
  const result = ids.filter((id) => valid.has(id))
  return result.length > 0 ? result : [focusId]
}
