# Ingestion

Ingestion writes the raw message first, then derives memory through jobs. A provider failure must not lose the message.

## Ingest a message

`Namiso.ingest()` performs these steps in one SQLite transaction:

1. Validate role, speaker, content, and conversation.
2. If `externalMessageId` already exists in the space, return the stored message and its processing status.
3. Append the message with the next `message_index` and the logical `occurredAt`.
4. Enqueue `annotate:<messageId>`.
5. Upsert `chunk:<conversationId>`.

The call returns without running extraction. Call `drain()` to process the queue. Batch ingestion is cheaper because the chunk job deduplicates per conversation.

## Job rules

Jobs use a dedupe key with a unique index. Enqueueing a completed or failed job resets it to `pending` with zero attempts. Enqueueing a pending or running job leaves it queued. This gives one annotation job per message and one chunk job per conversation.

`drain()`:

1. Requeues jobs stuck in `running` for more than 300 seconds.
2. Claims the oldest due job in a transaction.
3. Runs it.
4. Marks it `completed` or fails it.
5. Repeats until the queue is empty or the limit is reached.

A failed job backs off by `10 × 2^attempts` seconds, capped at 300. After three attempts it becomes `failed`. `retryJobs()` resets failed jobs and drains.

`annotate(messageId)` enqueues both jobs and drains. It is useful when one message must be searchable immediately.

## Idempotency

Re-running a job must converge to the same state:

- Entities resolve by exact name or alias before insertion.
- Claims check for an existing active claim with the same subject, predicate, and object.
- Events deduplicate by type, summary, and occurrence time.
- Annotations and evidence use unique indexes.
- Embedding documents upsert by source type, source ID, and model name.
- Chunks use deterministic IDs and content hashes.

The job may safely fail after the memory transaction and retry. The retry repeats extraction, finds the existing rows, and finishes the index work.

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

| Failure                      | Result                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| Invalid input                | `ValidationError`, nothing written                           |
| Unknown conversation         | `NotFoundError`, nothing written                             |
| Extraction provider fails    | Message stays stored; annotation job retries                 |
| Embedding provider fails     | Structured rows and FTS rows stay; vector is filled on retry |
| Vector extension unavailable | Exact scan is used; health reports `exact`                   |
| Process crash during a job   | Job is reclaimed after 300 seconds                           |

## Concurrency

The engine assumes one writer process per database file. SQLite WAL allows concurrent readers, but job claiming and message index allocation are not coordinated across processes.

## Forget

`forget()` removes messages, conversations, entities, or events and then rebuilds the space's indexes. Removing source messages invalidates claims and events that no longer have evidence. See `src/admin/forget.ts`.
