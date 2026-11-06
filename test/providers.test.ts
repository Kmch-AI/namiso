import assert from "node:assert/strict";
import { test } from "vitest";
import {
  HttpEmbeddingProvider,
  HttpExtractionProvider,
  HttpRerankerProvider,
  HashEmbeddingProvider,
  LexicalReranker,
  RuleExtractionProvider,
  ValidationError,
  providersFromEnv,
} from "../src/index.ts";
import { asMemorySpaceId, asMessageId } from "../src/ids.ts";
import { cosineSimilarity } from "../src/text.ts";

const embeddingFetch: typeof fetch = async (_input, init) => {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  const body = JSON.parse(init.body) as { input: string[] };
  return new Response(
    JSON.stringify({
      data: body.input.map(() => ({ embedding: [1, 0] })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const extractionFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [{ name: "IndexTTS2", type: "product" }],
              claims: [
                {
                  subject: { name: "用户A", type: "person" },
                  predicate: "uses",
                  object: { kind: "entity", name: "IndexTTS2", type: "product" },
                  modality: "asserted",
                  confidence: 0.9,
                },
              ],
              events: [
                {
                  type: "usage_change",
                  summary: "用户开始使用 IndexTTS2",
                  participants: [{ name: "用户A", type: "person", role: "actor" }],
                  modality: "asserted",
                  confidence: 0.9,
                },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const rerankFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("hash embeddings are deterministic, normalized, and fixed width", async () => {
  const provider = new HashEmbeddingProvider({ dimensions: 64 });
  const [left, right] = await provider.embed(["我在使用 TTS-A。", "我在使用 TTS-A。"]);
  assert.ok(left !== undefined && right !== undefined);
  assert.equal(left.length, 64);
  assert.deepEqual(left, right);
  const norm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.ok(cosineSimilarity(left, right) > 0.999);
});

test("rule extraction keeps full product names and detects state changes", async () => {
  const provider = new RuleExtractionProvider();
  const messageId = asMessageId("message-1");
  const base = {
    memorySpaceId: asMemorySpaceId("space-1"),
    focusMessageId: messageId,
    knownEntities: [],
  };
  const usage = await provider.extract({
    ...base,
    messages: [
      {
        id: messageId,
        role: "user",
        speakerId: "用户A",
        speakerName: "用户A",
        content: "我在使用 TTS-A。",
        occurredAt: 1_790_000_000,
        messageIndex: 0,
      },
    ],
  });
  assert.equal(usage.claims.length, 1);
  assert.equal(usage.claims[0]?.predicate, "uses");
  assert.equal(usage.claims[0]?.object.kind, "entity");
  assert.equal(
    usage.claims[0]?.object.kind === "entity" ? usage.claims[0].object.name : "",
    "TTS-A",
  );

  const change = await provider.extract({
    ...base,
    focusMessageId: asMessageId("message-2"),
    messages: [
      {
        id: asMessageId("message-2"),
        role: "user",
        speakerId: "用户A",
        speakerName: "用户A",
        content: "我决定重新开始使用 IndexTTS2 了。",
        occurredAt: 1_790_000_060,
        messageIndex: 1,
      },
    ],
  });
  assert.equal(change.claims.length, 0);
  assert.equal(change.events[0]?.type, "usage_change");
  assert.equal(change.events[0]?.modality, "asserted");

  const uncertain = await provider.extract({
    ...base,
    focusMessageId: asMessageId("message-3"),
    messages: [
      {
        id: asMessageId("message-3"),
        role: "user",
        speakerId: "用户A",
        speakerName: "用户A",
        content: "我可能还是会换回 IndexTTS2。",
        occurredAt: 1_790_000_120,
        messageIndex: 2,
      },
    ],
  });
  assert.equal(uncertain.claims.length, 0);
  assert.equal(uncertain.events[0]?.modality, "uncertain");
});

test("lexical reranker ranks lexically overlapping documents higher", async () => {
  const reranker = new LexicalReranker();
  const scores = await reranker.rerank({
    query: "我之前和谁讨论过 TTS-A？",
    documents: ["今天天气不错。", "用户曾与 B 讨论 TTS-A 的情感控制。"],
  });
  const ordered = scores.toSorted((left, right) => right.score - left.score);
  assert.equal(ordered[0]?.index, 1);
});

test("HTTP providers parse boundary payloads", async () => {
  const embedding = new HttpEmbeddingProvider({
    endpoint: "https://example.test/embeddings",
    model: "test-embedding",
    dimensions: 2,
    fetch: embeddingFetch,
  });
  const vectors = await embedding.embed(["a", "b"]);
  assert.deepEqual(vectors, [
    [1, 0],
    [1, 0],
  ]);

  const extraction = new HttpExtractionProvider({
    endpoint: "https://example.test/chat",
    model: "test-chat",
    fetch: extractionFetch,
  });
  const result = await extraction.extract({
    memorySpaceId: asMemorySpaceId("space-1"),
    focusMessageId: asMessageId("message-9"),
    messages: [],
    knownEntities: [],
  });
  assert.equal(result.claims[0]?.predicate, "uses");
  assert.deepEqual(result.claims[0]?.evidenceMessageIds, ["message-9"]);
  assert.equal(result.events[0]?.type, "usage_change");

  const reranker = new HttpRerankerProvider({
    endpoint: "https://example.test/rerank",
    model: "test-rerank",
    fetch: rerankFetch,
  });
  const scores = await reranker.rerank({ query: "q", documents: ["a", "b"] });
  assert.deepEqual(scores, [
    { index: 0, score: 0.1 },
    { index: 1, score: 0.9 },
  ]);
});

test("provider environment parsing is all-or-nothing", () => {
  assert.deepEqual(providersFromEnv({}), {});
  assert.throws(
    () => providersFromEnv({ NAMISO_EMBEDDING_URL: "https://example.test/embeddings" }),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.throws(
    () =>
      providersFromEnv({
        NAMISO_EMBEDDING_URL: "https://example.test/embeddings",
        NAMISO_EMBEDDING_MODEL: "test-embedding",
      }),
    (error: unknown) => error instanceof ValidationError,
  );

  const providers = providersFromEnv({
    NAMISO_EMBEDDING_URL: "https://example.test/embeddings",
    NAMISO_EMBEDDING_MODEL: "test-embedding",
    NAMISO_EMBEDDING_DIMENSIONS: "8",
    NAMISO_EXTRACTION_URL: "https://example.test/chat",
    NAMISO_EXTRACTION_MODEL: "test-chat",
    NAMISO_RERANK_URL: "https://example.test/rerank",
    NAMISO_RERANK_MODEL: "test-rerank",
  });
  assert.ok(providers.embedding instanceof HttpEmbeddingProvider);
  assert.equal(providers.embedding.dimensions, 8);
  assert.ok(providers.extraction instanceof HttpExtractionProvider);
  assert.ok(providers.reranker instanceof HttpRerankerProvider);
});
