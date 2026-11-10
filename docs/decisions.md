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

## D32. Interpreted query time without hard filtering

Relative-date questions were a measured error class. Extraction now stores absolute validity time, but retrieval did not interpret the question's own time phrase, so the answer model had to do calendar arithmetic.

`resolveTimeExpressions()` converts bounded phrases into half-open epoch ranges in a caller-supplied zone and clock. It covers Chinese and English relative days, weekdays, counted intervals, months, years, and absolute dates. Open ranges such as `4月15日之前` produce no window. The windows add a soft boost (0.5 in SQL relevance, 0.1 after ranking), appear in `trace.time`, and render as `[Query Time]`.

The first design used a hard filter with a widening fallback. Review found it would lose evidence: expansion re-adds out-of-window links, the survivor count is dominated by chunks and entities that the filter never drops, null-time records pass, and a false positive can silently empty the result. An explicit `timeRange` already covers the deterministic filter case. The soft boost and the rendered window keep every record and remove the calendar arithmetic from the answer model.

Verification: 89 tests pass, 1 integration test skipped. The formal offline run stays at 74.0% evidence recall and 78.0% context hit, with context tokens p50 717. The d3 interval moved from 75.0% to 76.0% evidence recall; the other intervals are unchanged. This is a dev-set observation, not a held-out claim.

## D33. Multi-label query aspects, facets, and coverage selection

The query parser returned one intent from one marker set. Multi-clause and differently-worded questions could lose their second or third fact to the `topK` cut.

`analyzeQuery()` adds multi-label aspects (`current`, `change`, `event_time`, `entity`, `history`, `general`) and up to three facets split on clause punctuation and whole-token conjunctions. `trace.intent` keeps the older projection, so existing callers and tests are unchanged. The SQL channel uses aspects to keep inactive claims for change queries and to fetch events for change, history, event-time, and time-window queries.

Facets are embedded in the same `embed` call as the raw query, and the best rank per candidate across the facet searches becomes one RRF channel. Selection reserves one slot for rank 1, one per facet, and one per explicitly named entity, then fills with a 0.7/0.3 Jaccard MMR. Quota slots respect `topK` and a 0.25 score floor. Self and speaker entities added by a pronoun create no quota, an empty pool returns an empty selection, and a facet counts as covered only when at least half its tokens overlap a selected item.

Measured on the formal offline run: aggregate evidence recall and context hit are unchanged at 74.0% and 78.0%. Interval results move (d0 78% to 77%, d3 78% to 79%, d45 77% to 76%). Context tokens p50 moves from 717 to 724. Retrieval latency p50 moves from 12.2 to 30.8 ms because the hash embedder runs three vectors on multi-clause queries; facets trigger on 619 of 714 queries. The offline hash embedder cannot exploit semantic facet similarity, so this is a no-regression check, not evidence of a gain. A real-model A/B remains the gate.

Verification: 94 tests pass, 1 integration test skipped.

## D34. CJK bigram fallback in a separate FTS table

Word segmentation misses a substring query such as `州西` against `杭州西湖`, because the document indexes `杭州` and `西湖` and the query becomes one word. Adding bigrams to the existing `fts_documents` table would collide with word tokens: FTS5 cannot tell a word from a bigram, so the first stage would match bigrams before any gate.

Schema version 8 adds `fts_ngrams`, populated with CJK bigrams only. The retriever runs the word FTS first, filtered to the requested kinds; only when fewer than three eligible word hits remain does it run the bigram query and append new candidates after the word hits. The kind filter runs before the gate, so a conversation-only query is not closed by claim-only word hits. The trace notes the fallback.

Verification: 96 tests pass, 1 integration test skipped. Two fixtures cover substring recovery and the no-fallback path. The formal offline run is unchanged at 74.0% evidence recall and 78.0% context hit, with context tokens p50 724. Ingest rose from 16.1s to 26.3s for 2240 turns because each document writes two FTS rows. The dev set shows no recall gain from this mechanism; it is a generic CJK recall fallback, not a tuned one.

Turn-pair documents are not added. The chunk policy already accepts size 1 or 2, so a caller can get turn-level windows without a new source type, and a new source type would need its own candidate mapping, forget and rebuild paths, and duplicate fusion. Automatic entity merge is not added either: alias text is already indexed and matched, and merging on name similarity would be unsafe. Both stay deferred.

## D35. Review corrections to the Phase 3 retrieval change

An adversarial review of the Phase 3 diff confirmed these defects. A month qualified by 今年/去年/明年 now selects that year, and a bare month uses the most recent past occurrence. February 29 falls back to the most recent leap year instead of rolling into March 1. Day and week ends use the next civil boundary, so a DST day is not 25 hours. Multi-word English phrases resolve before their single-word parts, and a trailing English before or after no longer turns a bounded phrase into an open range. Windows return in source order. A change query keeps superseded claims through validation. FTS kind filtering happens inside the query, before the limit, for both the word and bigram stages. A model switch deletes the previous model's FTS rows in the same upsert, and the indexer removes their vectors.

