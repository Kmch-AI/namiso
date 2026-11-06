import type {
  Annotation,
  Claim,
  ClaimObject,
  ClaimStatus,
  Entity,
  EntityAlias,
  EntityId,
  EntityType,
  Event,
  EventId,
  EventParticipant,
  EventStatus,
  EvidenceId,
  MemoryLink,
  MemorySpaceId,
  MessageId,
  Relation,
  TimePrecision,
} from '../types.ts'
import type { Database } from './database.ts'

import {
  asAnnotationId,
  asClaimId,
  asEntityId,
  asEventId,
  asEvidenceId,
  asMemorySpaceId,
  asMessageId,
  nowSeconds,
} from '../ids.ts'
import { count, readNumber, text, textOrNull } from './database.ts'
import { mapClaim, mapEntity, mapEvent, mapMemoryLink } from './mappers.ts'

export interface InsertEntityInput {
  spaceId: MemorySpaceId
  name: string
  type: EntityType
  description?: string
  metadata?: Record<string, unknown>
  createdAt?: number
}

export function insertEntity(db: Database, input: InsertEntityInput): Entity {
  const id = asEntityId(crypto.randomUUID())
  const timestamp = input.createdAt ?? nowSeconds()
  db.run(
    `INSERT INTO entities (
      id, memory_space_id, type, name, description, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.spaceId,
    input.type,
    input.name,
    input.description ?? null,
    timestamp,
    timestamp,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
  return {
    id,
    memorySpaceId: input.spaceId,
    type: input.type,
    name: input.name,
    description: input.description ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: input.metadata ?? null,
  }
}

export function getEntity(db: Database, entityId: EntityId): Entity | null {
  const row = db.get('SELECT * FROM entities WHERE id = ?', entityId)
  return row === undefined ? null : mapEntity(row)
}

export function findEntityByName(
  db: Database,
  spaceId: MemorySpaceId,
  name: string,
): Entity | null {
  const row = db.get(
    'SELECT * FROM entities WHERE memory_space_id = ? AND name = ? COLLATE NOCASE LIMIT 1',
    spaceId,
    name,
  )
  return row === undefined ? null : mapEntity(row)
}

export function findEntityByAlias(
  db: Database,
  spaceId: MemorySpaceId,
  alias: string,
): Entity | null {
  const row = db.get(
    `SELECT e.* FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE a.memory_space_id = ? AND a.alias = ? COLLATE NOCASE
     LIMIT 1`,
    spaceId,
    alias,
  )
  return row === undefined ? null : mapEntity(row)
}

export function listEntities(db: Database, spaceId: MemorySpaceId): Entity[] {
  return db
    .all('SELECT * FROM entities WHERE memory_space_id = ? ORDER BY name ASC', spaceId)
    .map(mapEntity)
}

export function findEntityBySpeakerId(
  db: Database,
  spaceId: MemorySpaceId,
  speakerId: string,
): Entity | null {
  const row = db.get(
    `SELECT * FROM entities
     WHERE memory_space_id = ? AND json_extract(metadata, '$.speakerId') = ?
     LIMIT 1`,
    spaceId,
    speakerId,
  )
  return row === undefined ? null : mapEntity(row)
}

export function getEntitiesByIds(db: Database, ids: readonly EntityId[]): Map<EntityId, Entity> {
  const result = new Map<EntityId, Entity>()
  if (ids.length === 0) return result
  const unique = [...new Set(ids)]
  const placeholders = unique.map(() => '?').join(', ')
  const rows = db.all(`SELECT * FROM entities WHERE id IN (${placeholders})`, ...unique)
  for (const row of rows) {
    const entity = mapEntity(row)
    result.set(entity.id, entity)
  }
  return result
}

export function updateEntity(
  db: Database,
  entityId: EntityId,
  patch: { description?: string; name?: string; type?: EntityType },
): void {
  const current = getEntity(db, entityId)
  if (current === null) return
  db.run(
    'UPDATE entities SET name = ?, type = ?, description = ?, updated_at = ? WHERE id = ?',
    patch.name ?? current.name,
    patch.type ?? current.type,
    patch.description ?? current.description,
    nowSeconds(),
    entityId,
  )
}

export function insertAlias(
  db: Database,
  input: {
    spaceId: MemorySpaceId
    entityId: EntityId
    alias: string
    sourceMessageId?: MessageId
    confidence?: number
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO entity_aliases (
      id, memory_space_id, entity_id, alias, source_message_id, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.spaceId,
    input.entityId,
    input.alias,
    input.sourceMessageId ?? null,
    input.confidence ?? 1,
    nowSeconds(),
  )
}

export function listAliasesBySpace(db: Database, spaceId: MemorySpaceId): Map<EntityId, string[]> {
  const result = new Map<EntityId, string[]>()
  const rows = db.all(
    'SELECT entity_id, alias FROM entity_aliases WHERE memory_space_id = ? ORDER BY created_at ASC',
    spaceId,
  )
  for (const row of rows) {
    const entityId = asEntityId(text(row, 'entity_id'))
    const aliases = result.get(entityId) ?? []
    aliases.push(text(row, 'alias'))
    result.set(entityId, aliases)
  }
  return result
}

export function listAliases(db: Database, entityId: EntityId): EntityAlias[] {
  return db
    .all('SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY created_at ASC', entityId)
    .map((row) => {
      const sourceMessageId = textOrNull(row, 'source_message_id')
      return {
        id: text(row, 'id'),
        entityId: asEntityId(text(row, 'entity_id')),
        alias: text(row, 'alias'),
        sourceMessageId: sourceMessageId === null ? null : asMessageId(sourceMessageId),
        confidence: readNumber(row, 'confidence'),
      }
    })
}

export interface InsertClaimInput {
  spaceId: MemorySpaceId
  subjectId: EntityId
  predicate: string
  object: ClaimObject
  status?: ClaimStatus
  validFrom?: number
  validUntil?: number
  confidence?: number
  metadata?: Record<string, unknown>
  createdAt?: number
}

export function insertClaim(db: Database, input: InsertClaimInput): Claim {
  const id = asClaimId(crypto.randomUUID())
  const timestamp = input.createdAt ?? nowSeconds()
  const status = input.status ?? 'active'
  db.run(
    `INSERT INTO claims (
      id, memory_space_id, subject_id, predicate, object_type, object_value,
      object_entity_id, status, valid_from, valid_until, confidence, created_at,
      updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.spaceId,
    input.subjectId,
    input.predicate,
    input.object.kind,
    input.object.kind === 'literal' ? input.object.value : null,
    input.object.kind === 'entity' ? input.object.entityId : null,
    status,
    input.validFrom ?? null,
    input.validUntil ?? null,
    input.confidence ?? 1,
    timestamp,
    timestamp,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
  return {
    id,
    memorySpaceId: input.spaceId,
    subjectId: input.subjectId,
    predicate: input.predicate,
    object: input.object,
    status,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    confidence: input.confidence ?? 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: input.metadata ?? null,
  }
}

export function getClaim(db: Database, claimId: string): Claim | null {
  const row = db.get('SELECT * FROM claims WHERE id = ?', claimId)
  return row === undefined ? null : mapClaim(row)
}

export function findActiveClaim(
  db: Database,
  spaceId: MemorySpaceId,
  subjectId: EntityId,
  predicate: string,
): Claim | null {
  const row = db.get(
    `SELECT * FROM claims
     WHERE memory_space_id = ? AND subject_id = ? AND predicate = ? AND status = 'active'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    spaceId,
    subjectId,
    predicate,
  )
  return row === undefined ? null : mapClaim(row)
}

export function listClaimsBySubject(
  db: Database,
  spaceId: MemorySpaceId,
  subjectId: EntityId,
  options: { includeInactive?: boolean; limit?: number } = {},
): Claim[] {
  const statusClause = options.includeInactive === true ? '' : "AND status = 'active'"
  return db
    .all(
      `SELECT * FROM claims
       WHERE memory_space_id = ? AND subject_id = ? ${statusClause}
       ORDER BY predicate ASC, created_at DESC LIMIT ?`,
      spaceId,
      subjectId,
      options.limit ?? 200,
    )
    .map(mapClaim)
}

export function listClaimsForEntities(
  db: Database,
  spaceId: MemorySpaceId,
  entityIds: readonly EntityId[],
  options: { includeInactive?: boolean; limit?: number } = {},
): Claim[] {
  if (entityIds.length === 0) return []
  const placeholders = entityIds.map(() => '?').join(', ')
  const statusClause = options.includeInactive === true ? '' : "AND status = 'active'"
  return db
    .all(
      `SELECT * FROM claims
       WHERE memory_space_id = ?
         AND (subject_id IN (${placeholders}) OR object_entity_id IN (${placeholders}))
         ${statusClause}
       ORDER BY created_at DESC LIMIT ?`,
      spaceId,
      ...entityIds,
      ...entityIds,
      options.limit ?? 100,
    )
    .map(mapClaim)
}

export function listClaims(db: Database, spaceId: MemorySpaceId): Claim[] {
  return db
    .all('SELECT * FROM claims WHERE memory_space_id = ? ORDER BY created_at ASC', spaceId)
    .map(mapClaim)
}

export function listClaimsByEntity(
  db: Database,
  entityId: EntityId,
  options: { includeInactive?: boolean; limit?: number } = {},
): Claim[] {
  const statusClause = options.includeInactive === true ? '' : "AND status = 'active'"
  return db
    .all(
      `SELECT * FROM claims
       WHERE subject_id = ? ${statusClause}
       ORDER BY created_at DESC LIMIT ?`,
      entityId,
      options.limit ?? 100,
    )
    .map(mapClaim)
}

export function setClaimStatus(
  db: Database,
  claimId: string,
  status: ClaimStatus,
  validUntil?: number | null,
): void {
  db.run(
    'UPDATE claims SET status = ?, valid_until = COALESCE(?, valid_until), updated_at = ? WHERE id = ?',
    status,
    validUntil ?? null,
    nowSeconds(),
    claimId,
  )
}

export interface InsertEventInput {
  spaceId: MemorySpaceId
  type: string
  summary: string
  description?: string
  occurredAt?: number
  timePrecision?: TimePrecision
  status?: EventStatus
  confidence?: number
  metadata?: Record<string, unknown>
  createdAt?: number
}

export function insertEvent(db: Database, input: InsertEventInput): Event {
  const id = asEventId(crypto.randomUUID())
  const timestamp = input.createdAt ?? nowSeconds()
  const timePrecision = input.timePrecision ?? 'unknown'
  const status = input.status ?? 'active'
  db.run(
    `INSERT INTO events (
      id, memory_space_id, type, summary, description, occurred_at, time_precision,
      status, confidence, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.spaceId,
    input.type,
    input.summary,
    input.description ?? null,
    input.occurredAt ?? null,
    timePrecision,
    status,
    input.confidence ?? 1,
    timestamp,
    timestamp,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
  return {
    id,
    memorySpaceId: input.spaceId,
    type: input.type,
    summary: input.summary,
    description: input.description ?? null,
    occurredAt: input.occurredAt ?? null,
    timePrecision,
    status,
    confidence: input.confidence ?? 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: input.metadata ?? null,
  }
}

export function getEvent(db: Database, eventId: EventId): Event | null {
  const row = db.get('SELECT * FROM events WHERE id = ?', eventId)
  return row === undefined ? null : mapEvent(row)
}

export function findEventBySignature(
  db: Database,
  spaceId: MemorySpaceId,
  type: string,
  summary: string,
  occurredAt: number | null,
): Event | null {
  const row = db.get(
    `SELECT * FROM events
     WHERE memory_space_id = ? AND type = ? AND summary = ?
       AND (occurred_at IS ? OR occurred_at = ?)
     LIMIT 1`,
    spaceId,
    type,
    summary,
    occurredAt,
    occurredAt,
  )
  return row === undefined ? null : mapEvent(row)
}

export function addParticipant(
  db: Database,
  eventId: EventId,
  entityId: EntityId,
  role: string,
): void {
  db.run(
    'INSERT OR IGNORE INTO event_participants (event_id, entity_id, role) VALUES (?, ?, ?)',
    eventId,
    entityId,
    role,
  )
}

export function listEventParticipants(db: Database, eventId: EventId): EventParticipant[] {
  return db.all('SELECT * FROM event_participants WHERE event_id = ?', eventId).map((row) => ({
    eventId: asEventId(text(row, 'event_id')),
    entityId: asEntityId(text(row, 'entity_id')),
    role: text(row, 'role'),
  }))
}

export function listEventsForEntity(
  db: Database,
  spaceId: MemorySpaceId,
  entityId: EntityId,
  options: {
    includeInactive?: boolean
    from?: number
    to?: number
    limit?: number
  } = {},
): Event[] {
  const conditions = ['e.memory_space_id = ?', 'p.entity_id = ?']
  const params: Array<string | number> = [spaceId, entityId]
  if (options.includeInactive !== true) {
    conditions.push("e.status = 'active'")
  }
  if (options.from !== undefined) {
    conditions.push('e.occurred_at >= ?')
    params.push(options.from)
  }
  if (options.to !== undefined) {
    conditions.push('e.occurred_at <= ?')
    params.push(options.to)
  }
  return db
    .all(
      `SELECT DISTINCT e.* FROM events e
       JOIN event_participants p ON p.event_id = e.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT ?`,
      ...params,
      options.limit ?? 50,
    )
    .map(mapEvent)
}

export function listEventsForEntities(
  db: Database,
  spaceId: MemorySpaceId,
  entityIds: readonly EntityId[],
  options: {
    includeInactive?: boolean
    from?: number
    to?: number
    limit?: number
  } = {},
): Event[] {
  if (entityIds.length === 0) return []
  const placeholders = entityIds.map(() => '?').join(', ')
  const conditions = ['e.memory_space_id = ?', `p.entity_id IN (${placeholders})`]
  const params: Array<string | number> = [spaceId, ...entityIds]
  if (options.includeInactive !== true) {
    conditions.push("e.status = 'active'")
  }
  if (options.from !== undefined) {
    conditions.push('e.occurred_at >= ?')
    params.push(options.from)
  }
  if (options.to !== undefined) {
    conditions.push('e.occurred_at <= ?')
    params.push(options.to)
  }
  return db
    .all(
      `SELECT DISTINCT e.* FROM events e
       JOIN event_participants p ON p.event_id = e.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT ?`,
      ...params,
      options.limit ?? 80,
    )
    .map(mapEvent)
}

export function listEvents(db: Database, spaceId: MemorySpaceId): Event[] {
  return db
    .all('SELECT * FROM events WHERE memory_space_id = ? ORDER BY created_at ASC', spaceId)
    .map(mapEvent)
}

export function findPreviousEventForActor(
  db: Database,
  spaceId: MemorySpaceId,
  type: string,
  entityId: EntityId,
  excludeEventId: string,
): Event | null {
  const row = db.get(
    `SELECT e.* FROM events e
     JOIN event_participants p ON p.event_id = e.id
     WHERE e.memory_space_id = ? AND e.type = ? AND p.entity_id = ? AND e.id <> ?
     ORDER BY COALESCE(e.occurred_at, 0) DESC, e.created_at DESC LIMIT 1`,
    spaceId,
    type,
    entityId,
    excludeEventId,
  )
  return row === undefined ? null : mapEvent(row)
}

export function listRecentEvents(db: Database, spaceId: MemorySpaceId, limit: number): Event[] {
  return db
    .all(
      `SELECT * FROM events WHERE memory_space_id = ? AND status = 'active'
       ORDER BY occurred_at DESC, created_at DESC LIMIT ?`,
      spaceId,
      limit,
    )
    .map(mapEvent)
}

export function setEventStatus(db: Database, eventId: EventId, status: EventStatus): void {
  db.run('UPDATE events SET status = ?, updated_at = ? WHERE id = ?', status, nowSeconds(), eventId)
}

export function addAnnotation(
  db: Database,
  input: {
    spaceId: MemorySpaceId
    messageId: MessageId
    targetType: 'entity' | 'claim' | 'event'
    targetId: string
    role: string
    confidence?: number
    extractorVersion?: string
    metadata?: Record<string, unknown>
  },
): Annotation {
  const id = asAnnotationId(crypto.randomUUID())
  const createdAt = nowSeconds()
  db.run(
    `INSERT OR IGNORE INTO annotations (
      id, memory_space_id, message_id, target_type, target_id, role, confidence,
      extractor_version, created_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.spaceId,
    input.messageId,
    input.targetType,
    input.targetId,
    input.role,
    input.confidence ?? 1,
    input.extractorVersion ?? null,
    createdAt,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
  return {
    id,
    messageId: input.messageId,
    targetType: input.targetType,
    targetId: input.targetId,
    role: input.role,
    confidence: input.confidence ?? 1,
    extractorVersion: input.extractorVersion ?? null,
    createdAt,
    metadata: input.metadata ?? null,
  }
}

export function getOrCreateEvidence(
  db: Database,
  input: {
    spaceId: MemorySpaceId
    sourceType: string
    sourceId: string
    evidenceType: string
    contentSnapshot?: string
    confidence?: number
  },
): EvidenceId {
  const existing = db.get(
    `SELECT id FROM evidence
     WHERE memory_space_id = ? AND source_type = ? AND source_id = ? AND evidence_type = ?`,
    input.spaceId,
    input.sourceType,
    input.sourceId,
    input.evidenceType,
  )
  if (existing !== undefined) {
    return asEvidenceId(text(existing, 'id'))
  }
  const id = asEvidenceId(crypto.randomUUID())
  db.run(
    `INSERT INTO evidence (
      id, memory_space_id, source_type, source_id, evidence_type, content_snapshot,
      confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.spaceId,
    input.sourceType,
    input.sourceId,
    input.evidenceType,
    input.contentSnapshot ?? null,
    input.confidence ?? 1,
    nowSeconds(),
  )
  return id
}

export function linkMemoryEvidence(
  db: Database,
  memoryType: 'claim' | 'event',
  memoryId: string,
  evidenceId: EvidenceId,
): void {
  db.run(
    'INSERT OR IGNORE INTO memory_evidence (memory_type, memory_id, evidence_id) VALUES (?, ?, ?)',
    memoryType,
    memoryId,
    evidenceId,
  )
}

export function evidenceMessageIds(
  db: Database,
  memoryType: 'claim' | 'event',
  memoryId: string,
): MessageId[] {
  return db
    .all(
      `SELECT e.source_id FROM memory_evidence me
       JOIN evidence e ON e.id = me.evidence_id
       WHERE me.memory_type = ? AND me.memory_id = ? AND e.source_type = 'message'
       ORDER BY e.created_at ASC`,
      memoryType,
      memoryId,
    )
    .map((row) => asMessageId(text(row, 'source_id')))
}

export function addMemoryLink(
  db: Database,
  input: {
    spaceId: MemorySpaceId
    sourceType: 'entity' | 'claim' | 'event'
    sourceId: string
    relation: Relation
    targetType: 'entity' | 'claim' | 'event'
    targetId: string
    confidence?: number
    metadata?: Record<string, unknown>
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO memory_links (
      id, memory_space_id, source_type, source_id, relation, target_type, target_id,
      confidence, created_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.spaceId,
    input.sourceType,
    input.sourceId,
    input.relation,
    input.targetType,
    input.targetId,
    input.confidence ?? 1,
    nowSeconds(),
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
}

export function listLinksFrom(
  db: Database,
  type: 'entity' | 'claim' | 'event',
  id: string,
): MemoryLink[] {
  return db
    .all('SELECT * FROM memory_links WHERE source_type = ? AND source_id = ?', type, id)
    .map(mapMemoryLink)
}

export function listLinksTo(
  db: Database,
  type: 'entity' | 'claim' | 'event',
  id: string,
): MemoryLink[] {
  return db
    .all('SELECT * FROM memory_links WHERE target_type = ? AND target_id = ?', type, id)
    .map(mapMemoryLink)
}

export function entityCount(db: Database, spaceId: MemorySpaceId): number {
  return count(db.get('SELECT COUNT(*) AS n FROM entities WHERE memory_space_id = ?', spaceId), 'n')
}

export function claimCount(db: Database, spaceId: MemorySpaceId): number {
  return count(db.get('SELECT COUNT(*) AS n FROM claims WHERE memory_space_id = ?', spaceId), 'n')
}

export function eventCount(db: Database, spaceId: MemorySpaceId): number {
  return count(db.get('SELECT COUNT(*) AS n FROM events WHERE memory_space_id = ?', spaceId), 'n')
}

export function invalidateUnsupportedMemories(db: Database, spaceId: MemorySpaceId): void {
  const now = nowSeconds()
  db.run(
    `UPDATE claims SET status = 'invalid', updated_at = ?
     WHERE memory_space_id = ? AND status <> 'invalid'
       AND NOT EXISTS (
         SELECT 1 FROM memory_evidence me
         WHERE me.memory_type = 'claim' AND me.memory_id = claims.id
       )`,
    now,
    spaceId,
  )
  db.run(
    `UPDATE events SET status = 'invalid', updated_at = ?
     WHERE memory_space_id = ? AND status <> 'invalid'
       AND NOT EXISTS (
         SELECT 1 FROM memory_evidence me
         WHERE me.memory_type = 'event' AND me.memory_id = events.id
       )`,
    now,
    spaceId,
  )
}

export function listSpaceIds(db: Database): MemorySpaceId[] {
  return db
    .all('SELECT id FROM memory_spaces ORDER BY created_at ASC')
    .map((row) => asMemorySpaceId(text(row, 'id')))
}
