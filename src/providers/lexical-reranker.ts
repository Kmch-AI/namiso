import { segment } from "../text.ts";
import type { RerankerProvider, RerankInput, RerankScore } from "./types.ts";

export class LexicalReranker implements RerankerProvider {
  readonly model = "namiso-lexical";

  async rerank(input: RerankInput): Promise<RerankScore[]> {
    const queryTokens = [...new Set(segment(input.query))];
    if (queryTokens.length === 0) {
      return input.documents.map((_, index) => ({ index, score: 0 }));
    }
    return input.documents.map((document, index) => {
      const documentTokens = new Set(segment(document));
      let matches = 0;
      for (const token of queryTokens) {
        if (documentTokens.has(token)) matches += 1;
      }
      const normalizedQuery = queryTokens.join(" ");
      const normalizedDocument = [...documentTokens].join(" ");
      const orderBonus = normalizedDocument.includes(normalizedQuery) ? 0.2 : 0;
      return {
        index,
        score: Math.min(1, matches / queryTokens.length + orderBonus),
      };
    });
  }
}
