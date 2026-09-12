import type { StateKey, StateStore } from "../../config/src/store.ts";
import type { TenantIdentity } from "./usage.ts";

const USAGE_PREFIX: StateKey = ["usage-records"];

export interface UsageRecord extends TenantIdentity {
  ts: string;
  requestId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number | null;
  durationMs: number;
  status: number;
  stream: boolean;
  cacheHit: boolean;
}

export type AnalyticsWindow = "1h" | "24h" | "7d";

export interface AnalyticsTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  costUsd: number;
  errorRatePct: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface AnalyticsBucket {
  label: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  errors: number;
}

export interface AnalyticsByModel {
  model: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface AnalyticsByProvider {
  provider: string;
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
}

/** Per-virtual-key rollup. Bounded: only records that a virtual key resolved
 * contribute, and those ids come from the governance store (operator-created,
 * not client-arbitrary), so the row count is bounded like byProvider. */
export interface AnalyticsByVirtualKey {
  virtualKeyId: string;
  virtualKeyName?: string;
  teamId?: string;
  customerId?: string;
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface AnalyticsReport {
  tracked: boolean;
  window: AnalyticsWindow;
  generatedAt: string;
  totals: AnalyticsTotals;
  series: AnalyticsBucket[];
  byModel: AnalyticsByModel[];
  byProvider: AnalyticsByProvider[];
  /** Per-tenant token/cost attribution; empty when no keyed traffic occurred. */
  byVirtualKey: AnalyticsByVirtualKey[];
}

const WINDOW_MS: Record<AnalyticsWindow, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

const BUCKETS = 12;

export class UsageTracker {
  private ring: UsageRecord[] = [];
  private appends = 0;
  private counter = 0;

  constructor(
    private store?: StateStore,
    private cap = 5000,
    private pruneEvery = 200,
  ) {}

  /**
   * Hot-path safe: synchronous in-memory append plus a fire-and-forget durable
   * write. Never blocks or throws into the caller.
   */
  record(entry: UsageRecord): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) {
      this.ring.splice(0, this.ring.length - this.cap);
    }
    if (this.store) {
      this.persist(entry).catch(() => {
        // The durable trail must never block or fail a request.
      });
    }
  }

  private async persist(entry: UsageRecord): Promise<void> {
    // Zero-padded ms timestamp + monotonic suffix = time-ordered keys.
    const key = [
      ...USAGE_PREFIX,
      `${Date.now().toString().padStart(15, "0")}-${
        (this.counter++).toString(36).padStart(6, "0")
      }`,
    ];
    await this.store!.set(key, entry);
    if (++this.appends % this.pruneEvery === 0) {
      await this.prune();
    }
  }

  /** Deletes the oldest durable entries beyond the cap. */
  private async prune(): Promise<number> {
    const keys = await this.store!.keys(USAGE_PREFIX);
    const excess = keys.length - this.cap;
    for (let i = 0; i < excess; i++) {
      await this.store!.delete(keys[i]);
    }
    return Math.max(0, excess);
  }

  /** In-memory record count (always available, ignores the durable store). */
  count(): number {
    return this.ring.length;
  }

  private async source(): Promise<UsageRecord[]> {
    if (this.store) {
      const rows = await this.store.list<UsageRecord>(USAGE_PREFIX);
      return rows.map((row) => row.value);
    }
    return this.ring;
  }

  /** Clears both the ring and (when present) the durable store. */
  async clear(): Promise<number> {
    const cleared = this.ring.length;
    this.ring = [];
    if (this.store) {
      const keys = await this.store.keys(USAGE_PREFIX);
      for (const key of keys) {
        await this.store.delete(key);
      }
      return keys.length;
    }
    return cleared;
  }

