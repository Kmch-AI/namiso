import type {
  ClaimCardinality,
  ClaimChange,
  EntityKind,
  MemoryDisclosure,
  MemorySensitivity,
  MessageId,
  MessageRole,
  TimePrecision,
} from '../types.ts'
import type {
  EmbeddingProvider,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedEvent,
  ExtractedObject,
  ExtractedParticipant,
  ExtractionDiagnostics,
  ExtractionInput,
  ExtractionModality,
  ExtractionProvider,
  ExtractionResult,
  ExtractionUsage,
  ExtractionWireFormat,
  ReasoningEffort,
  RerankerProvider,
  RerankInput,
  RerankScore,
} from './types.ts'

import { ProviderError } from '../errors.ts'
import { asMessageId } from '../ids.ts'
import { normalizeName } from '../text.ts'
import { ENTITY_KINDS } from '../types.ts'
import {
  asArray,
  asRecord,
  entityTypeField,
  numberField,
  optionalString,
  optionalStringArray,
  postJson,
  stringField,
} from './http-util.ts'

interface HttpBaseOptions {
  endpoint: string
  apiKey?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface HttpEmbeddingOptions extends HttpBaseOptions {
  model: string
  dimensions: number
  version?: string
  batchSize?: number
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly version: string
  readonly dimensions: number
  private readonly options: HttpEmbeddingOptions

  constructor(options: HttpEmbeddingOptions) {
    this.options = options
    this.model = options.model
    this.version = options.version ?? '1'
    this.dimensions = options.dimensions
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
      const payload = await postJson(
        this.options.endpoint,
        { model: this.model, input: batch },
        this.options,
      )
      const root = asRecord(payload, 'embedding response')
      const data = asArray(root['data'] ?? root['embeddings'], 'embedding data')
      const batchVectors = data.map((item, index) => parseEmbedding(item, index, this.dimensions))
      if (batchVectors.length !== batch.length) {
        throw new ProviderError(
          `embedding provider returned ${batchVectors.length} vectors for ${batch.length} inputs`,
        )
      }
      vectors.push(...batchVectors)
    }
    return vectors
  }
}

function parseEmbedding(item: unknown, index: number, dimensions: number): number[] {
  const value = Array.isArray(item) ? item : asRecord(item, `embedding ${index}`)['embedding']
  if (!Array.isArray(value)) {
    throw new ProviderError(`embedding ${index} is not an array`)
  }
  const vector = value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new ProviderError(`embedding ${index} contains a non-numeric value`)
    }
    return entry
  })
  if (vector.length !== dimensions) {
    throw new ProviderError(
      `embedding ${index} has ${vector.length} dimensions, expected ${dimensions}`,
    )
  }
  return vector
}

export interface HttpExtractionOptions extends HttpBaseOptions {
  model: string
  version?: string
  wireFormat?: ExtractionWireFormat
  reasoningEffort?: ReasoningEffort
  onUsage?: (usage: ExtractionUsage, total: ExtractionUsage) => void
}

export class HttpExtractionProvider implements ExtractionProvider {
  readonly version: string
  lastUsage: ExtractionUsage | null = null
  private totals: ExtractionUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  }

  private readonly options: HttpExtractionOptions
  private readonly wireFormat: ExtractionWireFormat

  constructor(options: HttpExtractionOptions) {
    this.options = options
    this.wireFormat = options.wireFormat ?? 'compact'
    this.version = options.version ?? options.model
  }

  get usage(): ExtractionUsage {
    return this.totals
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const compact = this.wireFormat === 'compact'
    const body: Record<string, unknown> = {
      model: this.options.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: compact ? COMPACT_EXTRACTION_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: JSON.stringify(compact ? compactRequest(input) : legacyRequest(input)),
        },
      ],
    }
    if (this.options.reasoningEffort !== undefined) {
      body['reasoning_effort'] = this.options.reasoningEffort
    }
    const payload = await postJson(this.options.endpoint, body, this.options)
    const root = asRecord(payload, 'extraction response')
    this.recordUsage(parseExtractionUsage(root['usage']))
    const choices = asArray(root['choices'], 'choices')
    const first = asRecord(choices[0], 'first choice')
    const message = asRecord(first['message'], 'choice message')
    const content = message['content']
    if (typeof content !== 'string') {
      throw new ProviderError('extraction response has no string content')
    }
    const parsed = parseJsonContent(content)
    return parseExtractionResult(parsed, input)
  }

  private recordUsage(usage: ExtractionUsage | null): void {
    this.lastUsage = usage
    if (usage === null) return
    const cacheHitTokens =
      usage.cacheHitTokens === undefined
        ? this.totals.cacheHitTokens
        : (this.totals.cacheHitTokens ?? 0) + usage.cacheHitTokens
    const cacheMissTokens =
      usage.cacheMissTokens === undefined
        ? this.totals.cacheMissTokens
        : (this.totals.cacheMissTokens ?? 0) + usage.cacheMissTokens
    this.totals = {
      promptTokens: this.totals.promptTokens + usage.promptTokens,
      completionTokens: this.totals.completionTokens + usage.completionTokens,
      totalTokens: this.totals.totalTokens + usage.totalTokens,
      reasoningTokens: this.totals.reasoningTokens + usage.reasoningTokens,
      ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
      ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    }
    this.options.onUsage?.(usage, { ...this.totals })
  }
}

