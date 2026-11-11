# Data model

The schema is `src/storage/schema.ts`. Repositories in `src/storage/` are the only code that reads or writes these tables.

## Isolation

`workspaces` contains `memory_spaces`. Every conversation, message, entity, claim, event, document, and job belongs to one memory space. Repository methods take a space ID and filter on it. There are no cross-space joins or vector searches.

## Tables

| Table                 | Purpose                                                                              | Key constraints                                                         |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `workspaces`          | Top-level grouping                                                                   | Primary key                                                             |
| `memory_spaces`       | Isolation boundary and configuration                                                 | Foreign key to workspace                                                |
| `conversations`       | Conversation metadata                                                                | Space, external ID, time range                                          |
| `messages`            | Raw conversation, append-only; `consolidated_at` marks extracted rows                | Unique `(conversation_id, message_index)`; unique external ID per space |
| `entities`            | People, groups, places, animals, objects, artifacts, activities, topics, other, self | Space and name index; one self per space                                |
| `entity_aliases`      | Alternate names                                                                      | Unique per entity; a name may repeat across entities                    |
| `claims`              | Subject, attribute, predicate, object facts                                          | Subject and attribute index; subject-object index; status               |
| `attributes`          | Attribute key, label, and cardinality per space                                      | Primary key `(memory_space_id, key)`                                    |
| `events`              | Time-bound occurrences                                                               | Time, type, and status indexes                                          |
| `event_participants`  | Entity roles in an event                                                             | Composite primary key                                                   |
| `annotations`         | Message-to-memory links                                                              | Unique `(message_id, target_type, target_id, role)`                     |
| `evidence`            | Source records for memories                                                          | Unique `(space, source_type, source_id, evidence_type)`                 |
| `memory_evidence`     | Claim or event to evidence                                                           | Composite primary key                                                   |
| `memory_links`        | Memory-to-memory relations                                                           | Unique endpoints and relation                                           |
| `chunks`              | Conversation windows used for retrieval                                              | Unique `(conversation_id, ordinal)`                                     |
| `chunk_messages`      | Chunk membership and order                                                           | Composite primary key                                                   |
| `embedding_documents` | Retrieval document text and stored vector                                            | Unique `(source_type, source_id, model_name)`                           |
| `jobs`                | Outbox for chunk and index work                                                      | Unique `dedupe_key`; status and `run_after` index                       |
| `fts_documents`       | FTS5 index over pre-segmented document text                                          | Virtual table, rebuilt from documents                                   |
| `fts_ngrams`          | FTS5 index over CJK bigrams used as a second retrieval stage                         | Virtual table, rebuilt from documents                                   |
| `fts_keys`            | Document key to FTS rowid per FTS table                                              | Primary key `(table_name, document_key)`; rowid index                   |
| `vec_documents`       | sqlite-vec table keyed by document ID, partitioned by memory space                   | Virtual table, dimensions from the embedding provider                   |

## Entity types

The general entity types are `person`, `group`, `place`, `animal`, `object`, `artifact`, `activity`, `topic`, and `other`. The first eight are semantic types; `other` is the fallback.

`self` is a special kind outside that taxonomy. Each memory space has at most one self entity, marked with type `self` and `metadata.self = true`; a partial unique index on `memory_space_id` where `type = 'self'` enforces it, and lookups read the type. The `self` option or `ensureSelf()` creates it; every assistant speaker resolves to it. The extraction prompt tells the model to use `artifact` for models, tools, other agents, and AI products, and `group` for companies and institutions. Persona, background, and preferences live on the self entity as its description and as claims whose subject is the self entity.

Schema version 2 migrates existing rows: `organization` becomes `group`, and `project` or `product` becomes `artifact`. Schema version 3 converts `ai` rows: a row with `metadata.self = true` becomes `self`, and any other `ai` row becomes `artifact`. Entity document text includes the type, so call `reindex()` once after upgrading an existing database.

## Consolidation state

`messages.consolidated_at` is null until extraction covers the message. `consolidate()` selects null rows per conversation, and the pipeline sets the timestamp after the batch's index sync. The column is not part of the public `Message` record; `health().counts.pendingMessages` reports the outstanding count.

Schema version 4 adds the column and backfills it from completed `annotate` jobs, then deletes those jobs. A database upgraded from version 3 keeps already-extracted messages marked and leaves failed or pending ones for the next `consolidate()`.

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

Each claim stores a stable `attribute` key and a `cardinality` of `one` or `many`. The extraction contract may also send a change verb: `new`, `adds`, `replaces`, `retracts`, or `disputes`. The `attributes` table remembers the first declared cardinality for each key, so a later batch cannot silently change a many-valued attribute into a replacing one.

One-valued attributes hold one current value. A later different value supersedes the active claim, sets `valid_until`, and adds a `supersedes` link. If the incoming evidence is older than every active value, the new claim is stored as `superseded` history instead. Many-valued attributes accumulate active claims; an explicit `replaces` removes only a claim with the same object. `retracts` marks the matching active value retracted and never falls back to another value. `disputes` stores the claim alongside the current value, and the context renders both in the conflict section.

