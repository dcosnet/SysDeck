import type { Sql } from "./pg_types.ts";

/**
 * Minimal parameterized-query surface. Everything in the gateway depends on
 * THIS, not on npm:postgres, so unit tests inject a fake and no test needs a
 * live database (assumption A1 of the state-consolidation run).
 */
export interface PgExecutor {
  /** Parameterized query returning rows. `sql.unsafe` satisfies this. */
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
}

/** Adds transaction scoping to {@link PgExecutor}. */
export interface PgTransactor extends PgExecutor {
  /**
   * Runs `fn` inside a single transaction. The callback's executor MUST be used
   * for every statement that has to commit atomically with the others - this is
   * what lets a data change and its cache invalidation share one commit
   * boundary, which is the main consistency win over an external cache.
   */
  transaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
}

export interface PgOptions {
  url: string;
  /**
   * Per-PROCESS pool size. Keep this small (5-10). With N gateway processes the
   * server-side connection budget is N x this, so the number that matters to
   * Postgres is the product, not this value. Behind PgBouncer the real budget is
   * its `default_pool_size` instead.
   */
  max?: number;
  /** Shows up in `pg_stat_activity`, so a stuck connection is attributable. */
  applicationName?: string;
}

/** Default per-process pool size - the KB's recommended 5-10 band. */
export const DEFAULT_POOL_SIZE = 8;

/** Upper bound on FROSTY_PG_POOL_SIZE; beyond this, add processes not sockets. */
const MAX_POOL_SIZE = 100;

/**
 * Bounded parse for FROSTY_PG_POOL_SIZE. Every config knob in this repo parses
 * with a bound and falls back rather than trusting the environment.
 */
export function poolSizeFromEnv(
  raw = Deno.env.get("FROSTY_PG_POOL_SIZE"),
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POOL_SIZE) {
    return DEFAULT_POOL_SIZE;
  }
  return parsed;
}

/**
 * Pooled application connection URL. Unset is a boot error, not a default:
 * silently connecting to `localhost` would let a misconfigured production
 * replica come up healthy against the wrong database.
 */
export function pgUrlFromEnv(): string {
  const url = Deno.env.get("FROSTY_PG_URL")?.trim();
  if (!url) {
    throw new Error(
      "FROSTY_PG_URL is required. The gateway keeps all durable state " +
        "(config, governance, logs, cache) in PostgreSQL. " +
        "Start one with `docker compose up -d postgres`.",
    );
  }
  return url;
}

/**
 * Session-stable URL for LISTEN. Falls back to the pooled URL, which is correct
 * ONLY when nothing is pooling in between - see {@link assertDirectUrlDistinct}.
 */
export function pgDirectUrlFromEnv(): string {
  return Deno.env.get("FROSTY_PG_DIRECT_URL")?.trim() || pgUrlFromEnv();
}

/**
 * Warns when LISTEN would run through what looks like a transaction pooler.
 * PgBouncer's default port is 6432; a LISTEN routed there registers on a
 * connection that is handed to somebody else after the next COMMIT, so
 * notifications stop arriving SILENTLY - no error, just a cache that never
 * invalidates. Detection is heuristic, so this warns rather than refusing.
 */
export function assertDirectUrlDistinct(
  pooled = pgUrlFromEnv(),
  direct = pgDirectUrlFromEnv(),
): void {
  if (direct === pooled && /:6432(\/|$|\?)/.test(pooled)) {
    console.warn(
      "FROSTY_PG_DIRECT_URL is unset and FROSTY_PG_URL points at :6432 " +
        "(PgBouncer's default port). LISTEN requires a session-stable " +
        "connection; through transaction pooling cross-process cache " +
        "invalidation will fail silently. Set FROSTY_PG_DIRECT_URL to the " +
        "PostgreSQL port (5432) or to a pool_mode=session alias.",
    );
  }
}

/**
 * Opens a pooled connection and wraps it in the executor interface the rest of
 * the gateway depends on. npm:postgres pools internally, so this is one object
 * per process, not one per request.
 */
export async function openPg(options: PgOptions): Promise<PgHandle> {
  const postgres = await import("postgres");
  const sql = postgres.default(options.url, {
    max: options.max ?? DEFAULT_POOL_SIZE,
    connection: {
      application_name: options.applicationName ?? "frosty-gateway",
    },
    // Cache state is disposable; a hung connection must not wedge a request
    // that only wanted to check for a cache hit.
    connect_timeout: 10,
    onnotice: () => {},
  }) as unknown as Sql;
  return new PgHandle(sql);
}

/**
 * Owns one npm:postgres pool and exposes it as a {@link PgTransactor}.
 * Everything downstream sees only the interface.
 */
export class PgHandle implements PgTransactor {
  constructor(private sql: Sql) {}

  async unsafe(query: string, params: unknown[] = []): Promise<unknown[]> {
    return await this.sql.unsafe(query, params) as unknown[];
  }

  async transaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx) => {
      return await fn({
        unsafe: async (query, params = []) =>
          await tx.unsafe(query, params) as unknown[],
      });
    }) as T;
  }

  /** Raw handle, for the LISTEN path which needs npm:postgres' own API. */
  raw(): Sql {
    return this.sql;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/**
 * Verifies the database is actually reachable and speaks SQL. Called at boot so
 * an unreachable Postgres fails loudly on line one instead of surfacing as a
 * confusing error on the first request (decision D6: refuse to start).
 */
export async function assertReachable(exec: PgExecutor): Promise<void> {
  try {
    await exec.unsafe("SELECT 1");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PostgreSQL is unreachable: ${message}\n` +
        "The gateway keeps all durable state in PostgreSQL and refuses to " +
        "start without it. Bring it up with `docker compose up -d postgres`, " +
        "or check FROSTY_PG_URL.",
    );
  }
}
