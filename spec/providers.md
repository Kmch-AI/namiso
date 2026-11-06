# Providers

Namiso calls three model interfaces. The core stores only the interface outputs and the provider identity.

## Extraction

```ts
interface ExtractionProvider {
  readonly version: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
```

Input contains the focus message, recent messages, and known entities. Output contains entities, claims, events, and evidence message IDs. See `src/providers/types.ts` for the full shape.

The default `RuleExtractionProvider` uses deterministic regular expressions. It is suitable for tests and small offline demos, not production extraction. Coverage and limits are in `spec/annotation.md`.

`HttpExtractionProvider` posts an OpenAI-compatible chat completion with `response_format: { type: "json_object" }`. It reads `choices[0].message.content` and parses the JSON object. Malformed items are dropped; malformed top-level output fails the job. Evidence IDs that the model cannot know fall back to the focus message.

## Embedding

```ts
interface EmbeddingProvider {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}
```

`HashEmbeddingProvider` hashes word features into a fixed-width, L2-normalized vector. It is deterministic and offline. It is not a semantic model: synonyms and paraphrases do not move closer.

`HttpEmbeddingProvider` posts `{ model, input: string[] }` to the endpoint and expects `{ data: [{ embedding: number[] }] }` or `{ embeddings: number[][] }`. It batches 64 texts by default. Each vector must match `dimensions`.

### Changing the embedding model

Document identity is `(source_type, source_id, model_name)`. After a model or dimension change, run `reindex()` before retrieval. Without it, old documents keep their old model and vectors. A dimension change also recreates the `vec_documents` table.

## Reranker

```ts
interface RerankerProvider {
  readonly model: string;
  rerank(input: {
    query: string;
    documents: readonly string[];
  }): Promise<Array<{ index: number; score: number }>>;
}
```

`LexicalReranker` scores token overlap and gives a small bonus to a document that contains all query tokens in order. It is deterministic and offline.

`HttpRerankerProvider` posts `{ model, query, documents }`. It accepts `{ scores: number[] }`, `{ results: [{ index, score }] }`, or `{ data: [{ index, relevance_score }] }`. The response must contain one score per document.

The engine expects scores on a comparable scale. The final ranking uses 0.7 × reranker score + 0.3 × normalized RRF. A cross-encoder that returns logits should normalize its scores before returning them.

## Implementing a provider

1. Implement the interface from `src/providers/types.ts`.
2. Validate external payloads at the provider boundary. Return typed results or throw.
3. Keep model-specific imports inside `src/providers/`.
4. Do not write to the database from a provider.
5. Pass the provider to `Namiso.open()`.

Provider failures fail the job. The message and any structured rows already written stay in place; the next retry repeats the job from the current state.

## Defaults and evaluation

| Provider   | Default                  | Deterministic | Semantic |
| ---------- | ------------------------ | ------------- | -------- |
| Extraction | `RuleExtractionProvider` | Yes           | No       |
| Embedding  | `HashEmbeddingProvider`  | Yes           | No       |
| Reranker   | `LexicalReranker`        | Yes           | No       |

The benchmark results in `spec/benchmark.md` use these defaults. They show what the engine does without a model service, not what a production embedding or LLM would do.
