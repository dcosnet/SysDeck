// Fleet-wide fixed-window rate limiting (decision-log 71 / open-risks R1).
//
// The in-process RateLimiter in rate_limit.ts holds its windows in a Map, so
// under FROSTY_WORKERS=N a per-window limit admits up to N times its stated
// value. This moves the window to the one authority every process already
// shares.

import type { StateKey, StateStore } from "../../config/src/store.ts";

/** Prefix for every window counter, so the janitor can find them by range. */
export const RATE_PREFIX = "ratelimit";

export type SharedVerdict = "admitted" | "limited" | "unavailable";

export interface SharedWindow {
  /** `requests` or `tokens`; keeps the two limit kinds in separate windows. */
  scope: string;
  /** Virtual key id. */
  id: string;
  max: number;
  windowMs: number;
  /** Units consumed; token limits pass the estimate, requests pass 1. */
  amount?: number;
}

/** Start of the fixed window containing `now`, in epoch millis. */
export function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Fixed-window limiter backed by the shared state store. Windows are addressed
 * by their start time, so every process computes the same key from the same
 * clock without any coordination.
 */
export class SharedRateLimiter {
  constructor(private store: StateStore) {}

  /** Counter key for one window. Exposed for the janitor and for tests. */
  static keyFor(window: SharedWindow, now: number): StateKey {
    return [
      RATE_PREFIX,
      window.scope,
      window.id,
      String(windowStart(now, window.windowMs)),
    ];
  }

  /**
   * Reserves `amount` against the current window.
   *
   * Returns "unavailable" rather than throwing when the store cannot answer.
   * The caller decides what that means: governance fails closed, matching how
   * a broken durable budget authority already denies.
   */
  async admit(window: SharedWindow, now = Date.now()): Promise<SharedVerdict> {
    const verdict = await this.store.reserveCounts([{
      key: SharedRateLimiter.keyFor(window, now),
      max: window.max,
      amount: window.amount ?? 1,
    }]);
    if (verdict === "reserved") {
      return "admitted";
    }
    return verdict === "exhausted" ? "limited" : "unavailable";
  }

  /** Milliseconds until the current window rolls over, for Retry-After. */
  retryAfterMs(windowMs: number, now = Date.now()): number {
    return Math.max(0, windowStart(now, windowMs) + windowMs - now);
  }
}

/**
 * Deletes window counters that can no longer be reserved against. Expired
 * windows are unreachable but not self-removing, so without this the counters
 * table grows one row per key per window forever.
 *
 * Returns the number deleted.
 */
export async function pruneRateWindows(
  store: StateStore,
  now = Date.now(),
  /** Keep this much slack behind the newest window an active limit could use. */
  graceMs = 3_600_000,
): Promise<number> {
  const entries = await store.listCounts([RATE_PREFIX]);
  let removed = 0;
  for (const entry of entries) {
    const start = Number(entry.key[entry.key.length - 1]);
    if (!Number.isFinite(start) || start >= now - graceMs) {
      continue;
    }
    await store.deleteCount(entry.key);
    removed++;
  }
  return removed;
}
