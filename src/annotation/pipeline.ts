import type { Indexer, IndexItem } from '../indexing/indexer.ts'
import type {
  ExtractionMessage,
  ExtractionProvider,
  ExtractionResult,
  ExtractedClaim,
  ExtractedEvent,
  KnownAttribute,
  KnownFact,
} from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type {
  Claim,
  ClaimCardinality,
  ClaimChange,
  Entity,
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
import { ensureAttribute, listAttributes } from '../storage/attribute-repo.ts'
import { getMessagesByIds, markMessagesConsolidated } from '../storage/conversation-repo.ts'
import {
  addAnnotation,
  getClaim,
  getEntitiesByIds,
  getEvent,
  getOrCreateEvidence,
  linkMemoryEvidence,
  listClaimsForEntities,
  listEventParticipants,
  setClaimRestriction,
  setEventRestriction,
} from '../storage/memory-repo.ts'
import { normalizeAttribute, normalizeName } from '../text.ts'
import { MemoryLinker } from './linker.ts'
import { isRestricted, mergeRestriction, restrictionOf } from './restriction.ts'

const KNOWN_ENTITY_LIMIT = 50
const KNOWN_ATTRIBUTE_LIMIT = 24
const KNOWN_FACT_LIMIT = 12
const NAME_ATTRIBUTES: ReadonlySet<string> = new Set([
  'name',
  '姓名',
  '名字',
  '昵称',
  '别名',
  'nickname',
  'alias',
])
const NAME_ALIAS_STOP = /[（(，,、；;：:\s“”"']/
const SELF_NAME =
  /(?:我叫|我的名字(?:是|叫))\s*(?!他|她|它|你|您)([^，。！？,!?\s]{1,20})|叫我\s*([^，。！？,!?\s]{1,20})/
const LEGACY_ONE_VALUED = new Set([
  'name',
  'occupation',
  'location',
  'age',
  'uses',
  'works_at',
  'status',
])

export class AnnotationPipeline {
  private readonly db: Database
  private readonly resolver: EntityResolver
  private readonly linker: MemoryLinker
  private readonly extractor: ExtractionProvider
  private readonly indexer: Indexer
  private readonly extractRoles: ReadonlySet<MessageRole>
  private readonly knownFacts: boolean

  constructor(
    db: Database,
    extractor: ExtractionProvider,
    indexer: Indexer,
    resolver: EntityResolver,
    extractRoles: readonly MessageRole[],
    knownFacts: boolean,
  ) {
    this.db = db
    this.extractor = extractor
    this.indexer = indexer
    this.resolver = resolver
    this.extractRoles = new Set(extractRoles)
    this.knownFacts = knownFacts
    this.linker = new MemoryLinker(db, resolver)
  }

  async runBatch(focus: readonly Message[], context: readonly Message[]): Promise<void> {
    const first = focus[0]
    if (first === undefined) return
    const spaceId = first.memorySpaceId
    const focusIds = focus.map((message) => message.id)
    const speakerNames = new Map<MessageId, string>()
    const entityIds = new Set<EntityId>()

    this.db.transaction(() => {
      for (const message of focus) {
        const speaker = this.resolver.resolveSpeaker({
          spaceId,
          speakerId: message.speakerId,
          speakerName: speakerNameOf(message),
          role: message.role,
        })
        speakerNames.set(message.id, speaker.name)
        entityIds.add(speaker.id)
        addAnnotation(this.db, {
          spaceId,
          messageId: message.id,
          targetType: 'entity',
          targetId: speaker.id,
          role: 'speaker',
          extractorVersion: this.extractor.version,
        })
      }
    })

    const extractable = focus.filter((message) => this.extractRoles.has(message.role))
    const extractionFocus = extractable[0]
    if (extractionFocus === undefined) {
      await this.indexer.sync(spaceId, this.indexItems(spaceId, entityIds, new Set(), new Set()))
      markMessagesConsolidated(this.db, focusIds)
      return
    }

    const messages: ExtractionMessage[] = [...context, ...focus].map((item) => ({
      id: item.id,
      role: item.role,
      speakerId: item.speakerId,
      speakerName: speakerNames.get(item.id) ?? speakerNameOf(item),
      content: item.content,
      occurredAt: item.occurredAt,
      messageIndex: item.messageIndex,
    }))

    const texts = [...focus, ...context].map((item) => item.content)
    const knownEntities = this.resolver.knownEntities(spaceId, texts, KNOWN_ENTITY_LIMIT)
    const extraction = await this.extractor.extract({
      memorySpaceId: spaceId,
      focusMessageIds: [extractionFocus.id, ...extractable.slice(1).map((item) => item.id)],
      messages,
      knownEntities,
      knownAttributes: this.knownAttributes(spaceId, texts),
      ...(this.knownFacts
        ? {
            knownFacts: this.factsFor(spaceId, [
              ...entityIds,
              ...knownEntities.map((entity) => entity.id),
            ]),
          }
        : {}),
    })

    const validEvidence = this.validEvidenceMap(spaceId, extraction, focusIds)
    const claimIds = new Set<string>()
    const eventIds = new Set<string>()
    const createdClaims: Array<{
      claim: Claim
      subject: Entity
      evidenceIds: readonly MessageId[]
    }> = []

    this.db.transaction(() => {
      this.captureNameAliases(spaceId, focus, extraction, speakerNames, validEvidence)

      for (const entity of extraction.entities) {
        const sourceMessageId =
          entity.evidenceMessageIds.find((id) => validEvidence.has(id)) ?? extractionFocus.id
        const resolved = this.resolver.resolve({
          spaceId,
          name: entity.name,
          type: entity.type,
          ...(entity.description === undefined ? {} : { description: entity.description }),
          ...(entity.aliases === undefined ? {} : { aliases: entity.aliases }),
          ...(entity.sensitivity === undefined ? {} : { sensitivity: entity.sensitivity }),
          ...(entity.disclosure === undefined ? {} : { disclosure: entity.disclosure }),
          sourceMessageId,
        })
        entityIds.add(resolved.id)
        addAnnotation(this.db, {
          spaceId,
          messageId: sourceMessageId,
          targetType: 'entity',
          targetId: resolved.id,
          role: 'mentioned',
          confidence: 0.8,
          extractorVersion: this.extractor.version,
        })
      }

      for (const claim of extraction.claims) {
        const evidenceIds = claim.evidenceMessageIds.filter((id) => validEvidence.has(id))
        if (evidenceIds.length === 0) continue
        const attributeKey =
          normalizeAttribute(claim.attribute ?? claim.predicate) ||
          normalizeAttribute(claim.predicate)
        if (attributeKey.length === 0) continue
        const declared: ClaimCardinality =
          claim.cardinality ?? (LEGACY_ONE_VALUED.has(claim.predicate) ? 'one' : 'many')
        const attribute = ensureAttribute(this.db, spaceId, {
          key: attributeKey,
          label: claim.predicate,
          cardinality: declared,
        })
        const change: ClaimChange = claim.change ?? 'new'
        const evidenceRoles = evidenceIds.flatMap((id) => {
          const message = validEvidence.get(id)
          return message === undefined ? [] : [message.role]
        })
        const result = this.linker.applyClaim(
          spaceId,
          {
            extracted: claim,
            attribute: attribute.key,
            cardinality: attribute.cardinality,
            change,
          },
          {
            extractorVersion: this.extractor.version,
            evidenceIds,
            evidenceRoles,
          },
        )
        if (result === null) continue
        this.upgradeClaimRestriction(result.claim, claim)
        if (result.created) {
          createdClaims.push({ claim: result.claim, subject: result.subject, evidenceIds })
        }
        entityIds.add(result.subject.id)
        if (result.objectEntity !== null) entityIds.add(result.objectEntity.id)
        claimIds.add(result.claim.id)
        for (const previous of result.superseded) claimIds.add(previous.id)
        this.attachClaimEvidence(spaceId, result.claim, evidenceIds, validEvidence)
        for (const messageId of evidenceIds) {
          addAnnotation(this.db, {
            spaceId,
            messageId,
            targetType: 'claim',
            targetId: result.claim.id,
            role: 'evidence',
            confidence: claim.confidence,
            extractorVersion: this.extractor.version,
          })
        }
      }

      for (const event of extraction.events) {
        const evidenceIds = event.evidenceMessageIds.filter((id) => validEvidence.has(id))
        if (evidenceIds.length === 0) continue
        const result = this.linker.applyEvent(spaceId, event, {
          extractorVersion: this.extractor.version,
          evidenceIds,
        })
        if (result.created) {
          this.linker.linkEventOccurrence(spaceId, result.event, evidenceIds)
        }
        this.upgradeEventRestriction(result.event, event)
        eventIds.add(result.event.id)
        for (const participant of result.participants) entityIds.add(participant.entity.id)
        this.attachEventEvidence(spaceId, result.event, evidenceIds, validEvidence)
        for (const messageId of evidenceIds) {
          addAnnotation(this.db, {
            spaceId,
            messageId,
            targetType: 'event',
            targetId: result.event.id,
            role: 'evidence',
            confidence: event.confidence,
            extractorVersion: this.extractor.version,
          })
        }
        for (const claim of result.affectedClaims) {
          claimIds.add(claim.id)
          this.attachClaimEvidence(spaceId, claim, evidenceIds, validEvidence)
          if (claim.object.kind === 'entity') entityIds.add(claim.object.entityId)
          entityIds.add(claim.subjectId)
        }
      }

      for (const created of createdClaims) {
        this.linker.linkOccurrence(spaceId, created.claim, created.subject, created.evidenceIds)
      }
    })

    await this.indexer.sync(spaceId, this.indexItems(spaceId, entityIds, claimIds, eventIds))
    markMessagesConsolidated(this.db, focusIds)
  }

  private captureNameAliases(
    spaceId: MemorySpaceId,
    focus: readonly Message[],
    extraction: ExtractionResult,
    speakerNames: ReadonlyMap<MessageId, string>,
    validEvidence: Map<MessageId, Message>,
  ): void {
    const blocked = new Set<string>()
    for (const claim of extraction.claims) {
      if (claim.object.kind !== 'literal') continue
      const key = normalizeAttribute(claim.attribute ?? claim.predicate)
      if (!NAME_ATTRIBUTES.has(key)) continue
      if (!isRestricted(restrictionOf(claim))) continue
      const alias = cleanAlias(claim.object.value)
      if (alias.length > 0) blocked.add(normalizeName(alias))
    }

    for (const message of focus) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const match = SELF_NAME.exec(message.content)
      if (match === null) continue
      const alias = cleanAlias(match[1] ?? match[2] ?? '')
      if (alias.length === 0 || alias.length > 24) continue
      if (blocked.has(normalizeName(alias))) continue
      const speaker = this.resolver.findSpeaker(spaceId, message.speakerId)
      if (speaker === null) continue
      this.resolver.addAlias(speaker, alias, message.id)
    }

    const speakers = new Set([...speakerNames.values()].map((name) => normalizeName(name)))
    for (const claim of extraction.claims) {
      if (claim.object.kind !== 'literal') continue
      const key = normalizeAttribute(claim.attribute ?? claim.predicate)
      if (!NAME_ATTRIBUTES.has(key)) continue
      if (isRestricted(restrictionOf(claim))) continue
      const alias = cleanAlias(claim.object.value)
      if (alias.length === 0 || alias.length > 24) continue
      const sourceMessageId = claim.evidenceMessageIds.find((id) => validEvidence.has(id))
      if (sourceMessageId === undefined) continue
      const message = validEvidence.get(sourceMessageId)
      if (message === undefined) continue
      const speakerNamed = speakers.has(normalizeName(claim.subject.name))
      const selfNamed =
        message.role === 'user' && normalizeName(claim.subject.name) === normalizeName(alias)
      if (!speakerNamed && !selfNamed) continue
      const subject = speakerNamed
        ? this.resolver.resolve({
            spaceId,
            name: claim.subject.name,
            type: claim.subject.type,
          })
        : this.resolver.findSpeaker(spaceId, message.speakerId)
      if (subject === null) continue
      this.resolver.addAlias(subject, alias, sourceMessageId)
    }
  }

  private upgradeClaimRestriction(stored: Claim, extracted: ExtractedClaim): void {
    const merged = mergeRestriction(restrictionOf(stored), restrictionOf(extracted))
    if (merged === null) return
    setClaimRestriction(this.db, stored.id, merged.sensitivity, merged.disclosure)
  }

  private upgradeEventRestriction(stored: Event, extracted: ExtractedEvent): void {
    const merged = mergeRestriction(restrictionOf(stored), restrictionOf(extracted))
    if (merged === null) return
    setEventRestriction(this.db, stored.id, merged.sensitivity, merged.disclosure)
  }

  private factsFor(spaceId: MemorySpaceId, entityIds: readonly EntityId[]): KnownFact[] {
    const ids = [...new Set(entityIds)]
    if (ids.length === 0) return []
    const claims = listClaimsForEntities(this.db, spaceId, ids, { limit: 200 }).filter(
      (claim) =>
        claim.modality === 'asserted' &&
        claim.polarity === 'positive' &&
        !isRestricted(restrictionOf(claim)),
    )
    const names = getEntitiesByIds(this.db, [
      ...new Set(
        claims.flatMap((claim) => [
          claim.subjectId,
          ...(claim.object.kind === 'entity' ? [claim.object.entityId] : []),
        ]),
      ),
    ])
    const rank = new Map(ids.map((id, index) => [id, index]))
    const ordered = claims.toSorted(
      (left, right) =>
        (rank.get(left.subjectId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.subjectId) ?? Number.MAX_SAFE_INTEGER) ||
        left.attribute.localeCompare(right.attribute) ||
        right.createdAt - left.createdAt,
    )
    const facts: KnownFact[] = []
    const seen = new Set<string>()
    for (const claim of ordered) {
      const subject = names.get(claim.subjectId)?.name
      const value =
        claim.object.kind === 'literal'
          ? claim.object.value
          : names.get(claim.object.entityId)?.name
      if (subject === undefined || value === undefined) continue
      const key = `${subject}\n${claim.predicate}\n${value}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.push({ subject, attribute: claim.predicate, value })
      if (facts.length >= KNOWN_FACT_LIMIT) break
    }
    return facts
  }

  private knownAttributes(spaceId: MemorySpaceId, texts: readonly string[]): KnownAttribute[] {
    const haystack = texts.join('\n').toLowerCase()
    return listAttributes(this.db, spaceId, 200)
      .filter(
        (attribute) =>
          haystack.includes(attribute.key) || haystack.includes(attribute.label.toLowerCase()),
      )
      .slice(0, KNOWN_ATTRIBUTE_LIMIT)
  }

  private validEvidenceMap(
    spaceId: MemorySpaceId,
    extraction: ExtractionResult,
    focusIds: readonly MessageId[],
  ): Map<MessageId, Message> {
    const ids = new Set<MessageId>(focusIds)
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

function cleanAlias(value: string): string {
  return (value.split(NAME_ALIAS_STOP)[0] ?? '').trim()
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
