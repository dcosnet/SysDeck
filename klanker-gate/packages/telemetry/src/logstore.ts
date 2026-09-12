import type { StateKey, StateStore } from "../../config/src/store.ts";
import { type LogEntry, statusClass } from "./logbus.ts";

const LOGS_PREFIX: StateKey = ["logs"];
/** Cap on distinct facet values returned by {@link LogStore.filterData}. */
const MAX_FACET_VALUES = 200;
/**
 * Cap on the in-memory requestId -> key index used by {@link LogStore.update}.
 * Only requests still awaiting a late enrichment patch need to be resolvable,
 * which is a small, short-lived set; the index is a latency optimization and
 * {@link LogStore.update} falls back to a bounded reverse scan on a miss.
 */
const MAX_KEY_INDEX = 1000;
/** Newest rows scanned when the key index misses. */
const UPDATE_SCAN_LIMIT = 500;

export interface LogQuery {
  q?: string;
  status?: number;
  limit?: number;
  offset?: number;
}

/** Aggregate counters over the (optionally filtered) durable log trail. */
export interface LogStats {
  /** Entries matched by the filter. */
  total: number;
  /** Count keyed by status class ("2xx", "4xx", "unknown", ...). */
  byStatusClass: Record<string, number>;
  /** Completed requests that succeeded (status < 400, not an error entry). */
  successCount: number;
  /** Completed requests that failed (error level or status >= 400). */
  errorCount: number;
  /** Success percentage over completed requests (0..100); 0 when none. */
  successRate: number;
  /** Mean duration over entries that recorded one, in ms. */
  avgLatencyMs: number;
  /** Token totals where recorded (0 when no entry carries usage). */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost total in integer micro-USD, plus its float-USD edge value. */
  costMicroUsd: number;
  costUsd: number;
}

/** Distinct filter facet values available across the durable log trail. */
export interface LogFilterData {
  /** Distinct HTTP status codes present. */
  statuses: number[];
  /** Distinct status classes present ("2xx", "5xx", ...). */
  statusClasses: string[];
  /** Distinct HTTP methods present. */
  methods: string[];
  /** Distinct request paths present (bounded). */
  paths: string[];
  /** Distinct models present — empty until a producer records the model. */
  models: string[];
  /** Distinct providers present — empty until a producer records the provider. */
  providers: string[];
}

/** Summary of a cost backfill pass. */
export interface RecalculateCostResult {
  /** Entries whose stored cost was (re)written. */
  recalculated: number;
  /** Entries examined. */
  scanned: number;
  /** Entries left unchanged (no derivable cost, or cost already current). */
  skipped: number;
}

export class LogStore {
  private appends = 0;
  private counter = 0;
  /** Entries evicted by cap-pruning over this store's lifetime. */
  private droppedCount = 0;
  /** Insertion-ordered requestId -> KV key, bounded by MAX_KEY_INDEX. */
  private keyByRequestId = new Map<string, StateKey>();

  constructor(
    private store: StateStore,
    private maxEntries = 5000,
    private pruneEvery = 200,
  ) {}

  async append(entry: LogEntry): Promise<void> {
    // Zero-padded ms timestamp + monotonic suffix = time-ordered keys.
    const key = [
      ...LOGS_PREFIX,
      `${Date.now().toString().padStart(15, "0")}-${
        (this.counter++).toString(36).padStart(6, "0")
      }`,
    ];
    await this.store.set(key, entry);
    if (entry.requestId) {
      this.keyByRequestId.set(entry.requestId, key);
      while (this.keyByRequestId.size > MAX_KEY_INDEX) {
        const oldest = this.keyByRequestId.keys().next();
        if (oldest.done) {
          break;
        }
        this.keyByRequestId.delete(oldest.value);
      }
    }
    if (++this.appends % this.pruneEvery === 0) {
      await this.prune();
    }
  }

  /**
   * Merges `patch` into the stored entry carrying `requestId`, returning the
   * merged entry (or undefined when no such entry is stored).
   *
   * Exists for streamed responses: their token/cost figures only resolve when
   * the SSE tap flushes, which is after the request logger has already appended
   * the row. The entry keeps its original key, so time ordering and the
   * write-time cap are unaffected - this rewrites one row, it never appends.
   */
  async update(
    requestId: string,
    patch: Partial<LogEntry>,
  ): Promise<LogEntry | undefined> {
    const indexed = this.keyByRequestId.get(requestId);
    if (indexed) {
      const current = await this.store.get<LogEntry>(indexed);
      if (current) {
        const merged = { ...current, ...patch };
        await this.store.set(indexed, merged);
        return merged;
      }
      // Pruned out from under us; drop the stale index entry and fall through.
      this.keyByRequestId.delete(requestId);
    }
    const rows = await this.store.list<LogEntry>(LOGS_PREFIX, {
      reverse: true,
    });
    for (const { key, value } of rows.slice(0, UPDATE_SCAN_LIMIT)) {
      if (value.requestId !== requestId) {
        continue;
      }
      const merged = { ...value, ...patch };
      await this.store.set(key, merged);
      return merged;
    }
    return undefined;
  }

