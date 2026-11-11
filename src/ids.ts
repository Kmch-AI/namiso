import type {
  AnnotationId,
  ChunkId,
  ClaimId,
  ConversationId,
  DocumentId,
  EntityId,
  EventId,
  EvidenceId,
  JobId,
  MemoryLinkId,
  MemorySpaceId,
  MessageId,
  WorkspaceId,
} from './types.ts'

import { ValidationError } from './errors.ts'

function identifier(value: string): string {
  if (value.length === 0) {
    throw new ValidationError('identifier cannot be empty')
  }
  return value
}

export const asWorkspaceId = (value: string): WorkspaceId => identifier(value) as WorkspaceId
export const asMemorySpaceId = (value: string): MemorySpaceId => identifier(value) as MemorySpaceId
export const asConversationId = (value: string): ConversationId =>
  identifier(value) as ConversationId
export const asMessageId = (value: string): MessageId => identifier(value) as MessageId
export const asEntityId = (value: string): EntityId => identifier(value) as EntityId
export const asClaimId = (value: string): ClaimId => identifier(value) as ClaimId
export const asEventId = (value: string): EventId => identifier(value) as EventId
export const asAnnotationId = (value: string): AnnotationId => identifier(value) as AnnotationId
export const asEvidenceId = (value: string): EvidenceId => identifier(value) as EvidenceId
export const asMemoryLinkId = (value: string): MemoryLinkId => identifier(value) as MemoryLinkId
export const asChunkId = (value: string): ChunkId => identifier(value) as ChunkId
export const asDocumentId = (value: string): DocumentId => identifier(value) as DocumentId
export const asJobId = (value: string): JobId => identifier(value) as JobId

export function newId(): string {
  return crypto.randomUUID()
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function timestampOf(value: Date | number): number {
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : Math.floor(value)
}
