import { ValidationError } from "./errors.ts";
import type { ChunkPolicy } from "./ingestion/chunker.ts";
import { DEFAULT_CHUNK_POLICY } from "./ingestion/chunker.ts";
import { HashEmbeddingProvider } from "./providers/hash-embedding.ts";
import { LexicalReranker } from "./providers/lexical-reranker.ts";
import { RuleExtractionProvider } from "./providers/rule-extraction.ts";
import type { EmbeddingProvider, ExtractionProvider, RerankerProvider } from "./providers/types.ts";

export type VectorIndexMode = "auto" | "sqlite-vec" | "exact";

export interface NamisoOptions {
  databasePath: string;
  workspace?: { id?: string; name?: string };
  memorySpace?: { id?: string; name?: string };
  embedding?: EmbeddingProvider;
  extraction?: ExtractionProvider;
  reranker?: RerankerProvider;
  vectorIndex?: VectorIndexMode;
  chunking?: Partial<ChunkPolicy>;
}

export interface ResolvedNamisoOptions {
  databasePath: string;
  workspace: { id: string | undefined; name: string };
  memorySpace: { id: string | undefined; name: string };
  embedding: EmbeddingProvider;
  extraction: ExtractionProvider;
  reranker: RerankerProvider;
  vectorIndex: VectorIndexMode;
  chunkPolicy: ChunkPolicy;
}

export function resolveOptions(options: NamisoOptions): ResolvedNamisoOptions {
  if (typeof options.databasePath !== "string" || options.databasePath.trim().length === 0) {
    throw new ValidationError("databasePath must be a non-empty string");
  }
  const embedding = options.embedding ?? new HashEmbeddingProvider();
  assertProvider("embedding", embedding, ["embed"]);
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0) {
    throw new ValidationError("embedding.dimensions must be a positive integer");
  }
  if (embedding.model.trim().length === 0) {
    throw new ValidationError("embedding.model must be non-empty");
  }
  const extraction = options.extraction ?? new RuleExtractionProvider();
  assertProvider("extraction", extraction, ["extract"]);
  const reranker = options.reranker ?? new LexicalReranker();
  assertProvider("reranker", reranker, ["rerank"]);
  const vectorIndex = options.vectorIndex ?? "auto";
  if (!["auto", "sqlite-vec", "exact"].includes(vectorIndex)) {
    throw new ValidationError(`unsupported vectorIndex: ${String(vectorIndex)}`);
  }
  const size = options.chunking?.size ?? DEFAULT_CHUNK_POLICY.size;
  const overlap = options.chunking?.overlap ?? DEFAULT_CHUNK_POLICY.overlap;
  if (!Number.isInteger(size) || size < 1 || size > 64) {
    throw new ValidationError("chunking.size must be an integer between 1 and 64");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new ValidationError("chunking.overlap must be an integer below chunking.size");
  }
  return {
    databasePath: options.databasePath,
    workspace: {
      id: options.workspace?.id,
      name: options.workspace?.name ?? "default",
    },
    memorySpace: {
      id: options.memorySpace?.id,
      name: options.memorySpace?.name ?? "default",
    },
    embedding,
    extraction,
    reranker,
    vectorIndex,
    chunkPolicy: { size, overlap },
  };
}

function assertProvider(label: string, provider: object, methods: readonly string[]): void {
  for (const method of methods) {
    const value = (provider as Record<string, unknown>)[method];
    if (typeof value !== "function") {
      throw new ValidationError(`${label} provider must implement ${method}()`);
    }
  }
}