Verification: 103 tests pass, 1 integration test skipped. The formal offline run remains at 74.0% evidence recall and 78.0% context hit, with context tokens p50 724 and ingest 26.3s.

## D36. Stable request prefix for extraction prompts

The extraction request is serialized in property order, and providers that cache prompt prefixes (such as OpenAI-compatible prompt caching) can only reuse a prefix that matches byte for byte. The per-call `focus` and `messages` came first, so every request diverged at the first field and no prefix could be reused across batches.

Both request builders now order the stable known state first (`knownEntities`, `knownAttributes`, `knownFacts`) and the per-call `focus`/`messages` last. The known state is itself capped and its order is deterministic, so consecutive batches share a longer prefix. JSON property order is the serialization order, so the change needs no format version. The response parser is order-independent.

Verification: 103 tests pass, 1 integration test skipped; a test asserts the first three keys of the compact payload. The formal offline run is unchanged at 74.0% evidence recall and 78.0% context hit with p50 724 context tokens, because the offline providers do not issue HTTP requests. A real-model 20-call run reports 9,600–13,952 cache-hit tokens in both wire formats, about 4–6% of prompt tokens. Both builders use the new order, so this does not isolate the reorder; it shows the endpoint caches roughly the system prompt and little of the per-call payload, so the ordering buys at most a few hundred tokens per call there. The order stays because it is behavior-neutral and a precondition for providers that cache longer prefixes.

## D37. Real-model extraction A/B for the compact wire format and the known-facts digest

The compact wire format and the known-facts digest were unit-tested but never compared with the earlier format on a real model. `bench/extraction-ab.ts` runs one persona's first 320 turns (640 messages, 20 consolidation batches of 32) through each arm with hash embedding, so only extraction calls the model service. The endpoint is a local OpenAI-compatible proxy (deepseek-v4.1-flash, reasoning effort low, temperature 0). The legacy arm did not change across runs 1–3, so its spread estimates run-to-run noise. Run 4 applied the validFrom and privacy fixes from this entry.

| Arm               | Claims | Attributes | Events | Timed claims | Private claims | Extraction tokens |
| ----------------- | ------ | ---------- | ------ | ------------ | -------------- | ----------------- |
| legacy 1          | 224    | 158        | 86     | 84           | 27             | 362,762           |
| legacy 2          | 218    | 157        | 84     | 27           | 17             | 389,335           |
| legacy 3          | 218    | 166        | 65     | 12           | 35             | 351,087           |
| compact 1         | 185    | 124        | 115    | 5            | 7              | 233,673           |
| compact 2         | 164    | 91         | 112    | 6            | 11             | 250,959           |
| compact 3         | 181    | 113        | 127    | 11           | 6              | 226,351           |
| compact 4 (fixed) | 187    | 104        | 105    | 20           | 3              | 210,358           |
| legacy 4 (fixed)  | 232    | 196        | 71     | 28           | 9              | 372,533           |
| compact-facts 1   | 162    | 106        | 96     | 3            | 9              | 211,537           |
| compact-facts 2   | 128    | 78         | 102    | 2            | 6              | 214,973           |
| compact-facts 3   | 169    | 96         | 90     | 23           | 10             | 214,325           |

Cost is the largest and most stable effect: compact uses 40–43% fewer extraction tokens, with prompt tokens down 47% and completion down 31–41%. The count differences are structural, not noise: compact extracts 15–20% fewer claims and 30–40% fewer distinct attributes, and 40–60% more events. The planned ±5% count gate is not met. The event surplus is unresolved; the raw responses show compact splitting narration into more dated events, which may be more anchors or more noise.

Two defects were found and fixed. First, the compact schema reused `v` for the object value and the claim start time, and the model never emitted it: 5–11 timed claims against legacy's 12–84. Spelling out `validFrom` and stating that it is set when the message gives or implies when the value became true raised compact to 20/187 (10.7%) against legacy's 28/232 (12.1%) in the matched run. Second, the original privacy example list made the model mark ordinary family facts private: the legacy arm produced 35 private claims including the father's age, former job, and TV taste, the mother's job, and the user's sore wrist. Clarifying that only a confidential presentation counts, and that ordinary facts about family or colleagues are not private, cut legacy to 9 private claims, all genuine. Compact still misses an explicit "do not bring it up" request, so its 3 private claims are lower than legacy's 9; the gap tracks its lower claim count rather than the rule, but it remains a disclosure risk.

Evidence integrity held in every arm: no claim or event lacked evidence. Dropped non-focus citations were 0–5 for compact and 0 for legacy; stating that `ev` indexes `messages` removed the drops in the final compact run.

