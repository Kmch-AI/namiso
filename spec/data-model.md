# Data model

The schema is `src/storage/schema.ts`. Repositories in `src/storage/` are the only code that reads or writes these tables.

## Isolation

`workspaces` contains `memory_spaces`. Every conversation, message, entity, claim, event, document, and job belongs to one memory space. Repository methods take a space ID and filter on it. There are no cross-space joins or vector searches.

## Tables

| Table                 | Purpose                                               | Key constraints                                                         |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `workspaces`          | Top-level grouping                                    | Primary key                                                             |
| `memory_spaces`       | Isolation boundary and configuration                  | Foreign key to workspace                                                |
| `conversations`       | Conversation metadata                                 | Space, external ID, time range                                          |
| `messages`            | Raw conversation, append-only                         | Unique `(conversation_id, message_index)`; unique external ID per space |
| `entities`            | People, AI, organizations, places, projects, products | Space and name index                                                    |
| `entity_aliases`      | Alternate names                                       | Unique alias per space                                                  |
| `claims`              | Subject, predicate, object facts                      | Subject and predicate index; status                                     |
| `events`              | Time-bound occurrences                                | Time, type, and status indexes                                          |
| `event_participants`  | Entity roles in an event                              | Composite primary key                                                   |
| `annotations`         | Message-to-memory links                               | Unique `(message_id, target_type, target_id, role)`                     |
| `evidence`            | Source records for memories                           | Unique `(space, source_type, source_id, evidence_type)`                 |
| `memory_evidence`     | Claim or event to evidence                            | Composite primary key                                                   |
| `memory_links`        | Memory-to-memory relations                            | Unique endpoints and relation                                           |
| `chunks`              | Conversation windows used for retrieval               | Unique `(conversation_id, ordinal)`                                     |
| `chunk_messages`      | Chunk membership and order                            | Composite primary key                                                   |
| `embedding_documents` | Retrieval document text and stored vector             | Unique `(source_type, source_id, model_name)`                           |
| `jobs`                | Outbox for extraction and chunk work                  | Unique `dedupe_key`; status and `run_after` index                       |
| `fts_documents`       | FTS5 index over pre-segmented document text           | Virtual table, rebuilt from documents                                   |
| `vec_documents`       | sqlite-vec table keyed by document ID                 | Virtual table, dimensions from the embedding provider                   |

## Identifiers

Every persisted ID is a UUID string. Domain types brand them, so `EntityId` and `EventId` cannot be swapped by accident. Conversion happens in `src/ids.ts` at the storage and API boundaries.

Chunk IDs are deterministic: `chunk:<conversationId>:<ordinal>`. Job IDs are deterministic from their dedupe key: `job:<dedupeKey>`. Deterministic IDs make retries idempotent.

## Claim state

`claims.status` is one of:

| Status       | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `active`     | Current valid claim                                |
| `superseded` | Replaced by a later claim                          |
| `disputed`   | Conflicting claims exist                           |
| `retracted`  | The source withdrew it                             |
| `invalid`    | No evidence remains or the claim failed validation |

A superseded claim keeps its row. Its `valid_until` records when the replacement took effect. A `memory_links` row with `supersedes` connects the new claim to the old one.

Functional predicates (`name`, `occupation`, `location`, `age`, `uses`, `works_at`, `status`) allow one active value per subject and predicate. Other predicates can accumulate multiple active claims, so `likes` and `friend_of` do not replace earlier values.

## Event state

Events are historical. A state change adds a new event and a `supersedes` link to the previous event. The old event stays `active` because the event did happen. `superseded` is a claim status, not an event status. Event status is `active`, `retracted`, or `invalid`.

`time_precision` is `exact`, `day`, `month`, `approximate`, or `unknown`. The rule extractor uses `day` for message time and `approximate` for relative phrases such as `上周`. It never presents a guessed time as exact.

## Time model

Every message stores `occurred_at`, the logical time of the conversation, and `created_at`, the wall-clock time the engine wrote it. Claims and events use `occurred_at` values from their source messages. `valid_from` and `valid_until` describe when a claim was true, not when the row was written.

## Evidence

An evidence row names its source. The first version uses `source_type = 'message'`. `evidence_type` separates `user_statement`, `assistant_statement`, and `external`. This distinction matters: a user saying "B may resign" supports the claim that the user said it, not the claim that B resigned. The rule extractor records uncertain statements as low-confidence events and skips their claims.

## Derived indexes

`embedding_documents` stores the retrieval text, its content hash, model name and version, dimensions, and a float32 vector blob. FTS rows and `vec_documents` rows are keyed by the document ID.

Changing the embedding model changes the document identity. `reindex()` deletes the space's documents and index rows, rebuilds document text from structured records and chunks, and re-embeds. The schema does not depend on any provider.
