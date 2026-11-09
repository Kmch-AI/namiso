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

## D20. Extraction is focus-only, user and assistant by default

The extraction prompt extracts only the focus message. Context messages and known entities resolve references. `extractRoles` defaults to `['user', 'assistant']`; system and tool messages keep a speaker annotation and remain raw chunks.

Why: the previous prompt let the model extract from all nine messages, which duplicated context facts. Focus-only removes that duplication. Assistant messages stay in the default because they often contain summaries, recommendations, and tool results. Excluding them saved tokens but lost structured assistant facts. Set `extractRoles: ['user']` to skip them.

Assistant claims can become active and carry `assistant_statement` evidence. A provider must mark speculation as `uncertain`; otherwise assistant guesses enter current memory.

An A/B on a nine-message context: output tokens fell from 1,878 to 848, claims from 7 to 2, and latency from 13.0s to 5.8s. Input rose from 698 to 779 tokens because the prompt is stricter.

## D21. Bound extraction and rerank inputs

Extraction now receives only known entities whose name or alias appears in the focus message or its eight context messages, capped at 50. Previously it received every entity in the space, so prompt size grew with memory. The match uses the same normalized name comparison as retrieval.

`HttpExtractionProvider` accepts `reasoningEffort` and parses `usage` into `lastUsage` and cumulative `usage`. `health()` reports the cumulative totals. Reasoning tokens are often the largest part of completion usage, so a caller can see them and lower the effort. There is no output token cap: truncating the structured JSON fails parsing and retries the job. Input bounds and reasoning effort are the useful controls.

`rerankPool` bounds the number of fused candidates sent to the reranker. It defaults to 50 and is capped at 50. Within the top 50, candidates past the rerank pool keep their normalized RRF score, so lowering the pool does not reduce the number of results returned by `topK`.

## D22. Eight semantic entity types, `other`, and special `self`

The general `EntityType` is `person`, `group`, `place`, `animal`, `object`, `artifact`, `activity`, `topic`, and `other`. The first eight are the semantic classes; `other` remains the fallback. `project` and `product` merge into `artifact`; `organization` merges into `group`.

`self` is not a general category. It is a special `EntityKind` reserved for the assistant entity and marked with `metadata.self = true`. Models, tools, other agents, and AI products are `artifact`; companies and institutions are `group`.

There is no runtime compatibility layer for retired type names. The HTTP parser accepts the general types plus `self`, and falls back to `other` for anything else. Schema version 2 migrates `organization`, `project`, and `product`; schema version 3 converts `ai` rows to `self` when they are marked as self, otherwise to `artifact`. Entity document text includes the type, so an upgraded database needs one `reindex()`.

## D23. One self entity and a hard `self` guard

Each memory space has at most one self entity, marked with `metadata.self = true` and type `self`. The `self` option or `ensureSelf()` creates it, and every assistant speaker resolves to it. The self entity is sent first in `knownEntities`, so the extractor has a stable identity for claims and event roles about the assistant.

Provider output is not trusted for this kind. An entity requested as `self` resolves to the self entity only when its name or alias matches; otherwise it is stored as `artifact`. `ensureEntity()` rejects `self`, so the public API cannot create a second one. Claims and event participants that refer to the assistant share the self entity ID. Persona, background, and preferences are stored as the self entity's description and as claims about it. Second-person queries add the self entity to retrieval mentions.

## D24. Explicit consolidation instead of per-message extraction

Ingestion used to enqueue one `annotate` job per message, and `drain()` called the extraction provider once per message. Batching messages before `drain()` did not reduce model calls, because each job carried one focus message.

Extraction now belongs to an explicit consolidation step. `ingest()` appends the message and queues only the local chunk job. `consolidate()` selects messages with `consolidated_at` null, groups them per conversation, and sends one extraction call per batch of up to 32 messages, capped at 128. A failed call leaves the batch pending, and the next call retries. `drain()` covers chunk and index jobs only.