The known-facts digest used 6–14% fewer tokens than compact and 8–22% fewer claims with 14–15% fewer attributes in every run, with no quality signal. It stays off by default.

Run-to-run noise is large for some fields. With the same legacy prompt and data, claims varied 2.8%, but timed claims ranged 12–84 and private claims 17–35. Future extraction A/Bs need repeated runs; one run cannot decide a prompt change.

Decision: compact stays the default because the cost saving is large and consistent and the two identified semantic defects are fixed and verified. Quality parity is not proven; the next gate is an answer/judge A/B on a held-out slice with frozen prompts. `knownFacts` stays opt-in.

Verification: 103 tests pass, 1 integration test skipped. The formal offline run is unchanged because the offline rule extractor never issues HTTP requests.

## D38. Calibrated token estimate for context budgeting

`estimateTokens` charged one per CJK character and one per four other characters. The spec called it deliberately conservative, but a measurement against the configured endpoint's `usage.prompt_tokens` shows the errors point both ways: about 0.68 tokens per CJK character, 1.0 per CJK punctuation mark, 0.78 per UUID character, 0.27 per ASCII letter or space, and 0.7 per remaining character. The old formula overcounted CJK by about 45% and undercounted UUIDs by about 3x.

The estimator now uses 0.7 per CJK character, 1.0 per CJK punctuation mark, 0.8 per UUID character, 0.25 per ASCII letter or space, and 0.7 per remaining character. On nine benchmark contexts the old estimate/measured ratio ranged 0.88–1.24; the new one ranges 0.81–1.22. Synthetic cases separate cleanly: 240 CJK characters estimate 157 against 161 measured, a 36-character UUID estimates 29 against 29, and 450 English characters estimate 117 against 100.

Verification: 105 tests pass, 1 integration test skipped. The formal offline run stays at 74.0% evidence recall and 78.0% context hit, with p50 725 (was 724). 119 of 714 rendered contexts changed, with mean characters up 2.6%, because most contexts are below the target and only near-budget contexts are recompressed. The estimator is tied to the configured tokenizer; recalibrate when the answer model changes. The 1600 target is unchanged.

## D39. Rerank the whole candidate pool

The HTTP reranker hardening capped the request at 25 documents while the retriever's rerank pool defaults to 50. A candidate outside the cap is not reranked and keeps only its 0.3 × normalized RRF share, while a reranked candidate adds 0.7 × its reranker score. A relevant candidate at RRF rank 26–50 can therefore never outrank a reranked irrelevant one, even when its fused rank is best.

The real-model full run exposed this: P16 evidence recall was 13% and P01 33%. Replaying one missed P16 item with the stored database showed unrelated chunks and a generic claim in the top results with the 25-document cap, and the correct sister-stress claims, phone-call events, and entity at the top with 50 documents. The excerpt length was not the cause: 25 documents at 240 or 2,000 characters ranked equally badly.

`HttpRerankerProvider` now defaults `maxDocuments` to 50, the default pool size. A provider configured with a smaller cap still has this failure mode; the spec states that the cap must cover the whole pool. A test asserts the default sends 50 of 60 documents.

Verification: 106 tests pass, 1 integration test skipped. Rerunning the same real-model databases with the fix raised evidence recall from 50% to 86% on P12, from 20% to 72% on P14, from 33% to 90% on P01, from 13% to 81% on P16, and from 18% to 75% on P17, with context hit following the same path. The combined 714-item run reaches 77.8% evidence recall and 82.5% context hit. The formal offline run is unaffected because it uses the lexical reranker.

D42 corrects the mechanism. An un-reranked candidate keeps its full normalized RRF, not 0.3 of it. A reranked candidate gets 0.7 × relevance + 0.3 × normalized RRF. With relevance near 1e-6, the cap pushed ranks 26–50 above ranks 1–25. Raising the cap to 50 removed that asymmetry and restored the RRF order; it did not improve reranking.

## D40. Full real-model run with reasoning off

Configuration: compact wire format, `knownFacts` off, reasoning effort `none` for extraction, answer, and judge, real Qwen3 embedding and reranker, calibrated token estimate, and the 50-document reranker pool from D39. Six personas ran in parallel over all 714 items.

Retrieval: 713 scored, 1 extraction error (`P20-CASE-045/d15`), 77.8% evidence recall, 82.5% context hit, context tokens p50 1178, p95 1599, max 1600.

Pass count: 608/714 = 85.2%. By persona: P01 73/88 (83.0%), P12 72/79 (91.1%), P14 65/82 (79.3%), P16 107/123 (87.0%), P17 148/172 (86.0%), P20 143/170 (84.1%).

