import type { ChunkService } from "../ingestion/chunk-service.ts";
import type { Indexer } from "../indexing/indexer.ts";
import { listChunksByConversation } from "../storage/chunk-repo.ts";
import {
  getConversation,
  getMessagesByIds,
  listConversationMessages,
} from "../storage/conversation-repo.ts";
import type { Database } from "../storage/database.ts";
import { asConversationId, asEntityId, asEventId, asMessageId } from "../ids.ts";
import { getEntity, invalidateUnsupportedMemories } from "../storage/memory-repo.ts";
import type { MemorySpaceId } from "../types.ts";

export type ForgetInput =
  | { scope: "message"; messageIds: readonly string[] }
  | { scope: "conversation"; conversationId: string }
  | { scope: "entity"; entityId: string }
  | { scope: "event"; eventId: string };

export interface ForgetReport {
  deletedMessages: number;
  deletedConversations: number;
  deletedEntities: number;
  deletedClaims: number;
  deletedEvents: number;
}

export async function forget(
  db: Database,
  indexer: Indexer,
  chunks: ChunkService,
  spaceId: MemorySpaceId,
  input: ForgetInput,
): Promise<ForgetReport> {
  const report: ForgetReport = {
    deletedMessages: 0,
    deletedConversations: 0,
    deletedEntities: 0,
    deletedClaims: 0,
    deletedEvents: 0,
  };
  if (input.scope === "message") {
    const messages = getMessagesByIds(db, input.messageIds.map(asMessageId)).filter(
      (message) => message.memorySpaceId === spaceId,
    );
    const conversations = new Set(messages.map((message) => message.conversationId));
    const ids = messages.map((message) => message.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      db.transaction(() => {
        db.run(
          `DELETE FROM evidence
           WHERE memory_space_id = ? AND source_type = 'message'
             AND source_id IN (${placeholders})`,
          spaceId,
          ...ids,
        );
        report.deletedMessages = db.run(
          `DELETE FROM messages WHERE memory_space_id = ? AND id IN (${placeholders})`,
          spaceId,
          ...ids,
        );
        invalidateUnsupportedMemories(db, spaceId);
      });
    }
    for (const conversationId of conversations) {
      await chunks.syncConversation(spaceId, conversationId);
    }
    return report;
  }
  if (input.scope === "conversation") {
    const conversation = getConversation(db, asConversationId(input.conversationId));
    if (conversation === null || conversation.memorySpaceId !== spaceId) return report;
    const messages = listConversationMessages(db, conversation.id);
    const chunkRows = listChunksByConversation(db, conversation.id);
    for (const chunk of chunkRows) indexer.remove("chunk", chunk.id);
    db.transaction(() => {
      for (const message of messages) {
        db.run(
          `DELETE FROM evidence
           WHERE memory_space_id = ? AND source_type = 'message' AND source_id = ?`,
          spaceId,
          message.id,
        );
      }
      report.deletedConversations = db.run(
        "DELETE FROM conversations WHERE id = ? AND memory_space_id = ?",
        conversation.id,
        spaceId,
      );
      invalidateUnsupportedMemories(db, spaceId);
    });
    return report;
  }
  if (input.scope === "entity") {
    const entity = getEntity(db, asEntityId(input.entityId));
    if (entity === null || entity.memorySpaceId !== spaceId) return report;
    const claimRows = db.all(
      "SELECT id FROM claims WHERE subject_id = ? OR object_entity_id = ?",
      entity.id,
      entity.id,
    );
    const claimIds = claimRows.map((row) => String(row["id"]));
    for (const claimId of claimIds) indexer.remove("claim", claimId);
    db.transaction(() => {
      if (claimIds.length > 0) {
        const placeholders = claimIds.map(() => "?").join(", ");
        db.run(
          `DELETE FROM memory_evidence
           WHERE memory_type = 'claim' AND memory_id IN (${placeholders})`,
          ...claimIds,
        );
        db.run(
          `DELETE FROM annotations
           WHERE target_type = 'claim' AND target_id IN (${placeholders})`,
          ...claimIds,
        );
        db.run(
          `DELETE FROM memory_links
           WHERE (source_type = 'claim' AND source_id IN (${placeholders}))
              OR (target_type = 'claim' AND target_id IN (${placeholders}))`,
          ...claimIds,
          ...claimIds,
        );
      }
      db.run("DELETE FROM annotations WHERE target_type = 'entity' AND target_id = ?", entity.id);
      db.run(
        `DELETE FROM memory_links
         WHERE (source_type = 'entity' AND source_id = ?)
            OR (target_type = 'entity' AND target_id = ?)`,
        entity.id,
        entity.id,
      );
      report.deletedClaims = claimIds.length;
      report.deletedEntities = db.run(
        "DELETE FROM entities WHERE id = ? AND memory_space_id = ?",
        entity.id,
        spaceId,
      );
      invalidateUnsupportedMemories(db, spaceId);
    });
    indexer.remove("entity", entity.id);
    return report;
  }
  const event = db.get(
    "SELECT id FROM events WHERE id = ? AND memory_space_id = ?",
    input.eventId,
    spaceId,
  );
  if (event === undefined) return report;
  db.transaction(() => {
    db.run(
      "DELETE FROM memory_evidence WHERE memory_type = 'event' AND memory_id = ?",
      input.eventId,
    );
    db.run("DELETE FROM annotations WHERE target_type = 'event' AND target_id = ?", input.eventId);
    db.run(
      `DELETE FROM memory_links
       WHERE (source_type = 'event' AND source_id = ?)
          OR (target_type = 'event' AND target_id = ?)`,
      input.eventId,
      input.eventId,
    );
    report.deletedEvents = db.run(
      "DELETE FROM events WHERE id = ? AND memory_space_id = ?",
      asEventId(input.eventId),
      spaceId,
    );
    invalidateUnsupportedMemories(db, spaceId);
  });
  indexer.remove("event", input.eventId);
  return report;
}