Schema version 5 adds `claims.attribute` and `claims.cardinality`, backfills the attribute from the normalized predicate, and creates the `attributes` table. Existing claims default to `many`, so an upgrade does not change which values are current.

Each claim also stores a `modality` and a `polarity`. Modalities are `asserted`, `reported`, `uncertain`, `negated`, `hypothetical`, and `quoted`. A negated claim is stored with modality `asserted` and polarity `negative`, so it remains a current negative fact such as "does not use X". An asserted claim whose evidence is assistant-only and whose subject is not the assistant itself is stored as `quoted`; a self-subject claim with a literal object stays asserted. Only asserted positive claims participate in supersession and conflict grouping. Unconfirmed claims render in a separate section.

Schema version 6 adds the modality and polarity columns and backfills them from the existing metadata. Legacy `negated` rows become asserted negative facts.

## Event state

Events are historical. A state change adds a new event and a `supersedes` link to the previous event. The old event stays `active` because the event did happen. `superseded` is a claim status, not an event status. Event status is `active`, `retracted`, or `invalid`. Each event stores its modality; the context marks planned, quoted, and uncertain events instead of presenting them as occurred facts.

`time_precision` is `exact`, `day`, `month`, `approximate`, or `unknown`. The rule extractor uses `day` for message time and `approximate` for relative phrases such as `上周`. It never presents a guessed time as exact.

## Sensitivity and disclosure

`entities`, `claims`, and `events` store `sensitivity` (`normal` or `private`) and `disclosure` (`allowed`, `alias_only`, or `do_not_volunteer`). Both default to `normal` and `allowed`. A private record defaults to `do_not_volunteer` when the provider omits disclosure.

The fields are a rendering boundary, not a deletion policy. The record keeps its value and its evidence; the context moves it to the private section. Sensitivity only moves upward: a restatement can make a record private, but a later normal restatement never makes it public again. Disclosure follows the same rule toward the more restrictive value.

Schema version 7 adds the columns. Existing rows become normal and allowed, so an upgrade changes no content.

## Memory links

`memory_links` stores directed edges between two entities, claims, or events. `relation` is text, so a new relation needs no migration. Known relations are `supersedes`, `updates`, `contradicts`, `continues`, `caused_by`, `derived_from`, `related_to`, `same_as`, and `same_occurrence`.

`same_occurrence` points from a claim about one occurrence to the event that records it. Its `confidence` is the token-overlap score that produced the match. The unique index on the endpoints and relation makes a repeated write a no-op.

Evidence closure is computed during retrieval and adds no table or column. A candidate's `closureEvidenceMessageIds` holds the evidence of the records expanded from it.

## Time model

Every message stores `occurred_at`, the logical time of the conversation, and `created_at`, the wall-clock time the engine wrote it. Claims and events use `occurred_at` values from their source messages. `valid_from` and `valid_until` describe when a claim was true, not when the row was written.

## Evidence

An evidence row names its source. The first version uses `source_type = 'message'`. `evidence_type` separates `user_statement`, `assistant_statement`, and `external`. This distinction matters: a user saying "B may resign" supports the claim that the user said it, not the claim that B resigned. The rule extractor records uncertain statements as low-confidence events and skips their claims.

## Derived indexes

`embedding_documents` stores the retrieval text, its content hash, model name and version, dimensions, and a float32 vector blob. FTS rows are keyed by the document ID. `vec_documents` uses the document ID as its primary key and `memory_space_id` as a partition key, so a nearest-neighbour search only scans the requested space before it applies `k`.

`fts_keys` maps a document key to the FTS rowid in each table. Deleting a document looks up the rowid instead of scanning the `UNINDEXED` key column; a missing mapping falls back to the key scan.

Changing the embedding model changes the document identity. `reindex()` deletes the space's documents and index rows, rebuilds document text from structured records and chunks, and re-embeds. The schema does not depend on any provider.

Schema version 8 adds `fts_ngrams`. `SCHEMA_SQL` creates it on open, so an existing database gets an empty table; call `reindex()` once to populate it. `indexDocument()` and `deleteFtsDocument()` maintain both FTS tables together.

Schema version 10 adds `fts_keys`, the `claims(memory_space_id, object_entity_id)` index, and the partitioned `vec_documents` layout. Migration backfills `fts_keys` from both FTS tables. Vectors use the new table on the next open: the store drops the old layout and copies stored vectors back from `embedding_documents`. Call `reindex()` if the copy reports a dimension mismatch.

Schema version 11 collapses duplicate self entities. It keeps one row per memory space, preferring a row already typed `self` and then the oldest, demotes the rest to `artifact`, clears their `metadata.self`, promotes the survivor to type `self`, and creates the partial unique index.