Tokens: extraction 1,042,215 prompt (316,158 cache hit, 726,057 miss) and 213,135 completion; answer 1,381,033 prompt (all miss) and 31,978 completion; judge 890,036 prompt (319,740 hit, 570,296 miss) and 152,574 completion. Total 3,710,971 tokens, 397,687 of them output, with zero reasoning tokens. Cost at DeepSeek-V4.1-Flash off-peak prices: $0.2377 extraction + $0.2263 answer + $0.1780 judge = $0.6421; at peak prices $1.2843. Embedding and reranking run on local servers and add no API cost.

Comparison: the 2026-11-08 run passed 654/714 (91.6%) with the legacy extraction format, thinking answer and judge, and the pre-hardening reranker; its recorded cost was $1.7204. The current run is 6.4 points lower and 63% cheaper. The comparison is confounded by reasoning effort, wire format, reranker excerpts, and endpoint drift, so it is a configuration result, not an attribution. A pass-rate comparison at equal reasoning effort remains open.

Two follow-up experiments split the 106 failures. Re-answering all 106 with reasoning `low` and judging with the same `none` judge recovered 34, which projects to 642/714 (89.9%). Re-judging the original answers with a `low` judge recovered 8 of the 83 that produced valid reviews. Answer effort is the larger factor; judge effort is small. The remaining 64 failures include 42 whose context contained no anchor message, so retrieval and extraction changes account for the rest. The earlier answer path inherited the provider's thinking default, which is why the equal-effort premise did not hold: that run billed 104,497 answer output tokens against roughly 36k tokens of delivered answer text, while this run billed 31,978 with zero reasoning tokens.

The first pass of this run also exposed the reranker pool defect in D39: with the 25-document cap, persona recall was 13–50%. Rerunning the same databases with the 50-document default produced the retrieval numbers above.

Verification: 106 tests pass, 1 integration test skipped. The failed extraction batch stays pending; a rerun of that persona retries it. D43 invalidates the pass comparison: the rerun reused a fully built database.

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

## D41. Structured-first context selection

Configuration: commit cc3b090. Selection gives the topK slots to renderable records (entity, claim, event), and up to eight ranked source-only candidates join the result as evidence contributors without rendering lines of their own. The run reuses the D40 extraction databases and the same answer and judge setup: reasoning effort `none`, compact wire format, known-facts digest off, 50-document reranker pool.

Context composition over 714 items: Current Claims 1.93 → 2.68 entries, Historical Events 4.64 → 7.77, Relevant Entities 1.85 → 2.45. Evidence stays at twelve messages but its share of context characters falls from 57.3% to 46.3%. Mean estimated context tokens rise from 1173 to 1368.

Retrieval: evidence recall 77.8% → 76.0%, context hit 82.5% → 80.5%. The loss is concentrated in P20 (70.9% → 62.4%). Replaying `P20-CASE-009/d00` explains it: the answering event ranked 33rd, and the baseline reached it only because MMR over a pool that contained chunks picked the April chunk. Structured-first selection fills the twelve slots with records about later readthroughs, and the evidence allocation then took up to four messages from each of them, starving the chunk candidate even though it was in the result set.

Pass count: 606/714 (84.9%) against 608/714 (85.2%). By persona: P01 77/88 (+4), P14 69/82 (+4), P17 149/172 (+1), P12 71/79 (−1), P16 107/123 (0), P20 133/170 (−10). By content tag the gains are 分散的线索 +7.1pt, 时间约定 +7.0, 真实变化 +6.9, 职业 +5.9, 生日 +5.0; the losses are 敏感的事 −10.0, 偏好 −9.1, 计划假设梦转述猜测 −7.7, 用户的基本信息 −5.4, 第三方事实 −5.3. The two-question difference is within noise; the trade is episodic anchors against current-state and change records.

A fix attempt gave every candidate one evidence message before any candidate took a second. It recovered P20 to 68.5% evidence recall and 77.1% context hit, but cost P01 89.8 → 85.2, P12 88.6 → 83.5, and P16 82.1 → 78.9, for a pooled 75.2%. Reserving four source slots for raw dialogue changed nothing on P12 and P20. The attempt is reverted in ee1ab06.

Decision: keep structured-first selection. The pass count is a tie, and the gains land on state tracking, the layer's differentiator. P20 is the known weakness. The next step is record-anchored evidence closure: when a selected record names an event instance, pull that instance's evidence through its links or a sibling event instead of relying on raw chunk rank.

Tokens: extraction 1,255,350 (1,042,215 prompt, 213,135 completion); answer 1,569,548 (1,535,587 prompt, 33,961 completion); judge 1,040,402 (887,368 prompt, 153,034 completion, including a five-call retry). Total 3,865,300. Cost at DeepSeek-V4.1-Flash prices: $0.6575 off-peak, $1.3150 peak. The baseline D40 run used 3,710,971 tokens and $0.6421, so the richer context costs 4.2% more.

