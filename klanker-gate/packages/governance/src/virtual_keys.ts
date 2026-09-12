import { z } from "zod";
import { createHash } from "node:crypto";
import { RateLimiter, type RateLimitPolicy } from "./rate_limit.ts";
import {
  MAX_BUDGET_RESET_INTERVAL_MS,
  MIN_BUDGET_RESET_INTERVAL_MS,
} from "./budget_epochs.ts";

/**
 * SHA-256 (hex) of a bearer token. Tokens are high-entropy random values, so a
 * single fast hash is the correct primitive (unlike low-entropy passwords).
 * This is what the gateway stores and compares — the raw token is never kept.
 */
export function hashVirtualKeyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Non-secret UI hint: last 4 chars only (was first 6 — leaked 75% of a min key). */
function tokenHintFor(token: string): string {
  return `…${token.slice(-4)}`;
}

export const BudgetSchema = z.object({
  maxRequests: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  /** Server-timed fixed reset interval; absence keeps lifetime-budget behavior. */
  resetIntervalMs: z.number().int().min(MIN_BUDGET_RESET_INTERVAL_MS).max(
    MAX_BUDGET_RESET_INTERVAL_MS,
  ).optional(),
}).strict().refine((budget) =>
  budget.resetIntervalMs === undefined ||
  budget.maxRequests !== undefined || budget.maxCostUsd !== undefined, {
  message: "resetIntervalMs requires a request or cost budget",
});

export const VirtualKeySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Optional human-readable note surfaced in the control UI. */
  description: z.string().optional(),
  /**
   * Raw bearer token. Accepted only transiently — as creation input, or from a
   * legacy record predating hashing. The manager derives {@link VirtualKey.tokenHash}
   * and never persists or retains the raw value.
   */
  token: z.string().min(8).optional(),
  /** SHA-256 (hex) of the bearer token: the persisted, compared credential. */
  tokenHash: z.string().length(64).optional(),
  /** Non-secret hint (last 4 chars of the token) surfaced in the control UI. */
  tokenHint: z.string().optional(),
  enabled: z.boolean().default(true),
  rateLimit: z.object({
    maxRequests: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }).optional(),
  /** Token-metered fixed window (wave-3). */
  tokenLimit: z.object({
    maxTokens: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }).optional(),
  /**
   * Budgets: request-count and/or dollar-cost. Exhausted keys are refused
   * until raised. Cost accounting is integer micro-USD internally.
   */
  budget: BudgetSchema.optional(),
  /**
   * Optional admission scope. When present (non-empty), a request is refused
   * (403) unless its resolved provider account is in `allowedProviders` and/or
   * its resolved model id is in `allowedModels`. Absent = unrestricted (the
   * back-compat default). Empty arrays are rejected at the schema so "no
   * restriction" is always expressed as absence, never `[]`. Provider ids are
   * account ids; model ids are the bare id with any `account/` prefix stripped.
   */
  allowedProviders: z.array(z.string().min(1)).min(1).optional(),
  allowedModels: z.array(z.string().min(1)).min(1).optional(),
  usedRequests: z.number().int().nonnegative().default(0),
  usedCostMicroUsd: z.number().int().nonnegative().default(0),
  /** Optional membership in the governance hierarchy (key -> team -> customer). */
  teamId: z.string().optional(),
}).refine((k) => k.token !== undefined || k.tokenHash !== undefined, {
  message: "virtual key requires a token or tokenHash",
});
export type VirtualKey = z.infer<typeof VirtualKeySchema>;

/** Browser-safe view: never exposes the token or its hash, cost in USD. */
export function publicVirtualKey(key: VirtualKey) {
  const { token: _token, tokenHash: _tokenHash, ...rest } = key;
  return {
    ...rest,
    // Prefer the stored hint; derive from a legacy raw token as a fallback.
    tokenHint: key.tokenHint ?? (key.token ? tokenHintFor(key.token) : "…"),
    usedCostUsd: key.usedCostMicroUsd / 1_000_000,
  };
}

export type KeyDecision =
  | { ok: true; key: VirtualKey }
  | {
    ok: false;
    status: number;
    message: string;
    code: string;
    /** For 429s: actual window reset, feeding the Retry-After header. */
    retryAfterMs?: number;
  };

export class VirtualKeyManager {
  private keys = new Map<string, VirtualKey>();
  /** tokenHash -> id, for O(1) constant-time lookup on the admission path. */
  private byHash = new Map<string, string>();
  private limiter: RateLimiter;
  private usageSink?: (id: string) => void;
  private costSink?: (id: string, microUsd: number) => void;

