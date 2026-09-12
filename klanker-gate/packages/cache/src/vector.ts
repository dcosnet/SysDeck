export interface VectorMatch {
  id: string;
  score: number;
  payload: unknown;
}

export interface VectorSearchOptions {
  threshold: number;
  limit?: number;
}

export interface VectorStore {
  upsert(id: string, vector: number[], payload: unknown): Promise<void>;
  search(vector: number[], opts: VectorSearchOptions): Promise<VectorMatch[]>;
  /** Removes one cached vector by its stable entry id. */
  delete(id: string): Promise<boolean>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** LRU-bounded in-process vector store (wave-1 semantics). */
export class InMemoryVectorStore implements VectorStore {
  private entries = new Map<string, { vector: number[]; payload: unknown }>();

  constructor(private maxEntries = 500) {}

  size(): number {
    return this.entries.size;
  }

  upsert(id: string, vector: number[], payload: unknown): Promise<void> {
    this.entries.delete(id);
    this.entries.set(id, { vector, payload });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(id));
  }

  search(
    vector: number[],
    opts: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    const matches: VectorMatch[] = [];
    for (const [id, entry] of this.entries) {
      const score = cosineSimilarity(vector, entry.vector);
      if (score >= opts.threshold) {
        matches.push({ id, score, payload: entry.payload });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return Promise.resolve(matches.slice(0, opts.limit ?? 1));
  }
}
