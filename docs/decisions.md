# Decision log

This file records the choices behind Namiso 0.1.0 and the verification run that supports the release. It exists so a reviewer can see why the code looks the way it does.

## D1. One package, not a monorepo

The design brief sketches `packages/core`, `packages/storage`, `packages/providers`, and `packages/sdk`. Namiso ships as one ESM package with folder boundaries instead.

Why: a first release has one consumer and one build. Workspace packages add versioning, build order, and dependency rules without removing any code. The folder layout and the spec map preserve the boundaries, and a package split remains possible when a second consumer appears.

## D2. `node:sqlite` instead of `better-sqlite3`

`node:sqlite` ships with Node 24 and later. It provides synchronous statements, FTS5, and extension loading. It removes a native build step and a dependency from the install path.

Trade-off: the minimum Node version is 24, and the API is younger than `better-sqlite3`. The storage layer isolates the choice behind `src/storage/database.ts`.

## D3. Pre-segment Chinese text for FTS5

SQLite's default FTS5 tokenizer does not segment Chinese. A custom tokenizer would add a native extension. Namiso uses `Intl.Segmenter('zh', { granularity: 'word' })` at index and query time, then stores space-separated words in an FTS5 table with the default tokenizer.

Trade-off: segmentation follows the ICU dictionary and is not customizable. The index is derived, so a future tokenizer change can rebuild it with `reindex()`.

## D4. Offline deterministic defaults

The default extraction, embedding, and reranking providers are rule-based or hash-based. They make tests reproducible and let the engine run without network access or credentials.

Trade-off: the default embedding is not semantic, and the rule extractor covers a small pattern set. The benchmark results describe this offline stack. Production users should pass an HTTP provider or implement the interfaces. The provider boundary keeps model code out of the core.

## D5. Claims and events are separate

Facts such as "user uses IndexTTS2" are claims. "User changed from TTS-A to IndexTTS2" is an event. A claim has a state and can be superseded. An event stays in history and links to the event it follows.

Why: collapsing them loses the difference between current state and the sequence that produced it. The state tests assert both: the active claim is current, and the superseded claim remains queryable.

## D6. Only asserted claims change state

The rule extractor marks uncertain statements with a modality. The linker skips claim creation for uncertain, negated, hypothetical, and quoted statements. It may still write an event with the uncertain modality.

Why: "I might switch back" is not a switch. The benchmark and tests both exercise this case. The cost is that an uncertain statement cannot later become a claim without another asserted message.

## D7. Two-pass, query-aware evidence selection

The first implementation selected evidence in time order and capped the list. On long histories, the top-ranked chunk filled the evidence slots with messages before the answer, so a correct retrieval still produced a context without the anchor. The fix selects messages by query-token overlap first, then fills remaining slots.

Evidence: public demo evidence recall moved from 87% to 93% with query-aware selection, then to 97% with the two-pass fill. Removing generic intent events moved it to 100%. The formal set settled at 74% with the raw baseline at 73%.

## D8. Remove generic intent events

The rule extractor originally wrote an `intent` event for every uncertain sentence, including "I want to cook earlier". On 360 turns this created more than a hundred low-value events that crowded retrieval and produced spurious supersession chains. The extractor now records only state-change events it can identify (`usage_change`, `usage_stop`, `recommendation`, `loan`).

Uncertain state changes still produce an uncertain event. Other uncertain statements remain in raw messages and chunks.

## D9. `sqlite-vec` with an exact fallback

The vector store loads `sqlite-vec` when available and otherwise scans stored float32 vectors with cosine similarity. The exact path keeps tests and unsupported platforms working. `health()` reports which backend is active.

Trade-off: the fallback is O(n) per query. For the first version's scale, correctness and portability matter more than approximate nearest-neighbor speed.

## D10. No export, import, or HTTP server in 0.1.0

The brief lists these as admin and integration work. The first release implements the memory core, retrieval, forgetting, and reindexing. Export and import need a stable serialized format and conflict rules, and an HTTP server needs authentication and tenancy decisions. Both are deferred and recorded in `spec/roadmap.md`.

## D11. Single writer per database

`node:sqlite` is synchronous and job claiming is a local transaction. The engine assumes one process owns a database file. WAL mode serves readers, but the engine does not coordinate writers across processes.

Why: multi-process write coordination needs a lease or an external queue. Adding one before there is a deployment would be speculative. The constraint is documented in `AGENTS.md` and `spec/ingestion.md`.

## D12. Benchmark measures retrieval evidence, not answers

The official benchmark requires an answer model and a grader. Namiso has no API key or paid model in this environment, and a deterministic answerer would not measure the product.

The harness therefore scores whether the answer key's anchor messages appear in the context. It exports contexts for an external answer model. Every report states the limit. The benchmark table never claims an official score or a ranking.

## D13. Vitest is the test runner, `node:assert` stays

Vitest provides TypeScript execution, watch mode, coverage, and readable failures. Tests still call `node:assert/strict` because `assert.ok` narrows nullable values in TypeScript. Replacing it with `expect` would add dozens of non-null guards for no behavior gain.

The suite runs with `vitest run`; `pnpm test:watch` and `pnpm test:coverage` use the same config.