function parseExtractionUsage(value: unknown): ExtractionUsage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const promptTokens = tokenCount(record['prompt_tokens'])
  const completionTokens = tokenCount(record['completion_tokens'])
  const totalTokens = tokenCount(record['total_tokens'])
  const details = record['completion_tokens_details']
  const detailsRecord =
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined
  const reasoningTokens =
    tokenCount(detailsRecord?.['reasoning_tokens']) ?? tokenCount(record['reasoning_tokens']) ?? 0
  const promptDetails = record['prompt_tokens_details']
  const promptDetailsRecord =
    promptDetails !== null && typeof promptDetails === 'object' && !Array.isArray(promptDetails)
      ? (promptDetails as Record<string, unknown>)
      : undefined
  const cacheHitTokens =
    tokenCount(record['prompt_cache_hit_tokens']) ??
    tokenCount(promptDetailsRecord?.['cached_tokens'])
  const cacheMissTokens =
    tokenCount(record['prompt_cache_miss_tokens']) ??
    (promptTokens === undefined || cacheHitTokens === undefined
      ? undefined
      : Math.max(0, promptTokens - cacheHitTokens))
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null
  }
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    reasoningTokens,
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
  }
}

function timeSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const seconds = value > 1e11 ? value / 1000 : value
  if (seconds < 0 || seconds > 4_102_444_800) return undefined
  return Math.floor(seconds)
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

const ROLE_CODES: Record<MessageRole, string> = {
  user: 'u',
  assistant: 'a',
  system: 's',
  tool: 't',
}

const ENTITY_TYPE_CODES: Record<EntityKind, string> = {
  person: 'p',
  group: 'g',
  place: 'l',
  animal: 'a',
  object: 'o',
  artifact: 'r',
  activity: 'c',
  topic: 't',
  other: 'x',
  self: 's',
}

const ENTITY_TYPE_BY_CODE = new Map(
  Object.entries(ENTITY_TYPE_CODES).map(([kind, code]) => [code, kind as EntityKind]),
)

function legacyRequest(input: ExtractionInput): Record<string, unknown> {
  return {
    focusMessageIds: input.focusMessageIds,
    messages: input.messages,
    knownEntities: input.knownEntities,
    knownAttributes: input.knownAttributes ?? [],
  }
}

function compactRequest(input: ExtractionInput): Record<string, unknown> {
  const indices = new Map(input.messages.map((message, index) => [message.id, index]))
  const focus = input.focusMessageIds.flatMap((id) => {
    const index = indices.get(id)
    return index === undefined ? [] : [index]
  })
  return {
    focus,
    messages: input.messages.map((message) => [
      ROLE_CODES[message.role],
      message.speakerName,
      message.content,
      message.occurredAt,
    ]),
    knownEntities: input.knownEntities.map((entity) =>
      entity.aliases.length === 0
        ? [entity.name, ENTITY_TYPE_CODES[entity.type]]
        : [entity.name, ENTITY_TYPE_CODES[entity.type], entity.aliases],
    ),
    knownAttributes: input.knownAttributes ?? [],
  }
}

