import { segment } from "../text.ts";
import type { EmbeddingProvider } from "./types.ts";

export interface HashEmbeddingOptions {
  dimensions?: number;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "namiso-hash";
  readonly version = "1";
  readonly dimensions: number;

  constructor(options: HashEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 256;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = segment(text);
    const features = [...tokens];
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const left = tokens[index];
      const right = tokens[index + 1];
      if (left !== undefined && right !== undefined) {
        features.push(`${left}_${right}`);
      }
    }
    for (const feature of features) {
      const hash = fnv1a(feature);
      const bucket = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      const weight = 1 + Math.min(feature.length, 8) * 0.05;
      vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
