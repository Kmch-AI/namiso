import { claimDocumentText, entityDocumentText, eventDocumentText } from "../indexing/documents.ts";
import type {
  Claim,
  Event,
  MemoryCandidate,
  MemoryRelationView,
  MemorySourceType,
  MemorySpaceId,
  Message,
} from "../types.ts";
import type { Database } from "../storage/database.ts";
import { getChunk } from "../storage/chunk-repo.ts";
import {
  evidenceMessageIds,
  getClaim,
  getEntitiesByIds,
  getEntity,
  getEvent,
  listAliases,
  listEventParticipants,
  listLinksFrom,
  listLinksTo,
} from "../storage/memory-repo.ts";
import { asChunkId, asEntityId, asEventId } from "../ids.ts";

export function candidateFromSource(
  db: Database,
  spaceId: MemorySpaceId,
  sourceType: MemorySourceType,
  sourceId: string,
): MemoryCandidate | null {
  if (sourceType === "chunk") {
    const chunk = getChunk(db, asChunkId(sourceId));
    if (chunk === null || chunk.memorySpaceId !== spaceId) return null;
    return {
      key: `chunk:${chunk.id}`,
      kind: "chunk",
      title: `对话片段 ${chunk.ordinal + 1}`,
      text: chunk.content,
      score: 0,
      channels: [],
      occurredAt: chunk.startedAt,
      status: null,
      evidenceMessageIds: chunk.messageIds,
      relations: [],
      record: { kind: "chunk", chunk },
    };
  }
  if (sourceType === "entity") {
    const entity = getEntity(db, asEntityId(sourceId));
    if (entity === null || entity.memorySpaceId !== spaceId) return null;
    const aliases = listAliases(db, entity.id).map((alias) => alias.alias);
    return {
      key: `entity:${entity.id}`,
      kind: "entity",
      title: entity.name,
      text: entityDocumentText(entity, aliases),
      score: 0,
      channels: [],
      occurredAt: null,
      status: null,
      evidenceMessageIds: [],
      relations: relationViews(db, "entity", entity.id),
      record: { kind: "entity", entity, aliases },
    };
  }
  if (sourceType === "claim") {
    const claim = getClaim(db, sourceId);
    if (claim === null || claim.memorySpaceId !== spaceId) return null;
    return claimCandidate(db, claim);
  }
  const event = getEvent(db, asEventId(sourceId));
  if (event === null || event.memorySpaceId !== spaceId) return null;
  return eventCandidate(db, event);
}

export function claimCandidate(db: Database, claim: Claim): MemoryCandidate | null {
  const entities = getEntitiesByIds(db, [
    claim.subjectId,
    ...(claim.object.kind === "entity" ? [claim.object.entityId] : []),
  ]);
  const subject = entities.get(claim.subjectId);
  if (subject === undefined) return null;
  const objectEntity =
    claim.object.kind === "entity" ? (entities.get(claim.object.entityId) ?? null) : null;
  return {
    key: `claim:${claim.id}`,
    kind: "claim",
    title: `${subject.name} ${claim.predicate}`,
    text: claimDocumentText(claim, subject, objectEntity),
    score: 0,
    channels: [],
    occurredAt: claim.validFrom,
    status: claim.status,
    evidenceMessageIds: evidenceMessageIds(db, "claim", claim.id),
    relations: relationViews(db, "claim", claim.id),
    record: { kind: "claim", claim, subject, objectEntity },
  };
}

export function eventCandidate(db: Database, event: Event): MemoryCandidate | null {
  const participants = listEventParticipants(db, event.id);
  const entities = getEntitiesByIds(
    db,
    participants.map((participant) => participant.entityId),
  );
  const views = participants.flatMap((participant) => {
    const entity = entities.get(participant.entityId);
    return entity === undefined ? [] : [{ entity, role: participant.role }];
  });
  return {
    key: `event:${event.id}`,
    kind: "event",
    title: event.type,
    text: eventDocumentText(event, views),
    score: 0,
    channels: [],
    occurredAt: event.occurredAt,
    status: event.status,
    evidenceMessageIds: evidenceMessageIds(db, "event", event.id),
    relations: relationViews(db, "event", event.id),
    record: { kind: "event", event, participants: views },
  };
}

export function messageCandidate(message: Message): MemoryCandidate {
  return {
    key: `message:${message.id}`,
    kind: "message",
    title: `${message.speakerId} · ${new Date(message.occurredAt * 1000).toISOString()}`,
    text: `[${message.id}] ${message.content}`,
    score: 0,
    channels: [],
    occurredAt: message.occurredAt,
    status: null,
    evidenceMessageIds: [message.id],
    relations: [],
    record: { kind: "message", message },
  };
}

export function relationViews(
  db: Database,
  type: "entity" | "claim" | "event",
  id: string,
): MemoryRelationView[] {
  const outgoing = listLinksFrom(db, type, id).map((link) => ({
    relation: link.relation,
    direction: "outgoing" as const,
    targetKind: link.targetType,
    targetId: link.targetId,
  }));
  const incoming = listLinksTo(db, type, id).map((link) => ({
    relation: link.relation,
    direction: "incoming" as const,
    targetKind: link.sourceType,
    targetId: link.sourceId,
  }));
  return [...outgoing, ...incoming];
}