const EXTRACTION_SYSTEM_PROMPT = `You extract long-term memory from a batch of focus messages.
focusMessageIds lists the messages to extract from. The other messages are context for resolving references; do not extract facts from them.
knownEntities are for resolving names and aliases only. Do not output an entity unless a focus message mentions it.
knownAttributes lists state keys already used in this memory space. Reuse an existing key when the meaning matches.
Return one JSON object with keys entities, claims, events.
entities: [{name, type, aliases?, description?, sensitivity?, disclosure?}]. type is person, group, place, animal, object, artifact, activity, topic, or other. The assistant itself uses the special type self.
The assistant itself is the only self entity. knownEntities includes it first when it exists. Use its exact name for claims and event roles about the assistant, including persona, background, and preferences. Models, tools, other agents, and AI products are artifact; companies and institutions are group.
claims: [{subject: {name, type}, predicate, attribute, cardinality?, change?, object: {kind: "literal", value} | {kind: "entity", name, type}, validFrom?, modality, confidence, sensitivity?, disclosure?, evidenceMessageIds}].
attribute is a short stable key reused across mentions. predicate is the human-readable label.
cardinality is one when the attribute holds a single current value, such as a name, location, or job; it is many when values accumulate, such as likes or friends. Omit it when reusing a known attribute.
change is new, adds, replaces, retracts, or disputes. Use replaces when a focus message changes a one-valued attribute. Use retracts when it explicitly denies the recorded value. Use disputes when sources disagree and the record cannot decide.
events: [{type, summary, occurredAt?, timePrecision?, participants: [{name, type, role}], modality, confidence, sensitivity?, disclosure?, evidenceMessageIds}].
occurredAt and validFrom are absolute epoch seconds. Resolve every relative expression such as yesterday, next Wednesday, or 前天 against the occurredAt of the message that states it. If it cannot be resolved, omit the field; for an event, also use timePrecision unknown or approximate.
modality is asserted, reported, uncertain, negated, hypothetical, or quoted. Use reported when the speaker relays someone else's statement. Use uncertain when the speaker is not asserting the fact.
sensitivity is normal or private; disclosure is allowed, alias_only, or do_not_volunteer. Mark a record private when the message presents it as confidential, such as a secret, someone else's health, family, or finances, a private message, or an explicit request not to tell someone. A request to use only an alias makes that value alias_only; the request itself is a normal record.
Every claim and event must cite at least one focus message id in evidenceMessageIds. Do not invent facts.
If the focus messages contain no long-term memory, return {entities: [], claims: [], events: []}.`

const COMPACT_EXTRACTION_SYSTEM_PROMPT = `You extract long-term memory from a batch of messages.
focus lists the indices of the messages to extract from. The other messages are context for resolving references; do not extract facts from them.
messages are [role, speaker, content, occurredAt]. role is u (user), a (assistant), s (system), or t (tool).
knownEntities are [name, type, aliases?]. knownAttributes are state keys already used in this space; reuse a key when the meaning matches.
Type codes: p person, g group, l place, a animal, o object, r artifact, c activity, t topic, x other, s the assistant itself. The assistant is the only s. Models, tools, other agents, and AI products are r; companies and institutions are g.
Return one JSON object with keys e, c, v.
e: [{"n": name, "t": type, "al"?: [aliases], "d"?: description, "ev"?: [indices], "z"?: "private", "w"?: disclosure}]
c: [{"s": subject name, "p": predicate, "a": attribute, "o": {"k": "l", "v": value} | {"k": "e", "n": name, "t"?: type}, "ev": [indices], "k"?: "one" | "many", "ch"?: change, "m"?: modality, "v"?: validFrom, "z"?: sensitivity, "w"?: disclosure, "c"?: confidence}]
v: [{"t": event type, "sum": summary, "ev": [indices], "at"?: occurredAt, "pr"?: precision, "m"?: modality, "who"?: [[name, role]], "z"?: sensitivity, "w"?: disclosure, "c"?: confidence, "d"?: description}]
ev lists focus message indices that support the item; entity items use it when the mention has a clear source. Omit a field when it has its default: m asserted, c 0.8, pr unknown, z normal, w allowed. k is one when the attribute holds a single current value, such as a name, location, or job; it is many when values accumulate, such as likes or friends. Omit k when reusing a known attribute.
ch is new, adds, replaces, retracts, or disputes. Use replaces when a focus message changes a one-valued attribute; retracts when it explicitly denies a recorded value; disputes when sources disagree and the record cannot decide.
at and v are absolute epoch seconds. Resolve every relative expression such as yesterday, next Wednesday, or 前天 against the occurredAt of the message that states it. If it cannot be resolved, omit the field; for an event, also use pr unknown or approximate.
m is asserted, reported, uncertain, negated, hypothetical, or quoted. Use reported when the speaker relays someone else's statement; uncertain when the speaker is not asserting the fact.
z is normal or private; w is allowed, alias_only, or do_not_volunteer. Mark a record private when the message presents it as confidential, such as a secret, someone else's health, family, or finances, a private message, or an explicit request not to tell someone. A request to use only an alias makes that value alias_only; the request itself is a normal record.
Every claim and event must cite at least one focus index in ev. Do not invent facts.
If the focus messages contain no long-term memory, return {"e": [], "c": [], "v": []}.`

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1))
      } catch {
        // fall through to the original error
      }
    }
    throw new ProviderError('extraction content is not JSON', { cause: error })
  }
}

