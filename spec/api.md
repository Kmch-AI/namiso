# API

Import from the package root:

```ts
import { Namiso } from 'namiso'
```

All methods operate on the memory space configured at `open()`. There is no cross-space query.

## Open

```ts
const memory = await Namiso.open({
  databasePath: './memory.db',
  workspace: { name: 'default' },
  memorySpace: { name: 'assistant' },
  embedding: new HashEmbeddingProvider(),
  extraction: new RuleExtractionProvider(),
  reranker: new LexicalReranker(),
  extractRoles: ['user', 'assistant'],
  self: {
    name: '四时小路',
    aliases: ['小路'],
    description: '常驻 AI 角色',
  },
  vectorIndex: 'auto',
  chunking: { size: 8, overlap: 2 },
})
```

| Option                               | Default                   | Notes                                              |
| ------------------------------------ | ------------------------- | -------------------------------------------------- |
| `databasePath`                       | required                  | Use `:memory:` for tests                           |
| `workspace.id`, `workspace.name`     | generated, `default`      | Reused by ID, or by name when ID is omitted        |
| `memorySpace.id`, `memorySpace.name` | generated, `default`      | Reused by ID, or by name within the workspace      |
| `embedding`                          | `HashEmbeddingProvider`   | Dimensions must stay stable for a database         |
| `extraction`                         | `RuleExtractionProvider`  | Use an LLM provider for production                 |
| `extractRoles`                       | `['user', 'assistant']`   | Roles sent to extraction; system and tool stay raw |
| `self`                               | unset                     | Assistant identity: name, aliases, description     |
| `reranker`                           | `LexicalReranker`         | Set `rerank: false` per query to skip              |
| `vectorIndex`                        | `auto`                    | `auto`, `sqlite-vec`, or `exact`                   |
| `chunking`                           | `{ size: 8, overlap: 2 }` | Size 1 to 64; overlap must be smaller              |

The returned object exposes `workspace` and `memorySpace`.

`self` is optional. Without it, the first assistant speaker creates the self entity. `ensureSelf()` can set or update the identity later.

## Conversations

```ts
createConversation(input?: {
  externalId?: string;
  title?: string;
  startedAt?: number | Date;
  metadata?: Record<string, unknown>;
}): Conversation

getConversation(conversationId: string): Conversation | null

listConversations(): Conversation[]
```

## Messages

```ts
getMessages(query?: {
  conversationId?: string;
  fromIndex?: number;
  toIndex?: number;
  fromTime?: number;
  toTime?: number;
  limit?: number;
}): Message[]
```

`limit` defaults to 100 and is capped at 10,000. Messages sort by occurrence time, then index.

## Ingest

```ts
await memory.ingest({
  conversationId,
  externalMessageId?: string,
  speakerId: "user",
  speakerName?: string,
  role: "user" | "assistant" | "system" | "tool",
  content: "我在使用 IndexTTS2。",
  occurredAt?: number | Date,
  metadata?: Record<string, unknown>,
});
```

Returns:

```ts
{
  messageId: string
  conversationId: string
  accepted: true
  consolidated: boolean
}
```

`externalMessageId` makes the call idempotent within a memory space. A duplicate returns the stored message and ignores the new content. `speakerName` is stored in metadata and becomes the speaker entity's display name.

## Process jobs

```ts
await memory.drain({ limit?: number }): Promise<DrainReport>

await memory.consolidate({
  conversationId?: string,    // default: every conversation in the space
  batchSize?: number,         // default 32, max 128
}): Promise<ConsolidateReport>

await memory.retryJobs(): Promise<DrainReport>
```

`DrainReport` contains `processed`, `completed`, `failed`, and `pending`. It covers chunk and index jobs only. `consolidate()` returns `{ messages, batches }`, where `batches` equals the number of extraction provider calls.

Ingestion never calls the extraction model. Messages stay pending until `consolidate()` runs. Each batch is one provider call, so consolidating a whole session costs one call per 32 messages by default. Call it before context compaction or a session switch. A failed call leaves every message in the batch pending; call it again to retry.

Calls are serialized per instance. A second call processes only messages that remain pending, so calling before compaction and again at session end does not re-extract the first half. Messages before the pending range are sent as context, not as extraction targets.

## Retrieve

