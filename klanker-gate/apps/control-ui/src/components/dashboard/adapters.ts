import type {
  AnalyticsBucket,
  AnalyticsModelRow,
  AnalyticsProviderRow,
  AnalyticsRollup,
  LogEntry,
} from "../../api";
import type { ChartSeries, LegendItem } from "../ui/chart";
import type { ComboboxOption } from "../ui/combobox";
import type { CsvColumn } from "../../lib/csv";
import { percentile } from "../../lib/analytics";
import { getEurRate } from "../../lib/currency";

const MICRO = 1_000_000;

/* ----------------------------- overview trends ------------------------- */

/** Request Volume: success (requests - errors) vs error count per bucket. */
export function requestVolumeSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Success",
      color: "2",
      values: rollup.series.map((b) => Math.max(0, b.requests - b.errors)),
    },
    { name: "Error", color: "4", values: rollup.series.map((b) => b.errors) },
  ];
}

/**
 * Token Usage: input (prompt) vs output (completion) tokens per bucket. The
 * gateway does not record cached-token counts per bucket, so the Cached measure
 * stays a flat zero series: present for legend parity, never fabricated.
 */
export function tokenUsageSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Input",
      color: "1",
      values: rollup.series.map((b) => b.promptTokens),
    },
    {
      name: "Output",
      color: "2",
      values: rollup.series.map((b) => b.completionTokens),
    },
    { name: "Cached", color: "5", values: rollup.series.map(() => 0) },
  ];
}

/** Cost trend: micro-USD per bucket converted to euros. */
export function costTrendSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Cost",
      color: "3",
      values: rollup.series.map((b) => (b.costMicroUsd / MICRO) * getEurRate()),
    },
  ];
}

/** Model Usage trend: total tokens per bucket across every model. */
export function tokenTrendSeries(rollup: AnalyticsRollup): ChartSeries[] {
  return [
    {
      name: "Total tokens",
      color: "1",
      values: rollup.series.map((b) => b.totalTokens),
    },
  ];
}

/* ------------------------------- latency ------------------------------- */

/** Split entries into ordered time buckets (span when every ts parses). */
function bucketByTime(entries: LogEntry[], bucketCount: number): LogEntry[][] {
  const buckets: LogEntry[][] = Array.from({ length: bucketCount }, () => []);
  if (entries.length === 0 || bucketCount <= 0) {
    return buckets;
  }
  const parsed = entries.map((e) => Date.parse(e.ts));
  const valid = parsed.filter((t) => !Number.isNaN(t));
  const min = valid.length > 0 ? Math.min(...valid) : 0;
  const max = valid.length > 0 ? Math.max(...valid) : 0;
  const useTime = valid.length === entries.length && max > min;
  for (let i = 0; i < entries.length; i++) {
    const index = useTime
      ? Math.min(
        bucketCount - 1,
        Math.floor(((parsed[i] - min) / (max - min)) * bucketCount),
      )
      : Math.min(
        bucketCount - 1,
        Math.floor((i / entries.length) * bucketCount),
      );
    buckets[index].push(entries[i]);
  }
  return buckets;
}

/**
 * Latency trend: avg / p90 / p95 / p99 of durationMs per time bucket. Derived
 * from stored request logs (the rollup carries no latency), reusing the shared
 * nearest-rank percentile helper.
 */
export function latencyTrendSeries(
  entries: LogEntry[],
  bucketCount = 12,
): ChartSeries[] {
  const groups = bucketByTime(entries, bucketCount);
  const avg: number[] = [];
  const p90: number[] = [];
  const p95: number[] = [];
  const p99: number[] = [];
  for (const group of groups) {
    const durations = group
      .map((e) => e.durationMs)
      .filter((d): d is number => typeof d === "number" && d >= 0)
      .sort((a, b) => a - b);
    const mean = durations.length === 0
      ? 0
      : durations.reduce((sum, v) => sum + v, 0) / durations.length;
    avg.push(mean);
    p90.push(percentile(durations, 90));
    p95.push(percentile(durations, 95));
    p99.push(percentile(durations, 99));
  }
  return [
    { name: "Avg", color: "1", values: avg },
    { name: "P90", color: "2", values: p90 },
    { name: "P95", color: "3", values: p95 },
    { name: "P99", color: "4", values: p99 },
  ];
}