Verification: 108 tests pass, 1 integration test skipped. D43 invalidates the pass comparison in this entry: the run reused a fully built database. The context-composition numbers and the retrieval deltas stand.

## D42. The reranker signal is unusable

Direct probes against the configured reranker return scores between 1e-6 and 1e-15 for every document, including a document that contains the answer. The order is also unreliable: replaying the fifty-document pool for `P20-CASE-009/d00` puts the answering event at reranker rank 43. The blend is `0.7 × relevance + 0.3 × normalized RRF`, so with relevance near zero the final order is the RRF order.

This also explains D39 correctly. With the provider capped at 25 documents, the first 25 received `0.7 × ~0 + 0.3 × nrrf`, while documents 26–50 had no relevance and kept the full `nrrf`. The cap therefore pushed ranks 26–50 above ranks 1–25, which produced the 13–50% recall. Raising the cap to 50 made the treatment uniform and restored RRF; it did not improve reranking.

`isDegenerate` now treats a batch whose best score is below 0.001 as carrying no usable signal, keeps the RRF order, and notes it in the trace. A test covers scores around 1e-7. P20 would not be saved by calibration alone, because the reranker's own order is poor; instance-aware selection and evidence closure remain the retrieval fixes.

## D43. Database reuse leaked future messages

The D40 rerun and the D41 run reused fully built databases. Retrieval has no as-of filter, so contexts for early questions included messages from later turns. Counting evidence lines dated after the item's `now`: D40 432/713 contexts, D41 560/714. All 22 P20 items that flipped from pass to fail under D41 had 4–12 future evidence messages; the D40 contexts for the same items had none.

`P20-CASE-004/d03` shows the effect. Its `now` is 2026-04-18. The D41 context contains the 2026-07-22 message where the user quits the part-time job, and the answer asserts the quit and the date as fact. The D40 context contains only the April plan.

The 606 versus 608 pass comparison is therefore invalid, and the D41 trade-off analysis is provisional. The harness now rejects a database whose latest message is later than the first pending item's `now`. A clean comparison needs fresh databases or an as-of filter.

## D44. Occurrence edges and evidence closure

Problem. `P20-CASE-009/d15` asks "那回试读会" and retrieval selects claims about the first readthrough but not the April event that records what was pointed out. The event ranked 33 by RRF because the reranker returns unusable scores. Its evidence message 135 is the only record of the problem.

Design. A new claim whose subject entity is an occurrence (`other`, `activity`, `topic`) and whose predicate plus literal object names a non-self entity participant of an earlier event links to that event with `same_occurrence`. Candidates exclude events that share evidence messages with the claim. The score is token Jaccard between the claim assertion and the event type plus summary. The edge is written when the best score is at least 0.1 and at least twice the runner-up. The match runs after the batch's event loop so same-batch events are visible, and only for claims created in the batch. The link confidence is the score. Evidence closure adds a linked record's evidence to the linking candidate, and evidence selection takes one closure message per candidate before its own messages.

Prototype before the change, on a copy of the stored P20 database. A manual claim-to-event link made the April event render. Message 135 was still starved by the twelve-slot budget. Adding message 135 to the claim's evidence put it into the context. The shipped matcher reproduces the edge on the stored claim with confidence 0.25, and the context then contains the April event, message 135, and the relation line.

Precision. Across the six stored databases the claim rule writes two edges: the P20 attendance claim to the April event at 0.25, and one P16 claim at 0.143. Four personas write none. Looser variants wrote 54 claim edges and 6 to 20 event-to-event edges per persona, with clear false links such as a signboard-width claim linked to a no-cold-drinks event. Requiring the shared entity in the claim's own assertion removed those. The event-to-event variant was rejected on that evidence.

Live result. A fresh P20 database with the new code passes the d15 item at 2/2 anchors. The fresh extractor did not produce the instance claim, though; it recorded the June correction as an event, so the new link did not fire and the pass came from direct retrieval. The unit is proven on the stored records and dormant when extraction omits the trigger. The next step is the trigger: the correction must produce an occurrence claim or an explicit instance reference.

Verification: 111 tests pass, 1 integration test skipped. Offline formal set 74.0% evidence recall and 78.0% context hit, context tokens p50 858. Paired retrieval latency at the same machine: head p50 20.0 ms and p95 47.4 ms against pre-change 20.1 ms and 48.9 ms. Ingest 27.22 s against 27.16 s.

Non-overfit: no persona, question, or phrase rules in `src/`. The rule uses entity types, participant entities, time order, and token overlap. The threshold is relative.

## D45. Ordinal clauses trigger event occurrence links

Problem. D44 left the occurrence edge dormant when extraction records a correction as an event instead of an occurrence claim. The fresh P20 extractor did exactly that: the June correction became event `840f5c5a` with the summary "秦渡纠正试读会顺序：第一次在…咖啡馆（只来X），南岗社区图书室是第二次", and no claim had an occurrence subject.