function parseExtractionResult(value: unknown, input: ExtractionInput): ExtractionResult {
  const root = asRecord(value, 'extraction result')
  if (Array.isArray(root['e']) || Array.isArray(root['c']) || Array.isArray(root['v'])) {
    return parseCompactResult(root, input)
  }
  const entities = parseItems(root['entities'], (item) => parseEntity(item, input.focusMessageIds))
  const claims = parseItems(root['claims'], (item) => parseClaim(item, input.focusMessageIds))
  const events = parseItems(root['events'], (item) => parseEvent(item, input.focusMessageIds))
  return { entities, claims, events }
}

function parseCompactResult(
  root: Record<string, unknown>,
  input: ExtractionInput,
): ExtractionResult {
  const diagnostics: ExtractionDiagnostics = { evidenceFallbacks: 0, evidenceDropped: 0 }
  const types = new Map<string, EntityKind>()
  for (const known of input.knownEntities) {
    types.set(normalizeName(known.name), known.type)
    for (const alias of known.aliases) types.set(normalizeName(alias), known.type)
  }
  const entities = parseItems(root['e'], (item) => parseCompactEntity(item, input))
  for (const entity of entities) types.set(normalizeName(entity.name), entity.type)
  const claims = parseItems(root['c'], (item) => parseCompactClaim(item, input, types, diagnostics))
  const events = parseItems(root['v'], (item) => parseCompactEvent(item, input, types, diagnostics))
  return { entities, claims, events, diagnostics }
}

function compactEvidence(
  value: unknown,
  input: ExtractionInput,
  diagnostics: ExtractionDiagnostics,
): MessageId[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.evidenceFallbacks += 1
    return [input.focusMessageIds[0]]
  }
  const focus = new Set<MessageId>(input.focusMessageIds)
  const ids: MessageId[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      diagnostics.evidenceDropped += 1
      continue
    }
    const message = input.messages[entry]
    if (message === undefined || !focus.has(message.id)) {
      diagnostics.evidenceDropped += 1
      continue
    }
    ids.push(message.id)
  }
  return ids
}

function compactEntityEvidence(value: unknown, input: ExtractionInput): MessageId[] {
  if (!Array.isArray(value) || value.length === 0) return [input.focusMessageIds[0]]
  const focus = new Set<MessageId>(input.focusMessageIds)
  const ids: MessageId[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) continue
    const message = input.messages[entry]
    if (message === undefined || !focus.has(message.id)) continue
    ids.push(message.id)
  }
  return ids.length === 0 ? [input.focusMessageIds[0]] : ids
}

function typeFromCode(value: string | undefined): EntityKind | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  return (
    ENTITY_TYPE_BY_CODE.get(normalized) ??
    ((ENTITY_KINDS as readonly string[]).includes(normalized)
      ? (normalized as EntityKind)
      : undefined)
  )
}

