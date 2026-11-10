# Annotation

Annotation turns raw messages into entities, claims, events, evidence, and state links. The pipeline is `src/annotation/pipeline.ts`; batching and pending state belong to `src/annotation/consolidator.ts`.

## Pipeline

1. Receive a focus batch and up to eight messages of earlier context.
2. Resolve the speaker entity for every focus message.
3. If no focus message has a role in `extractRoles`, sync the speaker documents and mark the batch consolidated.
4. Build the extraction input with the focus message IDs, the focus batch, the context, known entities mentioned in those messages, and, when `knownFacts` is enabled, up to 12 current facts about the batch's speakers and mentioned entities.
5. Call the extraction provider once for the batch.
6. Validate evidence IDs against the same memory space. A claim or event with no valid evidence is skipped.
7. In one transaction, resolve entities, apply claims and events, add annotations, and link evidence.
8. Sync retrieval documents for every touched entity, claim, and event, then mark the batch consolidated.

Evidence IDs from a provider are untrusted. The pipeline drops IDs that do not exist in the space.

## Role policy

`extractRoles` defaults to `['user', 'assistant']`. User and assistant messages in a batch are sent to extraction. System and tool messages keep a speaker annotation and remain in raw chunks.

Set `extractRoles: ['user']` to skip assistant extraction. Assistant messages still keep a speaker annotation and remain in raw chunks. The rule extractor still ignores assistant-stated facts; use an LLM provider for them.

## Extraction contract

The provider receives the focus message IDs, the batch, up to eight context messages, and known entities. It must extract only from the focus messages. Context and known entities are for resolving references.

Known entities are filtered before the call. The self entity is always included first when it exists. The remaining entities are those whose name or alias appears in any focus or context message, capped at 50 total. This keeps the extraction prompt bounded as the space grows and gives the model a stable identity for the assistant. Because the batch is larger than one message, the entity list covers the whole batch rather than a single turn.

With `knownFacts` enabled, the input also carries up to 12 `{subject, attribute, value}` facts: active asserted positive claims for the speaker entities and the known entities, ordered by entity order then attribute, deduplicated, and restricted records excluded. The digest lets the model avoid restating an unchanged fact and mark a changed one. The engine still dedupes identical values, so a model that ignores the digest does not corrupt state.

The provider returns:

- entities: name, type, optional aliases, description, sensitivity, and disclosure;
- claims: subject, predicate, optional attribute, cardinality, and change verb, object, modality, confidence, optional sensitivity and disclosure, evidence message IDs;
- events: type, summary, participants, optional time, precision, modality, confidence, optional sensitivity and disclosure, evidence message IDs.

`sensitivity` is `normal` or `private`; `disclosure` is `allowed`, `alias_only`, or `do_not_volunteer`. The pipeline stores both on entities, claims, and events. A private record without an explicit disclosure becomes `do_not_volunteer`. Restriction only moves upward: a later private or more restrictive extraction upgrades the stored row, and a later normal restatement never downgrades it.

`modality` is `asserted`, `reported`, `uncertain`, `negated`, `hypothetical`, or `quoted`. A negated claim is stored as a current negative fact; the other non-asserted modalities are stored and rendered as unconfirmed. An asserted claim whose evidence is assistant-only and whose subject is not the assistant becomes `quoted`.

Modality is `asserted`, `uncertain`, `negated`, `hypothetical`, or `quoted`. Only `asserted` claims become active. Uncertain statements can still produce events, with the modality stored in metadata.

The default `RuleExtractionProvider` handles deterministic patterns:

| Pattern                                | Result                               |
| -------------------------------------- | ------------------------------------ |
| `我叫…`, `我的名字是…`                 | `name` claim                         |
| `我喜欢…`, `I like…`                   | `likes` claim                        |
| `我在使用…`, `我使用…`, `I use…`       | `uses` claim                         |
| `我是程序员` and similar roles         | `occupation` claim                   |
| `我住在…`, `我搬到…`                   | `location` claim                     |
| `我今年 N 岁`                          | `age` claim                          |
| `X 是我的朋友`                         | `friend_of` claim                    |
| `我在 X 工作`                          | `works_at` claim                     |
| `开始使用`, `换回`, `改用`, `不再使用` | `usage_change` or `usage_stop` event |
| `推荐…`, `借了…`                       | `recommendation` or `loan` event     |

The rule extractor has limits. It does not resolve pronouns, quoted speech, third-party claims, or arbitrary facts. It extracts from user messages only; assistant messages still receive speaker annotations and remain in raw chunks. Use an LLM provider for production extraction. The HTTP provider prompt and parser are in `src/providers/http.ts`.

Entity types are defined in `spec/data-model.md`. The rule extractor types the assistant speaker as the special `self` kind; companies and teams become `group`; projects, products, models, and tools become `artifact`. The HTTP prompt tells the model to reserve `self` for the assistant itself.

## Self identity

Each memory space has at most one self entity, marked with `metadata.self = true` and type `self`. The `self` option or `ensureSelf()` creates it; every assistant speaker resolves to it, and its aliases include assistant speaker names.

Provider output typed `self` resolves to the self entity only when the name or alias matches. Any other entity requested as `self` is stored as `artifact`; the resolver never creates a second `self` entity. Claims and event participants that refer to the assistant therefore use the same self entity ID. Persona, background, and preferences are stored as the self entity's description and as claims whose subject is the self entity.

## Entity resolution

Resolution order in `EntityResolver`:

1. Assistant speaker: the self entity, creating or promoting it if needed.
2. Exact name in the space, case-insensitive.
3. Alias in the space.
4. Speaker ID stored in entity metadata.
5. Create a new entity. If the requested type is `self`, create it as `artifact` instead.

