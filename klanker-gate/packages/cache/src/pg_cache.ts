import type { PgExecutor } from "../../config/src/pg.ts";
import type { CachedEntry, CacheStore } from "./store.ts";
import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";

/**
 * DDL for the response cache. Idempotent, so every replica can run it at boot.
 *
 * `response` is TEXT rather than JSONB deliberately: the gateway stores and
 * returns an opaque canonical completion and never queries INTO it, so JSONB
 * would buy nothing and cost a parse on write plus a re-serialize on read
 * (DENO_KB §III.B, §IV).
 */
export const CACHE_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS frosty;

CREATE UNLOGGED TABLE IF NOT EXISTS frosty.response_cache (
    cache_key  text        PRIMARY KEY,
    request_id text,
    response   text        NOT NULL,
    stored_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS response_cache_expires_idx
    ON frosty.response_cache (expires_at);

CREATE INDEX IF NOT EXISTS response_cache_request_idx
    ON frosty.response_cache (request_id)
    WHERE request_id IS NOT NULL;
`;

export interface PgCacheStoreOptions {
  executor: PgExecutor;
  /**
   * Called on every backend failure. The cache still degrades to a miss; this
   * exists so a silently broken L2 shows up in metrics rather than looking like
   * a permanently cold cache.
   */
  onError?: (operation: string, error: unknown) => void;
}

export class PgCacheStore implements CacheStore {
  #exec: PgExecutor;
  #onError: (operation: string, error: unknown) => void;

  constructor(options: PgCacheStoreOptions) {
    this.#exec = options.executor;
    this.#onError = options.onError ?? (() => {});
  }

  /** Creates the schema if absent. Safe to run concurrently from N replicas. */
  async init(): Promise<void> {
    for (const statement of CACHE_SCHEMA_SQL.split(";")) {
      const trimmed = statement.trim();
      if (trimmed) {
        await this.#exec.unsafe(trimmed);
      }
    }
  }

  async get(key: string): Promise<CachedEntry | null> {
    try {
      const rows = await this.#exec.unsafe(
        `SELECT response, request_id,
                (EXTRACT(EPOCH FROM stored_at) * 1000)::bigint AS stored_ms
         FROM frosty.response_cache
         WHERE cache_key = $1 AND expires_at > clock_timestamp()`,
        [key],
      ) as Array<
        { response: string; request_id: string | null; stored_ms: string }
      >;
      if (rows.length === 0) {
        return null;
      }
      const row = rows[0];
      return {
        response: JSON.parse(row.response) as ChatCompletionResponse,
        storedAt: Number(row.stored_ms),
        requestId: row.request_id ?? undefined,
      };
    } catch (error) {
      this.#onError("get", error);
      return null;
    }
  }

  async set(key: string, entry: CachedEntry, ttlMs: number): Promise<void> {
    // make_interval takes seconds; the gateway thinks in milliseconds.
    const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
    try {
      await this.#exec.unsafe(
        `INSERT INTO frosty.response_cache
           (cache_key, request_id, response, stored_at, expires_at)
         VALUES ($1, $2, $3, clock_timestamp(),
                 clock_timestamp() + make_interval(secs => $4))
         ON CONFLICT (cache_key) DO UPDATE SET
           request_id = EXCLUDED.request_id,
           response   = EXCLUDED.response,
           stored_at  = EXCLUDED.stored_at,
           expires_at = EXCLUDED.expires_at`,
        [
          key,
          entry.requestId ?? null,
          JSON.stringify(entry.response),
          ttlSeconds,
        ],
      );
    } catch (error) {
      // A successfully generated completion must never be discarded because
      // the cache write failed - same contract the vector store already has.
      this.#onError("set", error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const rows = await this.#exec.unsafe(
        `DELETE FROM frosty.response_cache WHERE cache_key = $1
         RETURNING cache_key`,
        [key],
      ) as unknown[];
      return rows.length > 0;
    } catch (error) {
      this.#onError("delete", error);
      return false;
    }
  }

  async deleteByRequestId(requestId: string): Promise<boolean> {
    try {
      const rows = await this.#exec.unsafe(
        `DELETE FROM frosty.response_cache WHERE request_id = $1
         RETURNING cache_key`,
        [requestId],
      ) as unknown[];
      return rows.length > 0;
    } catch (error) {
      this.#onError("deleteByRequestId", error);
      return false;
    }
  }

  async clear(): Promise<number> {
    try {
      const rows = await this.#exec.unsafe(
        `DELETE FROM frosty.response_cache RETURNING cache_key`,
      ) as unknown[];
      return rows.length;
    } catch (error) {
      this.#onError("clear", error);
      return 0;
    }
  }

  async cleanupExpired(batchSize = 5000): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    try {
      // Bounded by ctid so one pass cannot lock the whole table; the caller
      // loops until a pass comes back short.
      const rows = await this.#exec.unsafe(
        `WITH expired AS (
           SELECT ctid FROM frosty.response_cache
           WHERE expires_at <= clock_timestamp()
           ORDER BY expires_at
           LIMIT $1
         )
         DELETE FROM frosty.response_cache AS c
         USING expired
         WHERE c.ctid = expired.ctid
         RETURNING c.cache_key`,
        [batchSize],
      ) as unknown[];
      return rows.length;
    } catch (error) {
      this.#onError("cleanupExpired", error);
      return 0;
    }
  }
}

/**
 * Periodic expired-row sweeper.
 *
 * Runs until `signal` aborts. In a multi-replica deployment every replica runs
 * one; that is harmless because the DELETE is idempotent and bounded - a row
 * another replica already removed simply is not in the next batch. Coordinating
 * them behind an advisory lock would need a session-stable connection and buys
 * nothing at this size.
 */
export async function runCacheJanitor(
  store: CacheStore,
  signal: AbortSignal,
  intervalMs = 60_000,
  batchSize = 5000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      let deleted: number;
      do {
        deleted = await store.cleanupExpired(batchSize);
      } while (deleted === batchSize && !signal.aborted);
    } catch (error) {
      console.error("cache janitor pass failed", error);
    }
    await sleep(intervalMs, signal);
  }
}

/** Interruptible sleep - aborting must not leave a timer holding the process. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    }, { once: true });
  });
}
