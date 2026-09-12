import type {
  VectorMatch,
  VectorSearchOptions,
  VectorStore,
} from "./vector.ts";

export interface PgExecutor {
  /** Parameterized query; returns rows. npm:postgres `sql.unsafe` satisfies this. */
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
}

export interface PgVectorStoreOptions {
  executor: PgExecutor;
  /** Table name; created on first use. Not user input — never interpolate secrets. */
  table?: string;
  dimension?: number;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export class PgVectorStore implements VectorStore {
  private executor: PgExecutor;
  private table: string;
  private dimension?: number;
  private ready = false;

  constructor(options: PgVectorStoreOptions) {
    this.executor = options.executor;
    this.table = options.table ?? "frosty_vectors";
    this.dimension = options.dimension;
  }

  private async ensure(dimension: number): Promise<void> {
    if (this.ready) {
      return;
    }
    const dim = this.dimension ?? dimension;
    await this.executor.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.executor.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.table} (` +
        `id uuid PRIMARY KEY, embedding vector(${dim}), payload jsonb)`,
    );
    this.ready = true;
  }

  async upsert(id: string, vector: number[], payload: unknown): Promise<void> {
    await this.ensure(vector.length);
    await this.executor.unsafe(
      `INSERT INTO ${this.table} (id, embedding, payload) ` +
        `VALUES ($1, $2::vector, $3) ` +
        `ON CONFLICT (id) DO UPDATE SET ` +
        `embedding = EXCLUDED.embedding, payload = EXCLUDED.payload`,
      [id, vectorLiteral(vector), JSON.stringify(payload)],
    );
  }

  async search(
    vector: number[],
    opts: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    await this.ensure(vector.length);
    const rows = await this.executor.unsafe(
      `SELECT id, payload, 1 - (embedding <=> $1::vector) AS score ` +
        `FROM ${this.table} ` +
        `WHERE 1 - (embedding <=> $1::vector) >= $2 ` +
        `ORDER BY embedding <=> $1::vector LIMIT $3`,
      [vectorLiteral(vector), opts.threshold, opts.limit ?? 1],
    ) as Array<{ id: string; payload: unknown; score: number | string }>;
    return rows.map((row) => ({
      id: String(row.id),
      score: Number(row.score),
      payload: typeof row.payload === "string"
        ? JSON.parse(row.payload)
        : row.payload,
    }));
  }

  async delete(id: string): Promise<boolean> {
    await this.executor.unsafe(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return true;
  }
}
