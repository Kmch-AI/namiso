# Roadmap

## Implemented

| Stage | Scope                                                                                  | Status                                                         |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P0    | Raw conversations, chunks, embeddings, vector search                                   | Implemented                                                    |
| P1    | Entities, aliases, claims, events, annotations, evidence, batch extraction             | Implemented                                                    |
| P2    | Memory links, entity resolution, state supersession, uncertainty, temporal fields      | Implemented with rule-based extraction                         |
| P3    | SQL, FTS5, vector, RRF, reranker, graph and timeline expansion                         | Implemented                                                    |
| P4    | Context builder, soft token target, evidence injection, uncertainty notes              | Implemented                                                    |
| P5    | Harness adapter                                                                        | Library API only; no Cortico adapter exists in this repository |
| P6    | Attribute state, modality, absolute time, sensitivity and disclosure, context contract | Implemented                                                    |

## Deferred

- HTTP server and transport API.
- Background worker process. `drain()` is explicit.
- Import and export of a memory space.
- Entity merge and split operations after creation.
- LLM validation and contradiction resolution during annotation.
- Automatic consolidation and forgetting policies.
- Multi-process writer coordination.
- A custom FTS tokenizer. The current implementation pre-segments text.
- Benchmarks for answer quality, cost, and latency under a real model provider.

## Explicit non-goals for the first version

- Agent reasoning, planning, or message scheduling.
- A graph database or a separate vector database.
- Automatic personality evolution.
- Dropping raw messages after summarization.
- Binding the core to one LLM, embedding model, or reranker.
- Treating a generated user profile as the only memory.

These boundaries follow the design brief in section 16. Extend them only after the core memory model and evaluation harness are stable.
