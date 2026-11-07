# Benchmark

The harness reads the JSONL format from [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark). It measures retrieval, not answer quality.

## What the harness does

For each question:

1. Select the persona's history prefix up to `cutoff_turn`.
2. Ingest each turn as one user message and one assistant message.
3. Drain extraction and indexing.
4. Call `getContext()` with the question.
5. Check whether an answer-key anchor turn appears in the returned evidence messages.

History is ingested incrementally per persona, so the engine never sees turns after the question's cutoff. Questions and contexts are not written back to memory.

The adapter accepts:

- a repository root, if `demo/exam-inputs.jsonl` exists;
- a `demo` directory;
- a dataset directory with `exam-inputs.jsonl`, `histories/`, and optional `review-only/answer-key.jsonl`.

Anchor turns map to message indexes `2 × (turn - 1)` and `2 × (turn - 1) + 1`. This assumes one user message and one assistant message per turn, which is the dataset contract. Each question is scored independently; histories are reused across questions with the same or later cutoff.

## Commands

```bash
git clone https://github.com/Ornn8/chat-memory-benchmark.git ../chat-memory-benchmark

# Public demo, 108 questions
node bench/run.ts \
  --dataset ../chat-memory-benchmark/demo \
  --out bench/out/demo

# Formal set, 714 questions
node bench/run.ts \
  --dataset ../chat-memory-benchmark/datasets/natural-timegrid-20261101-v2 \
  --out bench/out/formal

# Raw chunk baseline
node bench/run.ts --dataset <path> --mode raw --out bench/out/formal-raw

# Local fixture used by CI and quick checks
pnpm bench
```

Options: `--limit`, `--persona`, `--max-tokens`, `--top-k`, `--mode hybrid|raw`, `--models`.

`--models` builds providers from `NAMISO_*` variables. Without it, the run uses the offline defaults and the report records them. When the extraction provider exposes usage, the CLI prints cumulative prompt, completion, reasoning, and total tokens after the report.

`bench/out/` is ignored by git. Each run writes `contexts.jsonl` and `report.json`.

## Metrics

- **Evidence recall**: for each anchor turn, whether at least one of its two messages appears in the context evidence. Averaged over scoring questions. Multi-anchor questions average per anchor.
- **Context hit rate**: whether any anchor for the question appears. This is higher when a question has several anchors.
- **Context tokens**: the engine's heuristic estimate for the assembled context.
- **Retrieval latency**: wall time for one `getContext()` call, including query embedding, retrieval, reranking, expansion, and context assembly.
- **Ingest time**: all message writes, drains, consolidation, extraction, and indexing for the run.
- **Consolidation batches**: extraction provider calls. One call covers up to 32 pending messages.

Answer-key `retrieval_required: false` entries are excluded from recall. The demo has four such entries, so 104 of 108 questions are scored.

## Results

Environment: Windows 11, Node 26.13.0, AMD Ryzen 9 8945HX, 32 logical cores, single process. The harness does not control CPU frequency or background load. Runs were sequential.

Formal set, 714 scored questions, 6 personas, 2240 turns:

| Run | Mode            | Evidence recall | Context hit | Tokens p50 / p95 / max | Retrieval p50 / p95 | Ingest |
| --- | --------------- | --------------- | ----------- | ---------------------- | ------------------- | ------ |
| 1   | hybrid          | 74%             | 78%         | 725 / 1541 / 1609      | 13.29 / 30.05 ms    | 19.3 s |
| 2   | hybrid          | 74%             | 78%         | 725 / 1539 / 1609      | 12.94 / 30.71 ms    | 19.2 s |
| 3   | hybrid          | 74%             | 78%         | 725 / 1538 / 1609      | 12.56 / 29.73 ms    | 18.6 s |
| 4   | hybrid          | 74%             | 78%         | 725 / 1541 / 1609      | 11.01 / 26.86 ms    | 17.1 s |
| 5   | hybrid          | 74%             | 78%         | 725 / 1539 / 1609      | 10.87 / 26.68 ms    | 17.1 s |
| 6   | hybrid          | 74%             | 78%         | 725 / 1541 / 1609      | 11.32 / 26.43 ms    | 17.0 s |
| 7   | hybrid, batched | 74%             | 78%         | 725 / 1599 / 1600      | 11.58 / 27.50 ms    | 16.5 s |
| 1   | raw chunks      | 73%             | 77%         | 699 / 1515 / 1584      | 12.56 / 31.04 ms    | 19.1 s |
| 2   | raw chunks      | 73%             | 77%         | 699 / 1515 / 1584      | 12.01 / 30.19 ms    | 18.8 s |

