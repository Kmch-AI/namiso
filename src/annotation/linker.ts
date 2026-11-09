import type { EntityResolver } from '../annotation/entity-resolver.ts'
import type { ExtractedClaim, ExtractedEvent } from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type {
  Claim,
  ClaimCardinality,
  ClaimChange,
  ClaimObject,
  ClaimStatus,
  Entity,
  EntityId,
  Event,
  MemorySpaceId,
  MessageId,
} from '../types.ts'

import { nowSeconds } from '../ids.ts'
import {
  addMemoryLink,
  addParticipant,
  findEventBySignature,
  findPreviousEventForActor,
  insertClaim,
  insertEvent,
  listClaimsBySubject,
  setClaimStatus,
} from '../storage/memory-repo.ts'

export interface ClaimWriteResult {
  claim: Claim
  created: boolean
  superseded: Claim[]
  subject: Entity
  objectEntity: Entity | null
}

export interface ClaimStateInput {
  extracted: ExtractedClaim
  attribute: string
  cardinality: ClaimCardinality
  change: ClaimChange
}

export interface EventWriteResult {
  event: Event
  created: boolean
  participants: Array<{ entity: Entity; role: string }>
  affectedClaims: Claim[]
}

export class MemoryLinker {
  private readonly db: Database
  private readonly resolver: EntityResolver

  constructor(db: Database, resolver: EntityResolver) {
    this.db = db
    this.resolver = resolver
  }

  applyClaim(
    spaceId: MemorySpaceId,
    input: ClaimStateInput,
    options: { extractorVersion: string; evidenceIds: readonly MessageId[] },
  ): ClaimWriteResult | null {
    const { extracted, attribute, cardinality, change } = input
    if (extracted.modality !== 'asserted') return null
    const subject = this.resolver.resolve({
      spaceId,
      name: extracted.subject.name,
      type: extracted.subject.type,
    })
    const objectEntity =
      extracted.object.kind === 'entity'
        ? this.resolver.resolve({
            spaceId,
            name: extracted.object.name,
            type: extracted.object.type,
          })
        : null
    const object: ClaimObject =
      objectEntity === null
        ? {
            kind: 'literal',
            value: extracted.object.kind === 'literal' ? extracted.object.value : '',
          }
        : { kind: 'entity', entityId: objectEntity.id }
    const metadata = {
      extractorVersion: options.extractorVersion,
      evidenceMessageIds: options.evidenceIds,
      modality: extracted.modality,
      attribute,
      cardinality,
      change,
    }
    const active = listClaimsBySubject(this.db, spaceId, subject.id).filter(
      (claim) => claim.attribute === attribute,
    )
    const assertedAt = extracted.validFrom ?? nowSeconds()
    const insert = (status?: ClaimStatus, validUntil?: number): Claim =>
      insertClaim(this.db, {
        spaceId,
        subjectId: subject.id,
        predicate: extracted.predicate,
        attribute,
        cardinality,
        object,
        confidence: extracted.confidence,
        ...(status === undefined ? {} : { status }),
        ...(extracted.validFrom === undefined ? {} : { validFrom: extracted.validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }),
        metadata,
      })

    if (change !== 'retracts') {
      const same = active.find((claim) => sameObject(claim.object, object))
      if (same !== undefined) {
        return { claim: same, created: false, superseded: [], subject, objectEntity }
      }
    }

    if (change === 'retracts') {
      const matching = active.filter((claim) => sameObject(claim.object, object))
      const first = matching[0]
      if (first !== undefined) {
        for (const claim of matching) {
          setClaimStatus(this.db, claim.id, 'retracted', assertedAt)
        }
        return {
          claim: first,
          created: false,
          superseded: matching,
          subject,
          objectEntity,
        }
      }
      const claim = insert('retracted')
      return { claim, created: true, superseded: [], subject, objectEntity }
    }

    if (change === 'disputes') {
      const claim = insert()
      return { claim, created: true, superseded: [], subject, objectEntity }
    }

    const replacing =
      change === 'replaces' || ((change === 'new' || change === 'adds') && cardinality === 'one')
    if (!replacing) {
      const claim = insert()
      return { claim, created: true, superseded: [], subject, objectEntity }
    }

    const targets =
      cardinality === 'one' ? active : active.filter((claim) => sameObject(claim.object, object))
    if (change === 'new' && cardinality === 'one' && targets.length > 0) {
      const newer = targets.filter((claim) => (claim.validFrom ?? claim.createdAt) > assertedAt)
      if (newer.length === targets.length) {
        const validUntil = Math.min(...targets.map((claim) => claim.validFrom ?? claim.createdAt))
        const claim = insert('superseded', validUntil)
        return { claim, created: true, superseded: [], subject, objectEntity }
      }
    }
    const claim = insert()
    const superseded: Claim[] = []
    for (const target of targets) {
      setClaimStatus(this.db, target.id, 'superseded', assertedAt)
      addMemoryLink(this.db, {
        spaceId,
        sourceType: 'claim',
        sourceId: claim.id,
        relation: 'supersedes',
        targetType: 'claim',
        targetId: target.id,
      })
      superseded.push(target)
    }
    return { claim, created: true, superseded, subject, objectEntity }
  }

