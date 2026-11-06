import { ProviderError } from "../errors.ts";
import { asMessageId } from "../ids.ts";
import type { TimePrecision } from "../types.ts";
import {
  asArray,
  asRecord,
  entityTypeField,
  numberField,
  optionalString,
  optionalStringArray,
  postJson,
  stringField,
} from "./http-util.ts";
import type {
  EmbeddingProvider,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedEvent,
  ExtractedObject,
  ExtractionInput,
  ExtractionModality,
  ExtractionProvider,
  ExtractionResult,
  RerankerProvider,
  RerankInput,
  RerankScore,
} from "./types.ts";

interface HttpBaseOptions {
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpEmbeddingOptions extends HttpBaseOptions {
  model: string;
  dimensions: number;
  version?: string;
  batchSize?: number;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  private readonly options: HttpEmbeddingOptions;

  constructor(options: HttpEmbeddingOptions) {
    this.options = options;
    this.model = options.model;
    this.version = options.version ?? "1";
    this.dimensions = options.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64;
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const payload = await postJson(
        this.options.endpoint,
        { model: this.model, input: batch },
        this.options,
      );
      const root = asRecord(payload, "embedding response");
      const data = asArray(root["data"] ?? root["embeddings"], "embedding data");
      const batchVectors = data.map((item, index) => parseEmbedding(item, index, this.dimensions));
      if (batchVectors.length !== batch.length) {
        throw new ProviderError(
          `embedding provider returned ${batchVectors.length} vectors for ${batch.length} inputs`,
        );
      }
      vectors.push(...batchVectors);
    }
    return vectors;
  }
}

function parseEmbedding(item: unknown, index: number, dimensions: number): number[] {
  const value = Array.isArray(item) ? item : asRecord(item, `embedding ${index}`)["embedding"];
  if (!Array.isArray(value)) {
    throw new ProviderError(`embedding ${index} is not an array`);
  }
  const vector = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ProviderError(`embedding ${index} contains a non-numeric value`);
    }
    return entry;
  });
  if (vector.length !== dimensions) {
    throw new ProviderError(
      `embedding ${index} has ${vector.length} dimensions, expected ${dimensions}`,
    );
  }
  return vector;
}

export interface HttpExtractionOptions extends HttpBaseOptions {
  model: string;
  version?: string;
}

export class HttpExtractionProvider implements ExtractionProvider {
  readonly version: string;
  private readonly options: HttpExtractionOptions;

  constructor(options: HttpExtractionOptions) {
    this.options = options;
    this.version = options.version ?? options.model;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const payload = await postJson(
      this.options.endpoint,
      {
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              focusMessageId: input.focusMessageId,
              messages: input.messages,
              knownEntities: input.knownEntities,
            }),
          },
        ],
      },
      this.options,
    );
    const root = asRecord(payload, "extraction response");
    const choices = asArray(root["choices"], "choices");
    const first = asRecord(choices[0], "first choice");
    const message = asRecord(first["message"], "choice message");
    const content = message["content"];
    if (typeof content !== "string") {
      throw new ProviderError("extraction response has no string content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new ProviderError("extraction content is not JSON", { cause: error });
    }
    return parseExtractionResult(parsed, input.focusMessageId);
  }
}

const EXTRACTION_SYSTEM_PROMPT = `You extract long-term memory from conversation.
Return one JSON object with keys entities, claims, events.
entities: [{name, type, aliases?, description?}]. type is person, ai, organization, place, project, product, or other.
claims: [{subject: {name, type}, predicate, object: {kind: "literal", value} | {kind: "entity", name, type}, modality, confidence, evidenceMessageIds}].
events: [{type, summary, occurredAt?, timePrecision?, participants: [{name, type, role}], modality, confidence, evidenceMessageIds}].
modality is asserted, uncertain, negated, hypothetical, or quoted.
Use evidenceMessageIds from the input messages. Do not invent facts. Use uncertain when the speaker is not asserting the fact.`;

function parseExtractionResult(value: unknown, focusMessageId: string): ExtractionResult {
  const root = asRecord(value, "extraction result");
  const entities = parseItems(root["entities"], (item) => parseEntity(item, focusMessageId));
  const claims = parseItems(root["claims"], (item) => parseClaim(item, focusMessageId));
  const events = parseItems(root["events"], (item) => parseEvent(item, focusMessageId));
  return { entities, claims, events };
}

function parseItems<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const item of value) {
    try {
      const parsed = parse(item);
      if (parsed !== null) result.push(parsed);
    } catch {
      continue;
    }
  }
  return result;
}

function parseEntity(item: unknown, focusMessageId: string): ExtractedEntity | null {
  const record = asRecord(item, "entity");
  const name = stringField(record, "name").trim();
  if (name.length === 0) return null;
  const aliases = optionalStringArray(record, "aliases");
  const description = optionalString(record, "description");
  const entities: ExtractedEntity = {
    name,
    type: entityTypeField(record, "type"),
    evidenceMessageIds: [asMessageId(focusMessageId)],
    ...(aliases === undefined ? {} : { aliases }),
    ...(description === undefined ? {} : { description }),
  };
  return entities;
}

