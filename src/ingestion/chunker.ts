import { hashText } from "../text.ts";
import type { ChunkInput } from "../storage/chunk-repo.ts";
import type { ConversationId, Message } from "../types.ts";

export interface ChunkPolicy {
  size: number;
  overlap: number;
}

export const DEFAULT_CHUNK_POLICY: ChunkPolicy = { size: 8, overlap: 2 };

export function buildChunks(
  conversationId: ConversationId,
  messages: readonly Message[],
  policy: ChunkPolicy = DEFAULT_CHUNK_POLICY,
): ChunkInput[] {
  if (messages.length === 0) return [];
  const size = Math.max(1, policy.size);
  const overlap = Math.max(0, Math.min(policy.overlap, size - 1));
  const stride = Math.max(1, size - overlap);
  const chunks: ChunkInput[] = [];
  let ordinal = 0;
  let lastCovered = -1;
  for (let start = 0; start < messages.length; start += stride) {
    const window = messages.slice(start, start + size);
    const first = window[0];
    const last = window[window.length - 1];
    if (first === undefined || last === undefined) break;
    if (last.messageIndex <= lastCovered) break;
    lastCovered = last.messageIndex;
    const content = window
      .map((message) => `${message.speakerId}（${message.role}）：${message.content}`)
      .join("\n");
    chunks.push({
      id: `chunk:${conversationId}:${ordinal}`,
      ordinal,
      firstMessageIndex: first.messageIndex,
      lastMessageIndex: last.messageIndex,
      startedAt: first.occurredAt,
      endedAt: last.occurredAt,
      participants: [...new Set(window.map((message) => message.speakerId))],
      content,
      contentHash: hashText(content),
      messageIds: window.map((message) => message.id),
    });
    ordinal += 1;
  }
  return chunks;
}