  /**
   * Windowed rollup shaped to the /api/analytics contract. Buckets by ts across
   * the window into a fixed 12 buckets, falling back to arrival order when a ts
   * cannot be parsed. `now` is injectable for deterministic tests.
   */
  async rollup(
    opts: { window?: AnalyticsWindow; now?: number } = {},
  ): Promise<AnalyticsReport> {
    const window = opts.window ?? "24h";
    const now = opts.now ?? Date.now();
    const windowMs = WINDOW_MS[window];
    const windowStart = now - windowMs;
    const bucketMs = windowMs / BUCKETS;
    const records = await this.source();

    const series: AnalyticsBucket[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      series.push({
        label: String(i + 1),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costMicroUsd: 0,
        errors: 0,
      });
    }

    const totals: AnalyticsTotals = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costMicroUsd: 0,
      costUsd: 0,
      errorRatePct: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
    const byModel = new Map<string, AnalyticsByModel>();
    const byProvider = new Map<string, AnalyticsByProvider>();
    const byVirtualKey = new Map<string, AnalyticsByVirtualKey>();
    let errors = 0;

    records.forEach((r, index) => {
      const tsMs = Date.parse(r.ts);
      let bucket: number;
      if (Number.isFinite(tsMs)) {
        if (tsMs < windowStart || tsMs > now) {
          return; // outside the window
        }
        bucket = Math.min(
          BUCKETS - 1,
          Math.max(0, Math.floor((tsMs - windowStart) / bucketMs)),
        );
      } else {
        // Unparseable ts: distribute by arrival order across the buckets.
        bucket = Math.min(
          BUCKETS - 1,
          Math.floor((index / Math.max(1, records.length)) * BUCKETS),
        );
      }

      const cost = r.costMicroUsd ?? 0;
      const isError = r.status >= 400;

      totals.requests += 1;
      totals.promptTokens += r.promptTokens;
      totals.completionTokens += r.completionTokens;
      totals.totalTokens += r.totalTokens;
      totals.costMicroUsd += cost;
      if (r.cacheHit) {
        totals.cacheHits += 1;
      } else {
        totals.cacheMisses += 1;
      }
      if (isError) {
        errors += 1;
      }

      const s = series[bucket];
      s.requests += 1;
      s.promptTokens += r.promptTokens;
      s.completionTokens += r.completionTokens;
      s.totalTokens += r.totalTokens;
      s.costMicroUsd += cost;
      if (isError) {
        s.errors += 1;
      }

      const mkey = JSON.stringify([r.model, r.provider]);
      const m = byModel.get(mkey) ?? {
        model: r.model,
        provider: r.provider,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costMicroUsd: 0,
      };
      m.requests += 1;
      m.promptTokens += r.promptTokens;
      m.completionTokens += r.completionTokens;
      m.totalTokens += r.totalTokens;
      m.costMicroUsd += cost;
      byModel.set(mkey, m);

      const p = byProvider.get(r.provider) ?? {
        provider: r.provider,
        requests: 0,
        totalTokens: 0,
        costMicroUsd: 0,
      };
      p.requests += 1;
      p.totalTokens += r.totalTokens;
      p.costMicroUsd += cost;
      byProvider.set(r.provider, p);

      // Only tenant-attributed records join the per-virtual-key rollup.
      if (r.virtualKeyId) {
        const v = byVirtualKey.get(r.virtualKeyId) ?? {
          virtualKeyId: r.virtualKeyId,
          virtualKeyName: r.virtualKeyName,
          teamId: r.teamId,
          customerId: r.customerId,
          requests: 0,
          totalTokens: 0,
          costMicroUsd: 0,
        };
        v.requests += 1;
        v.totalTokens += r.totalTokens;
        v.costMicroUsd += cost;
        byVirtualKey.set(r.virtualKeyId, v);
      }
    });

    totals.costUsd = totals.costMicroUsd / 1e6;
    totals.errorRatePct = totals.requests > 0
      ? Math.round((errors / totals.requests) * 10_000) / 100
      : 0;

    return {
      tracked: records.length > 0,
      window,
      generatedAt: new Date().toISOString(),
      totals,
      series,
      byModel: [...byModel.values()].sort((a, b) =>
        b.totalTokens - a.totalTokens
      ),
      byProvider: [...byProvider.values()].sort((a, b) =>
        b.totalTokens - a.totalTokens
      ),
      byVirtualKey: [...byVirtualKey.values()].sort((a, b) =>
        b.totalTokens - a.totalTokens
      ),
    };
  }
}