The caller decides when memory is formed. The intended point is before context compaction or a session switch, when the agent is about to lose the raw conversation. Retrieval is unchanged and still runs on every `getContext()` call; only extraction moves off the turn path. The provider contract changed from `focusMessageId` to `focusMessageIds`, so one request can cover a whole batch. Repeated calls are incremental because they select only messages with `consolidated_at` null, and calls on one instance are serialized so an overlapping second call runs after the first.

The effect is proportional to batch size. A 100-message session now costs four extraction calls instead of 100. The formal 714-question offline run completed with 74% evidence recall and 78% context hit, unchanged from earlier runs. It used 482 consolidation calls for 4480 messages; one call per message would have been 4480. The harness consolidates at every exam cutoff, so this call pattern is closer to per-item than to per-session.

## D25. Context contract, short refs, and structured relevance

The real-model review showed that 46 of 60 failures already had the anchor in context. The context now renders a two-line memory contract, short refs with a `refs` map, local dates with a weekday, record-derived conflict and uncertainty sections, and modality markers. Retrieval trace notes and provider errors stay in the trace. Entity descriptions are suppressed when a rendered claim or event already describes the entity. Evidence selection keeps linked claim and event evidence even without query overlap and adds adjacent turns when slots remain.

The SQL channel now ranks claims and events by query overlap with their document text, then status or intent boosts and recency, before its cap. This stops the newest unrelated records from filling the fusion pool.

Workspace and memory space lookups now reuse an existing row by name when the caller omits an id. This fixes resume reopening a fresh empty space. On the real P01 database, two opens return the same workspace and space with 704 messages.

Deferred: the as-of replay harness, extraction schema v5, token estimator calibration, and a context-aware internal judge. The next change is the extraction contract, because all 7,260 claims in the real-model databases are active with no supersession and no validity time.

## D26. Attribute-keyed claim state

The real-model databases held 7,260 claims, 6,309 globally distinct predicates, 17 rows matching the seven-predicate whitelist, zero superseded claims, and zero validity times. Free-text predicates meant the state machine almost never ran.

Claims now store `attribute`, `cardinality`, and the result of a change verb. The pipeline normalizes the attribute, resolves cardinality from the `attributes` registry, and applies `new`, `adds`, `replaces`, `retracts`, or `disputes`. One-valued attributes supersede a later value and keep the old row with `valid_until`; older evidence lands as superseded history. Many-valued attributes accumulate, and an explicit replace removes only the matching object. Retraction never falls back to another value. The context groups conflicts by attribute.

Schema version 5 adds the columns and the registry, and backfills `attribute` from the normalized predicate. Existing claims default to `many`, so an upgrade does not change current state. Providers that omit the new fields keep legacy behavior.

Verification: 61 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717.

## D27. Modality, polarity, and attribution

Extraction previously dropped every non-asserted claim, so a denial or a plan vanished while an assistant restatement could become a world fact. The linker now stores modality and polarity. A user-grounded negation becomes an asserted negative fact and retracts the matching positive value. Uncertain, hypothetical, quoted, and reported claims are stored and rendered in `[Unconfirmed]`. An asserted claim backed only by assistant messages, about a subject other than the assistant, is stored as quoted; a self-subject claim with a literal object keeps its asserted modality.

Schema version 6 adds `claims.modality`, `claims.polarity`, and `events.modality`, and backfills them from the existing metadata. Legacy negated rows become asserted negative facts. The context reads event modality from the column and marks planned, quoted, and uncertain events.

Verification: 64 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717.

## D28. Absolute time for claims and events

The extractor saw relative expressions such as 昨天 or next Wednesday but had no instruction for resolving them, and neither side carried a unit. Claims had no time field at all, so the context showed the earliest evidence message date. A value the user reported as having started years earlier therefore rendered as the day it was mentioned.

Claims now carry `validFrom`, and both `validFrom` and event `occurredAt` are absolute epoch seconds. The prompt resolves each relative expression against the occurrence time of the message that states it and omits the field when it cannot. The parser also accepts milliseconds from models that send them, and drops negative, out-of-range, or non-numeric values rather than guessing. The context renders a validity date as `始于` and an evidence fallback as `记录于`, so the model can tell when a value became true from when it was recorded.