  /**
   * When true, `admit` skips the in-process rate and token windows because a
   * FLEET-WIDE authority enforces them instead. Running both would double
   * count: the local window would deny at `max` on a single worker that had
   * only served `max` of the fleet's traffic.
   */
  private externalRateLimit = false;

  constructor(
    keys: VirtualKey[] = [],
    limiterDefaults: RateLimitPolicy = { maxRequests: 60, windowMs: 60_000 },
  ) {
    this.limiter = new RateLimiter(limiterDefaults);
    for (const key of keys) {
      // Persisted records predating newer schema fields must be normalized
      // (defaults applied) or dropped — a malformed key that skipped
      // validation could otherwise neutralize its own budget checks (NaN).
      try {
        this.register(key);
      } catch (error) {
        console.warn(
          `virtual key "${key?.id ?? "?"}" skipped at load: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  /**
   * Normalize a key into its at-rest form and index it: derive tokenHash (and a
   * UI hint) from a raw token when present — migrating legacy records — strip
   * the raw token so it is never retained, and (re)index by hash for lookup.
   * Returns the stored, hash-only record (safe to persist).
   */
  private register(input: VirtualKey): VirtualKey {
    const parsed = VirtualKeySchema.parse(input);
    const tokenHash = parsed.tokenHash ??
      (parsed.token ? hashVirtualKeyToken(parsed.token) : undefined);
    if (!tokenHash) {
      // Unreachable: the schema refine guarantees token||tokenHash. Guard anyway.
      throw new Error(`virtual key "${parsed.id}" has no token or tokenHash`);
    }
    const tokenHint = parsed.tokenHint ??
      (parsed.token ? tokenHintFor(parsed.token) : undefined);
    const { token: _rawToken, ...rest } = parsed;
    const record: VirtualKey = { ...rest, tokenHash, tokenHint };
    // Drop any stale hash index entry for this id before re-indexing.
    const previous = this.keys.get(parsed.id);
    if (previous?.tokenHash) {
      this.byHash.delete(previous.tokenHash);
    }
    this.keys.set(parsed.id, record);
    this.byHash.set(tokenHash, parsed.id);
    return record;
  }

  /** Upserts a key, returning the stored hash-only record (safe to persist). */
  /** Hands rate and token windows to a shared authority (see SharedRateLimiter). */
  useExternalRateLimit(external: boolean): void {
    this.externalRateLimit = external;
  }

  /** Whether rate and token windows are enforced outside this process. */
  hasExternalRateLimit(): boolean {
    return this.externalRateLimit;
  }

  upsert(key: VirtualKey): VirtualKey {
    return this.register(key);
  }

  remove(id: string): boolean {
    const key = this.keys.get(id);
    if (key?.tokenHash) {
      this.byHash.delete(key.tokenHash);
    }
    return this.keys.delete(id);
  }

  get(id: string): VirtualKey | undefined {
    return this.keys.get(id);
  }

  list(): VirtualKey[] {
    return [...this.keys.values()];
  }

  /**
   * Governance is active once any key exists — including disabled ones, so
   * disabling the last key locks inference down instead of opening it up.
   */
  active(): boolean {
    return this.keys.size > 0;
  }

  findByToken(token: string): VirtualKey | undefined {
    // Hash + Map lookup: O(1) and constant-time in the presented token (an
    // attacker cannot probe it byte-by-byte via the old `===` short-circuit).
    const id = this.byHash.get(hashVirtualKeyToken(token));
    return id ? this.keys.get(id) : undefined;
  }

  /**
   * Full admission decision: auth, enablement, budgets (requests + cost),
   * request rate limit, token-window limit. `estimatedTokens` is the
   * request-side estimate; the response reconciles actuals afterwards.
   */
  check(token: string | null, estimatedTokens = 0): KeyDecision {
    if (!token) {
      return {
        ok: false,
        status: 401,
        message: "Missing virtual key. Send Authorization: Bearer <key>.",
        code: "missing_virtual_key",
      };
    }
    const key = this.findByToken(token);
    if (!key || !key.enabled) {
      return {
        ok: false,
        status: 401,
        message: "Unknown or disabled virtual key.",
        code: "invalid_virtual_key",
      };
    }
    if (
      key.budget?.resetIntervalMs === undefined &&
      key.budget?.maxRequests !== undefined &&
      key.usedRequests >= key.budget.maxRequests
    ) {
      return {
        ok: false,
        status: 402,
        message: `Virtual key "${key.name}" has exhausted its request budget.`,
        code: "budget_exhausted",
      };
    }
    if (
      key.budget?.resetIntervalMs === undefined &&
      key.budget?.maxCostUsd !== undefined &&
      key.usedCostMicroUsd >= Math.round(key.budget.maxCostUsd * 1_000_000)
    ) {
      return {
        ok: false,
        status: 402,
        message: `Virtual key "${key.name}" has exhausted its cost budget.`,
        code: "cost_budget_exhausted",
      };
    }
    if (
      !this.externalRateLimit && key.rateLimit &&
      !this.limiter.check(key.id, key.rateLimit)
    ) {
      return {
        ok: false,
        status: 429,
        message: `Virtual key "${key.name}" is rate limited.`,
        code: "rate_limited",
        retryAfterMs: this.limiter.retryAfterMs(key.id),
      };
    }
    if (
      !this.externalRateLimit &&
      key.tokenLimit &&
      !this.limiter.consume(
        `tokens:${key.id}`,
        key.tokenLimit.maxTokens,
        key.tokenLimit.windowMs,
        Math.max(1, estimatedTokens),
      )
    ) {
      return {
        ok: false,
        status: 429,
        message: `Virtual key "${key.name}" exceeded its token limit.`,
        code: "token_limited",
        retryAfterMs: this.limiter.retryAfterMs(`tokens:${key.id}`),
      };
    }
    return { ok: true, key };
  }

  /**
   * Request-count accounting. The admission path uses a reserve→commit/release
   * protocol so the read-in-`check` and this increment happen in one synchronous
   * tick (no `await` between), which closes the concurrent over-admission race:
   *
   *   recordUsage(id, false)  // reserve: in-memory increment, NOT yet persisted
   *   ... await downstream admission gates ...
   *   persistUsage(id)        // commit: durable write, once fully admitted
   *   releaseRequest(id)      // rollback: undo the reserve if a later gate denies
   *
   * `persist = true` keeps the legacy one-shot behavior (increment + persist).
   */
  recordUsage(id: string, persist = true): void {
    const key = this.keys.get(id);
    if (key) {
      key.usedRequests += 1;
      if (persist) {
        this.usageSink?.(id);
      }
    }
  }

  /** Rollback of a reserved (not-yet-persisted) request increment. */
  releaseRequest(id: string): void {
    const key = this.keys.get(id);
    if (key && key.usedRequests > 0) {
      key.usedRequests -= 1;
    }
  }

  /** Commit a reserved request increment to the persistence sink. */
  persistUsage(id: string): void {
    if (this.keys.has(id)) {
      this.usageSink?.(id);
    }
  }

  /** Post-response accounting: dollar cost (micro-USD) for the request. */
  recordCost(id: string, microUsd: number, persist = true): void {
    const key = this.keys.get(id);
    if (key && microUsd > 0) {
      // Nullish guard: a legacy record without the field must accrue from
      // zero, never NaN (NaN would disable the budget check forever).
      key.usedCostMicroUsd = (key.usedCostMicroUsd ?? 0) + microUsd;
      if (persist) {
        this.costSink?.(id, microUsd);
      }
    }
  }

  /** Post-response token reconciliation: actuals beyond the admission estimate. */
  recordTokens(id: string, tokens: number): void {
    const key = this.keys.get(id);
    if (key?.tokenLimit && tokens > 0) {
      this.limiter.consume(
        `tokens:${id}`,
        Infinity,
        key.tokenLimit.windowMs,
        tokens,
      );
    }
  }

  retryAfterMs(id: string): number {
    return Math.max(
      this.limiter.retryAfterMs(id),
      this.limiter.retryAfterMs(`tokens:${id}`),
    );
  }

  /**
   * Durable-budget wiring: replays persisted usage/cost counters over the
   * loaded keys (boot) and registers the per-request persistence hooks.
   * Counters win over the snapshot stored inside the key record.
   */
  hydrateUsage(usage: Record<string, number>): void {
    for (const [id, count] of Object.entries(usage)) {
      const key = this.keys.get(id);
      if (key) {
        key.usedRequests = count;
      }
    }
  }

  hydrateCost(costs: Record<string, number>): void {
    for (const [id, micro] of Object.entries(costs)) {
      const key = this.keys.get(id);
      if (key) {
        key.usedCostMicroUsd = micro;
      }
    }
  }

  onUsage(sink: (id: string) => void): void {
    this.usageSink = sink;
  }

  onCost(sink: (id: string, microUsd: number) => void): void {
    this.costSink = sink;
  }
}
