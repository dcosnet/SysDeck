import type {
  ProviderAccountConfig,
  ResetPeriod,
} from "../../contracts/src/config.ts";

/** The three metered dimensions, each with its own limit + reset period. */
export type ProviderBudgetDimension = "requests" | "tokens" | "cost";

export type ProviderBudgetDecision =
  | { ok: true }
  | {
    ok: false;
    dimension: ProviderBudgetDimension;
    code: string;
    message: string;
    /** Milliseconds until the offending window resets (Retry-After feed). */
    retryAfterMs: number;
  };

const PERIOD_MS: Record<ResetPeriod, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000, // 30-day month, matching the reference's coarse windows
};

/** A reset period bounds a fixed window; an omitted period = lifetime cap. */
function windowMsFor(period: ResetPeriod | undefined): number {
  return period === undefined ? Infinity : PERIOD_MS[period];
}

interface Counter {
  count: number;
  windowStart: number;
}

export interface ProviderBudgetTrackerOptions {
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
}

export class ProviderBudgetTracker {
  // Keyed `${accountId}::${dimension}`. Only configured dimensions allocate a
  // counter, so unlimited accounts never grow the map.
  private counters = new Map<string, Counter>();
  private now: () => number;
  private sink?: (
    dimension: ProviderBudgetDimension,
    id: string,
    amount: number,
  ) => void;
  private anchorSink?: (
    dimension: ProviderBudgetDimension,
    id: string,
    windowStart: number,
  ) => void;