function compactEntityType(
  value: string | undefined,
  name: string,
  types: Map<string, EntityKind>,
): EntityKind {
  return typeFromCode(value) ?? types.get(normalizeName(name)) ?? 'other'
}

function parseCompactEntity(item: unknown, input: ExtractionInput): ExtractedEntity | null {
  const record = asRecord(item, 'entity')
  const name = stringField(record, 'n').trim()
  if (name.length === 0) return null
  const aliases = optionalStringArray(record, 'al')
  const description = optionalString(record, 'd')
  const sensitivity = sensitivityValue(record['z'])
  const disclosure = disclosureValue(record['w'])
  return {
    name,
    type: typeFromCode(optionalString(record, 't')) ?? 'other',
    evidenceMessageIds: compactEntityEvidence(record['ev'], input),
    ...(aliases === undefined ? {} : { aliases }),
    ...(description === undefined ? {} : { description }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
  }
}

function compactObject(value: unknown, types: Map<string, EntityKind>): ExtractedObject | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length === 0 ? null : { kind: 'literal', value: text }
  }
  const record = asRecord(value, 'claim object')
  if (record['k'] === 'e' || record['k'] === 'entity') {
    const name = stringField(record, 'n').trim()
    if (name.length === 0) return null
    return {
      kind: 'entity',
      name,
      type: compactEntityType(optionalString(record, 't'), name, types),
    }
  }
  const literal = record['v'] ?? record['value']
  if (typeof literal !== 'string' || literal.trim().length === 0) return null
  return { kind: 'literal', value: literal.trim() }
}

function parseCompactClaim(
  item: unknown,
  input: ExtractionInput,
  types: Map<string, EntityKind>,
  diagnostics: ExtractionDiagnostics,
): ExtractedClaim | null {
  const record = asRecord(item, 'claim')
  const subjectName = stringField(record, 's').trim()
  const predicate = stringField(record, 'p').trim()
  if (subjectName.length === 0 || predicate.length === 0) return null
  const object = compactObject(record['o'], types)
  if (object === null) return null
  const attribute = optionalString(record, 'a')?.trim() ?? ''
  const cardinality = codeValue(record['k'], CARDINALITIES)
  const change = codeValue(record['ch'], CHANGES)
  const validFrom = timeSeconds(record['v'])
  const sensitivity = sensitivityValue(record['z'])
  const disclosure = disclosureValue(record['w'])
  return {
    subject: {
      name: subjectName,
      type: types.get(normalizeName(subjectName)) ?? 'other',
    },
    predicate,
    object,
    modality: modalityValue(record['m']),
    confidence: clamp(numberField(record, 'c', 0.8)),
    evidenceMessageIds: compactEvidence(record['ev'], input, diagnostics),
    ...(attribute.length === 0 ? {} : { attribute }),
    ...(cardinality === undefined ? {} : { cardinality }),
    ...(change === undefined ? {} : { change }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
  }
}

function compactParticipants(
  value: unknown,
  types: Map<string, EntityKind>,
): ExtractedParticipant[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!Array.isArray(entry)) return []
    const name = typeof entry[0] === 'string' ? entry[0].trim() : ''
    if (name.length === 0) return []
    const role =
      typeof entry[1] === 'string' && entry[1].trim().length > 0 ? entry[1] : 'participant'
    return [{ name, type: types.get(normalizeName(name)) ?? 'other', role }]
  })
}

function parseCompactEvent(
  item: unknown,
  input: ExtractionInput,
  types: Map<string, EntityKind>,
  diagnostics: ExtractionDiagnostics,
): ExtractedEvent | null {
  const record = asRecord(item, 'v')
  const type = stringField(record, 't').trim()
  const summary = stringField(record, 'sum').trim()
  if (type.length === 0 || summary.length === 0) return null
  const occurredAt = timeSeconds(record['at'])
  const precision = record['pr']
  const timePrecision =
    typeof precision === 'string' && (PRECISIONS as readonly string[]).includes(precision)
      ? (precision as TimePrecision)
      : 'unknown'
  const description = optionalString(record, 'd')
  const sensitivity = sensitivityValue(record['z'])
  const disclosure = disclosureValue(record['w'])
  return {
    type,
    summary,
    participants: compactParticipants(record['who'], types),
    modality: modalityValue(record['m']),
    confidence: clamp(numberField(record, 'c', 0.8)),
    evidenceMessageIds: compactEvidence(record['ev'], input, diagnostics),
    timePrecision,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(description === undefined ? {} : { description }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
  }
}

function codeValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function parseItems<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const item of value) {
    try {
      const parsed = parse(item)
      if (parsed !== null) result.push(parsed)
    } catch {
      continue
    }
  }
  return result
}

