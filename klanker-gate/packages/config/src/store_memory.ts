import {
  compareKeys,
  hasPrefix,
  keyId,
  type StateEntry,
  type StateKey,
  type StateListOptions,
  type StateStore,
} from "./store.ts";

export class MemoryStateStore implements StateStore {
  #values = new Map<string, { key: StateKey; value: unknown }>();
  #counters = new Map<string, { key: StateKey; value: bigint }>();

  /**
   * Named instances, so "close it and open the same address again" still
   * observes the data that was written - the durability property several
   * integration tests assert by reopening a path. `close()` therefore only
   * drops an ANONYMOUS store's contents; a named one survives, exactly as a
   * real database at that address would.
   */
  static #named = new Map<string, MemoryStateStore>();

  /**
   * Returns the store registered under `name`, creating it on first use.
   * `:memory:` and an empty name are anonymous: each call gets a fresh store,
   * matching how Deno KV treated `:memory:`.
   */
  static named(name?: string): MemoryStateStore {
    if (!name || name === ":memory:") {
      return new MemoryStateStore();
    }
    const existing = MemoryStateStore.#named.get(name);
    if (existing) {
      return existing;
    }
    const created = new MemoryStateStore();
    MemoryStateStore.#named.set(name, created);
    return created;
  }

  /** Drops every named instance. Test isolation hook; never used in the app. */
  static resetAll(): void {
    MemoryStateStore.#named.clear();
  }

  /** True while this instance is registered under a name. */
  #isNamed(): boolean {
    for (const store of MemoryStateStore.#named.values()) {
      if (store === this) return true;
    }
    return false;
  }

  set(key: StateKey, value: unknown): Promise<void> {
    // Structured-clone on write mirrors what a real store does: the caller
    // mutating the object it just handed over must not retroactively change
    // what was persisted.
    this.#values.set(keyId(key), { key: [...key], value: clone(value) });
    return Promise.resolve();
  }

  get<T>(key: StateKey): Promise<T | null> {
    const hit = this.#values.get(keyId(key));
    return Promise.resolve(hit ? clone(hit.value) as T : null);
  }

  list<T>(
    prefix: StateKey,
    options: StateListOptions = {},
  ): Promise<Array<StateEntry<T>>> {
    const rows = [...this.#values.values()]
      .filter((row) => hasPrefix(row.key, prefix))
      .sort((a, b) =>
        options.reverse ? compareKeys(b.key, a.key) : compareKeys(a.key, b.key)
      )
      .map((row) => ({ key: row.key, value: clone(row.value) as T }));
    return Promise.resolve(
      options.limit !== undefined ? rows.slice(0, options.limit) : rows,
    );
  }

  keys(prefix: StateKey): Promise<StateKey[]> {
    return Promise.resolve(
      [...this.#values.values()]
        .filter((row) => hasPrefix(row.key, prefix))
        .sort((a, b) => compareKeys(a.key, b.key))
        .map((row) => row.key),
    );
  }

  delete(key: StateKey): Promise<void> {
    this.#values.delete(keyId(key));
    return Promise.resolve();
  }

  sum(key: StateKey, delta: bigint): Promise<void> {
    const id = keyId(key);
    const current = this.#counters.get(id)?.value ?? 0n;
    this.#counters.set(id, { key: [...key], value: current + delta });
    return Promise.resolve();
  }

  getCount(key: StateKey): Promise<number> {
    return Promise.resolve(Number(this.#counters.get(keyId(key))?.value ?? 0n));
  }

  listCounts(prefix: StateKey): Promise<Array<StateEntry<number>>> {
    return Promise.resolve(
      [...this.#counters.values()]
        .filter((row) => hasPrefix(row.key, prefix))
        .sort((a, b) => compareKeys(a.key, b.key))
        .map((row) => ({ key: row.key, value: Number(row.value) })),
    );
  }

  deleteCount(key: StateKey): Promise<void> {
    this.#counters.delete(keyId(key));
    return Promise.resolve();
  }

  getOrSet<T>(key: StateKey, value: T): Promise<T> {
    const id = keyId(key);
    const existing = this.#values.get(id);
    if (existing) {
      return Promise.resolve(clone(existing.value) as T);
    }
    this.#values.set(id, { key: [...key], value: clone(value) });
    return Promise.resolve(value);
  }

  reserveCounts(
    limits: ReadonlyArray<{ key: StateKey; max: number; amount?: number }>,
  ): Promise<"reserved" | "exhausted" | "conflict"> {
    // Single-threaded and synchronous end to end: no await sits between the
    // check and the increment, so no interleaving is possible. The Postgres
    // implementation buys the same guarantee with a transaction.
    for (const limit of limits) {
      const current = Number(this.#counters.get(keyId(limit.key))?.value ?? 0n);
      if (current + (limit.amount ?? 1) > limit.max) {
        return Promise.resolve("exhausted");
      }
    }
    for (const limit of limits) {
      const id = keyId(limit.key);
      const current = this.#counters.get(id)?.value ?? 0n;
      this.#counters.set(id, {
        key: [...limit.key],
        value: current + BigInt(limit.amount ?? 1),
      });
    }
    return Promise.resolve("reserved");
  }

  close(): void {
    // A named store models a database that outlives the handle: closing the
    // handle must not delete the data, or every reopen-and-assert test would
    // pass vacuously against an empty store.
    if (!this.#isNamed()) {
      this.#values.clear();
      this.#counters.clear();
    }
  }
}

/**
 * Deep copy for stored values. `structuredClone` handles the JSON-shaped data
 * this store holds and, unlike a JSON round-trip, preserves `undefined`-free
 * object identity semantics without stringifying.
 */
function clone(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return structuredClone(value);
}
