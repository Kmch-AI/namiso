# Namiso

Namiso is a standalone long-term memory engine for AI agents. It keeps the raw conversation, extracts structured memories from it, and returns a context an agent can use.

The engine does not run an agent, call tools, or schedule messages. It owns conversation history, memory spaces, extraction, links, indexes, and retrieval.

## What it stores

- Raw messages, append-only.
- Entities, aliases, claims, and events.
- Evidence that connects each claim and event to the messages that support it.
- Links that record supersession, updates, contradictions, and other state changes.
- Derived FTS and vector indexes that you can rebuild.

## Requirements

Node.js 24 or newer and pnpm 12. The package is ESM and uses the built-in `node:sqlite` module.

## Quick start

```ts
import { Namiso } from 'namiso'

const memory = await Namiso.open({
  databasePath: './memory.db',
  memorySpace: { name: 'assistant' },
})

const conversation = memory.createConversation({ title: 'first' })

await memory.ingest({
  conversationId: conversation.id,
  speakerId: 'user',
  role: 'user',
  content: '我在使用 IndexTTS2。',
})

await memory.drain()

const context = await memory.getContext({
  query: '我现在使用什么模型？',
})

console.log(context.text)
memory.close()
```

`drain()` runs extraction, link updates, and index writes. For lower ingest latency, batch several messages and call `drain()` once.

## Default providers

The defaults run offline:

| Provider   | Default                  | Use                                                        |
| ---------- | ------------------------ | ---------------------------------------------------------- |
| Extraction | `RuleExtractionProvider` | Deterministic pattern extraction for tests and small demos |
| Embedding  | `HashEmbeddingProvider`  | Deterministic feature hashing, not a semantic model        |
| Reranker   | `LexicalReranker`        | Token overlap scoring                                      |

Production deployments should pass an LLM extraction provider and a real embedding model. `HttpExtractionProvider`, `HttpEmbeddingProvider`, and `HttpRerankerProvider` accept OpenAI-compatible endpoints. See `spec/providers.md`.

## Real models

Providers are injected in `Namiso.open()`. Pass `embedding`, `extraction`, and `reranker` directly, or build them from environment variables:

```ts
import { Namiso, providersFromEnv } from 'namiso'

const memory = await Namiso.open({
  databasePath: './memory.db',
  ...providersFromEnv(process.env),
})
```

`providersFromEnv()` reads the variables in `.env.example`. An endpoint URL and a model name must be set together. Embedding also requires `NAMISO_EMBEDDING_DIMENSIONS` to match the model output. Empty variables are ignored, so the offline defaults stay active.

To run the benchmark against real models, export the variables and add `--models`:

```bash
node bench/run.ts --dataset <path> --models --out bench/out/models
```

The report prints the actual embedding, extraction, and reranker identities. The integration test is opt-in and skipped by default:

```bash
NAMISO_RUN_MODEL_TESTS=1 pnpm test:integration
```

The integration points are in `src/providers/types.ts` (interfaces), `src/providers/http.ts` (HTTP adapters), `src/providers/from-env.ts` (environment factory), and `src/namiso.ts` (`Namiso.open`). The benchmark passes its provider set in `bench/chat-memory-benchmark.ts`. The opt-in test is `test/models.integration.test.ts`.

## Retrieval

`getContext()` runs SQL, FTS, and vector retrieval, fuses the results with Reciprocal Rank Fusion, reranks the candidates, expands linked memories, checks status and time, and assembles a token-budgeted context with evidence IDs.

`retrieve()` returns the ranked candidates and the retrieval trace without assembling a context.

## Benchmark

The harness reads the JSONL format from [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark). It measures whether the evidence message for an answer appears in the returned context. It does not measure answer correctness.

Formal set, 714 questions, 6 personas, 2240 turns, ranges over repeated runs:

| Mode               | Evidence recall | Context hit rate | Retrieval p50   | Retrieval p95   |
| ------------------ | --------------- | ---------------- | --------------- | --------------- |
| Hybrid             | 74%             | 78%              | 10.9 to 13.3 ms | 26.4 to 30.7 ms |
| Raw chunk baseline | 73%             | 77%              | 12.0 to 12.6 ms | 30.2 to 31.0 ms |

Public demo, 108 questions (104 scored), 299 turns: 100% evidence recall in both modes.

The default hash embedding is not semantic, so a real embedding model should change these numbers. The raw baseline shows that structured memory adds little to evidence recall on this dataset. Its main gain is current-state and state-change handling, which the evidence-recall metric does not score. See `spec/benchmark.md`.

## Docs

- `AGENTS.md` lists project conventions and the documentation map.
- `spec/README.md` indexes the module docs.

## License

MIT.