Recall and hit rate are identical across the six hybrid runs because extraction, embedding, and ranking are deterministic. Latency varies with machine load.

Run 7 is the only run with explicit consolidation. It made 482 extraction calls for 4480 messages; the earlier runs made one call per message. The harness consolidates at every exam cutoff, so 482 reflects that call pattern, not the fewer calls a session-boundary integration would make. Scores are unchanged.

By interval, hybrid run 1:

| Interval | Questions | Evidence recall | Context hit |
| -------- | --------- | --------------- | ----------- |
| d0       | 189       | 74%             | 78%         |
| d3       | 184       | 75%             | 78%         |
| d15      | 174       | 75%             | 79%         |
| d45      | 167       | 71%             | 77%         |

Public demo, 108 questions (104 scored), 299 turns:

| Mode       | Evidence recall | Context hit | Tokens p50 / p95 | Retrieval p50 / p95         | Ingest       |
| ---------- | --------------- | ----------- | ---------------- | --------------------------- | ------------ |
| hybrid     | 100%            | 100%        | 379 / 417        | 5.4 to 5.6 / 9.2 to 10.0 ms | 1.3 to 1.4 s |
| raw chunks | 100%            | 100%        | 371 / 406        | 5.08 / 9.32 ms              | 1.3 s        |

All runs reported zero item errors. Ranges cover repeated hybrid runs; the raw demo was measured once.

## Offline provider stack

The scores above used no external model service. Namiso filled the three provider slots with the deterministic defaults:

| Slot       | Default                  | What it does                                                                        |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Extraction | `RuleExtractionProvider` | Regex patterns for names, preferences, usage, locations, recommendations, and loans |
| Embedding  | `HashEmbeddingProvider`  | Hashes word and adjacent-word features into 256 normalized dimensions               |
| Reranker   | `LexicalReranker`        | Counts query-token overlap and gives a small ordered-match bonus                    |

These are real providers behind the same interfaces as the HTTP implementations. They produce deterministic vectors and scores, so the pipeline runs end to end and the benchmark is reproducible. They are not semantic models. Current runs print their identities as `embedding=namiso-hash extraction=rule-v2 reranker=namiso-lexical`. The results above were recorded with `rule-v1` before the entity type migration. `--models` replaces any of them with the configured HTTP provider.

## Reading the numbers

Evidence recall is not answer accuracy. A context can contain the anchor message and still produce a wrong answer, and an answer can be correct from a paraphrase without the exact anchor. The official repository requires a separate answer model and its own grader. This harness exports `contexts.jsonl` for that step and does not call a model.

The result table above uses the offline defaults. `--models` replaces them with configured HTTP providers and records their identities in the report. The default stack is offline and deterministic. `HashEmbeddingProvider` hashes word features; it does not place paraphrases near each other. `RuleExtractionProvider` covers a small pattern set. A production embedding model and an LLM extractor should change both recall and the structured-memory share of the result.

The raw baseline uses only chunks (`memoryTypes: ["conversation"]`). The hybrid gain on the formal set is one point of evidence recall. The structured layer's advantage is current-state tracking, supersession, uncertainty, and evidence-linked claims. This metric barely measures those, because most formal questions ask for episodic facts that appear in raw text.

The demo set is saturated at 100% for both modes. It is useful as an integration check, not as evidence of ranking quality.

The context budget is a target, not a cap. The builder shortens excerpts until the estimate fits and keeps every selected record. A set of records larger than the target reports `overBudget` rather than losing entries.

## Provenance

- Benchmark repository commit: `1916d40e04a5062b4957e643da251126f1f55708`
- Formal dataset: `natural-timegrid-20261101-v2`
- Namiso version: 0.1.0

Do not compare these numbers with published scores from the benchmark's charts. The published results cover different question subsets and use a different answer model and grader.