Aliases are unique per space. Two similar names are never merged by string similarity alone. A caller can add aliases with `ensureSelf()` or `ensureEntity()`. An extracted entity carries its sensitivity and disclosure through resolution; an existing entity upgrades when a later extraction is more restrictive.

## Claim linking

The pipeline normalizes the claim attribute, resolves its cardinality from the provider or the `attributes` registry, and passes the change verb to `MemoryLinker`. The linker applies these rules:

| Situation                                                         | Result                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Same attribute and same object                                    | Reuse the active claim; add evidence                                   |
| One-valued attribute, different object, newer or explicit replace | Insert a new active claim; supersede the old; add a `supersedes` link  |
| One-valued attribute, different object, older evidence            | Insert the new claim as `superseded` history with `valid_until`        |
| Many-valued attribute, new object                                 | Insert an active claim                                                 |
| Many-valued attribute, explicit replace on the matching object    | Replace only that object; other values stay active                     |
| `retracts` with a matching object                                 | Mark the matching active claims `retracted`                            |
| `retracts` with no matching object                                | Insert a `retracted` claim so the recorded denial is not lost          |
| `disputes`                                                        | Insert the claim alongside the current value; the context renders both |
| Negated claim with user evidence                                  | Retract the matching positive value; store an active negative fact     |
| Uncertain, hypothetical, quoted, or reported claim                | Store it; never supersede; the context renders it as unconfirmed       |
| Asserted claim with assistant-only evidence, subject not self     | Store it as quoted                                                     |
| Provider retry                                                    | Reuse existing rows; no duplicate claims                               |

Attribute keys are normalized by `normalizeAttribute()`: NFKC, trimmed, lowercase ASCII, collapsed whitespace, and stripped wrapping punctuation. An empty result falls back to the normalized predicate. The registry keeps the first declared cardinality for a key; it never upgrades a `many` attribute to `one`. Predicate remains the display label and the indexed text.

## Event linking

Events are deduplicated by type, summary, and occurrence time. Participants are inserted with their roles.

For a `usage_change` event:

1. Find the actor's active `uses` claims.
2. If the new object is already active, change nothing.
3. Otherwise mark the old claims `superseded` and insert a new `uses` claim.
4. Link the new claim to the old claims with `supersedes`.
5. Link the new event to the previous event of the same type with `supersedes`.

For a `usage_stop` event, supersede the actor's active `uses` claims without inserting a new one. Uncertain events never change claim state.

## Speaker identity

A self-given name registers an alias on the speaker entity before entities and claims resolve. The focus message is the source. A user or assistant message matching `我叫X`, `我的名字是X`, `我的名字叫X`, or `叫我X` registers `X` as an alias of that message's speaker. A negative lookahead keeps `我叫他`, `我叫你`, and similar from matching. The value is cut at the first punctuation or whitespace and capped at 24 characters.

A name-like claim whose normalized attribute is `name`, `姓名`, `名字`, `昵称`, `别名`, `nickname`, or `alias` can veto the alias. When such a claim is restricted, meaning `sensitivity = private` or a disclosure other than `allowed`, its value is never registered. An alias is also skipped when another entity already owns that name or alias, so extraction cannot attach one entity's name to another. An alias renders in public entity lines, so promoting a restricted name would bypass its claim restriction. Later claims and extracted entities that use the name resolve to the speaker, so a self-given name does not split the person into a second entity.

## Occurrence linking

The linker may connect a new claim to an earlier event that records the same occurrence. The relation is `same_occurrence` from claim to event, and its confidence is the match score. The rule:

1. The claim's subject entity type is `other`, `activity`, or `topic`.
2. The claim's predicate plus literal object contains the name of a non-self entity that participates in a candidate event.
3. Candidate events occur before the claim's latest evidence message and share no evidence message with the claim.
4. The score is token Jaccard between the claim's predicate plus object and the event's type plus summary, using `segment()`.
5. The best score must be at least 0.1 and at least twice the runner-up when one exists.
6. The link is written with insert-or-ignore, so reconsolidation never duplicates it.

The pipeline applies claims before events in a batch, so it runs the match for claims created in the batch after the event loop. That is the first point where the batch's events, their evidence, and the claim evidence are all stored. The write is insert-or-ignore, so reconsolidation never duplicates an edge, and a duplicate claim never starts a match.

An event can restate an earlier occurrence without recording it again, for example a correction that says the first session was the one at the café. When a created event's summary holds a clause with an ordinal occurrence reference such as `第一次`, `上次`, or `首次`, the linker runs the same match for that clause. The clause must name the non-self participant, the candidate must occur before the latest evidence message time, and the same score gate applies. The relation is `updates` from the new event to the earlier event. The evidence time is the anchor because a restating event often has no occurrence time of its own. Only created events start a match, and the write is insert-or-ignore.

## Evidence types

Evidence is created from messages with one of `user_statement`, `assistant_statement`, or `external`. A claim or event always links to at least one evidence row. The same message can support many memories.

## Conflict detection

The context builder groups active claims by subject and attribute. Two different values in one group render a conflict line with both values and dates. The annotation pipeline does not silently choose between conflicting active claims; it records them and leaves resolution to a later explicit `replaces` or `retracts` claim.

## Known gaps

- No general coreference resolution beyond the speaker, known aliases, and ordinal occurrence clauses.
- No automatic entity merge beyond a self-given name alias on a speaker.
- Extraction defaults to user and assistant messages. System and tool facts remain raw chunks unless `extractRoles` includes them.
- The rule extractor ignores assistant-stated facts.
- No contradiction detector that marks a claim `disputed` during writes. Conflicts surface as retrieval notes.
- No LLM validation pass over extracted facts.
