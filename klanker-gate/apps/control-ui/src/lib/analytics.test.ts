import { beforeEach, describe, expect, it } from "vitest";
import type {
  AnalyticsBucket,
  AnalyticsModelRow,
  AnalyticsRollup,
  LogEntry,
} from "../api";
import {
  buildSeries,
  costSeries,
  latencySummary,
  modelUsageLegend,
  modelUsageSeries,
  percentile,
  requestSummary,
  tokenUsageSeries,
  topModels,
  withinWindow,
} from "./analytics";
import { resetEurRate } from "./currency";

beforeEach(() => {
  resetEurRate();
});

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    ts: "2026-07-14T00:00:00.000Z",
    level: "info",
    message: "req",
    ...partial,
  };
}

function bucket(partial: Partial<AnalyticsBucket>): AnalyticsBucket {
  return {
    label: "1",
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
    errors: 0,
    ...partial,
  };
}

function modelRow(partial: Partial<AnalyticsModelRow>): AnalyticsModelRow {
  return {
    model: "m",
    provider: "p",
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
    ...partial,
  };
}

function rollup(partial: Partial<AnalyticsRollup>): AnalyticsRollup {
  return {
    tracked: true,
    window: "24h",
    generatedAt: "2026-07-14T00:00:00.000Z",
    totals: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costMicroUsd: 0,
      costUsd: 0,
      errorRatePct: 0,
      cacheHits: 0,
      cacheMisses: 0,
    },
    series: [],
    byModel: [],
    byProvider: [],
    ...partial,
  };
}

describe("percentile", () => {
  it("returns 0 for an empty sample", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("uses nearest-rank over a sorted sample", () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sample, 50)).toBe(50);
    expect(percentile(sample, 90)).toBe(90);
    expect(percentile(sample, 95)).toBe(100);
    expect(percentile(sample, 99)).toBe(100);
  });
});

describe("latencySummary", () => {
  it("ignores entries without a numeric duration", () => {
    const entries = [
      entry({ durationMs: 100 }),
      entry({ durationMs: 200 }),
      entry({}), // no duration
      entry({ durationMs: 300 }),
    ];
    const summary = latencySummary(entries);
    expect(summary.count).toBe(3);
    expect(summary.p50).toBe(200);
    expect(summary.p99).toBe(300);
  });

  it("is zeroed when nothing has a duration", () => {
    expect(latencySummary([entry({})])).toMatchObject({
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      count: 0,
    });
  });
});

describe("requestSummary", () => {
  it("counts requests, errors, and the error rate", () => {
    const entries = [
      entry({ status: 200 }),
      entry({ status: 200 }),
      entry({ status: 500 }),
      entry({ status: 404 }),
      entry({}), // not a request (no status)
    ];
    const summary = requestSummary(entries);
    expect(summary.total).toBe(4);
    expect(summary.errors).toBe(2);
    expect(summary.success).toBe(2);
    expect(summary.errorRatePct).toBe(50);
  });

  it("reports a 0 rate with no requests", () => {
    expect(requestSummary([]).errorRatePct).toBe(0);
  });
});

describe("buildSeries", () => {
  it("returns no buckets for empty input", () => {
    expect(buildSeries([], 6)).toEqual([]);
  });

  it("splits entries by timestamp into ordered buckets", () => {
    const entries = [
      entry({ ts: "2026-07-14T00:00:00.000Z", status: 500, durationMs: 10 }),
      entry({ ts: "2026-07-14T00:05:00.000Z", status: 200, durationMs: 20 }),
      entry({ ts: "2026-07-14T01:00:00.000Z", status: 200, durationMs: 30 }),
    ];
    const series = buildSeries(entries, 2);
    expect(series).toHaveLength(2);
    // Total across buckets equals the input length.
    expect(series[0].total + series[1].total).toBe(3);
    // The single 500 near the start lands in the first bucket.
    expect(series[0].errors).toBe(1);
    expect(series[1].errors).toBe(0);
    // Aggregate error count is preserved regardless of bucketing.
    expect(series.reduce((n, b) => n + b.errors, 0)).toBe(1);
  });

  it("falls back to arrival order when timestamps do not parse", () => {
    const entries = Array.from(
      { length: 4 },
      (_, i) => entry({ ts: "not-a-date", status: 200, durationMs: i }),
    );
    const series = buildSeries(entries, 2);
    expect(series).toHaveLength(2);
    expect(series[0].total).toBe(2);
    expect(series[1].total).toBe(2);
  });
});

