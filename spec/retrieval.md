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

Entity resolution checks explicit `entityIds` first. Otherwise it matches every entity name and alias against the query text. A query containing a first-person marker also adds the latest user speaker. This is how `我现在使用什么模型` reaches the user's active claims without naming the user.

## Channels

**SQL** returns mentioned entities, claims for those entities, and events with those participants. Active claims sort before inactive ones. With no mentioned entity, an event or history query returns recent events.

**FTS5** searches pre-segmented document text. Chinese text is segmented with `Intl.Segmenter('zh', { granularity: 'word' })`; the index stores words separated by spaces. The default SQLite tokenizer then handles each word. Query terms are ORed with quotes. This avoids relying on a tokenizer that does not segment Chinese.

**Vector** embeds the query and searches `sqlite-vec` for the nearest documents. If the extension is unavailable, the engine scans stored float32 vectors and computes cosine similarity. Both backends return document IDs; the engine maps them to chunk, entity, claim, or event candidates.

Channels return at most 80 candidates. The FTS channel asks for the top 30 matches before that cap.

## Fusion

Reciprocal Rank Fusion merges channels by rank, not by raw score:

```text
RRF(d) = Σ 1 / (60 + rank_i(d) + 1)
```

The fused candidate keeps the union of its channels. A candidate found by several channels rises.

## Reranking

The first 50 fused candidates go to the reranker. The default is a lexical overlap scorer. The final score is:

```text
0.7 × relevance + 0.3 × normalized RRF
```

If the reranker throws, retrieval keeps the RRF order and adds a note to the trace. If it returns fewer scores than documents, missing scores fall back to normalized RRF.

The reranker judges relevance only. It does not decide whether a claim is current or an event is uncertain.

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

The context builder chooses at most 12 evidence messages. A naive earliest-first selection loses the anchor when a relevant chunk ranks below an irrelevant one. Selection works in two passes:

1. For each candidate in rank order, choose its messages with the highest query-token overlap. Chunks contribute up to three messages; claims and events up to two.
2. Fill remaining slots with the highest-ranked messages that had no overlap.

Chosen evidence is displayed in time order. This keeps the context readable while preserving the message that answers the query.

## Context assembly

Sections appear in this order:

1. Current claims
2. Relevant entities
3. Historical events
4. Historical claims
5. Memory relations
6. Evidence messages
7. Uncertainty

Every item keeps its internal ID, such as `[claim:<uuid>]` or `[message:<uuid>]`, so a caller can fetch the record.

The budget uses `estimateTokens()`: one per CJK character and one per four remaining characters. The heuristic is deliberately conservative. Sections shrink from the end when they exceed the budget. The uncertainty section is always appended, so it can push the estimate slightly over the limit. An empty context is never returned for a non-empty result set.

## Trace

Every result includes a trace with:

- query and parsed intent;
- resolved entity IDs;
- per-channel counts and top five keys;
- fused, reranked, and expanded counts;
- elapsed milliseconds;
- notes for degraded reranking, conflicts, and uncertain events.

The trace is the first place to look when a memory is missing from the context.
