import { normalizeName } from "../text.ts";
import type { Entity, EntityId, EntityType, MemorySpaceId, MessageId } from "../types.ts";
import type { Database } from "../storage/database.ts";
import {
  findEntityByAlias,
  findEntityByName,
  findEntityBySpeakerId,
  insertAlias,
  insertEntity,
  listAliasesBySpace,
  listEntities,
  updateEntity,
} from "../storage/memory-repo.ts";
import type { KnownEntity } from "../providers/types.ts";

export interface ResolveEntityInput {
  spaceId: MemorySpaceId;
  name: string;
  type: EntityType;
  description?: string;
  aliases?: readonly string[];
  sourceMessageId?: MessageId;
}

export class EntityResolver {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  resolve(input: ResolveEntityInput): Entity {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("entity name cannot be empty");
    }
    const existing =
      findEntityByName(this.db, input.spaceId, name) ??
      findEntityByAlias(this.db, input.spaceId, name);
    if (existing !== null) {
      if (
        input.description !== undefined &&
        input.description.length > 0 &&
        existing.description === null
      ) {
        updateEntity(this.db, existing.id, { description: input.description });
      }
      for (const alias of input.aliases ?? []) {
        const cleaned = alias.trim();
        if (cleaned.length === 0 || normalizeName(cleaned) === normalizeName(existing.name)) {
          continue;
        }
        insertAlias(this.db, {
          spaceId: input.spaceId,
          entityId: existing.id,
          alias: cleaned,
          ...(input.sourceMessageId === undefined
            ? {}
            : { sourceMessageId: input.sourceMessageId }),
        });
      }
      return existing;
    }
    const entity = insertEntity(this.db, {
      spaceId: input.spaceId,
      name,
      type: input.type,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    for (const alias of input.aliases ?? []) {
      const cleaned = alias.trim();
      if (cleaned.length === 0 || normalizeName(cleaned) === normalizeName(name)) continue;
      insertAlias(this.db, {
        spaceId: input.spaceId,
        entityId: entity.id,
        alias: cleaned,
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      });
    }
    return entity;
  }

  resolveSpeaker(input: {
    spaceId: MemorySpaceId;
    speakerId: string;
    speakerName: string;
    role: "user" | "assistant" | "system" | "tool";
  }): Entity {
    const bySpeaker = findEntityBySpeakerId(this.db, input.spaceId, input.speakerId);
    if (bySpeaker !== null) return bySpeaker;
    const displayName =
      input.speakerName.trim().length > 0 ? input.speakerName.trim() : input.speakerId;
    const existing =
      findEntityByName(this.db, input.spaceId, displayName) ??
      findEntityByAlias(this.db, input.spaceId, displayName);
    if (existing !== null) return existing;
    const type: EntityType =
      input.role === "assistant" ? "ai" : input.role === "user" ? "person" : "other";
    return insertEntity(this.db, {
      spaceId: input.spaceId,
      name: displayName,
      type,
      metadata: { speakerId: input.speakerId },
    });
  }

  findSpeaker(spaceId: MemorySpaceId, speakerId: string): Entity | null {
    const bySpeaker = findEntityBySpeakerId(this.db, spaceId, speakerId);
    if (bySpeaker !== null) return bySpeaker;
    return (
      findEntityByName(this.db, spaceId, speakerId) ??
      findEntityByAlias(this.db, spaceId, speakerId)
    );
  }

  knownEntities(spaceId: MemorySpaceId): KnownEntity[] {
    const entities = listEntities(this.db, spaceId);
    const aliases = listAliasesBySpace(this.db, spaceId);
    return entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      aliases: aliases.get(entity.id) ?? [],
    }));
  }

  findMentioned(spaceId: MemorySpaceId, text: string, limit = 5): Entity[] {
    const normalized = normalizeName(text);
    const aliases = listAliasesBySpace(this.db, spaceId);
    const matches: Array<{ entity: Entity; length: number }> = [];
    for (const entity of listEntities(this.db, spaceId)) {
      const names = [entity.name, ...(aliases.get(entity.id) ?? [])];
      let best = 0;
      for (const name of names) {
        const normalizedName = normalizeName(name);
        if (normalizedName.length >= 2 && normalized.includes(normalizedName)) {
          best = Math.max(best, normalizedName.length);
        }
      }
      if (best > 0) matches.push({ entity, length: best });
    }
    matches.sort((left, right) => right.length - left.length);
    return matches.slice(0, limit).map((match) => match.entity);
  }

  aliasMap(spaceId: MemorySpaceId): Map<EntityId, string[]> {
    return listAliasesBySpace(this.db, spaceId);
  }
}