```ts
await memory.retrieve({
  query: "我现在使用什么模型？",
  entityIds?: string[],
  memoryTypes?: Array<"conversation" | "entity" | "claim" | "event">,
  timeRange?: { from?: number; to?: number },
  topK?: number,
  rerank?: boolean,
  rerankPool?: number,         // default 50, capped at 50
  includeEvidence?: boolean,
  includeRelations?: boolean,
}): Promise<RetrieveResult>
```

`RetrieveResult` contains `candidates`, `total`, and `trace`. Candidate records are a discriminated union with `kind` of `message`, `chunk`, `entity`, `claim`, or `event`. Each candidate has a score, channels, status, evidence message IDs, and relations. `rerankPool` limits only the documents sent to the reranker; candidates beyond it keep their RRF score.

## Context

```ts
await memory.getContext({
  query: "我现在使用什么模型？",
  maxTokens?: number,          // target, default 1200
  includeEvidence?: boolean,   // default true
  ...retrieve options
}): Promise<MemoryContext>
```

`MemoryContext` contains:

| Field           | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| `text`          | Sectioned context for a prompt                           |
| `items`         | Structured candidates used in the context                |
| `evidence`      | Raw evidence messages, full content                      |
| `tokenEstimate` | Heuristic token count                                    |
| `compressed`    | Whether excerpts were shortened to approach `maxTokens`  |
| `overBudget`    | Whether the shortest excerpts still exceeded `maxTokens` |
| `uncertainties` | Conflict and uncertainty notes                           |
| `trace`         | Retrieval trace                                          |

`maxTokens` is a target. The builder shortens evidence and summaries until the estimate fits. It never drops an item, so a set of records larger than the target reports `overBudget` instead of losing entries.

## Timeline

```ts
memory.timeline({
  entityId?: string,
  entityName?: string,
  from?: number,
  to?: number,
  eventTypes?: string[],
  includeSuperseded?: boolean,
}): TimelineEntry[]
```

Returns events in ascending time order with participants and evidence message IDs. Provide `entityId` or `entityName`.

## Memory details

```ts
getEntityDetails(idOrName: string): EntityDetails | null
getEventDetails(eventId: string): EventDetails | null
getClaimDetails(claimId: string): ClaimDetails | null
```

Details include aliases, claims, events, participants, evidence IDs, and links.

## Entities and links

```ts
await memory.ensureSelf({
  name: "四时小路",
  aliases?: string[],
  description?: string,
}): Promise<Entity>

await memory.ensureEntity({
  name: "IndexTTS2",
  type: "artifact",
  aliases?: string[],
  description?: string,
}): Promise<Entity>

memory.link({
  sourceType: "claim" | "event" | "entity",
  sourceId: string,
  relation: "supersedes" | "updates" | "contradicts" | "continues" |
            "caused_by" | "derived_from" | "related_to" | "same_as",
  targetType: "claim" | "event" | "entity",
  targetId: string,
  confidence?: number,
}): void
```

`ensureSelf` creates or updates the single self entity for the space, marks it with `metadata.self`, and sets its type to `self`. `ensureEntity` resolves by name or alias before creating, indexes the entity document, and rejects the special `self` type; use `artifact` for models, tools, and AI products. `link` validates both endpoints in the current space.

## Maintenance

```ts
await memory.forget(
  | { scope: "message"; messageIds: string[] }
  | { scope: "conversation"; conversationId: string }
  | { scope: "entity"; entityId: string }
  | { scope: "event"; eventId: string }
): Promise<ForgetReport>

await memory.reindex(): Promise<{ documents: number }>

memory.health(): HealthReport

memory.close(): void
```

`forget` removes the target, drops dependent rows and documents, invalidates memories with no evidence, and rebuilds indexes. `reindex` rebuilds all documents, FTS rows, and vectors for the space. Call it after changing the embedding model or dimensions.

`health` reports counts, job states, the vector backend, provider identities, extraction token usage when the provider exposes it, and warnings for missing vectors, failed jobs, and exact-scan fallback.

## Errors

| Class             | Code         | When                                                   |
| ----------------- | ------------ | ------------------------------------------------------ |
| `ValidationError` | `validation` | Invalid config or input, closed instance               |
| `NotFoundError`   | `not_found`  | Missing conversation, message, entity, claim, or event |
| `ProviderError`   | `provider`   | HTTP or provider boundary failure                      |
| `NamisoError`     | varies       | Schema or internal invariant failure                   |
