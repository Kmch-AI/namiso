import { DEFAULT_CHUNK_POLICY, buildChunks } from "../ingestion/chunker.ts";
import type { ChunkPolicy } from "../ingestion/chunker.ts";
import type { Indexer } from "../indexing/indexer.ts";
import { syncChunks } from "../storage/chunk-repo.ts";
import { listConversationMessages } from "../storage/conversation-repo.ts";
import type { Database } from "../storage/database.ts";
import type { ConversationId, MemorySpaceId } from "../types.ts";

export class ChunkService {
  private readonly db: Database;
  private readonly indexer: Indexer;
  private readonly policy: ChunkPolicy;

  constructor(db: Database, indexer: Indexer, policy: ChunkPolicy = DEFAULT_CHUNK_POLICY) {
    this.db = db;
    this.indexer = indexer;
    this.policy = policy;
  }

  async syncConversation(spaceId: MemorySpaceId, conversationId: ConversationId): Promise<void> {
    const messages = listConversationMessages(this.db, conversationId);
    const inputs = buildChunks(conversationId, messages, this.policy);
    const result = syncChunks(
      this.db,
      spaceId,
      conversationId,
      inputs,
      Math.floor(Date.now() / 1000),
    );
    for (const removedId of result.removedIds) {
      this.indexer.remove("chunk", removedId);
    }
    await this.indexer.sync(
      spaceId,
      result.chunks.map((chunk) => ({
        sourceType: "chunk" as const,
        sourceId: chunk.id,
        content: chunk.content,
      })),
    );
  }
}
