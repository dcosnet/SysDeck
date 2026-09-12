import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";

/** A cached completion plus the metadata needed for TTL and invalidation. */
export interface CachedEntry {
  response: ChatCompletionResponse;
  /** Epoch millis the entry was written. TTL is enforced against this. */
  storedAt: number;
  /** Gateway request id that produced it; the handle for targeted eviction. */
  requestId?: string;
}

export interface CacheStore {
  /** Null on miss, on expiry, and on any backend failure. */
  get(key: string): Promise<CachedEntry | null>;
  set(key: string, entry: CachedEntry, ttlMs: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Removes whatever the given gateway request stored. */
  deleteByRequestId(requestId: string): Promise<boolean>;
  /** Drops every entry; returns how many were removed. */
  clear(): Promise<number>;
  /** Deletes a bounded batch of expired rows; returns how many went. */
  cleanupExpired(batchSize?: number): Promise<number>;
}

/**
 * Stable cache-key digest.
 *
 * The natural key is the normalized request JSON, which routinely runs to
 * kilobytes - far past the ~2704-byte limit of a PostgreSQL btree index entry,
 * so it cannot be a primary key directly. SHA-256 of that JSON is fixed-width,
 * collision-resistant for this purpose, and keeps the L1 tier free to go on
 * using the raw string (no hashing cost on the in-process hot path).
 */
export async function digestKey(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
