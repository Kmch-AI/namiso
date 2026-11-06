import type { Chunk, ChunkId, ConversationId, MemorySpaceId, MessageId } from '../types.ts'
import type { Database } from './database.ts'

import { asChunkId, asMessageId } from '../ids.ts'
import { count, text } from './database.ts'
import { mapChunk } from './mappers.ts'

export interface ChunkInput {
  id: string
  ordinal: number
  firstMessageIndex: number
  lastMessageIndex: number
  startedAt: number
  endedAt: number
  participants: string[]
  content: string
  contentHash: string
  messageIds: MessageId[]
}

export interface SyncChunksResult {
  chunks: Chunk[]
  changed: Chunk[]
  removedIds: ChunkId[]
}

export function syncChunks(
  db: Database,
  spaceId: MemorySpaceId,
  conversationId: ConversationId,
  inputs: readonly ChunkInput[],
  createdAt: number,
): SyncChunksResult {
  return db.transaction(() => {
    const existingRows = db.all(
      'SELECT * FROM chunks WHERE conversation_id = ? ORDER BY ordinal ASC',
      conversationId,
    )
    const existingHashes = new Map<string, string>()
    for (const row of existingRows) {
      existingHashes.set(text(row, 'id'), text(row, 'content_hash'))
    }
    const changedIds = new Set<string>()
    for (const input of inputs) {
      db.run(
        `INSERT INTO chunks (
          id, memory_space_id, conversation_id, ordinal, first_message_index,
          last_message_index, started_at, ended_at, participants, content,
          content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          first_message_index = excluded.first_message_index,
          last_message_index = excluded.last_message_index,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          participants = excluded.participants,
          content = excluded.content,
          content_hash = excluded.content_hash`,
        input.id,
        spaceId,
        conversationId,
        input.ordinal,
        input.firstMessageIndex,
        input.lastMessageIndex,
        input.startedAt,
        input.endedAt,
        JSON.stringify(input.participants),
        input.content,
        input.contentHash,
        createdAt,
      )
      db.run('DELETE FROM chunk_messages WHERE chunk_id = ?', input.id)
      for (const [index, messageId] of input.messageIds.entries()) {
        db.run(
          `INSERT INTO chunk_messages (chunk_id, message_id, message_index)
           VALUES (?, ?, ?)`,
          input.id,
          messageId,
          input.firstMessageIndex + index,
        )
      }
      if (existingHashes.get(input.id) !== input.contentHash) {
        changedIds.add(input.id)
      }
    }
    const keep = new Set(inputs.map((input) => input.id))
    const removedIds: ChunkId[] = []
    for (const row of existingRows) {
      const id = text(row, 'id')
      if (!keep.has(id)) {
        db.run('DELETE FROM chunks WHERE id = ?', id)
        removedIds.push(asChunkId(id))
      }
    }
    const chunks = listChunksByConversation(db, conversationId)
    return {
      chunks,
      changed: chunks.filter((chunk) => changedIds.has(chunk.id)),
      removedIds,
    }
  })
}

export function getChunk(db: Database, chunkId: ChunkId): Chunk | null {
  const row = db.get('SELECT * FROM chunks WHERE id = ?', chunkId)
  if (row === undefined) return null
  return mapChunk(row, chunkMessageIds(db, chunkId))
}

export function listChunksByConversation(db: Database, conversationId: ConversationId): Chunk[] {
  return db
    .all('SELECT * FROM chunks WHERE conversation_id = ? ORDER BY ordinal ASC', conversationId)
    .map((row) => mapChunk(row, chunkMessageIds(db, asChunkId(text(row, 'id')))))
}

export function listChunks(db: Database, spaceId: MemorySpaceId): Chunk[] {
  return db
    .all('SELECT * FROM chunks WHERE memory_space_id = ? ORDER BY created_at ASC', spaceId)
    .map((row) => mapChunk(row, chunkMessageIds(db, asChunkId(text(row, 'id')))))
}

export function chunkMessageIds(db: Database, chunkId: ChunkId): string[] {
  return db
    .all(
      'SELECT message_id FROM chunk_messages WHERE chunk_id = ? ORDER BY message_index ASC',
      chunkId,
    )
    .map((row) => asMessageId(text(row, 'message_id')))
}

export function chunkCount(db: Database, spaceId: MemorySpaceId): number {
  return count(db.get('SELECT COUNT(*) AS n FROM chunks WHERE memory_space_id = ?', spaceId), 'n')
}
