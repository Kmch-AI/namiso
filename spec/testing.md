# Testing

Tests run on Vitest. Vitest handles TypeScript, watch mode, and coverage. Assertions use `node:assert/strict` because `assert.ok` narrows nullable values without extra guards.

## Commands

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm test:integration
pnpm lint
pnpm fmt:check
pnpm verify
```

`pnpm verify` runs type-aware lint, format check, tests, and the build in that order. `pnpm lint` runs oxlint with tsgolint, so it reports TypeScript diagnostics as well as lint findings. There is no separate `tsc` typecheck step. `tsc` runs only in `pnpm build`, where it emits `dist/` and declarations.

## Test setup

`test/helpers.ts` opens an in-memory database, creates a conversation, and assigns increasing timestamps. Most suites use `vectorIndex: "exact"` so results do not depend on the platform vector extension. One test opens `auto` and accepts either backend.

Integration tests assert through the public API and never inspect tables. Provider tests call the provider interfaces directly with a fake `fetch`, because the provider contract is the behavior under test.

## Coverage

| File                        | Behavior                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ingestion.test.ts`         | Message order, external-ID deduplication, job idempotency, space isolation                                        |
| `state-evolution.test.ts`   | Supersession, uncertain intent, timeline order, evidence retention                                                |
| `retrieval.test.ts`         | Three-channel retrieval, current claims, time ranges, budget truncation, evidence selection, both vector backends |
| `forget.test.ts`            | Message, entity, and conversation deletion with index cleanup                                                     |
| `providers.test.ts`         | Hash embedding invariants, rule extraction, lexical rerank, HTTP payload parsing                                  |
| `extraction-policy.test.ts` | Default user and assistant extraction, and user-only opt-out                                                      |
| `api.test.ts`               | Boundary validation, alias resolution, manual links, reindex, closed instance                                     |

The default suite has 28 tests plus one skipped real-model test. It runs in under a second on the development machine.

## Writing a test

1. Open a fresh in-memory engine with `setup()`.
2. Ingest messages with `say()`.
3. Call `drain()` before reading structured memory or retrieving.
4. Assert a value the caller can observe: returned records, context text, evidence IDs, or health counts.
5. Close the engine.

Avoid asserting private helper calls, generated IDs, or exact scores. Scores change when ranking weights change.

## Commit hook

`pnpm install` runs `simple-git-hooks` through the `prepare` script. The installed pre-commit hook runs `pnpm lint-staged`. Staged TypeScript files go through `oxlint --fix` and `oxfmt`; staged JSON, Markdown, and YAML files go through `oxfmt`.

The hook is a fast local check. `pnpm verify` remains the full gate.

## Real model tests

`test/models.integration.test.ts` calls the providers configured through `NAMISO_*` variables. It is skipped unless `NAMISO_RUN_MODEL_TESTS=1`. Without that flag, the suite never makes a network call.

```bash
NAMISO_RUN_MODEL_TESTS=1 pnpm test:integration
```

Set the endpoint and model variables first. See `.env.example` and `spec/providers.md`.

## What is not covered

- A real embedding service or LLM extraction call. The HTTP tests use a fake `fetch`.
- Multi-process writes. The engine documents a single-writer model.
- Long-running crash recovery beyond job retry and stale-claim requeue.
- Answer correctness. The benchmark measures evidence retrieval; it does not call an answer model.
- Fuzz or property tests for malformed provider output.

Add a benchmark or a focused fixture when a change affects ranking, evidence selection, or state linking. Unit tests alone will not catch a regression in retrieval quality.