Rejected trigger. Splitting every event summary into clauses and matching each clause against earlier events wrote 0 edges on P01 and 9 to 28 edges on each other persona, with clear false links such as a family mention linked to a knee-pain event and writing-session clauses each linked to one earlier writing event. Adding the requirement that the clause contain an ordinal occurrence reference (`第一次`, `上次`, `首次`, and similar) left one edge across the six stored databases and 1,406 events: the P20 correction to the April event, score 0.24.

Rule. When a created event's summary contains a clause with an ordinal occurrence reference, the linker matches that clause against earlier events. The clause must name a non-self entity that participates in the candidate event, the candidate must occur before the latest evidence message time, shared evidence excludes a candidate, and the score gate is the D44 gate. The relation is `updates` from the new event to the earlier one, because the correction restates the occurrence rather than recording it again. The evidence time anchors the match because a restating event often has no occurrence time.

Live result. On a copy of the fresh P20 database, the shipped path writes `updates` from event `840f5c5a` to the April event at 0.241. `P20-CASE-009/d45` asks "我第一次试读会在哪儿、谁来了、他指出什么问题？". Before the link the context lacks the April event. After it, the context contains the April event, the claim that X pointed out the motive timeline gap, and the relation line, and estimated tokens rise from 1,623 to 1,711.

Verification: 112 tests pass, 1 integration test skipped. A test covers a correction event linking its ordinal clause and a market trip with the same ordinal, place, and participant staying unlinked.

Non-overfit: the trigger uses ordinal language patterns, participant entities, evidence order, and token overlap. No persona, question, or event-summary strings.

## D46. Caller context resolves third-person queries

Problem. `getContext` received only the query. A follow-up such as "他最近在忙什么？" names no entity, so the SQL channel had nothing to look up and the engine could not use the previous turn. The chat harness holds that turn but had no way to pass it.

Design. `retrieve` and `getContext` accept `context?: string`, the recent dialogue, capped at 8,000 characters at the public boundary. It is read only when the query contains a third-person reference (`他`, `她`, `它`, `对方`, `这位`, `那人`, and similar), detected with a regex that excludes `其他`, `其它`, and `他人`. Matching runs on the last 240 characters of the context, falls back to the whole context, and adds at most two non-self entities. A person reference keeps person entities; a mixed reference keeps any type. Context entities join the mentioned set used by the SQL channel and appear in the trace, but create no coverage quotas, following the existing rule for pronoun-resolved entities. Ranking, FTS, and vector search still use the query alone.

Verification: a unit test resolves a friend named in the context for a `他` query, finds no entity without the context, ignores the context for a query without a reference marker, and rejects a context over the cap. 113 tests pass, 1 integration test skipped. The benchmark harness passes no context, so this unit has no benchmark delta; it is a caller-facing capability with unit coverage only.

Non-overfit: the rule uses pronoun markers and entity names from caller-supplied text. No persona, question, or phrase strings.

## D47. Bare entities take no context line

Problem. The relevant-entities section rendered every selected entity, so an entity with no description and no aliases produced a line that added only its name and type. In the P20 d15 readthrough context, two of the three entity lines carried no description and a third described a participant of a different instance. None answered the question, and each line cost context budget.

Rule. An entity renders only when it has details: aliases, a description that is not suppressed because a rendered claim or event already names the entity, or, for a restricted entity, a description for the private section. The section header disappears when no line remains. The entity is removed from `MemoryContext.items`, which lists rendered records, but it remains a retrieval candidate, so selection, expansion, and coverage quotas are unchanged.

Verification: a claim-named bare entity produces no `[Relevant Entities]` section while the claim renders; an entity with a description still renders its line; the private-entity test now asserts the public section is absent and the description stays in `[Private]`. 114 tests pass, 1 integration test skipped. The offline formal set stays at 74.0% evidence recall and 78.0% context hit, and context tokens p50 fall from 858 to 831; retrieval latency p50 is 19.7 ms and ingest 27.2 s.

## D48. Speaker identity merge kept after a controlled comparison

Problem. In the fresh P20 database the user was stored as three entities: `用户` with 147 claims, `秦渡` with 82, and `渡哥` with 53. The speaker entity comes from the message speaker, so a first-person query resolves to `用户` and the SQL channel never reaches the claims and events under the other names. Across 170 fresh P20 contexts, 24 contained claims on a named user entity. P20-CASE-029/d00 shows the cost: the self-introduction event that says the user writes suspense has `秦渡` as its participant, so the profile question never retrieves it and the answer denies the genre.

First attempt. A prompt rule named the user speaker entity and required first-person statements, including a self-given name, to use it. The configured extractor ignored it: a live P20 run still stored `秦渡 名字 秦渡` with the named entity as subject, contexts with named user claims rose from 24 to 77, evidence recall fell from 78.0% to 75.0%, and context hit from 84.0% to 80.0%. The prompt additions were removed.

