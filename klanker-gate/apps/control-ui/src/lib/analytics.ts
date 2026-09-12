import type { AnalyticsModelRow, AnalyticsRollup, LogEntry } from "../api";
import type { ChartSeries, LegendItem } from "../components/ui/chart";
import { getEurRate } from "./currency";

/** Nearest-rank percentile over an ascending-sorted numeric sample. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

export interface LatencySummary {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  count: number;
}

/** p50/p90/p95/p99 of the durationMs field across the given entries. */
export function latencySummary(entries: LogEntry[]): LatencySummary {
  const durations = entries
    .map((entry) => entry.durationMs)
    .filter((d): d is number => typeof d === "number" && d >= 0)
    .sort((a, b) => a - b);
  return {
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    count: durations.length,
  };
}

export interface RequestSummary {
  /** Log lines that carry a numeric status (real requests). */
  total: number;
  errors: number;
  success: number;
  errorRatePct: number;
}

/** Counts of requests, errors (status >= 400), and the error rate percent. */
export function requestSummary(entries: LogEntry[]): RequestSummary {
  const requests = entries.filter((entry) => typeof entry.status === "number");
  const errors = requests.filter((entry) => (entry.status ?? 0) >= 400);
  const total = requests.length;
  return {
    total,
    errors: errors.length,
    success: total - errors.length,
    errorRatePct: total === 0 ? 0 : (errors.length / total) * 100,
  };
}

export interface SeriesBucket {
  /** 1-based bucket ordinal, rendered on the x axis. */
  label: string;
  total: number;
  success: number;
  errors: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * Split entries into `bucketCount` ordered buckets and summarize each.
 * Buckets span the observed time range when every `ts` parses to a distinct
 * instant; otherwise entries fall back to even chunks by arrival order, so the
 * chart stays deterministic even when timestamps are opaque.
 */
export function buildSeries(
  entries: LogEntry[],
  bucketCount = 12,
): SeriesBucket[] {
  if (entries.length === 0 || bucketCount <= 0) {
    return [];
  }
  const parsed = entries.map((entry) => Date.parse(entry.ts));
  const valid = parsed.filter((t) => !Number.isNaN(t));
  const min = valid.length > 0 ? Math.min(...valid) : 0;
  const max = valid.length > 0 ? Math.max(...valid) : 0;
  const useTime = valid.length === entries.length && max > min;

  const buckets: LogEntry[][] = Array.from({ length: bucketCount }, () => []);
  for (let i = 0; i < entries.length; i++) {
    let index: number;
    if (useTime) {
      const frac = (parsed[i] - min) / (max - min);
      index = Math.min(bucketCount - 1, Math.floor(frac * bucketCount));
    } else {
      index = Math.min(
        bucketCount - 1,
        Math.floor((i / entries.length) * bucketCount),
      );
    }
    buckets[index].push(entries[i]);
  }

  return buckets.map((group, i) => {
    const requests = requestSummary(group);
    const latency = latencySummary(group);
    return {
      label: String(i + 1),
      total: group.length,
      success: requests.success,
      errors: requests.errors,
      p50: latency.p50,
      p90: latency.p90,
      p95: latency.p95,
      p99: latency.p99,
    };
  });
}

/** Keep only entries whose `ts` falls within the last `windowMs`. */
export function withinWindow(
  entries: LogEntry[],
  windowMs: number,
  now = Date.now(),
): LogEntry[] {
  if (windowMs <= 0) {
    return entries;
  }
  const cutoff = now - windowMs;
  return entries.filter((entry) => {
    const t = Date.parse(entry.ts);
    // Unparseable timestamps are kept: never drop data we cannot place.
    return Number.isNaN(t) || t >= cutoff;
  });
}

/* --------------------- server rollup -> chart series -------------------- */
// These shape an AnalyticsRollup (from GET /api/analytics) into the same
// dependency-free ChartSeries the log-derived cards use. Colors are the
// literal --chart-1..5 family; every function is pure over its input.

/** Token Usage: prompt vs completion tokens across the rollup buckets. */
export function tokenUsageSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Prompt",
      color: "1",
      values: rollup.series.map((bucket) => bucket.promptTokens),
    },
    {
      name: "Completion",
      color: "2",
      values: rollup.series.map((bucket) => bucket.completionTokens),
    },
  ];
}

/** Cost: micro-USD per bucket converted to euros (color chart-3). */
export function costSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Cost",
      color: "3",
      values: rollup.series.map((bucket) =>
        (bucket.costMicroUsd / 1_000_000) * getEurRate()
      ),
    },
  ];
}

/** Models sorted by total tokens (descending), capped at `limit`. */
export function topModels(
  rollup: AnalyticsRollup,
  limit = 6,
): AnalyticsModelRow[] {
  return [...rollup.byModel]
    .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0))
    .slice(0, Math.max(0, limit));
}

/**
 * Model Usage: the top models by total tokens as one bar series. Every bar
 * shares chart-1 (one measure, tokens), so the legend below names each model
 * in the same hue rather than implying distinct series.
 */
export function modelUsageSeries(
  rollup: AnalyticsRollup,
  limit = 6,
): ChartSeries[] {
  return [
    {
      name: "Total tokens",
      color: "1",
      values: topModels(rollup, limit).map((row) => row.totalTokens),
    },
  ];
}

/** Model names behind the single Model Usage series, in bar order. */
export function modelUsageLegend(
  rollup: AnalyticsRollup,
  limit = 6,
): LegendItem[] {
  return topModels(rollup, limit).map((row) => ({
    name: row.model,
    color: "1",
  }));
}
