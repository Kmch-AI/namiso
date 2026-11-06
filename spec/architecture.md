# Architecture

Namiso is a library, not a service. The public facade is `Namiso` in `src/namiso.ts`. All other modules are internal and import through explicit file paths.

## Layers

```text
Namiso facade
  ├── ingestion       write messages, enqueue jobs, build chunks
  ├── annotation      extract, resolve entities, link state changes
  ├── indexing        build retrieval documents, sync FTS and vectors
  ├── retrieval       SQL, FTS, vector, RRF, rerank, expansion
  └── context         assemble and budget the final memory context

Storage            SQLite schema, repositories, vector store
Providers          extraction, embedding, reranker interfaces and implementations
Admin              forget and rebuild paths
```

## Dependencies point inward

`namiso.ts` wires the modules. Domain types live in `src/types.ts`. Storage repositories own SQL. Providers expose interfaces from `src/providers/types.ts`.

The core does not import an HTTP client, a model SDK, or an agent harness. `HttpEmbeddingProvider` and the other HTTP providers live under `src/providers/` and are optional adapters. A different harness writes its own adapter and calls the same facade.

## Write path

1. `ingest()` validates the input and resolves the conversation in the configured memory space.
2. It appends the message and enqueues two jobs in one transaction: `annotate:<messageId>` and `chunk:<conversationId>`.
3. `drain()` claims jobs in creation order.
4. An `annotate` job loads recent context, calls the extraction provider, resolves entities, applies claims and events, links evidence, and syncs entity, claim, and event documents.
5. A `chunk` job rebuilds deterministic conversation chunks, removes stale chunks, and syncs chunk documents.
6. Index sync writes the document row, the FTS row, and the vector. FTS is written even if embedding fails, so a provider outage does not hide structured memory.

The raw message commits before extraction runs. A failed job keeps the message and retries.

## Read path

1. Parse the query intent and resolve mentioned entities. A first-person query adds the latest user speaker, so `我现在用什么` finds the user's active claims.
2. Run three channels: structured SQL, FTS5, and vector search.
3. Fuse channel rankings with RRF, k = 60.
4. Rerank the first 50 candidates. The final score is 0.7 × reranker score + 0.3 × normalized RRF.
5. Apply current-state and time-range filters, and collect conflict and uncertainty notes.
6. Expand linked claims and events, then add timeline neighbours. Expansion is bounded.
7. Select evidence messages with query overlap first, then fill remaining slots.
8. Assemble sections under a token budget.

`retrieve()` stops before context assembly and returns the trace. `getContext()` adds the context.

## Runtime model

`node:sqlite` is synchronous. One `Namiso` instance owns one database file. Do not open the same file from two processes for writes. WAL mode allows readers, but the engine does not coordinate writers.

Jobs are claimed with a transaction and marked `running`. A run that stalls for 300 seconds is returned to `pending` by the next `drain()`. This makes a crash between claim and completion recoverable.

## Failure boundaries

- Invalid public input throws `ValidationError`.
- Missing records throw `NotFoundError`.
- Provider failures throw `ProviderError` or the provider's error and fail the job.
- A failed job backs off and retries up to three attempts. `retryJobs()` resets failed jobs.
- A corrupt or incompatible index is rebuildable with `reindex()`.

## What is not here

No HTTP server, background daemon, agent adapter, or multi-process queue. Those are integration layers around the library. See `spec/roadmap.md`.