Second attempt. A structural pass ran before entities and claims resolved. Self-introductions were read from the messages (`我叫X`, `我的名字是X`, `叫我X`), and name-like claims also registered aliases. Restricted claims registered nothing. The merge worked: the user entity absorbed `秦渡` and `渡哥` with aliases, no separate name entity remained, and contexts with named user claims fell from 24 to 2. The user entity grew to 311 claims and 66 events.

Live result. Fresh P20 end to end, answer at reasoning `none`, judged by the benchmark's own prompt: baseline 144/170 passed, merged 139/170. Evidence recall 78.0% in both runs, context hit 84.0% to 83.0%. Context tokens p95 rose from 1,669 to 1,850 and max from 1,924 to 2,229. Per-item flips were 12 gained and 16 lost. The gains include the predicted profile items (`P20-CASE-029/d03`, `P20-CASE-010/d03`); the losses include `P20-CASE-041` at two intervals, where the extractor attributed the 7/23 delivery to the story character 周砚, and several items where the merged subject crowded out the answer record. Extraction variance is large: an earlier fresh P20 run scored 81.0% evidence recall and this baseline 78.0% with the same code.

Third attempt. The merge was reduced to one source: the message pattern only, with the claim-source path removed, plus a veto for restricted name claims. The tree was rebuilt with this version and a second fresh P20 sample was taken. The merge again worked: contexts with named user claims were 3, and the user entity held 243 claims and 74 events. Retrieval scored 74.0% evidence recall and 80.0% context hit, against the 78.0%/84.0% baseline, with 3 extraction errors and 167 scored items. The two merged samples both land below the baseline.

Controlled comparison. The extraction replay harness keys each extraction request by the system prompt, focus indices, and message tuples, excluding known entities and facts. One error-free P20 build was recorded and replayed for both runs, so the only difference was identity resolution. Retrieval was neutral: 78.0% evidence recall and 85.0% context hit in both runs. Nine items changed anchors, four gained and five lost; `P20-CASE-028`, the city profile question, gained at all four intervals. End to end, the same answer and judge pipeline scored the baseline 137/169 and the merge 141/169, with 16 items gained and 11 lost. The gains include `P20-CASE-009/d45`, `P20-CASE-021/d00`, `P20-CASE-013/d03`, and `P20-CASE-025/d45`. The sign under a fixed extraction is positive on answers and neutral on anchors. The two earlier negative samples measured extraction variance, which moved the anchor score by 3 points with identical code.

Decision. The simplified merge ships. It reads self-introductions from the focus messages, vetoes names that a restricted claim marks private, and relies on the alias guard that refuses a name another entity owns (b5f8d13). The claim-source path and the prompt rule stay out. The per-subject claim cap was tried as the crowding companion and rejected (D49); under the same controlled replay it cost five anchors and gained none. The alias guard was replaced by duplicate-tolerant resolution in D50.

Verification: 117 tests pass, 1 integration test skipped; `pnpm verify` passes. The offline formal set scores 74.0% evidence recall and 77.0% context hit with p50 860 tokens; the one-point hit difference from the pre-merge 78.0% is `P20-CASE-025/d00`, where the merged participant changes the expansion graph. The controlled artifacts are under `bench/out/replay-clean/`.

## D49. Subject claim cap rejected on the controlled replay

Problem. A person accumulates claims, and the twelve context slots can fill with one subject's records. The baseline P20 contexts show 8 to 10 claims whose subject is the user for a single profile question, and the merged user entity measured in D48 held 243 to 311 claims.

Rule tried. Before coverage selection, the renderable claims were grouped by subject and capped at four in rank order. Each dropped claim's evidence messages moved to the first kept claim's closure evidence, so the evidence stayed reachable without a visible line.

Controlled result. One error-free P20 extraction recording was replayed for both runs, so the only difference was the cap. The baseline scored 78.0% evidence recall and 85.0% context hit. The cap scored 77.0% and 84.0%. Five items changed anchors, all five lost and none gained. The cap removed claims the questions needed; the MMR fill and the entity and facet quotas already kept one subject from taking every slot. Reverted in 3519a70.

The extraction replay harness stays in `bench/out/extraction-replay.mjs`. It keys each extraction request by the system prompt, focus indices, and message tuples, excluding known entities and facts, and it is the tool that separated the merge's neutral effect from the earlier extraction variance.

## D50. Duplicate names across entities, resolution by type then age

Problem. The alias index was unique on `(memory_space_id, alias)`, and `aliasOwnedElsewhere` skipped any extracted alias that another entity already owned. Two people sharing a name are normal, so the engine could not record the second one and the first claimant kept the string forever. Identity was decided by whoever wrote first, not by the entity.