const MODALITIES: readonly ExtractionModality[] = [
  "asserted",
  "uncertain",
  "negated",
  "hypothetical",
  "quoted",
];

function parseModality(record: Record<string, unknown>): ExtractionModality {
  const value = record["modality"];
  if (typeof value === "string" && (MODALITIES as readonly string[]).includes(value)) {
    return value as ExtractionModality;
  }
  return "asserted";
}

function parseClaim(item: unknown, focusMessageId: string): ExtractedClaim | null {
  const record = asRecord(item, "claim");
  const subject = asRecord(record["subject"], "claim subject");
  const object = asRecord(record["object"], "claim object");
  const subjectName = stringField(subject, "name").trim();
  const predicate = stringField(record, "predicate").trim();
  if (subjectName.length === 0 || predicate.length === 0) return null;
  const parsedObject: ExtractedObject | null =
    object["kind"] === "entity"
      ? {
          kind: "entity",
          name: stringField(object, "name").trim(),
          type: entityTypeField(object, "type"),
        }
      : { kind: "literal", value: stringField(object, "value").trim() };
  if (parsedObject.kind === "literal" && parsedObject.value.length === 0) return null;
  if (parsedObject.kind === "entity" && parsedObject.name.length === 0) return null;
  const validFrom = record["validFrom"];
  return {
    subject: { name: subjectName, type: entityTypeField(subject, "type") },
    predicate,
    object: parsedObject,
    modality: parseModality(record),
    confidence: clamp(numberField(record, "confidence", 0.8)),
    evidenceMessageIds: evidenceIds(record, focusMessageId),
    ...(typeof validFrom === "number" ? { validFrom } : {}),
  };
}

const PRECISIONS: readonly TimePrecision[] = ["exact", "day", "month", "approximate", "unknown"];

function parseEvent(item: unknown, focusMessageId: string): ExtractedEvent | null {
  const record = asRecord(item, "event");
  const type = stringField(record, "type").trim();
  const summary = stringField(record, "summary").trim();
  if (type.length === 0 || summary.length === 0) return null;
  const participants = Array.isArray(record["participants"])
    ? record["participants"].flatMap((entry) => {
        try {
          const participant = asRecord(entry, "participant");
          const name = stringField(participant, "name").trim();
          if (name.length === 0) return [];
          return [
            {
              name,
              type: entityTypeField(participant, "type"),
              role: stringField(participant, "role", "participant"),
            },
          ];
        } catch {
          return [];
        }
      })
    : [];
  const occurredAt = record["occurredAt"];
  const precision = record["timePrecision"];
  const timePrecision =
    typeof precision === "string" && (PRECISIONS as readonly string[]).includes(precision)
      ? (precision as TimePrecision)
      : "unknown";
  const description = optionalString(record, "description");
  return {
    type,
    summary,
    participants,
    modality: parseModality(record),
    confidence: clamp(numberField(record, "confidence", 0.8)),
    evidenceMessageIds: evidenceIds(record, focusMessageId),
    timePrecision,
    ...(typeof occurredAt === "number" ? { occurredAt } : {}),
    ...(description === undefined ? {} : { description }),
  };
}

function evidenceIds(
  record: Record<string, unknown>,
  focusMessageId: string,
): readonly ReturnType<typeof asMessageId>[] {
  const values = optionalStringArray(record, "evidenceMessageIds");
  if (values === undefined || values.length === 0) {
    return [asMessageId(focusMessageId)];
  }
  return values.map(asMessageId);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export interface HttpRerankerOptions extends HttpBaseOptions {
  model: string;
}

export class HttpRerankerProvider implements RerankerProvider {
  readonly model: string;
  private readonly options: HttpRerankerOptions;

  constructor(options: HttpRerankerOptions) {
    this.options = options;
    this.model = options.model;
  }

  async rerank(input: RerankInput): Promise<RerankScore[]> {
    const payload = await postJson(
      this.options.endpoint,
      { model: this.model, query: input.query, documents: input.documents },
      this.options,
    );
    return parseRerankScores(payload, input.documents.length);
  }
}

function parseRerankScores(payload: unknown, expected: number): RerankScore[] {
  const root = asRecord(payload, "rerank response");
  if (Array.isArray(root["scores"])) {
    return root["scores"].map((value, index) => ({
      index,
      score: typeof value === "number" ? value : 0,
    }));
  }
  const data = Array.isArray(root["results"]) ? root["results"] : root["data"];
  if (!Array.isArray(data)) {
    throw new ProviderError("rerank response has no scores or results");
  }
  const scores = data.map((entry, position) => {
    const record = asRecord(entry, `rerank result ${position}`);
    return {
      index: numberField(record, "index", position),
      score: numberField(record, "score", numberField(record, "relevance_score", 0)),
    };
  });
  if (scores.length !== expected) {
    throw new ProviderError(`reranker returned ${scores.length} scores for ${expected} documents`);
  }
  return scores;
}
