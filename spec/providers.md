# Providers

Namiso calls three model interfaces. The core stores only the interface outputs and the provider identity.

## Extraction

```ts
interface ExtractionProvider {
  readonly version: string
  extract(input: ExtractionInput): Promise<ExtractionResult>
}
```

Input contains the focus message IDs, the message batch, known entities, and known attributes. Output contains entities, claims, events, and evidence message IDs. See `src/providers/types.ts` for the full shape.

Each claim carries `predicate` plus optional `attribute`, `cardinality`, `change`, `validFrom`, `sensitivity`, and `disclosure`. `attribute` is the stable state key; the pipeline normalizes it and falls back to the predicate. `cardinality` is `one` or `many`. `change` is `new`, `adds`, `replaces`, `retracts`, or `disputes`. `validFrom` is the absolute time the value became true. `sensitivity` is `normal` or `private`; `disclosure` is `allowed`, `alias_only`, or `do_not_volunteer`. Entities and events accept the same two fields. A provider that omits these fields keeps the legacy behavior: the predicate becomes the attribute, the known one-valued predicate set gets `one`, every other attribute gets `many`, and every record is normal and allowed. The HTTP prompt sends `knownAttributes` so the model can reuse an existing key across batches.

The extraction prompt must extract only from the messages listed in `focusMessageIds`. Context messages and known entities are for resolving references. `knownEntities` must not appear in the output unless a focus message mentions them. The engine sends only entities mentioned in the focus batch or the recent context, capped at 50; it does not send the whole space. Known attributes are those whose key or label appears in the focus batch or recent context, capped at 24.

The prompt uses the entity set in `spec/data-model.md`. `self` is the special kind for the assistant itself, and the self entity is sent first in `knownEntities`. The prompt instructs the model to attach the assistant's persona, background, and preferences to that entity, and to classify models, tools, other agents, and AI products as `artifact`, and companies and institutions as `group`. The HTTP parser accepts the general types plus `self`; any other value falls back to `other`.

The default `RuleExtractionProvider` uses deterministic regular expressions. It is suitable for tests and small offline demos, not production extraction. Coverage and limits are in `spec/annotation.md`.

`HttpExtractionProvider` posts an OpenAI-compatible chat completion with `response_format: { type: "json_object" }`. It reads `choices[0].message.content` and parses the JSON object. If the content has surrounding prose or a code fence, the provider retries with the substring from the first `{` to the last `}`. Malformed items are dropped; content with no parseable object throws. Evidence IDs that the model cannot know fall back to the first focus message. Each HTTP call covers one consolidation batch.

Claim `validFrom` and event `occurredAt` are absolute epoch seconds. The prompt resolves a relative expression such as 昨天 or next Wednesday against the occurrence time of the message that states it, and omits the field when it cannot. The parser also accepts milliseconds: a value above 10^11 is divided by 1000. A negative, out-of-range, or non-numeric time is dropped rather than guessed.

The prompt marks a record private only when the message presents it as confidential, such as a secret, another person's health, family, or finances, a private message, or an explicit request not to tell someone. A request to use only an alias marks that value `alias_only`; the request itself stays a normal record. The engine applies no topic-word list of its own.

Options:

| Option            | Sends              | Notes                                                                  |
| ----------------- | ------------------ | ---------------------------------------------------------------------- |
| `reasoningEffort` | `reasoning_effort` | `none`, `minimal`, `low`, `medium`, or `high`; endpoint support varies |
| `onUsage`         | not sent           | Called as `(usage, total)` after each response that includes usage     |