Verification: 66 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717.

## D29. Sensitivity, disclosure, and a private section

The real-model review found four inappropriate-disclosure failures. Three of the four had the anchor in context: the value rendered as an ordinary entity description or evidence line, so the answer model repeated it in a public blurb.

Claims, events, and entities now carry `sensitivity` (`normal` or `private`) and `disclosure` (`allowed`, `alias_only`, or `do_not_volunteer`). Extraction supplies both; the pipeline defaults a private record to `do_not_volunteer` and only upgrades restriction, never downgrades it. Schema version 7 adds the columns.

The context moves restricted records to a `[Private]` section whose first line says to quote them only when the question asks directly. A private entity description leaves the public entity line. Evidence that supports a restricted claim or event is marked `私密原文`. Values and evidence stay in the context, so a direct question can still be answered and the evidence invariant is unchanged. Conflicts and uncertainty notes use public records only, because a conflict line would expose both private values.

Sensitivity comes from the extraction field. The engine has no topic-word list and no persona-, question-, or phrase-specific rule.

No provider payload is redacted. The extractor must see its source message, and the embedding text must stay retrievable; the answering context is the only surface that can restate a value to a user.

Verification: 71 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717. The offline stack uses rule extraction, which emits no restrictions, so these metrics check for regressions, not the privacy effect.

## D30. Compact extraction wire

Extraction output was 70.5% of consolidation cost, and every claim and event repeated a 36-character evidence UUID. The extraction user payload was 70.8% message JSON, and only 30.1% of it was message content.

`HttpExtractionProvider` now defaults to a compact wire. The request sends focus indices, `[role, speaker, content, occurredAt]` message tuples without IDs, and `[name, type, aliases?]` known entities without IDs. The response uses `e`, `c`, and `v`, short keys, type codes, per-item evidence indices, and omitted defaults. The parser accepts both response shapes, so a model that answers in the old shape still parses. Evidence indices resolve only against focus messages: an absent list falls back to the first focus message, and a context-only list is dropped, so a claim never attaches to a context message. `diagnostics` counts both. `wireFormat: "legacy"` keeps the old prompt and body for an A/B.

On a 16-message, 20-entity fixture the compact request body is 54% of the legacy body. That is a fixture measurement, not a production saving. The offline stack uses rule extraction, so it cannot measure this change; a real-model A/B remains the gate.

Verification: 74 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717.

## D31. Optional known-facts digest

Extraction saw known entities and attribute keys but not their current values, so it could restate an unchanged fact or miss that a value changed. The digest was capped tightly after the cost review: an earlier 24-fact version was estimated at 840-1,440 input tokens per call, several times its first estimate.

`knownFacts: true` sends up to 12 `{subject, attribute, value}` facts: active asserted positive claims for the batch's speakers and mentioned entities, deduplicated, ordered by entity order then attribute, with restricted records excluded. The prompt appends one no-restatement rule only when facts are present. The engine's object dedupe and state machine still decide what is stored, so a model that ignores the digest does not corrupt state.

It is off by default. It is a correctness feature, not a cost saving: the added input is real, and the benefit needs a real-model A/B to quantify.

Verification: 76 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717.

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

## Verification record (2026-11-09)

| Check             | Result                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `pnpm verify`     | Pass, 55 tests, 1 real-model test skipped                             |
| Real P01 reopen   | Same workspace and space ID across two opens, 704 messages            |
| Formal offline    | 74.0% evidence recall, 78.0% context hit, 482 batches, 0 errors       |
| Context tokens    | p50 717, p95 1598, max 1600; baseline was p50 725, p95 1599, max 1600 |
| Context UUIDs     | 0 of 714 rendered contexts contain a raw UUID                         |
| Retrieval latency | p50 13.0 ms, p95 38.1 ms                                              |
