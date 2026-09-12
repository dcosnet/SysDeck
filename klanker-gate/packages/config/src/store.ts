/** One element of a key path. Strings in every current call site. */
export type StateKeyPart = string | number;

/** An ordered key path, e.g. ["config", "providers", "openai"]. */
export type StateKey = readonly StateKeyPart[];

/** One entry returned by a prefix listing. */
export interface StateEntry<T> {
  key: StateKey;
  value: T;
}

export interface StateListOptions {
  /** Descending key order. Used by the log trail to read newest-first. */
  reverse?: boolean;
  limit?: number;
}

/**
 * Durable key/value + atomic-counter store.
 *
 * Values and counters are deliberately SEPARATE namespaces. A counter is an
 * atomic integer that only ever moves by addition; a value is an opaque JSON
 * document replaced wholesale. Mixing them in one keyspace is what forced the
 * old `Deno.KvU64` casts up through the service layer.
 */
export interface StateStore {
  set(key: StateKey, value: unknown): Promise<void>;
  get<T>(key: StateKey): Promise<T | null>;
  list<T>(
    prefix: StateKey,
    options?: StateListOptions,
  ): Promise<Array<StateEntry<T>>>;
  /** Key-only listing (log pruning) - skips value deserialization cost. */
  keys(prefix: StateKey): Promise<StateKey[]>;
  delete(key: StateKey): Promise<void>;

  /** Atomic counter increment - no read-modify-write race. */
  sum(key: StateKey, delta: bigint): Promise<void>;
  /** Reads a counter written by sum(); 0 when absent. */
  getCount(key: StateKey): Promise<number>;
  /** Prefix listing over the COUNTER namespace. */
  listCounts(prefix: StateKey): Promise<Array<StateEntry<number>>>;
  /**
   * Removes a counter.
   *
   * Distinct from {@link StateStore.delete} because counters live in their own
   * namespace: deleting a virtual key has to clear its usage and cost counters,
   * and a `delete()` on the value namespace silently would not - leaving a
   * revoked key's spend attributed forever, and a recreated key starting at its
   * predecessor's total.
   */
  deleteCount(key: StateKey): Promise<void>;

  /**
   * Sets a small metadata record once, returning the value that won the race.
   * Used for server-owned governance schedule anchors; callers never supply a
   * versionstamp or trust a client clock.
   */
  getOrSet<T>(key: StateKey, value: T): Promise<T>;

  /**
   * Atomically reserves capacity across every supplied counter. The caller has
   * already selected the period-specific keys and maximums. `amount` defaults
   * to 1; token metering passes the estimated token count. Callers fail closed
   * when this cannot be resolved, so "conflict" must never be treated as an
   * admit.
   *
   * All-or-nothing: exceeding any single maximum rolls the whole reservation
   * back, so an oversized request cannot poison a fresh window.
   */
  reserveCounts(
    limits: ReadonlyArray<{ key: StateKey; max: number; amount?: number }>,
  ): Promise<"reserved" | "exhausted" | "conflict">;

  close(): Promise<void> | void;
}

/**
 * Historical name for {@link StateStore}. Kept as an alias because it appears in
 * the constructor signature of five long-lived collaborators (ConfigService,
 * ConfigCrypto, LogStore, UsageTracker, BudgetEpochStore); renaming those would
 * bury the actual behavior change in a diff full of rename noise.
 */
export type ConfigStore = StateStore;

/** Lexicographic comparison of two key paths, element by element. */
export function compareKeys(a: StateKey, b: StateKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = String(a[i]);
    const y = String(b[i]);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/**
 * True when `key` is a STRICT descendant of `prefix`.
 *
 * The strictness matters: `list(["a"])` must yield the children of ["a"] and
 * NOT the entry stored at ["a"] itself. That is Deno KV's prefix semantics and
 * the code that migrated off it depends on the distinction - `ConfigService`
 * stores settings at ["config","settings"] while listing providers under
 * ["config","providers"], and a non-strict prefix would let an entry at a
 * listing's own root leak into the results as a bogus row.
 */
export function hasPrefix(key: StateKey, prefix: StateKey): boolean {
  if (key.length <= prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (String(key[i]) !== String(prefix[i])) {
      return false;
    }
  }
  return true;
}

/** Stable string form of a key path, for use as a Map key. */
export function keyId(key: StateKey): string {
  // \x1f (unit separator) never appears in a key part, so the encoding is
  // unambiguous: ["a","b"] and ["a\x1fb"] cannot collide in practice.
  return key.map(String).join("\x1f");
}