The provider parses `usage` from the response. `lastUsage` holds the latest call, `usage` holds cumulative totals, and `reasoningTokens` reads `completion_tokens_details.reasoning_tokens`. `cacheHitTokens` and `cacheMissTokens` read `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, or `prompt_tokens_details.cached_tokens`; both stay absent when the response reports neither. `health()` reports the cumulative totals when the provider exposes them. A response without `usage` leaves the totals unchanged and sets `lastUsage` to `null`.

## Embedding

```ts
interface EmbeddingProvider {
  readonly model: string
  readonly version: string
  readonly dimensions: number
  embed(texts: readonly string[]): Promise<number[][]>
}
```

`HashEmbeddingProvider` hashes word features into a fixed-width, L2-normalized vector. It is deterministic and offline. It is not a semantic model: synonyms and paraphrases do not move closer.

`HttpEmbeddingProvider` posts `{ model, input: string[] }` to the endpoint and expects `{ data: [{ embedding: number[] }] }` or `{ embeddings: number[][] }`. It batches 64 texts by default. Each vector must match `dimensions`.

### Changing the embedding model

Document identity is `(source_type, source_id, model_name)`. After a model or dimension change, run `reindex()` before retrieval. Without it, old documents keep their old model and vectors. A dimension change also recreates the `vec_documents` table.

## Reranker

```ts
interface RerankerProvider {
  readonly model: string
  rerank(input: {
    query: string
    documents: readonly string[]
  }): Promise<Array<{ index: number; score: number }>>
}
```

`LexicalReranker` scores token overlap and gives a small bonus to a document that contains all query tokens in order. It is deterministic and offline.

`HttpRerankerProvider` posts `{ model, query, documents }`. It accepts `{ scores: number[] }`, `{ results: [{ index, score }] }`, or `{ data: [{ index, relevance_score }] }`. The response must contain one score per document.

The engine expects scores on a comparable scale. The final ranking uses 0.7 × reranker score + 0.3 × normalized RRF. A cross-encoder that returns logits should normalize its scores before returning them.

## Environment wiring

`providersFromEnv()` maps environment variables to HTTP providers. It returns an empty object when no provider is configured, so `Namiso.open()` keeps the offline defaults.

| Prefix     | Variables                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction | `NAMISO_EXTRACTION_URL`, `NAMISO_EXTRACTION_MODEL`, `NAMISO_EXTRACTION_API_KEY`, `NAMISO_EXTRACTION_VERSION`, `NAMISO_EXTRACTION_REASONING_EFFORT`                     |
| Embedding  | `NAMISO_EMBEDDING_URL`, `NAMISO_EMBEDDING_MODEL`, `NAMISO_EMBEDDING_DIMENSIONS`, `NAMISO_EMBEDDING_API_KEY`, `NAMISO_EMBEDDING_VERSION`, `NAMISO_EMBEDDING_BATCH_SIZE` |
| Reranker   | `NAMISO_RERANK_URL`, `NAMISO_RERANK_MODEL`, `NAMISO_RERANK_API_KEY`                                                                                                    |
| Shared     | `NAMISO_MODEL_TIMEOUT_MS`                                                                                                                                              |

An endpoint and model must be set together. An embedding endpoint also requires dimensions. Values are trimmed; empty values count as unset. `NAMISO_EXTRACTION_REASONING_EFFORT` accepts `none`, `minimal`, `low`, `medium`, or `high`.

Where the code connects:

| Concern                           | File                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| Provider contracts                | `src/providers/types.ts`                                              |
| HTTP payload parsing and requests | `src/providers/http.ts`, `src/providers/http-util.ts`                 |
| Environment factory               | `src/providers/from-env.ts`                                           |
| Injection into the engine         | `src/namiso.ts`, `Namiso.open()` options                              |
| Benchmark injection               | `bench/run.ts` `--models`, passed in `bench/chat-memory-benchmark.ts` |
| Opt-in real-model test            | `test/models.integration.test.ts`                                     |
| Fake-boundary tests               | `test/providers.test.ts`                                              |

`.env.example` lists the full set. The package does not load `.env`; run Node with `--env-file=.env` or export the variables in the shell.

## Implementing a provider

1. Implement the interface from `src/providers/types.ts`.
2. Validate external payloads at the provider boundary. Return typed results or throw.
3. Keep model-specific imports inside `src/providers/`.
4. Do not write to the database from a provider.
5. Pass the provider to `Namiso.open()`.

Provider failures throw. Messages in the failed batch stay pending; calling `consolidate()` again repeats extraction from the current state.

## Defaults and evaluation

| Provider   | Default                  | Deterministic | Semantic |
| ---------- | ------------------------ | ------------- | -------- |
| Extraction | `RuleExtractionProvider` | Yes           | No       |
| Embedding  | `HashEmbeddingProvider`  | Yes           | No       |
| Reranker   | `LexicalReranker`        | Yes           | No       |

The benchmark results in `spec/benchmark.md` use these defaults. They show what the engine does without a model service, not what a production embedding or LLM would do.
