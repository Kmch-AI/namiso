import { claimDocumentText, entityDocumentText, eventDocumentText } from "./documents.ts";
import type { Indexer } from "./indexer.ts";
import type { IndexItem } from "./indexer.ts";
import type { EntityResolver } from "../annotation/entity-resolver.ts";
import type { Database } from "../storage/database.ts";
import type { VectorStore } from "../storage/vector-store.ts";
import {
  getEntitiesByIds,
  listClaims,
  listEntities,
  listEventParticipants,
  listEvents,
} from "../storage/memory-repo.ts";
import { listChunks } from "../storage/chunk-repo.ts";
import { listDocuments } from "../storage/search-repo.ts";
import type { MemorySpaceId } from "../types.ts";

export async function rebuildIndexes(
  db: Database,
  vectors: VectorStore,
  indexer: Indexer,
  resolver: EntityResolver,
  spaceId: MemorySpaceId,
): Promise<{ documents: number }> {
  const documents = listDocuments(db, spaceId);
  db.transaction(() => {
    for (const document of documents) {
      vectors.remove(document.id);
    }
    db.run("DELETE FROM fts_documents WHERE memory_space_id = ?", spaceId);
    db.run("DELETE FROM embedding_documents WHERE memory_space_id = ?", spaceId);
  });

  const items: IndexItem[] = [];
  const aliases = resolver.aliasMap(spaceId);
  for (const entity of listEntities(db, spaceId)) {
    items.push({
      sourceType: "entity",
      sourceId: entity.id,
      content: entityDocumentText(entity, aliases.get(entity.id) ?? []),
    });
  }

  const claims = listClaims(db, spaceId);
  const claimEntities = getEntitiesByIds(
    db,
    claims.flatMap((claim) => [
      claim.subjectId,
      ...(claim.object.kind === "entity" ? [claim.object.entityId] : []),
    ]),
  );
  for (const claim of claims) {
    const subject = claimEntities.get(claim.subjectId);
    if (subject === undefined) continue;
    const objectEntity =
      claim.object.kind === "entity" ? (claimEntities.get(claim.object.entityId) ?? null) : null;
    items.push({
      sourceType: "claim",
      sourceId: claim.id,
      content: claimDocumentText(claim, subject, objectEntity),
    });
  }

  const events = listEvents(db, spaceId);
  const eventParticipants = events.map((event) => ({
    event,
    participants: listEventParticipants(db, event.id),
  }));
  const eventEntities = getEntitiesByIds(
    db,
    eventParticipants.flatMap((item) =>
      item.participants.map((participant) => participant.entityId),
    ),
  );
  for (const item of eventParticipants) {
    const participants = item.participants.flatMap((participant) => {
      const entity = eventEntities.get(participant.entityId);
      return entity === undefined ? [] : [{ entity, role: participant.role }];
    });
    items.push({
      sourceType: "event",
      sourceId: item.event.id,
      content: eventDocumentText(item.event, participants),
    });
  }

  for (const chunk of listChunks(db, spaceId)) {
    items.push({
      sourceType: "chunk",
      sourceId: chunk.id,
      content: chunk.content,
    });
  }

  await indexer.sync(spaceId, items);
  return { documents: items.length };
}
