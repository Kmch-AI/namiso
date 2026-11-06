import type {
  Conversation,
  ConversationId,
  MemorySpace,
  MemorySpaceId,
  Message,
  MessageId,
  MessageRole,
  Workspace,
  WorkspaceId,
} from '../types.ts'
import type { Database } from './database.ts'

import {
  asConversationId,
  asMemorySpaceId,
  asMessageId,
  asWorkspaceId,
  nowSeconds,
} from '../ids.ts'
import { count, textOrNull } from './database.ts'
import { mapConversation, mapMemorySpace, mapMessage, mapWorkspace } from './mappers.ts'

export interface EnsureWorkspaceInput {
  id?: string
  name: string
  createdAt?: number
}

export function ensureWorkspace(db: Database, input: EnsureWorkspaceInput): Workspace {
  const id = asWorkspaceId(input.id ?? crypto.randomUUID())
  const createdAt = input.createdAt ?? nowSeconds()
  const existing = db.get('SELECT * FROM workspaces WHERE id = ?', id)
  if (existing !== undefined) return mapWorkspace(existing)
  db.run(
    'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)',
    id,
    input.name,
    createdAt,
  )
  return { id, name: input.name, createdAt }
}

export interface EnsureMemorySpaceInput {
  id?: string
  name: string
  config?: Record<string, unknown>
  createdAt?: number
}

export function ensureMemorySpace(
  db: Database,
  workspaceId: WorkspaceId,
  input: EnsureMemorySpaceInput,
): MemorySpace {
  const id = asMemorySpaceId(input.id ?? crypto.randomUUID())
  const createdAt = input.createdAt ?? nowSeconds()
  const existing = db.get('SELECT * FROM memory_spaces WHERE id = ?', id)
  if (existing !== undefined) return mapMemorySpace(existing)
  db.run(
    'INSERT INTO memory_spaces (id, workspace_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    workspaceId,
    input.name,
    input.config === undefined ? null : JSON.stringify(input.config),
    createdAt,
  )
  return {
    id,
    workspaceId,
    name: input.name,
    config: input.config ?? null,
    createdAt,
  }
}

export interface CreateConversationInput {
  id?: string
  externalId?: string
  title?: string
  startedAt?: number
  metadata?: Record<string, unknown>
}

export function createConversation(
  db: Database,
  memorySpaceId: MemorySpaceId,
  input: CreateConversationInput,
): Conversation {
  const id = asConversationId(input.id ?? crypto.randomUUID())
  const startedAt = input.startedAt ?? nowSeconds()
  db.run(
    `INSERT INTO conversations (id, memory_space_id, external_id, title, started_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    memorySpaceId,
    input.externalId ?? null,
    input.title ?? null,
    startedAt,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  )
  return {
    id,
    memorySpaceId,
    externalId: input.externalId ?? null,
    title: input.title ?? null,
    startedAt,
    endedAt: null,
    metadata: input.metadata ?? null,
  }
}

export function getConversation(db: Database, conversationId: ConversationId): Conversation | null {
  const row = db.get('SELECT * FROM conversations WHERE id = ?', conversationId)
  return row === undefined ? null : mapConversation(row)
}

export function findConversationByExternalId(
  db: Database,
  memorySpaceId: MemorySpaceId,
  externalId: string,
): Conversation | null {
  const row = db.get(
    'SELECT * FROM conversations WHERE memory_space_id = ? AND external_id = ?',
    memorySpaceId,
    externalId,
  )
  return row === undefined ? null : mapConversation(row)
}

export function listConversations(db: Database, memorySpaceId: MemorySpaceId): Conversation[] {
  return db
    .all(
      'SELECT * FROM conversations WHERE memory_space_id = ? ORDER BY started_at DESC',
      memorySpaceId,
    )
    .map(mapConversation)
}

export interface AppendMessageInput {
  id?: MessageId
  memorySpaceId: MemorySpaceId
  conversationId: ConversationId
  externalMessageId?: string
  speakerId: string
  role: MessageRole
  content: string
  occurredAt: number
  createdAt?: number
  metadata?: Record<string, unknown>
}

export function appendMessage(db: Database, input: AppendMessageInput): Message {
  return db.transaction(() => {
    const row = db.get(
      'SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index FROM messages WHERE conversation_id = ?',
      input.conversationId,
    )
    const messageIndex = count(row, 'next_index')
    const id = input.id ?? asMessageId(crypto.randomUUID())
    const createdAt = input.createdAt ?? nowSeconds()
    db.run(
      `INSERT INTO messages (
        id, memory_space_id, conversation_id, external_message_id, speaker_id, role,
        content, message_index, occurred_at, created_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.memorySpaceId,
      input.conversationId,
      input.externalMessageId ?? null,
      input.speakerId,
      input.role,
      input.content,
      messageIndex,
      input.occurredAt,
      createdAt,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    db.run(
      'UPDATE conversations SET ended_at = MAX(COALESCE(ended_at, 0), ?) WHERE id = ?',
      input.occurredAt,
      input.conversationId,
    )
    const stored = db.get('SELECT * FROM messages WHERE id = ?', id)
    if (stored === undefined) {
      throw new Error('message insert did not return a row')
    }
    return mapMessage(stored)
  })
}