Design. Aliases are unique per entity, not per space: `idx_entity_aliases_unique` covers `(memory_space_id, entity_id, alias)` (schema 9, `ALIAS_UNIQUENESS_MIGRATION_SQL`). Extraction attaches aliases without a collision check. Resolution picks a target from the evidence:

1. The self entity, when the name matches its name or one of its aliases. The assistant identity keeps precedence so speaker names do not fragment.
2. A canonical name, case-insensitive. This beats every alias, because an entity's own name is its primary designator.
3. Alias owners. An owner whose type equals the requested type wins; otherwise the oldest owner wins, ordered by `created_at` then ID. The order is stable, so repeated mentions keep resolving to one entity.
4. Otherwise create an entity.

The restricted-name rule is unchanged: a name-like claim marked private or restrictive still blocks the self-given-name scan, so a restricted name never becomes a public alias.

Verification: tests cover a duplicate alias attached to a second entity, a canonical name winning over another entity's alias, and a shared alias resolving to the typed owner over an older entity. A migration test builds a version-8 database with the old unique index and proves the rebuilt index accepts the same alias on a second entity. `pnpm verify` passes with 120 tests.

Controlled replay. The error-free P20 extraction recording was replayed into three fresh databases. The merge build scored 78.0% evidence recall and 85.0% context hit. The alias build scored the same, with one item changed: `P20-CASE-030/d03` fell from 2 to 1 anchor hits. A second identical alias build reproduced that same single change, so it is deterministic rather than run-to-run jitter; the merge-versus-alias context text also differs in 133 items, but that is a separate ordering effect, and a same-code rebuild still reorders 96. The cause is the two aliases the guard used to drop, `满编 → 小满` and `苏编 → full name`: entity documents index aliases, so their embeddings and downstream ranking shift. The lost anchor is the 2026-08-11 turn whose assistant line says the person manages the library; the 2026-07-14 turn carries the same fact, so the item's context hit stays true. Headline retrieval is unchanged.

## D51. Full-set real-model run with thinking answers

Run. The current version (12b93d0 plus e9fd003) built all 714 questions in one fresh database, 6 personas, 2,240 turns, 478 extraction batches. Extraction used `reasoning_effort=none`; answers and judging omitted the parameter, so they ran at the provider's default thinking level. Answers were capped at 4,096 tokens, reviews at 4,096 with retries at 8,192 and 32,768 for packets whose reasoning exhausted the cap. The answer model was the same `workbuddy2api/cn:deepseek-v4.1-flash` endpoint. Embedding and reranking stayed on the local Qwen3 servers.

Retrieval. 709 of 714 items scored; five extraction calls returned non-JSON and were skipped (`P12-ADD-001/d03`, `P17-CASE-011/d03`, `P17-CASE-013/d03`, `P20-CASE-022/d45`, `P20-CASE-030/d00`). Evidence recall 86.0%, context hit 89.0%, context tokens p50/p95/max 1,300/1,600/1,891, retrieval latency p50 449 ms, ingest 40.7 minutes.

Answers. 557 of 709 passed (78.6%). By persona: P01 71/88, P12 68/78, P14 57/82, P16 86/123, P17 140/170, P20 135/168. By interval: d0 155/188, d3 141/181, d15 134/174, d45 127/166. Answering took 11.2 minutes.

Cost. Extraction 1,249,408 tokens (prompt 1,039,267; completion 210,141; reasoning 0; cache hit 313,855). Answers 1,611,230 tokens (prompt 1,497,165; completion 114,065; reasoning 74,680; cache hit 37,504). Judging 1,701,406 tokens across three passes (prompt 863,953; completion 837,453; reasoning 686,750; cache hit 385,275; 866 calls). Total 4,562,044 tokens, of which 3,400,385 prompt, 1,161,659 completion, 761,430 reasoning, 736,634 cached. The provider exposes no per-call price or credit, so the cost basis is tokens. Wall clock was about 1 hour 46 minutes: 50 build and retrieval, 11 answers, 45 judging.

Artifacts. `bench/out/full-20261110/` holds `items.jsonl`, `contexts.jsonl`, `answers.jsonl`, `packets.jsonl`, `reviews.jsonl`, `results.jsonl`, `summary.json`, and the per-stage logs and usage files.

## Verification record (2026-11-09)

| Check             | Result                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `pnpm verify`     | Pass, 55 tests, 1 real-model test skipped                             |
| Real P01 reopen   | Same workspace and space ID across two opens, 704 messages            |
| Formal offline    | 74.0% evidence recall, 78.0% context hit, 482 batches, 0 errors       |
| Context tokens    | p50 717, p95 1598, max 1600; baseline was p50 725, p95 1599, max 1600 |
| Context UUIDs     | 0 of 714 rendered contexts contain a raw UUID                         |
| Retrieval latency | p50 13.0 ms, p95 38.1 ms                                              |
