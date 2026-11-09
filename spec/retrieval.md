# Retrieval

Retrieval combines structured lookup, full-text search, and vector search. The pipeline is `src/retrieval/retriever.ts`; context assembly is `src/context/builder.ts`.

## Query parsing

`parseQuery()` classifies intent from markers:

| Intent         | Markers                                     |
| -------------- | ------------------------------------------- |
| `current_fact` | 现在, 目前, 当前, currently, now            |
| `history`      | 以前, 曾经, 过去, 之前, used to, previously |
| `event`        | 什么时候, 发生过, 讨论过, when did          |
| `entity`       | 是谁, 是什么, who is                        |
| `general`      | Everything else                             |

A query with both current and history markers is general. A current query filters out non-active claims after fusion. A history query keeps superseded claims.

`analyzeQuery()` adds a multi-label view alongside that projection. Aspects are `current`, `change`, `event_time`, `entity`, `history`, and `general`; `general` appears only when no other aspect matched. Aspects are cues, not exclusive categories. A change query keeps inactive claims and fetches events. Facets split the query at clause punctuation and at whole-token conjunctions (`和`, `与`, `以及`, `and`, `or`, and similar), keep the first three non-duplicate fragments with content, and drop a fragment whose token set equals the whole query. `trace.intent` keeps the older single-label projection, so existing callers are unchanged.

Entity resolution checks explicit `entityIds` first. Otherwise it matches every entity name and alias against the query text. A query containing a second-person marker (`你`, `您`, `you`, `your`) adds the self entity, so questions such as `你的性格是什么` reach the assistant's persona claims. A query containing a first-person marker also adds the latest user speaker. This is how `我现在使用什么模型` reaches the user's active claims without naming the user. Only explicitly named or explicitly requested entities create coverage quotas; self and speaker entities added by a pronoun do not.

## Query time

`resolveTimeExpressions(query, now, timeZone)` converts bounded expressions into half-open epoch ranges. It handles relative days (今天, 昨天, 明天), qualified weekdays (上周三, next Friday), counted intervals (3天前, 两周后), months and years (上个月, 去年), absolute dates (2026-03-02, 3月2日, 2025年12月), and their English forms. Each window carries its granularity and whether the year was implied. An open range such as `4月15日之前` or `before yesterday` produces no window, because its bounds are not known. `now` and `timeZone` come from the caller; the zone must be an IANA name.

The windows are a soft signal. A claim or event in a window gains 0.5 in the SQL channel's relevance, and every in-window candidate gains 0.1 after ranking. Retrieval does not hard-filter on an interpreted window: expansion, null-time records, and a false positive would all lose evidence, and an explicit `timeRange` already provides a deterministic filter. `trace.time` records `now`, the zone, and the windows. The context renders the first window as `[Query Time]` before the claims section.

## Channels

**SQL** returns mentioned entities, claims for those entities, and events with those participants. Claims and events are ranked by query overlap with their document text, then by status or intent boosts and recency, before the channel cap. This keeps recent but unrelated records from displacing a relevant older one. With no mentioned entity, an event or history query returns recent events.

**FTS5** searches pre-segmented document text. Chinese text is segmented with `Intl.Segmenter('zh', { granularity: 'word' })`; the index stores words separated by spaces. The default SQLite tokenizer then handles each word. Query terms are ORed with quotes. This avoids relying on a tokenizer that does not segment Chinese.

A second index stores CJK bigrams. The FTS channel runs the word query first, filtered to the requested memory types. When fewer than three eligible word hits remain, it runs the bigram query and appends new candidates after the word hits. This recovers a substring such as `州西` from a document that segmented as `杭州` and `西湖`. The trace notes when the fallback ran.

**Vector** embeds the query and searches `sqlite-vec` for the nearest documents. If the extension is unavailable, the engine scans stored float32 vectors and computes cosine similarity. Both backends return document IDs; the engine maps them to chunk, entity, claim, or event candidates. When the query has facets, the same batched `embed` call also embeds each facet, and the best rank per candidate across the facet searches forms one **facet** channel.

Channels return at most 80 candidates. The FTS channel asks for the top 30 matches before that cap.

## Fusion

Reciprocal Rank Fusion merges channels by rank, not by raw score:

```text
RRF(d) = Σ 1 / (60 + rank_i(d) + 1)
```

The fused candidate keeps the union of its channels. A candidate found by several channels rises.

## Reranking

The top 50 fused candidates form the ranking pool. The first `rerankPool` of them go to the reranker. `rerankPool` defaults to 50 and is capped at 50. The default reranker is a lexical overlap scorer. Candidates past the rerank pool keep their normalized RRF score, so a small pool does not reduce the number of results returned by `topK`. The final score is:

```text
0.7 × relevance + 0.3 × normalized RRF
```

If the reranker throws, retrieval keeps the RRF order and adds a note to the trace. If it returns fewer scores than documents, missing scores fall back to normalized RRF. If every returned score lies within 1e-9 of the others, the scores carry no ranking information; retrieval keeps the RRF order and notes the degenerate result in the trace.

The reranker judges relevance only. It does not decide whether a claim is current or an event is uncertain.

## Selection

The ranked pool feeds coverage selection, which returns `min(topK, pool length)` items:

1. Take rank 1.
2. For each facet, keep the highest-ranked unpicked candidate that shares at least half the facet's tokens and scores at least 0.25 × the top score. If a selected candidate already covers the facet, no slot is used.
3. For each explicitly named entity, do the same with a candidate whose structured record names it.
4. Fill the remaining slots with `0.7 × score − 0.3 × max Jaccard(tokens, selected)`.