export function findMessageByExternalId(
  db: Database,
  memorySpaceId: MemorySpaceId,
  externalMessageId: string,
): Message | null {
  const row = db.get(
    'SELECT * FROM messages WHERE memory_space_id = ? AND external_message_id = ?',
    memorySpaceId,
    externalMessageId,
  )
  return row === undefined ? null : mapMessage(row)
}

export function getMessage(db: Database, messageId: MessageId): Message | null {
  const row = db.get('SELECT * FROM messages WHERE id = ?', messageId)
  return row === undefined ? null : mapMessage(row)
}

export function getMessagesByIds(db: Database, ids: readonly MessageId[]): Message[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.all(
    `SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY occurred_at ASC`,
    ...ids,
  )
  return rows.map(mapMessage)
}

export interface MessageQuery {
  conversationId?: ConversationId
  memorySpaceId?: MemorySpaceId
  fromIndex?: number
  toIndex?: number
  fromTime?: number
  toTime?: number
  limit?: number
}

export function listMessages(db: Database, query: MessageQuery): Message[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (query.conversationId !== undefined) {
    conditions.push('conversation_id = ?')
    params.push(query.conversationId)
  }
  if (query.memorySpaceId !== undefined) {
    conditions.push('memory_space_id = ?')
    params.push(query.memorySpaceId)
  }
  if (query.fromIndex !== undefined) {
    conditions.push('message_index >= ?')
    params.push(query.fromIndex)
  }
  if (query.toIndex !== undefined) {
    conditions.push('message_index <= ?')
    params.push(query.toIndex)
  }
  if (query.fromTime !== undefined) {
    conditions.push('occurred_at >= ?')
    params.push(query.fromTime)
  }
  if (query.toTime !== undefined) {
    conditions.push('occurred_at <= ?')
    params.push(query.toTime)
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const limit = Math.max(1, Math.min(query.limit ?? 100, 10_000))
  const rows = db.all(
    `SELECT * FROM messages ${where} ORDER BY occurred_at ASC, message_index ASC LIMIT ?`,
    ...params,
    limit,
  )
  return rows.map(mapMessage)
}

export function listConversationMessages(db: Database, conversationId: ConversationId): Message[] {
  return db
    .all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY message_index ASC',
      conversationId,
    )
    .map(mapMessage)
}

export function recentMessages(
  db: Database,
  conversationId: ConversationId,
  beforeIndex: number,
  limit: number,
): Message[] {
  return db
    .all(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND message_index < ?
       ORDER BY message_index DESC LIMIT ?`,
      conversationId,
      beforeIndex,
      limit,
    )
    .map(mapMessage)
    .toReversed()
}

export function latestUserSpeakerId(db: Database, memorySpaceId: MemorySpaceId): string | null {
  const row = db.get(
    `SELECT speaker_id FROM messages
     WHERE memory_space_id = ? AND role = 'user'
     ORDER BY occurred_at DESC, message_index DESC LIMIT 1`,
    memorySpaceId,
  )
  return row === undefined ? null : textOrNull(row, 'speaker_id')
}

export function messageCount(db: Database, memorySpaceId: MemorySpaceId): number {
  return count(
    db.get('SELECT COUNT(*) AS n FROM messages WHERE memory_space_id = ?', memorySpaceId),
    'n',
  )
}

export function conversationMessageCount(db: Database, conversationId: ConversationId): number {
  return count(
    db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId),
    'n',
  )
}

export function firstMessageAt(db: Database, conversationId: ConversationId): number | null {
  const row = db.get(
    'SELECT MIN(occurred_at) AS first FROM messages WHERE conversation_id = ?',
    conversationId,
  )
  const value = row?.['first']
  return typeof value === 'number' ? value : null
}