describe("withinWindow", () => {
  it("keeps only entries newer than the cutoff", () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const entries = [
      entry({ ts: "2026-07-14T11:59:00.000Z" }), // 1m ago, kept
      entry({ ts: "2026-07-14T09:00:00.000Z" }), // 3h ago, dropped
    ];
    const kept = withinWindow(entries, 60 * 60 * 1000, now);
    expect(kept).toHaveLength(1);
  });

  it("keeps entries with unparseable timestamps", () => {
    const kept = withinWindow([entry({ ts: "bogus" })], 1000, Date.now());
    expect(kept).toHaveLength(1);
  });
});

describe("tokenUsageSeries", () => {
  it("maps prompt and completion tokens over the buckets", () => {
    const series = tokenUsageSeries(rollup({
      series: [
        bucket({ promptTokens: 10, completionTokens: 4 }),
        bucket({ promptTokens: 20, completionTokens: 9 }),
      ],
    }));
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ name: "Prompt", color: "1" });
    expect(series[0].values).toEqual([10, 20]);
    expect(series[1]).toMatchObject({ name: "Completion", color: "2" });
    expect(series[1].values).toEqual([4, 9]);
  });

  it("yields empty value arrays for an empty rollup", () => {
    const series = tokenUsageSeries(rollup({}));
    expect(series.every((s) => s.values.length === 0)).toBe(true);
  });
});

describe("costSeries", () => {
  it("converts micro-USD per bucket into euros", () => {
    const series = costSeries(rollup({
      series: [
        bucket({ costMicroUsd: 2_500_000 }),
        bucket({ costMicroUsd: 500_000 }),
      ],
    }));
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ name: "Cost", color: "3" });
    // Default EUR rate is 0.92: 2.5 USD -> 2.3 EUR, 0.5 USD -> 0.46 EUR.
    expect(series[0].values).toEqual([2.5 * 0.92, 0.5 * 0.92]);
  });
});

describe("topModels / modelUsage", () => {
  const busy = rollup({
    byModel: [
      modelRow({ model: "a", totalTokens: 30 }),
      modelRow({ model: "b", totalTokens: 90 }),
      modelRow({ model: "c", totalTokens: 60 }),
    ],
  });

  it("sorts models by total tokens, descending", () => {
    expect(topModels(busy).map((m) => m.model)).toEqual(["b", "c", "a"]);
  });

  it("caps the ranking at the requested limit", () => {
    expect(topModels(busy, 2).map((m) => m.model)).toEqual(["b", "c"]);
  });

  it("does not mutate the source byModel array", () => {
    topModels(busy);
    expect(busy.byModel.map((m) => m.model)).toEqual(["a", "b", "c"]);
  });

  it("shapes a single bar series of total tokens in rank order", () => {
    const series = modelUsageSeries(busy);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ name: "Total tokens", color: "1" });
    expect(series[0].values).toEqual([90, 60, 30]);
  });

  it("names each model in the legend in the same bar order and hue", () => {
    const legend = modelUsageLegend(busy);
    expect(legend.map((l) => l.name)).toEqual(["b", "c", "a"]);
    expect(legend.every((l) => l.color === "1")).toBe(true);
  });

  it("returns no series values / legend for an empty rollup", () => {
    expect(modelUsageSeries(rollup({}))[0].values).toEqual([]);
    expect(modelUsageLegend(rollup({}))).toEqual([]);
  });
});