Quota slots stop at `topK`. The floor applies only to quota slots, so the result still reaches the requested size. An empty pool returns an empty selection. `trace.coverage` records the floor, each facet and entity quota, which candidate filled it, and whether it added a slot.

## Validation

After fusion:

- Current queries drop claims whose status is not `active`.
- A time range drops claims and events outside the range. Entities and chunks are not filtered because a chunk can span the boundary.
- Multiple active claims with the same subject and predicate produce a conflict note.
- Events whose stored modality is `uncertain` produce an uncertainty note.

Notes appear in `trace.notes` and in the final context's uncertainty section.

## Expansion

The engine expands up to five top candidates through `memory_links` and event participants:

- Linked claims and events are added with a score decay of 0.8.
- Related events from the same participant are added with a decay of 0.7.
- Expansion stops at 30 extra candidates and two link hops.
- `includeEvidence` adds up to 20 evidence messages as candidates.

Expansion can add superseded claims to a current-query result. That is intentional: the context shows the current claim and its history separately.

## Evidence selection

The context builder chooses at most 12 evidence messages. A naive earliest-first selection loses the anchor when a relevant chunk ranks below an irrelevant one. Selection works in three passes:

1. For each candidate in rank order, choose its messages with the highest query-token overlap. Chunks contribute up to three messages; claims and events up to four, and linked claim or event evidence is kept even when it shares no query token, because the follow-up that resolves a question is often short.
2. Add the messages adjacent to each chosen message when slots remain.
3. Fill remaining slots with the highest-ranked messages that had no overlap.

Chosen evidence is displayed in time order. This keeps the context readable while preserving the message that answers the query.

## Context assembly

Sections appear in this order:

1. Memory contract
2. Query time, when a bounded expression resolved
3. Current claims
4. Unconfirmed claims
5. Relevant entities
6. Unresolved conflicts
7. Uncertain events
8. Historical events
9. Historical claims
10. Memory relations
11. Private records
12. Evidence messages

The contract states that the sections are the retrieved record, that the answer must not add facts, dates, causes, or status, and that a missing record is answered as missing rather than as never having happened.

Current claims are asserted claims. A negative fact renders with `≠` before the object. Claims with uncertain, hypothetical, quoted, or reported modality render in the unconfirmed section with their modality label instead of `当前有效`. Conflicts are computed only from asserted positive claims.

A record with `sensitivity = private` or `disclosure` other than `allowed` renders in the private section instead of its normal section, with a marker: `私密`, `仅用别名`, or `不主动提及`. The section states that its records are quoted only when the question directly asks. The value stays visible, so a direct question can still be answered. A private entity description never appears in the public entity line; it renders in the private section. Evidence lines whose message supports a private claim or event carry `私密原文`. Conflicts and uncertain-event notes are computed only from public records, because rendering both sides of a private conflict would expose it.

Claims show their status and, when known, the date the value became true: the claim's `validFrom` renders as `始于`, and the earliest evidence message renders as `记录于` when `validFrom` is absent. Entities show a description only when no rendered claim or event already describes them; otherwise the description is omitted or marked as an early summary. Conflicts are computed from rendered active claims with the same subject and predicate and different values. Each conflict line lists both values with dates and instructs the reader not to choose. Events are selected by retrieval rank, then displayed in time order; each carries a modality marker, and an undated event shows the date of its earliest evidence message as `时间未知（提及于 …）`. Retrieval trace notes, including reranker errors, never enter the model text.

Dates are formatted in the requested IANA time zone with a weekday, such as `2026-07-01（周三）`. The default is the process time zone.

Each line carries a reference such as `[claim:c1]` or `[message:m1]`. `MemoryContext.refs` maps the reference back to the record ID. `idMode: "full"` renders the raw IDs instead. `MemoryContext.items` and `MemoryContext.evidence` always keep full records and IDs.

Every item keeps its internal reference, so a caller can fetch the record.

The budget is a target, not a cap. `estimateTokens()` charges 0.7 per CJK character, 1 per CJK punctuation mark, 0.8 per UUID character, 0.25 per ASCII letter or space, and 0.7 per remaining character. The coefficients were calibrated against the configured endpoint's reported prompt tokens on benchmark contexts. The estimate is a heuristic, not a tokenizer.

The builder renders every selected item at full detail first. If the estimate exceeds `maxTokens`, it scales excerpt lengths for evidence, event summaries, entity descriptions, and literal objects down to a floor, then binary-searches the scale that fits. Nothing is dropped: every claim, entity, event, relation, and evidence message keeps its ID line, and `context.evidence` still returns full message records. `compressed` reports that excerpts were shortened. `overBudget` reports that even the floor exceeded the target, which happens when the selected items alone cost more than `maxTokens`. The uncertainty section is part of every render. An empty context is never returned for a non-empty result set.

## Trace

Every result includes a trace with:

- query and parsed intent; `intent` is the older single-label projection;
- multi-label aspects and facet strings;
- resolved entity IDs;
- per-channel counts and top five keys, including the facet channel;
- fused, reranked, and expanded counts; `rerankedCount` is the number sent to the reranker and is 0 when reranking is off;
- the coverage floor and each facet or entity quota result;
- the interpreted time windows, clock, and zone when a query has a bounded time expression;
- elapsed milliseconds;
- notes for degraded reranking, degenerate reranker scores, unavailable vector search, conflicts, and uncertain events.

The trace is the first place to look when a memory is missing from the context.
