import {
  asChunkId,
  asClaimId,
  asConversationId,
  asEntityId,
  asEventId,
  asJobId,
  asMemoryLinkId,
  asMemorySpaceId,
  asMessageId,
  asWorkspaceId,
} from "../ids.ts";
import type {
  Chunk,
  Claim,
  ClaimObject,
  Conversation,
  Entity,
  Event,
  Job,
  MemoryLink,
  MemorySpace,
  Message,
  Workspace,
} from "../types.ts";
import type { Row } from "./database.ts";
import {
  jsonArrayOrNull,
  jsonOrNull,
  numberOrNull,
  oneOf,
  readNumber,
  text,
  textOrNull,
} from "./database.ts";

const ROLES = ["user", "assistant", "system", "tool"] as const;
const ENTITY_TYPES = [
  "person",
  "ai",
  "organization",
  "place",
  "project",
  "product",
  "other",
] as const;
const CLAIM_STATUSES = ["active", "superseded", "disputed", "retracted", "invalid"] as const;
const EVENT_STATUSES = ["active", "retracted", "invalid"] as const;
const TIME_PRECISIONS = ["exact", "day", "month", "approximate", "unknown"] as const;
const RELATIONS = [
  "supersedes",
  "updates",
  "contradicts",
  "continues",
  "caused_by",
  "derived_from",
  "related_to",
  "same_as",
] as const;
const MEMORY_OR_ENTITY = ["entity", "claim", "event"] as const;
const JOB_TYPES = ["annotate", "chunk"] as const;
const JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;

export function mapWorkspace(row: Row): Workspace {
  return {
    id: asWorkspaceId(text(row, "id")),
    name: text(row, "name"),
    createdAt: readNumber(row, "created_at"),
  };
}

export function mapMemorySpace(row: Row): MemorySpace {
  return {
    id: asMemorySpaceId(text(row, "id")),
    workspaceId: asWorkspaceId(text(row, "workspace_id")),
    name: text(row, "name"),
    config: jsonOrNull(row, "config"),
    createdAt: readNumber(row, "created_at"),
  };
}

export function mapConversation(row: Row): Conversation {
  return {
    id: asConversationId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    externalId: textOrNull(row, "external_id"),
    title: textOrNull(row, "title"),
    startedAt: readNumber(row, "started_at"),
    endedAt: numberOrNull(row, "ended_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapMessage(row: Row): Message {
  return {
    id: asMessageId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    conversationId: asConversationId(text(row, "conversation_id")),
    externalMessageId: textOrNull(row, "external_message_id"),
    speakerId: text(row, "speaker_id"),
    role: oneOf(row, "role", ROLES),
    content: text(row, "content"),
    messageIndex: readNumber(row, "message_index"),
    occurredAt: readNumber(row, "occurred_at"),
    createdAt: readNumber(row, "created_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapEntity(row: Row): Entity {
  return {
    id: asEntityId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    type: oneOf(row, "type", ENTITY_TYPES),
    name: text(row, "name"),
    description: textOrNull(row, "description"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapClaim(row: Row): Claim {
  const objectType = text(row, "object_type");
  const object: ClaimObject =
    objectType === "entity"
      ? { kind: "entity", entityId: asEntityId(text(row, "object_entity_id")) }
      : { kind: "literal", value: text(row, "object_value") };
  return {
    id: asClaimId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    subjectId: asEntityId(text(row, "subject_id")),
    predicate: text(row, "predicate"),
    object,
    status: oneOf(row, "status", CLAIM_STATUSES),
    validFrom: numberOrNull(row, "valid_from"),
    validUntil: numberOrNull(row, "valid_until"),
    confidence: readNumber(row, "confidence"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapEvent(row: Row): Event {
  return {
    id: asEventId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    type: text(row, "type"),
    summary: text(row, "summary"),
    description: textOrNull(row, "description"),
    occurredAt: numberOrNull(row, "occurred_at"),
    timePrecision: oneOf(row, "time_precision", TIME_PRECISIONS),
    status: oneOf(row, "status", EVENT_STATUSES),
    confidence: readNumber(row, "confidence"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapMemoryLink(row: Row): MemoryLink {
  return {
    id: asMemoryLinkId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    sourceType: oneOf(row, "source_type", MEMORY_OR_ENTITY),
    sourceId: text(row, "source_id"),
    relation: oneOf(row, "relation", RELATIONS),
    targetType: oneOf(row, "target_type", MEMORY_OR_ENTITY),
    targetId: text(row, "target_id"),
    confidence: readNumber(row, "confidence"),
    createdAt: readNumber(row, "created_at"),
    metadata: jsonOrNull(row, "metadata"),
  };
}

export function mapChunk(row: Row, messageIds: string[]): Chunk {
  return {
    id: asChunkId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    conversationId: asConversationId(text(row, "conversation_id")),
    ordinal: readNumber(row, "ordinal"),
    firstMessageIndex: readNumber(row, "first_message_index"),
    lastMessageIndex: readNumber(row, "last_message_index"),
    startedAt: readNumber(row, "started_at"),
    endedAt: readNumber(row, "ended_at"),
    participants: jsonArrayOrNull(row, "participants") ?? [],
    content: text(row, "content"),
    contentHash: text(row, "content_hash"),
    createdAt: readNumber(row, "created_at"),
    messageIds: messageIds.map(asMessageId),
  };
}

export function mapJob(row: Row): Job {
  return {
    id: asJobId(text(row, "id")),
    memorySpaceId: asMemorySpaceId(text(row, "memory_space_id")),
    type: oneOf(row, "type", JOB_TYPES),
    payload: jsonOrNull(row, "payload") ?? {},
    status: oneOf(row, "status", JOB_STATUSES),
    attempts: readNumber(row, "attempts"),
    maxAttempts: readNumber(row, "max_attempts"),
    runAfter: readNumber(row, "run_after"),
    lastError: textOrNull(row, "last_error"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}
