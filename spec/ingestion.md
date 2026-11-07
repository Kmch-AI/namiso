# Ingestion

Ingestion writes the raw message and builds local indexes. Model extraction runs only when the caller asks for it. A provider failure must not lose the message.

## Ingest a message

`Namiso.ingest()` performs these steps in one SQLite transaction:

1. Validate role, speaker, content, and conversation.
2. If `externalMessageId` already exists in the space, return the stored message and its consolidation state.
3. Append the message with the next `message_index`, the logical `occurredAt`, and `consolidated_at` null.
4. Upsert `chunk:<conversationId>`.

The call returns without running extraction and without an extraction job. `health().counts.pendingMessages` reports how many messages wait for consolidation. Batch ingestion is cheap because the chunk job deduplicates per conversation.

## Job rules

Only chunk jobs use the queue. A job uses a dedupe key with a unique index. Enqueueing a completed or failed job resets it to `pending` with zero attempts. Enqueueing a pending or running job leaves it queued. This gives one chunk job per conversation.

`drain()`:

1. Requeues jobs stuck in `running` for more than 300 seconds.
2. Claims the oldest due job in a transaction.
3. Runs it.
4. Marks it `completed` or fails it.
5. Repeats until the queue is empty or the limit is reached.

A failed job backs off by `10 × 2^attempts` seconds, capped at 300. After three attempts it becomes `failed`. `retryJobs()` resets failed jobs and drains.

## Consolidation

`consolidate()` is the only path that calls the extraction provider. For each conversation with pending messages it:

1. Selects up to `batchSize` messages with `consolidated_at` null, in message order.
2. Loads up to eight messages before the first one as context.
3. Sends one extraction request for the whole batch.
4. Writes entities, claims, events, evidence, and annotations in one transaction.
5. Syncs their retrieval documents.
6. Marks every message in the batch consolidated.

`batchSize` defaults to 32 and is capped at 128. A session of 100 messages costs four extraction calls, not 100. `consolidate()` without a conversation processes every conversation in the space. Call it before context compaction or a session switch, when the agent is about to lose the raw conversation.

Repeated calls are incremental. A second call selects only messages with `consolidated_at` null, so an earlier half of the session is not extracted again. Up to eight messages before the first pending message are sent as context and are not part of `focusMessageIds`. Concurrent calls on one instance are serialized; the later call runs after the earlier one and finds only what is still pending.

Extraction failures throw. Messages in the failed batch stay pending, so calling `consolidate()` again retries them.

## Idempotency

Re-running consolidation must converge to the same state:

- Entities resolve by exact name or alias before insertion.
- Claims check for an existing active claim with the same subject, predicate, and object.
- Events deduplicate by type, summary, and occurrence time.
- Annotations and evidence use unique indexes.
- Embedding documents upsert by source type, source ID, and model name.
- Chunks use deterministic IDs and content hashes.
- Consolidated messages are skipped on the next run.

A run may fail after the memory transaction and before marking messages consolidated. The retry repeats extraction, finds the existing rows, and finishes the index work and the marker.

## Chunking

Messages are the stored unit. Chunks are the retrieval unit.

The default policy is eight messages with two messages of overlap. For each window the engine stores:

- deterministic chunk ID and ordinal;
- first and last message index;
- start and end time;
- participant speaker IDs;
- rendered content;
- SHA-256 content hash;
- ordered message IDs.

A chunk job rebuilds all chunks for its conversation, updates changed rows, removes rows that no longer exist, and syncs documents. Chunk content includes the speaker and role, so retrieval text reflects who said what.

## Failure behavior

| Failure                            | Result                                                       |
| ---------------------------------- | ------------------------------------------------------------ |
| Invalid input                      | `ValidationError`, nothing written                           |
| Unknown conversation               | `NotFoundError`, nothing written                             |
| Extraction provider fails          | Messages stay stored and pending; `consolidate()` retries    |
| Embedding provider fails           | Structured rows and FTS rows stay; vector is filled on retry |
| Vector extension unavailable       | Exact scan is used; health reports `exact`                   |
| Process crash during a job         | Job is reclaimed after 300 seconds                           |
| Process crash during consolidation | Messages stay pending; the next call repeats extraction      |

## Concurrency

The engine assumes one writer process per database file. SQLite WAL allows concurrent readers, but job claiming and message index allocation are not coordinated across processes.

## Forget

`forget()` removes messages, conversations, entities, or events and then rebuilds the space's indexes. Removing source messages invalidates claims and events that no longer have evidence. See `src/admin/forget.ts`.