  constructor(opts: ProviderBudgetTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private static key(id: string, dim: ProviderBudgetDimension): string {
    return `${id}::${dim}`;
  }

  private static periodFor(
    config: ProviderAccountConfig,
    dim: ProviderBudgetDimension,
  ): ResetPeriod | undefined {
    const gov = config.governance;
    switch (dim) {
      case "requests":
        return gov?.requestsResetPeriod;
      case "tokens":
        return gov?.tokensResetPeriod;
      case "cost":
        return gov?.budgetResetPeriod;
    }
  }

  /** Micro-USD is the internal cost unit (integer), matching virtual keys. */
  private static limitFor(
    config: ProviderAccountConfig,
    dim: ProviderBudgetDimension,
  ): number | undefined {
    const gov = config.governance;
    switch (dim) {
      case "requests":
        return gov?.maxRequests;
      case "tokens":
        return gov?.maxTokens;
      case "cost":
        return gov?.budgetUsd === undefined
          ? undefined
          : Math.round(gov.budgetUsd * 1_000_000);
    }
  }

  /** Current windowed count, lazily resetting an elapsed window to zero. */
  private current(
    config: ProviderAccountConfig,
    dim: ProviderBudgetDimension,
  ): number {
    const rec = this.counters.get(ProviderBudgetTracker.key(config.id, dim));
    if (!rec) {
      return 0;
    }
    const windowMs = windowMsFor(ProviderBudgetTracker.periodFor(config, dim));
    if (this.now() - rec.windowStart >= windowMs) {
      return 0; // window elapsed — treated as fresh (reset on next bump)
    }
    return rec.count;
  }

  private bump(
    config: ProviderAccountConfig,
    dim: ProviderBudgetDimension,
    amount: number,
  ): void {
    if (amount <= 0) {
      return;
    }
    const key = ProviderBudgetTracker.key(config.id, dim);
    const rec = this.counters.get(key);
    const windowMs = windowMsFor(ProviderBudgetTracker.periodFor(config, dim));
    if (!rec || this.now() - rec.windowStart >= windowMs) {
      const windowStart = this.now();
      this.counters.set(key, { count: amount, windowStart });
      // Persist the anchor so a restart mid-window does NOT re-anchor the reset
      // boundary to boot time (which would keep an exhausted budget locked out
      // for a full extra period on every deploy).
      this.anchorSink?.(dim, config.id, windowStart);
    } else {
      rec.count += amount;
    }
    this.sink?.(dim, config.id, amount);
  }

  private deny(
    config: ProviderAccountConfig,
    dim: ProviderBudgetDimension,
    code: string,
    message: string,
  ): ProviderBudgetDecision {
    const rec = this.counters.get(ProviderBudgetTracker.key(config.id, dim));
    const windowMs = windowMsFor(ProviderBudgetTracker.periodFor(config, dim));
    const retryAfterMs = rec && Number.isFinite(windowMs)
      ? Math.max(0, rec.windowStart + windowMs - this.now())
      : 0;
    return { ok: false, dimension: dim, code, message, retryAfterMs };
  }

  /**
   * Read-only admission check for an account's per-provider budgets. Returns
   * ok when the account has no governance group or is within every configured
   * limit; otherwise the first exceeded dimension. Never mutates state, so the
   * manager can call it freely during selection and failover enumeration.
   */
  check(config: ProviderAccountConfig): ProviderBudgetDecision {
    const gov = config.governance;
    if (!gov) {
      return { ok: true };
    }
    if (
      gov.maxRequests !== undefined &&
      this.current(config, "requests") >= gov.maxRequests
    ) {
      return this.deny(
        config,
        "requests",
        "provider_request_limit",
        `Provider "${config.id}" has reached its request limit.`,
      );
    }
    if (
      gov.maxTokens !== undefined &&
      this.current(config, "tokens") >= gov.maxTokens
    ) {
      return this.deny(
        config,
        "tokens",
        "provider_token_limit",
        `Provider "${config.id}" has reached its token limit.`,
      );
    }
    const costLimit = ProviderBudgetTracker.limitFor(config, "cost");
    if (costLimit !== undefined && this.current(config, "cost") >= costLimit) {
      return this.deny(
        config,
        "cost",
        "provider_budget_exhausted",
        `Provider "${config.id}" has exhausted its cost budget.`,
      );
    }
    return { ok: true };
  }

  /** Convenience predicate for the manager's selection filter. */
  allows(config: ProviderAccountConfig): boolean {
    return this.check(config).ok;
  }

  /** One dispatched request against the account (dispatch-path accounting). */
  recordRequest(config: ProviderAccountConfig): void {
    if (config.governance?.maxRequests === undefined) {
      return;
    }
    this.bump(config, "requests", 1);
  }

  /** Post-response token accounting (billing-path). */
  recordTokens(config: ProviderAccountConfig, tokens: number): void {
    if (config.governance?.maxTokens === undefined) {
      return;
    }
    this.bump(config, "tokens", tokens);
  }

  /** Post-response micro-USD cost accounting (billing-path). */
  recordCost(config: ProviderAccountConfig, microUsd: number): void {
    if (config.governance?.budgetUsd === undefined) {
      return;
    }
    this.bump(config, "cost", microUsd);
  }

  /**
   * Durable-counter wiring (optional, mirrors VirtualKeyManager). Register a
   * sink to persist each increment; seed counts at boot via hydrate(). Without
   * a sink the tracker is in-memory only and still enforces within a process
   * lifetime.
   */
  onRecord(
    sink: (
      dimension: ProviderBudgetDimension,
      id: string,
      amount: number,
    ) => void,
  ): void {
    this.sink = sink;
  }

  /** Register a sink to persist each window's start timestamp (see hydrate). */
  onAnchor(
    sink: (
      dimension: ProviderBudgetDimension,
      id: string,
      windowStart: number,
    ) => void,
  ): void {
    this.anchorSink = sink;
  }

  /**
   * Replays persisted counts for one dimension. `anchors` supplies the persisted
   * window-start per id so the reset boundary survives a restart; an id without
   * a persisted anchor falls back to boot time. A window that has already
   * elapsed against its restored anchor resets on next access (current/bump),
   * so this both keeps an exhausted budget closed within its period AND lets it
   * reset on schedule regardless of restart timing.
   */
  hydrate(
    dimension: ProviderBudgetDimension,
    counts: Record<string, number>,
    anchors: Record<string, number> = {},
  ): void {
    const bootStart = this.now();
    for (const [id, count] of Object.entries(counts)) {
      if (count > 0) {
        this.counters.set(ProviderBudgetTracker.key(id, dimension), {
          count,
          windowStart: anchors[id] ?? bootStart,
        });
      }
    }
  }
}
