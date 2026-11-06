# Namiso

Standalone long-term memory engine for AI agents. It stores raw conversations, extracts entities, claims, and events, links state changes, and returns a budgeted memory context.

## Stack

- Node.js 24 or newer. Storage uses the built-in `node:sqlite` module.
- TypeScript 7, ESM only. Node runs the `.ts` sources directly; `npm run build` emits `dist/` with `.js` specifiers.
- SQLite with FTS5 and `sqlite-vec`. The exact vector scan is the fallback.
- oxlint for lint, oxfmt for formatting, Vitest for tests.
- One runtime dependency: `sqlite-vec`. Model providers are interfaces.

## Commands

| Command                             | Does                                    |
| ----------------------------------- | --------------------------------------- |
| `npm install`                       | Install dependencies                    |
| `npm run verify`                    | Typecheck, lint, format check, and test |
| `npm test`                          | Run the test suite                      |
| `npm run test:watch`                | Run tests in watch mode                 |
| `npm run build`                     | Emit the ESM package into `dist/`       |
| `npm run bench -- --dataset <path>` | Run the retrieval benchmark             |

## Layout

```text
src/
  namiso.ts            public facade
  types.ts             domain types and branded IDs
  storage/             SQLite schema, repositories, FTS and vector index
  ingestion/           message writes, jobs, chunking
  annotation/          extraction pipeline, entity resolution, linking
  indexing/            retrieval documents, embedding sync, rebuilds
  retrieval/           query parsing, channels, fusion, reranking, expansion
  context/             memory context assembly and budget
  providers/           extraction, embedding, and reranker implementations
  admin/               forgetting
spec/                  module docs, read on demand
test/                  node:test suites
bench/                 chat-memory-benchmark adapter and local fixture
```

## Invariants

- Raw messages are append-only. Structured memory is derived and rebuildable.
- Every read and write is scoped to one memory space.
- Replacing a fact keeps history through claim status and `supersedes` links.
- Every claim and event links to at least one evidence message.
- FTS and vector indexes are derived. `reindex()` rebuilds them.
- One process owns one database file. `node:sqlite` is synchronous.
- Core code does not import provider-specific or harness-specific modules.

## Conventions

- Domain types live in `src/types.ts`. IDs are branded; create them at boundaries.
- Validate at public API and provider boundaries. Trust internal types.
- SQL belongs in `src/storage/*-repo.ts`. Other modules do not issue SQL.
- `src/` does not log. The benchmark CLI writes to stdout.
- A behavior change updates its `spec/` document in the same change.

## Progressive disclosure

Read `spec/README.md` first. Load only the document for the area you touch.

| Area                         | Document               |
| ---------------------------- | ---------------------- |
| Module boundaries, data flow | `spec/architecture.md` |
| Tables, statuses, time model | `spec/data-model.md`   |
| Message writes, jobs, chunks | `spec/ingestion.md`    |
| Extraction and state links   | `spec/annotation.md`   |
| Query, fusion, context       | `spec/retrieval.md`    |
| Public methods               | `spec/api.md`          |
| Model providers              | `spec/providers.md`    |
| Tests                        | `spec/testing.md`      |
| Benchmark                    | `spec/benchmark.md`    |
| Implemented scope            | `spec/roadmap.md`      |
