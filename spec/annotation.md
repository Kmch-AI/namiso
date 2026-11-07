# Annotation

Annotation turns a raw message into entities, claims, events, evidence, and state links. The pipeline is `src/annotation/pipeline.ts`.

## Pipeline

1. Resolve the speaker entity.
2. If the message role is not in `extractRoles`, write the speaker annotation, sync the speaker document, and stop.
3. Load up to eight previous messages as context.
4. Build the extraction input with the focus message, context, and known entities.
5. Call the extraction provider.
6. Validate evidence IDs against the same memory space. Unknown IDs fall back to the focus message.
7. In one transaction, resolve entities, apply claims and events, add annotations, and link evidence.
8. Sync retrieval documents for every touched entity, claim, and event.

Evidence IDs from a provider are untrusted. The pipeline drops IDs that do not exist in the space.

## Role policy

`extractRoles` defaults to `['user', 'assistant']`. User and assistant messages are sent to extraction. System and tool messages keep a speaker annotation and remain in raw chunks.

Set `extractRoles: ['user']` to skip assistant extraction. Assistant messages still keep a speaker annotation and remain in raw chunks. The rule extractor still ignores assistant-stated facts; use an LLM provider for them.

## Extraction contract

The provider receives the focus message, up to eight context messages, and known entities. It must extract only from the focus message. Context and known entities are for resolving references.

The provider returns:

- entities: name, type, optional aliases and description;
- claims: subject, predicate, object, modality, confidence, evidence message IDs;
- events: type, summary, participants, optional time, precision, modality, confidence, evidence message IDs.

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

## Entity resolution

Resolution order in `EntityResolver`:

1. Exact name in the space, case-insensitive.
2. Alias in the space.
3. Speaker ID stored in entity metadata.
4. Create a new entity.

Aliases are unique per space. Two similar names are never merged by string similarity alone. A caller can add aliases with `ensureEntity()`.

## Claim linking

`MemoryLinker` applies these rules:

| Situation                                   | Result                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Same functional predicate, same object      | Reuse the active claim; add evidence                                          |
| Same functional predicate, different object | Insert a new active claim; mark the old `superseded`; add a `supersedes` link |
| Non-functional predicate                    | Accumulate claims unless an identical active claim exists                     |
| Uncertain or negated claim                  | Do not create an active claim                                                 |
| Provider retry                              | Reuse existing rows; no duplicate claims                                      |

Functional predicates are `name`, `occupation`, `location`, `age`, `uses`, `works_at`, and `status`.

## Event linking

Events are deduplicated by type, summary, and occurrence time. Participants are inserted with their roles.

For a `usage_change` event:

1. Find the actor's active `uses` claims.
2. If the new object is already active, change nothing.
3. Otherwise mark the old claims `superseded` and insert a new `uses` claim.
4. Link the new claim to the old claims with `supersedes`.
5. Link the new event to the previous event of the same type with `supersedes`.

For a `usage_stop` event, supersede the actor's active `uses` claims without inserting a new one. Uncertain events never change claim state.

## Evidence types

Evidence is created from messages with one of `user_statement`, `assistant_statement`, or `external`. A claim or event always links to at least one evidence row. The same message can support many memories.

## Conflict detection

The retriever checks active claims with the same subject and predicate. Different objects produce an uncertainty note in the context. The annotation pipeline does not silently choose between conflicting active claims; it records them and leaves resolution to retrieval or a later provider.

## Known gaps

- No coreference resolution beyond the speaker and known aliases.
- No automatic entity merge after creation.
- Extraction defaults to user and assistant messages. System and tool facts remain raw chunks unless `extractRoles` includes them.
- The rule extractor ignores assistant-stated facts.
- No contradiction detector that marks a claim `disputed` during writes. Conflicts surface as retrieval notes.
- No LLM validation pass over extracted facts.