  applyEvent(
    spaceId: MemorySpaceId,
    extracted: ExtractedEvent,
    options: { extractorVersion: string; evidenceIds: readonly MessageId[] },
  ): EventWriteResult {
    const participants: Array<{ entity: Entity; role: string }> = []
    for (const participant of extracted.participants) {
      const entity = this.resolver.resolve({
        spaceId,
        name: participant.name,
        type: participant.type,
      })
      participants.push({ entity, role: participant.role })
    }
    const occurredAt = extracted.occurredAt ?? null
    const existing = findEventBySignature(
      this.db,
      spaceId,
      extracted.type,
      extracted.summary,
      occurredAt,
    )
    if (existing !== null) {
      for (const participant of participants) {
        addParticipant(this.db, existing.id, participant.entity.id, participant.role)
      }
      return { event: existing, created: false, participants, affectedClaims: [] }
    }
    const event = insertEvent(this.db, {
      spaceId,
      type: extracted.type,
      summary: extracted.summary,
      ...(extracted.description === undefined ? {} : { description: extracted.description }),
      ...(extracted.occurredAt === undefined ? {} : { occurredAt: extracted.occurredAt }),
      timePrecision: extracted.timePrecision ?? 'unknown',
      confidence: extracted.confidence,
      metadata: {
        extractorVersion: options.extractorVersion,
        evidenceMessageIds: options.evidenceIds,
        modality: extracted.modality,
      },
    })
    for (const participant of participants) {
      addParticipant(this.db, event.id, participant.entity.id, participant.role)
    }

    const affectedClaims: Claim[] = []
    const actor = participants.find((participant) => participant.role === 'actor')
    const objectEntity = participants.find((participant) => participant.role === 'object')
    if (actor !== undefined) {
      const previousEvent = findPreviousEventForActor(
        this.db,
        spaceId,
        extracted.type,
        actor.entity.id,
        event.id,
      )
      if (previousEvent !== null) {
        addMemoryLink(this.db, {
          spaceId,
          sourceType: 'event',
          sourceId: event.id,
          relation:
            extracted.type === 'usage_change' || extracted.type === 'usage_stop'
              ? 'supersedes'
              : 'related_to',
          targetType: 'event',
          targetId: previousEvent.id,
        })
      }
      if (extracted.modality === 'asserted') {
        if (extracted.type === 'usage_change' && objectEntity !== undefined) {
          affectedClaims.push(
            ...this.replaceUsesClaim(
              spaceId,
              actor.entity,
              objectEntity.entity,
              extracted,
              options,
            ),
          )
        } else if (extracted.type === 'usage_stop') {
          affectedClaims.push(...this.stopUsesClaims(spaceId, actor.entity, extracted))
        }
      }
    }

    return { event, created: true, participants, affectedClaims }
  }

  private replaceUsesClaim(
    spaceId: MemorySpaceId,
    actor: Entity,
    object: Entity,
    extracted: ExtractedEvent,
    options: { extractorVersion: string; evidenceIds: readonly MessageId[] },
  ): Claim[] {
    const active = listClaimsBySubject(this.db, spaceId, actor.id).filter(
      (claim) => claim.attribute === 'uses',
    )
    const same = active.find(
      (claim) => claim.object.kind === 'entity' && claim.object.entityId === object.id,
    )
    if (same !== undefined) return []
    const superseded: Claim[] = []
    for (const claim of active) {
      setClaimStatus(this.db, claim.id, 'superseded', extracted.occurredAt ?? nowSeconds())
      superseded.push(claim)
    }
    const claim = insertClaim(this.db, {
      spaceId,
      subjectId: actor.id,
      predicate: 'uses',
      attribute: 'uses',
      cardinality: 'one',
      object: { kind: 'entity', entityId: object.id },
      confidence: extracted.confidence,
      ...(extracted.occurredAt === undefined ? {} : { validFrom: extracted.occurredAt }),
      metadata: {
        extractorVersion: options.extractorVersion,
        evidenceMessageIds: options.evidenceIds,
        derivedFromEvent: extracted.type,
      },
    })
    for (const previous of superseded) {
      addMemoryLink(this.db, {
        spaceId,
        sourceType: 'claim',
        sourceId: claim.id,
        relation: 'supersedes',
        targetType: 'claim',
        targetId: previous.id,
      })
    }
    return [...superseded, claim]
  }

  private stopUsesClaims(
    spaceId: MemorySpaceId,
    actor: Entity,
    extracted: ExtractedEvent,
  ): Claim[] {
    const active = listClaimsBySubject(this.db, spaceId, actor.id).filter(
      (claim) => claim.attribute === 'uses',
    )
    for (const claim of active) {
      setClaimStatus(this.db, claim.id, 'superseded', extracted.occurredAt ?? nowSeconds())
    }
    return active
  }
}

function sameObject(left: ClaimObject, right: ClaimObject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'literal' && right.kind === 'literal') {
    return left.value.trim().toLowerCase() === right.value.trim().toLowerCase()
  }
  if (left.kind === 'entity' && right.kind === 'entity') {
    return left.entityId === right.entityId
  }
  return false
}

export function entityIdsOf(claims: readonly Claim[]): EntityId[] {
  const ids = new Set<EntityId>()
  for (const claim of claims) {
    ids.add(claim.subjectId)
    if (claim.object.kind === 'entity') ids.add(claim.object.entityId)
  }
  return [...ids]
}
