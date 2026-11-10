import type { KnownEntity } from '../providers/types.ts'
import type { Database } from '../storage/database.ts'
import type {
  Entity,
  EntityId,
  EntityKind,
  MemoryDisclosure,
  MemorySensitivity,
  MemorySpaceId,
  MessageId,
  SelfIdentity,
} from '../types.ts'

import {
  findEntityByAlias,
  findEntityByName,
  findEntityBySpeakerId,
  findSelfEntity,
  getEntity,
  insertAlias,
  insertEntity,
  listAliasesBySpace,
  listEntities,
  updateEntity,
} from '../storage/memory-repo.ts'
import { normalizeName } from '../text.ts'
import { mergeRestriction, restrictionOf } from './restriction.ts'

export interface ResolveEntityInput {
  spaceId: MemorySpaceId
  name: string
  type: EntityKind
  description?: string
  aliases?: readonly string[]
  sensitivity?: MemorySensitivity
  disclosure?: MemoryDisclosure
  sourceMessageId?: MessageId
}

export class EntityResolver {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  resolve(input: ResolveEntityInput): Entity {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new Error('entity name cannot be empty')
    }
    const self = findSelfEntity(this.db, input.spaceId)
    if (self !== null && this.matchesSelf(self, input.spaceId, name)) {
      if (self.type !== 'self') {
        updateEntity(this.db, self.id, { type: 'self' })
      }
      const current = self.type === 'self' ? self : { ...self, type: 'self' as const }
      this.updateDetails(current, input, name)
      return current
    }
    let existing =
      findEntityByName(this.db, input.spaceId, name) ??
      findEntityByAlias(this.db, input.spaceId, name)
    if (existing !== null) {
      if (existing.type === 'self' && existing.id !== self?.id) {
        updateEntity(this.db, existing.id, { type: 'artifact' })
        return { ...existing, type: 'artifact' }
      }
      if (self !== null && existing.id === self.id && existing.type !== 'self') {
        updateEntity(this.db, existing.id, { type: 'self' })
        existing = { ...existing, type: 'self' }
      }
      this.updateDetails(existing, input, name)
      return existing
    }
    const type = input.type === 'self' ? 'artifact' : input.type
    const entity = insertEntity(this.db, {
      spaceId: input.spaceId,
      name,
      type,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
      ...(input.disclosure === undefined ? {} : { disclosure: input.disclosure }),
    })
    this.addAliases(entity, input.aliases, input.sourceMessageId, name)
    return entity
  }

  ensureSelf(spaceId: MemorySpaceId, input: SelfIdentity): Entity {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new Error('self name cannot be empty')
    }
    const existing =
      findSelfEntity(this.db, spaceId) ??
      findEntityByName(this.db, spaceId, name) ??
      findEntityByAlias(this.db, spaceId, name)
    if (existing !== null) {
      return this.writeSelf(existing, input)
    }
    const entity = insertEntity(this.db, {
      spaceId,
      name,
      type: 'self',
      ...(input.description === undefined ? {} : { description: input.description }),
      metadata: { self: true },
    })
    this.addAliases(entity, input.aliases, undefined, name)
    return entity
  }

  self(spaceId: MemorySpaceId): Entity | null {
    return findSelfEntity(this.db, spaceId)
  }

  resolveSpeaker(input: {
    spaceId: MemorySpaceId
    speakerId: string
    speakerName: string
    role: 'user' | 'assistant' | 'system' | 'tool'
  }): Entity {
    const displayName =
      input.speakerName.trim().length > 0 ? input.speakerName.trim() : input.speakerId
    if (input.role === 'assistant') {
      return this.resolveSelfSpeaker(input.spaceId, input.speakerId, displayName)
    }
    const self = findSelfEntity(this.db, input.spaceId)
    const bySpeaker = findEntityBySpeakerId(this.db, input.spaceId, input.speakerId)
    if (bySpeaker !== null && bySpeaker.id !== self?.id) return bySpeaker
    const existing =
      findEntityByName(this.db, input.spaceId, displayName) ??
      findEntityByAlias(this.db, input.spaceId, displayName)
    if (existing !== null && existing.id !== self?.id) return existing
    return insertEntity(this.db, {
      spaceId: input.spaceId,
      name: displayName,
      type: input.role === 'user' ? 'person' : 'other',
      metadata: { speakerId: input.speakerId },
    })
  }

  private resolveSelfSpeaker(
    spaceId: MemorySpaceId,
    speakerId: string,
    speakerName: string,
  ): Entity {
    const self = findSelfEntity(this.db, spaceId)
    if (self !== null) {
      this.attachSpeaker(self, speakerId, speakerName)
      return getEntity(this.db, self.id) ?? self
    }
    const existing =
      findEntityBySpeakerId(this.db, spaceId, speakerId) ??
      findEntityByName(this.db, spaceId, speakerName) ??
      findEntityByAlias(this.db, spaceId, speakerName)
    if (existing !== null) {
      const promoted = this.writeSelf(existing, { name: speakerName })
      this.attachSpeaker(promoted, speakerId, speakerName)
      return getEntity(this.db, promoted.id) ?? promoted
    }
    return insertEntity(this.db, {
      spaceId,
      name: speakerName,
      type: 'self',
      metadata: { speakerId, self: true },
    })
  }

  private writeSelf(entity: Entity, input: SelfIdentity): Entity {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new Error('self name cannot be empty')
    }
    if (normalizeName(name) !== normalizeName(entity.name)) {
      insertAlias(this.db, {
        spaceId: entity.memorySpaceId,
        entityId: entity.id,
        alias: entity.name,
      })
    }
    updateEntity(this.db, entity.id, {
      name,
      type: 'self',
      ...(input.description === undefined ? {} : { description: input.description }),
      metadata: { ...entity.metadata, self: true },
    })
    this.addAliases(entity, input.aliases, undefined, name)
    return getEntity(this.db, entity.id) ?? entity
  }

  private attachSpeaker(self: Entity, speakerId: string, speakerName: string): void {
    const metadata: Record<string, unknown> = { ...self.metadata, self: true }
    if (typeof metadata['speakerId'] !== 'string') {
      metadata['speakerId'] = speakerId
    }
    if (
      self.type !== 'self' ||
      self.metadata?.['self'] !== true ||
      metadata['speakerId'] !== self.metadata?.['speakerId']
    ) {
      updateEntity(this.db, self.id, { type: 'self', metadata })
    }
    if (normalizeName(speakerName) !== normalizeName(self.name)) {
      this.addAliases(self, [speakerName], undefined, self.name)
    }
  }

  private matchesSelf(self: Entity, spaceId: MemorySpaceId, name: string): boolean {
    if (normalizeName(self.name) === normalizeName(name)) return true
    return findEntityByAlias(this.db, spaceId, name)?.id === self.id
  }

  private updateDetails(entity: Entity, input: ResolveEntityInput, name: string): void {
    if (
      input.description !== undefined &&
      input.description.length > 0 &&
      entity.description === null
    ) {
      updateEntity(this.db, entity.id, { description: input.description })
    }
    const merged = mergeRestriction(restrictionOf(entity), restrictionOf(input))
    if (merged !== null) {
      updateEntity(this.db, entity.id, merged)
      Object.assign(entity, merged)
    }
    this.addAliases(entity, input.aliases, input.sourceMessageId, name)
  }

  private addAliases(
    entity: Entity,
    aliases: readonly string[] | undefined,
    sourceMessageId: MessageId | undefined,
    canonicalName: string,
  ): void {
    for (const alias of aliases ?? []) {
      const cleaned = alias.trim()
      if (cleaned.length === 0 || normalizeName(cleaned) === normalizeName(canonicalName)) {
        continue
      }
      insertAlias(this.db, {
        spaceId: entity.memorySpaceId,
        entityId: entity.id,
        alias: cleaned,
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      })
    }
  }

  addAlias(entity: Entity, alias: string, sourceMessageId?: MessageId): void {
    this.addAliases(entity, [alias], sourceMessageId, entity.name)
  }

  findSpeaker(spaceId: MemorySpaceId, speakerId: string): Entity | null {
    const bySpeaker = findEntityBySpeakerId(this.db, spaceId, speakerId)
    if (bySpeaker !== null) return bySpeaker
    return (
      findEntityByName(this.db, spaceId, speakerId) ??
      findEntityByAlias(this.db, spaceId, speakerId)
    )
  }

  knownEntities(spaceId: MemorySpaceId, texts: readonly string[], limit = 50): KnownEntity[] {
    if (limit <= 0) return []
    const aliases = listAliasesBySpace(this.db, spaceId)
    const self = findSelfEntity(this.db, spaceId)
    const result: KnownEntity[] = self === null ? [] : [toKnownEntity(self, aliases)]
    const normalizedTexts = texts
      .map((text) => normalizeName(text))
      .filter((text) => text.length > 0)
    if (normalizedTexts.length === 0) return result.slice(0, limit)
    const matches: Array<{ entity: Entity; textIndex: number; matchLength: number }> = []
    for (const entity of listEntities(this.db, spaceId)) {
      if (self !== null && entity.id === self.id) continue
      const names = [entity.name, ...(aliases.get(entity.id) ?? [])]
      let textIndex = -1
      let matchLength = 0
      for (const name of names) {
        const normalizedName = normalizeName(name)
        if (normalizedName.length < 2) continue
        for (const [index, text] of normalizedTexts.entries()) {
          if (!text.includes(normalizedName)) continue
          if (
            textIndex === -1 ||
            index < textIndex ||
            (index === textIndex && normalizedName.length > matchLength)
          ) {
            textIndex = index
            matchLength = normalizedName.length
          }
        }
      }
      if (textIndex !== -1) matches.push({ entity, textIndex, matchLength })
    }
    matches.sort(
      (left, right) =>
        left.textIndex - right.textIndex ||
        right.matchLength - left.matchLength ||
        left.entity.name.localeCompare(right.entity.name),
    )
    for (const { entity } of matches) {
      if (result.length >= limit) break
      result.push(toKnownEntity(entity, aliases))
    }
    return result
  }

  findMentioned(spaceId: MemorySpaceId, text: string, limit = 5): Entity[] {
    const normalized = normalizeName(text)
    const aliases = listAliasesBySpace(this.db, spaceId)
    const matches: Array<{ entity: Entity; length: number }> = []
    for (const entity of listEntities(this.db, spaceId)) {
      const names = [entity.name, ...(aliases.get(entity.id) ?? [])]
      let best = 0
      for (const name of names) {
        const normalizedName = normalizeName(name)
        if (normalizedName.length >= 2 && normalized.includes(normalizedName)) {
          best = Math.max(best, normalizedName.length)
        }
      }
      if (best > 0) matches.push({ entity, length: best })
    }
    matches.sort((left, right) => right.length - left.length)
    return matches.slice(0, limit).map((match) => match.entity)
  }

  aliasMap(spaceId: MemorySpaceId): Map<EntityId, string[]> {
    return listAliasesBySpace(this.db, spaceId)
  }
}

function toKnownEntity(entity: Entity, aliases: Map<EntityId, string[]>): KnownEntity {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    aliases: aliases.get(entity.id) ?? [],
  }
}