  /** Deletes the oldest entries beyond the cap, counting them as dropped. */
  async prune(): Promise<number> {
    const keys = await this.store.keys(LOGS_PREFIX);
    const excess = keys.length - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      await this.store.delete(keys[i]);
    }
    const dropped = Math.max(0, excess);
    this.droppedCount += dropped;
    return dropped;
  }

  /** Entries the store had to drop (cap-prune evictions) over its lifetime. */
  dropped(): number {
    return this.droppedCount;
  }

  /** True when `entry` passes the substring (method/path) + status filter. */
  private matches(
    entry: LogEntry,
    q: string | undefined,
    status?: number,
  ): boolean {
    if (status !== undefined && entry.status !== status) {
      return false;
    }
    if (q) {
      const haystack = `${entry.method} ${entry.path}`.toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  }

  /** Newest-first query with substring (path/method) and status filters. */
  async query(options: LogQuery = {}): Promise<{
    entries: LogEntry[];
    total: number;
  }> {
    const rows = await this.store.list<LogEntry>(LOGS_PREFIX, {
      reverse: true,
    });
    const q = options.q?.toLowerCase();
    const filtered = rows
      .map((r) => r.value)
      .filter((entry) => this.matches(entry, q, options.status));
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return {
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  /** Aggregate stats over the (optionally filtered) trail. */
  async stats(options: LogQuery = {}): Promise<LogStats> {
    const rows = await this.store.list<LogEntry>(LOGS_PREFIX);
    const q = options.q?.toLowerCase();
    const byStatusClass: Record<string, number> = {};
    let total = 0;
    let successCount = 0;
    let errorCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let costMicroUsd = 0;

    for (const { value: entry } of rows) {
      if (!this.matches(entry, q, options.status)) {
        continue;
      }
      total++;

      const cls = statusClass(entry.status);
      byStatusClass[cls] = (byStatusClass[cls] ?? 0) + 1;

      const isError = entry.level === "error" ||
        (entry.status !== undefined && entry.status >= 400);
      if (isError) {
        errorCount++;
      } else if (entry.status !== undefined && entry.status < 400) {
        successCount++;
      }

      if (entry.durationMs !== undefined) {
        latencySum += entry.durationMs;
        latencyCount++;
      }

      promptTokens += entry.promptTokens ?? 0;
      completionTokens += entry.completionTokens ?? 0;
      totalTokens += entry.totalTokens ??
        ((entry.promptTokens ?? 0) + (entry.completionTokens ?? 0));
      costMicroUsd += entry.costMicroUsd ?? 0;
    }

    const completed = successCount + errorCount;
    return {
      total,
      byStatusClass,
      successCount,
      errorCount,
      successRate: completed > 0 ? (successCount / completed) * 100 : 0,
      avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
      promptTokens,
      completionTokens,
      totalTokens,
      costMicroUsd,
      costUsd: costMicroUsd / 1_000_000,
    };
  }

  /** Distinct facet values available for building log filters. */
  async filterData(): Promise<LogFilterData> {
    const rows = await this.store.list<LogEntry>(LOGS_PREFIX);
    const statuses = new Set<number>();
    const statusClasses = new Set<string>();
    const methods = new Set<string>();
    const paths = new Set<string>();
    const models = new Set<string>();
    const providers = new Set<string>();

    for (const { value: entry } of rows) {
      if (entry.status !== undefined) {
        statuses.add(entry.status);
        statusClasses.add(statusClass(entry.status));
      }
      if (entry.method) methods.add(entry.method);
      if (entry.path) paths.add(entry.path);
      if (entry.model) models.add(entry.model);
      if (entry.provider) providers.add(entry.provider);
    }

    return {
      statuses: [...statuses].sort((a, b) => a - b),
      statusClasses: [...statusClasses].sort(),
      methods: [...methods].sort(),
      paths: [...paths].sort().slice(0, MAX_FACET_VALUES),
      models: [...models].sort().slice(0, MAX_FACET_VALUES),
      providers: [...providers].sort().slice(0, MAX_FACET_VALUES),
    };
  }

  /**
   * Re-derives per-entry cost from a costing function (typically the pricing
   * catalog + the entry's token counts) and rewrites entries whose stored cost
   * is missing or stale. `coster` returns integer micro-USD, or null when no
   * cost is derivable (unpriced model / no tokens) so the entry is left as-is.
   */
  async recalculateCost(
    coster: (entry: LogEntry) => number | null,
  ): Promise<RecalculateCostResult> {
    const rows = await this.store.list<LogEntry>(LOGS_PREFIX);
    let recalculated = 0;
    for (const { key, value } of rows) {
      const cost = coster(value);
      if (cost === null || cost === value.costMicroUsd) {
        continue; // no derivable cost, or already current
      }
      await this.store.set(key, { ...value, costMicroUsd: cost });
      recalculated++;
    }
    return {
      recalculated,
      scanned: rows.length,
      skipped: rows.length - recalculated,
    };
  }

  async clear(): Promise<number> {
    const keys = await this.store.keys(LOGS_PREFIX);
    for (const key of keys) {
      await this.store.delete(key);
    }
    this.keyByRequestId.clear();
    return keys.length;
  }
}
