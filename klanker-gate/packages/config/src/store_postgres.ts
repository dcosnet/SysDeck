import type { PgTransactor } from "./pg.ts";
import {
  keyId,
  type StateEntry,
  type StateKey,
  type StateListOptions,
  type StateStore,
} from "./store.ts";

/** Key-path separator. Never appears inside a key part. */
const SEP = "\x1f";
/** Successor of SEP; the exclusive upper bound of a prefix range. */
const SEP_NEXT = "\x20";

interface StateRow {
  key_path: string[];
  value: unknown;
}

interface CounterRow {
  key_path: string[];
  value: string | number | bigint;
}

/**
 * DDL for the state tables. Idempotent, so every process can run it at boot
 * without coordination; concurrent `CREATE TABLE IF NOT EXISTS` from N starting
 * replicas is safe.
 */
export const STATE_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS frosty;

CREATE TABLE IF NOT EXISTS frosty.state (
    key_text   text COLLATE "C" PRIMARY KEY,
    key_path   text[]      NOT NULL,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS frosty.counters (
    key_text   text COLLATE "C" PRIMARY KEY,
    key_path   text[]      NOT NULL,
    value      bigint      NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

export class PostgresStateStore implements StateStore {
  constructor(private db: PgTransactor) {}

  /** Creates the schema if absent. Safe to call from every process at boot. */
  async init(): Promise<void> {
    // Split on the statement boundary: npm:postgres' simple-query path accepts
    // multi-statement strings, but `unsafe` with a params array does not.
    for (const statement of STATE_SCHEMA_SQL.split(";")) {
      const trimmed = statement.trim();
      if (trimmed) {
        await this.db.unsafe(trimmed);
      }
    }
  }

  async set(key: StateKey, value: unknown): Promise<void> {
    await this.db.unsafe(
      `INSERT INTO frosty.state (key_text, key_path, value)
       VALUES ($1, $2::text[], $3::jsonb)
       ON CONFLICT (key_text) DO UPDATE
         SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
      [keyId(key), toPathArray(key), JSON.stringify(value ?? null)],
    );
  }

  async get<T>(key: StateKey): Promise<T | null> {
    const rows = await this.db.unsafe(
      `SELECT value FROM frosty.state WHERE key_text = $1`,
      [keyId(key)],
    ) as Array<{ value: unknown }>;
    if (rows.length === 0) {
      return null;
    }
    return decodeJson(rows[0].value) as T;
  }

  async list<T>(
    prefix: StateKey,
    options: StateListOptions = {},
  ): Promise<Array<StateEntry<T>>> {
    const rows = await this.#listRange<StateRow>(
      "frosty.state",
      "key_path, value",
      prefix,
      options,
    );
    return rows.map((row) => ({
      key: row.key_path,
      value: decodeJson(row.value) as T,
    }));
  }

  async keys(prefix: StateKey): Promise<StateKey[]> {
    const rows = await this.#listRange<{ key_path: string[] }>(
      "frosty.state",
      "key_path",
      prefix,
      {},
    );
    return rows.map((row) => row.key_path);
  }

  async delete(key: StateKey): Promise<void> {
    await this.db.unsafe(`DELETE FROM frosty.state WHERE key_text = $1`, [
      keyId(key),
    ]);
  }

  async sum(key: StateKey, delta: bigint): Promise<void> {
    await this.db.unsafe(
      `INSERT INTO frosty.counters (key_text, key_path, value)
       VALUES ($1, $2::text[], $3::bigint)
       ON CONFLICT (key_text) DO UPDATE
         SET value = frosty.counters.value + EXCLUDED.value,
             updated_at = clock_timestamp()`,
      [keyId(key), toPathArray(key), delta.toString()],
    );
  }

  async getCount(key: StateKey): Promise<number> {
    const rows = await this.db.unsafe(
      `SELECT value FROM frosty.counters WHERE key_text = $1`,
      [keyId(key)],
    ) as Array<{ value: string | number }>;
    return rows.length === 0 ? 0 : Number(rows[0].value);
  }

  async listCounts(prefix: StateKey): Promise<Array<StateEntry<number>>> {
    const rows = await this.#listRange<CounterRow>(
      "frosty.counters",
      "key_path, value",
      prefix,
      {},
    );
    return rows.map((row) => ({
      key: row.key_path,
      value: Number(row.value),
    }));
  }

  async deleteCount(key: StateKey): Promise<void> {
    await this.db.unsafe(`DELETE FROM frosty.counters WHERE key_text = $1`, [
      keyId(key),
    ]);
  }

  async getOrSet<T>(key: StateKey, value: T): Promise<T> {
    // The no-op `DO UPDATE SET value = <table>.value` is what makes this one
    // statement: plain `DO NOTHING` returns zero rows on conflict, forcing a
    // second SELECT and reopening the race this method exists to close.
    const rows = await this.db.unsafe(
      `INSERT INTO frosty.state (key_text, key_path, value)
       VALUES ($1, $2::text[], $3::jsonb)
       ON CONFLICT (key_text) DO UPDATE SET value = frosty.state.value
       RETURNING value`,
      [keyId(key), toPathArray(key), JSON.stringify(value ?? null)],
    ) as Array<{ value: unknown }>;
    return rows.length === 0 ? value : decodeJson(rows[0].value) as T;
  }

  async reserveCounts(
    limits: ReadonlyArray<{ key: StateKey; max: number; amount?: number }>,
  ): Promise<"reserved" | "exhausted" | "conflict"> {
    if (limits.length === 0) {
      return "reserved";
    }
    // Single-counter fast path. A transaction costs BEGIN + statement + COMMIT
    // (three round trips); one conditional upsert is atomic on its own, because
    // the WHERE is evaluated under the row lock the UPDATE takes. Measured on
    // the rate-limit path: ~6.7 ms -> ~2.2 ms serial. Multi-counter budget
    // reservations still need the transaction below for all-or-nothing.
    if (limits.length === 1) {
      const limit = limits[0];
      const amount = limit.amount ?? 1;
      // An amount larger than the whole allowance can never be admitted, and
      // must not be attempted, or the INSERT branch would seed an over-max row.
      if (amount > limit.max) {
        return "exhausted";
      }
      try {
        const rows = await this.db.unsafe(
          `INSERT INTO frosty.counters (key_text, key_path, value)
           VALUES ($1, $2::text[], $3)
           ON CONFLICT (key_text) DO UPDATE
             SET value = frosty.counters.value + $3,
                 updated_at = clock_timestamp()
             WHERE frosty.counters.value + $3 <= $4
           RETURNING value`,
          [keyId(limit.key), toPathArray(limit.key), amount, limit.max],
        ) as Array<{ value: string | number }>;
        // No row returned means the WHERE rejected the update: at the limit,
        // and nothing was consumed.
        return rows.length === 0 ? "exhausted" : "reserved";
      } catch {
        return "conflict";
      }
    }

    const ordered = [...limits].sort((a, b) =>
      keyId(a.key) < keyId(b.key) ? -1 : keyId(a.key) > keyId(b.key) ? 1 : 0
    );
    try {
      return await this.db.transaction(async (tx) => {
        for (const limit of ordered) {
          const amount = limit.amount ?? 1;
          const rows = await tx.unsafe(
            `INSERT INTO frosty.counters (key_text, key_path, value)
             VALUES ($1, $2::text[], $3)
             ON CONFLICT (key_text) DO UPDATE
               SET value = frosty.counters.value + $3,
                   updated_at = clock_timestamp()
             RETURNING value`,
            [keyId(limit.key), toPathArray(limit.key), amount],
          ) as Array<{ value: string | number }>;
          // The row lock taken by this UPDATE is held until COMMIT, so no
          // concurrent reservation can slip between the increment and the
          // check. Exceeding the max rolls the whole reservation back.
          if (Number(rows[0]?.value ?? 0) > limit.max) {
            throw new BudgetExhausted();
          }
        }
        return "reserved" as const;
      });
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        return "exhausted";
      }
      // Anything else - a serialization failure, a lost connection, a dead
      // pool - is NOT an admit. Governance fails closed on "conflict".
      return "conflict";
    }
  }

  /**
   * Shared prefix range scan. An empty prefix reads the whole table; otherwise
   * the range is [prefix + \x1f, prefix + \x20), which is a half-open interval
   * over the primary-key index.
   */
  async #listRange<T>(
    table: string,
    columns: string,
    prefix: StateKey,
    options: StateListOptions,
  ): Promise<T[]> {
    const order = options.reverse ? "DESC" : "ASC";
    // `table` and `columns` are module-private literals, never caller input;
    // every VALUE is a bind parameter.
    if (prefix.length === 0) {
      const sql = `SELECT ${columns} FROM ${table} ORDER BY key_text ${order}` +
        (options.limit !== undefined ? ` LIMIT $1` : ``);
      return await this.db.unsafe(
        sql,
        options.limit !== undefined ? [options.limit] : [],
      ) as T[];
    }
    const base = keyId(prefix);
    const params: unknown[] = [base + SEP, base + SEP_NEXT];
    let sql = `SELECT ${columns} FROM ${table}
       WHERE key_text >= $1 AND key_text < $2
       ORDER BY key_text ${order}`;
    if (options.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $3`;
    }
    return await this.db.unsafe(sql, params) as T[];
  }

  close(): void {
    // The pool is owned by the PgHandle that was injected here, because the
    // cache and the LISTEN path share it. Closing it is the owner's job.
  }
}

/** Internal signal used to roll back a reservation transaction. */
class BudgetExhausted extends Error {
  constructor() {
    super("budget exhausted");
    this.name = "BudgetExhausted";
  }
}

/** Key path as a plain string array, for the `text[]` bind parameter. */
function toPathArray(key: StateKey): string[] {
  return key.map(String);
}

/**
 * npm:postgres parses `jsonb` into JS values, but a driver configured
 * differently (or a column read through `unsafe` on some versions) can hand back
 * the raw string. Accept both rather than depending on driver-parsing behavior.
 */
function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Convenience for the ordering helpers to stay importable from one place. */
export { SEP as STATE_KEY_SEPARATOR };