/* --------------------------- provider breakdown ------------------------ */

/** Providers sorted by total tokens (descending), optionally to one row. */
function filterProviders(
  rows: AnalyticsProviderRow[],
  filter: string,
): AnalyticsProviderRow[] {
  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  return filter === "all"
    ? sorted
    : sorted.filter((row) => row.provider === filter);
}

/** Provider Cost: one bar per provider (euros), chart-3. */
export function providerCostSeries(
  rollup: AnalyticsRollup,
  filter: string,
): ChartSeries[] {
  return [
    {
      name: "Cost",
      color: "3",
      values: filterProviders(rollup.byProvider, filter).map((r) =>
        (r.costMicroUsd / MICRO) * getEurRate()
      ),
    },
  ];
}

/** Provider Token Usage: one bar per provider (total tokens), chart-1. */
export function providerTokenSeries(
  rollup: AnalyticsRollup,
  filter: string,
): ChartSeries[] {
  return [
    {
      name: "Total tokens",
      color: "1",
      values: filterProviders(rollup.byProvider, filter).map((r) =>
        r.totalTokens
      ),
    },
  ];
}

/** Provider names behind the single provider bar series, in bar order. */
export function providerLegend(
  rollup: AnalyticsRollup,
  filter: string,
  color: LegendItem["color"],
): LegendItem[] {
  return filterProviders(rollup.byProvider, filter).map((row) => ({
    name: row.provider,
    color,
  }));
}

/* ----------------------------- filter options -------------------------- */

/** Distinct model options for the per-card model filter ("All Models" first). */
export function modelOptions(rollup: AnalyticsRollup): ComboboxOption[] {
  const seen = new Set<string>();
  const options: ComboboxOption[] = [{ value: "all", label: "All Models" }];
  for (const row of rollup.byModel) {
    if (!seen.has(row.model)) {
      seen.add(row.model);
      options.push({ value: row.model, label: row.model });
    }
  }
  return options;
}

/** Distinct provider options ("All Providers" first). */
export function providerOptions(rollup: AnalyticsRollup): ComboboxOption[] {
  const seen = new Set<string>();
  const options: ComboboxOption[] = [{ value: "all", label: "All Providers" }];
  for (const row of rollup.byProvider) {
    if (!seen.has(row.provider)) {
      seen.add(row.provider);
      options.push({ value: row.provider, label: row.provider });
    }
  }
  return options;
}

/* -------------------------------- csv ---------------------------------- */

/** Overview export: the analytics time-series buckets. */
export const overviewCsvColumns: CsvColumn<AnalyticsBucket>[] = [
  { header: "bucket", value: (b) => b.label },
  { header: "requests", value: (b) => b.requests },
  { header: "errors", value: (b) => b.errors },
  { header: "prompt_tokens", value: (b) => b.promptTokens },
  { header: "completion_tokens", value: (b) => b.completionTokens },
  { header: "total_tokens", value: (b) => b.totalTokens },
  {
    header: "cost_eur",
    value: (b) => ((b.costMicroUsd / MICRO) * getEurRate()).toFixed(6),
  },
];

/** Provider Usage export: the by-provider rollup rows. */
export const providerCsvColumns: CsvColumn<AnalyticsProviderRow>[] = [
  { header: "provider", value: (r) => r.provider },
  { header: "requests", value: (r) => r.requests },
  { header: "total_tokens", value: (r) => r.totalTokens },
  {
    header: "cost_eur",
    value: (r) => ((r.costMicroUsd / MICRO) * getEurRate()).toFixed(6),
  },
];

/** Model Rankings export: the by-model rollup rows. */
export const modelCsvColumns: CsvColumn<AnalyticsModelRow>[] = [
  { header: "model", value: (r) => r.model },
  { header: "provider", value: (r) => r.provider },
  { header: "requests", value: (r) => r.requests },
  { header: "prompt_tokens", value: (r) => r.promptTokens },
  { header: "completion_tokens", value: (r) => r.completionTokens },
  { header: "total_tokens", value: (r) => r.totalTokens },
  {
    header: "cost_eur",
    value: (r) => ((r.costMicroUsd / MICRO) * getEurRate()).toFixed(6),
  },
];