## D14. Lint and format configuration in TypeScript

`oxlint.config.ts` and `oxfmt.config.ts` replace the JSON files. Both tools export `defineConfig`, so rule and formatting options are typed and the project has one configuration language. The scripts pass `-c` explicitly so a future config filename change cannot silently select another file.

`oxfmt` uses single quotes, no semicolons, and sorted imports. Type-only imports come first, then the remaining groups by path kind. Formatting also applies to TypeScript code fences in Markdown.

## D15. No Drizzle ORM in 0.1.0

Drizzle supports `node:sqlite`, so the driver is not the blocker. The storage layer depends on SQLite features that the schema layer would not own: FTS5, `vec0`, partial unique indexes, `INSERT OR IGNORE`, `ON CONFLICT` upserts, `json_extract`, and `bm25` ranking. A Drizzle schema would either omit those or leave raw SQL beside an ORM schema, creating two sources of truth.

The repositories are already parameterized and map rows into branded domain types. The seam for a future ORM is `src/storage/*-repo.ts`. Revisit Drizzle when ordinary CRUD dominates the storage layer and generated migrations become the larger problem.

## D16. Real model providers are environment-driven and opt-in

`providersFromEnv()` reads endpoint, model, key, dimension, and timeout variables. The benchmark uses it only with `--models`. The real-model integration test requires `NAMISO_RUN_MODEL_TESTS=1`.

Why: a stray environment variable must not start paid model calls during a normal test run. The offline defaults keep CI deterministic. The report records the actual provider identities, so a result cannot silently mix model and offline runs.

## D17. pnpm with a committed lockfile

The project uses pnpm 12 and commits `pnpm-lock.yaml`. `packageManager` pins the expected pnpm version. pnpm 12 moved build-script approval to `pnpm-workspace.yaml`; `allowBuilds` permits only `esbuild` and `simple-git-hooks`.

`oxlint-tsgolint` is pinned to `7.0.2005`. The newer `7.0.2006` was inside pnpm's minimum release age window at install time. Remove the pin after the window passes if the update is wanted.

## D18. Type-aware lint and a commit hook

`oxlint.config.ts` enables `typeAware` and `typeCheck`, backed by `oxlint-tsgolint`. This runs TypeScript 7 semantic rules and compiler diagnostics inside the lint step. The lint script is part of `pnpm verify`, so a type error fails the gate before the build. `tsc` remains only in `pnpm build`, where it emits `dist/` and declarations.

`typescript/no-unsafe-type-assertion` is off because branded IDs and parsed provider payloads deliberately assert at validated boundaries. The central constructors and parsers are the narrow places where casts are allowed.

`simple-git-hooks` installs `pnpm lint-staged` as the pre-commit hook. Staged files are fixed and formatted before commit. The full type-aware check still runs in `pnpm verify`; the hook trades completeness for speed on a single commit.

## D19. ESNext target and lib, Node 24 runtime

`target` and `lib` are `ESNext`. TypeScript emits modern syntax, and the type checker exposes the latest ECMAScript library types. Node 24 is the runtime floor, and it implements the ECMAScript features the project uses.

`module` and `moduleResolution` stay `nodenext`. A Bun application with a bundler can use `Preserve` and `bundler`; this package runs directly on Node and emits with `tsc`, so Node ESM resolution checks stay in place. The build config is the only place that compiles.

## Verification record

Run on 2026-11-06 on Windows 11, Node 26.13.0, AMD Ryzen 9 8945HX.

| Check                      | Result                                                                      |
| -------------------------- | --------------------------------------------------------------------------- |
| `pnpm lint`                | Pass, no findings; TypeScript diagnostics included                          |
| `pnpm fmt:check`           | Pass                                                                        |
| `pnpm test`                | Vitest, 26 tests pass, 1 real-model test skipped                            |
| `pnpm build`               | Pass                                                                        |
| `pnpm verify`              | Pass, lint + format + test + build                                          |
| Built `dist/` smoke test   | Message ingested, 2 jobs completed, context contained the `IndexTTS2` claim |
| `pnpm bench` local fixture | 3 questions, 100% evidence recall, 0 errors                                 |
| Demo, hybrid               | 108 questions, 104 scored, 100% evidence recall, 100% context hit           |
| Demo, raw baseline         | 104 scored, 100% evidence recall, 100% context hit                          |
| Formal, hybrid, 6 runs     | 714 scored, 74% evidence recall, 78% context hit, 0 errors                  |
| Formal, raw baseline       | 714 scored, 73% evidence recall, 77% context hit                            |

The first full benchmark attempt reported 23% evidence recall. The cause was a harness bug: `getMessages()` defaults to 100 rows, so anchor messages after turn 50 were missing from the index map. Fixing the harness to request all messages raised the result to 87%. The retrieval engine had not been the limiter. This is why the benchmark notes must state whether the observation method was checked before the system.

The formal-set latency was 10.87 to 13.29 ms p50 and 26.68 to 30.71 ms p95 across five runs. Ingest was 17.1 to 19.3 seconds for 2240 turns. These are single-process measurements, not throughput claims. No profiler run was used to name a hardware limiter, so the report does not claim one.