function parseEntity(
  item: unknown,
  focusMessageIds: readonly [MessageId, ...MessageId[]],
): ExtractedEntity | null {
  const record = asRecord(item, 'entity')
  const name = stringField(record, 'name').trim()
  if (name.length === 0) return null
  const aliases = optionalStringArray(record, 'aliases')
  const description = optionalString(record, 'description')
  const sensitivity = parseSensitivity(record)
  const disclosure = parseDisclosure(record)
  const entities: ExtractedEntity = {
    name,
    type: entityTypeField(record, 'type'),
    evidenceMessageIds: [focusMessageIds[0]],
    ...(aliases === undefined ? {} : { aliases }),
    ...(description === undefined ? {} : { description }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
  }
  return entities
}

const MODALITIES: readonly ExtractionModality[] = [
  'asserted',
  'reported',
  'uncertain',
  'negated',
  'hypothetical',
  'quoted',
]

const CARDINALITIES: readonly ClaimCardinality[] = ['one', 'many']
const CHANGES: readonly ClaimChange[] = ['new', 'adds', 'replaces', 'retracts', 'disputes']
const SENSITIVITIES: readonly MemorySensitivity[] = ['normal', 'private']
const DISCLOSURES: readonly MemoryDisclosure[] = ['allowed', 'alias_only', 'do_not_volunteer']

function parseModality(record: Record<string, unknown>): ExtractionModality {
  return modalityValue(record['modality'])
}

function modalityValue(value: unknown): ExtractionModality {
  if (typeof value === 'string' && (MODALITIES as readonly string[]).includes(value)) {
    return value as ExtractionModality
  }
  return 'asserted'
}

function parseSensitivity(record: Record<string, unknown>): MemorySensitivity | undefined {
  return sensitivityValue(record['sensitivity'])
}

function sensitivityValue(value: unknown): MemorySensitivity | undefined {
  return typeof value === 'string' && (SENSITIVITIES as readonly string[]).includes(value)
    ? (value as MemorySensitivity)
    : undefined
}

function parseDisclosure(record: Record<string, unknown>): MemoryDisclosure | undefined {
  return disclosureValue(record['disclosure'])
}

function disclosureValue(value: unknown): MemoryDisclosure | undefined {
  return typeof value === 'string' && (DISCLOSURES as readonly string[]).includes(value)
    ? (value as MemoryDisclosure)
    : undefined
}

function parseClaim(
  item: unknown,
  focusMessageIds: readonly [MessageId, ...MessageId[]],
): ExtractedClaim | null {
  const record = asRecord(item, 'claim')
  const subject = asRecord(record['subject'], 'claim subject')
  const object = asRecord(record['object'], 'claim object')
  const subjectName = stringField(subject, 'name').trim()
  const predicate = stringField(record, 'predicate').trim()
  if (subjectName.length === 0 || predicate.length === 0) return null
  const parsedObject: ExtractedObject | null =
    object['kind'] === 'entity'
      ? {
          kind: 'entity',
          name: stringField(object, 'name').trim(),
          type: entityTypeField(object, 'type'),
        }
      : { kind: 'literal', value: stringField(object, 'value').trim() }
  if (parsedObject.kind === 'literal' && parsedObject.value.length === 0) return null
  if (parsedObject.kind === 'entity' && parsedObject.name.length === 0) return null
  const validFrom = timeSeconds(record['validFrom'])
  const sensitivity = parseSensitivity(record)
  const disclosure = parseDisclosure(record)
  const attribute = typeof record['attribute'] === 'string' ? record['attribute'].trim() : ''
  const cardinality =
    typeof record['cardinality'] === 'string' &&
    (CARDINALITIES as readonly string[]).includes(record['cardinality'])
      ? (record['cardinality'] as ClaimCardinality)
      : undefined
  const change =
    typeof record['change'] === 'string' &&
    (CHANGES as readonly string[]).includes(record['change'])
      ? (record['change'] as ClaimChange)
      : undefined
  return {
    subject: { name: subjectName, type: entityTypeField(subject, 'type') },
    predicate,
    object: parsedObject,
    modality: parseModality(record),
    confidence: clamp(numberField(record, 'confidence', 0.8)),
    evidenceMessageIds: evidenceIds(record, focusMessageIds),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
    ...(attribute.length === 0 ? {} : { attribute }),
    ...(cardinality === undefined ? {} : { cardinality }),
    ...(change === undefined ? {} : { change }),
  }
}

const PRECISIONS: readonly TimePrecision[] = ['exact', 'day', 'month', 'approximate', 'unknown']

function parseEvent(
  item: unknown,
  focusMessageIds: readonly [MessageId, ...MessageId[]],
): ExtractedEvent | null {
  const record = asRecord(item, 'event')
  const type = stringField(record, 'type').trim()
  const summary = stringField(record, 'summary').trim()
  if (type.length === 0 || summary.length === 0) return null
  const participants = Array.isArray(record['participants'])
    ? record['participants'].flatMap((entry) => {
        try {
          const participant = asRecord(entry, 'participant')
          const name = stringField(participant, 'name').trim()
          if (name.length === 0) return []
          return [
            {
              name,
              type: entityTypeField(participant, 'type'),
              role: stringField(participant, 'role', 'participant'),
            },
          ]
        } catch {
          return []
        }
      })
    : []
  const occurredAt = timeSeconds(record['occurredAt'])
  const sensitivity = parseSensitivity(record)
  const disclosure = parseDisclosure(record)
  const precision = record['timePrecision']
  const timePrecision =
    typeof precision === 'string' && (PRECISIONS as readonly string[]).includes(precision)
      ? (precision as TimePrecision)
      : 'unknown'
  const description = optionalString(record, 'description')
  return {
    type,
    summary,
    participants,
    modality: parseModality(record),
    confidence: clamp(numberField(record, 'confidence', 0.8)),
    evidenceMessageIds: evidenceIds(record, focusMessageIds),
    timePrecision,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(disclosure === undefined ? {} : { disclosure }),
    ...(description === undefined ? {} : { description }),
  }
}

function evidenceIds(
  record: Record<string, unknown>,
  focusMessageIds: readonly [MessageId, ...MessageId[]],
): readonly ReturnType<typeof asMessageId>[] {
  const values = optionalStringArray(record, 'evidenceMessageIds')
  if (values === undefined || values.length === 0) {
    return [focusMessageIds[0]]
  }
  return values.map(asMessageId)
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export interface HttpRerankerOptions extends HttpBaseOptions {
  model: string
}

export class HttpRerankerProvider implements RerankerProvider {
  readonly model: string
  private readonly options: HttpRerankerOptions

  constructor(options: HttpRerankerOptions) {
    this.options = options
    this.model = options.model
  }

  async rerank(input: RerankInput): Promise<RerankScore[]> {
    const payload = await postJson(
      this.options.endpoint,
      { model: this.model, query: input.query, documents: input.documents },
      this.options,
    )
    return parseRerankScores(payload, input.documents.length)
  }
}

function parseRerankScores(payload: unknown, expected: number): RerankScore[] {
  const root = asRecord(payload, 'rerank response')
  if (Array.isArray(root['scores'])) {
    return root['scores'].map((value, index) => ({
      index,
      score: typeof value === 'number' ? value : 0,
    }))
  }
  const data = Array.isArray(root['results']) ? root['results'] : root['data']
  if (!Array.isArray(data)) {
    throw new ProviderError('rerank response has no scores or results')
  }
  const scores = data.map((entry, position) => {
    const record = asRecord(entry, `rerank result ${position}`)
    return {
      index: numberField(record, 'index', position),
      score: numberField(record, 'score', numberField(record, 'relevance_score', 0)),
    }
  })
  if (scores.length !== expected) {
    throw new ProviderError(`reranker returned ${scores.length} scores for ${expected} documents`)
  }
  return scores
}
