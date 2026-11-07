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
| `workspace.id`, `workspace.name`     | generated, `default`      | Existing workspace is reused by ID                 |
| `memorySpace.id`, `memorySpace.name` | generated, `default`      | Existing space is reused by ID                     |
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
  processingStatus: 'pending' | 'completed'
}
```

`externalMessageId` makes the call idempotent within a memory space. A duplicate returns the stored message and ignores the new content. `speakerName` is stored in metadata and becomes the speaker entity's display name.

## Process jobs

```ts
await memory.drain({ limit?: number }): Promise<DrainReport>

await memory.annotate(messageId: string): Promise<DrainReport>

await memory.retryJobs(): Promise<DrainReport>
```

`DrainReport` contains `processed`, `completed`, `failed`, and `pending`.

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
  maxTokens?: number,          // default 1200
  includeEvidence?: boolean,   // default true
  ...retrieve options
}): Promise<MemoryContext>
```

`MemoryContext` contains:

| Field           | Meaning                                   |
| --------------- | ----------------------------------------- |
| `text`          | Sectioned context for a prompt            |
| `items`         | Structured candidates used in the context |
| `evidence`      | Raw evidence messages                     |
| `tokenEstimate` | Heuristic token count                     |
| `truncated`     | Whether the budget removed content        |
| `uncertainties` | Conflict and uncertainty notes            |
| `trace`         | Retrieval trace                           |

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
