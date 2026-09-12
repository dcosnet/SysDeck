import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { LogEntry } from "../../api";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { StatTile } from "../ui/stat-tile";
import { Chart, ChartLegend, type ChartSeries } from "../ui/chart";
import { buildSeries } from "../../lib/analytics";
import { classifyOutcome, entryTokens, formatCostUsd } from "./logs-model";
import { cn } from "../../lib/utils";

/**
 * KPI row over the currently visible logs. Every tile derives from recorded
 * fields: Total Requests / Success Rate / Avg Latency from the base request
 * fields, Total Tokens / Total Cost from the telemetry enrichment carried on
 * inference entries. A window with no inference traffic still shows an honest
 * "N/A" for the last two rather than a fabricated zero, because "no request
 * recorded usage" and "usage was zero" are different facts.
 */
export function LogsKpiRow(
  { entries, loading }: { entries: LogEntry[]; loading: boolean },
) {
  let success = 0;
  let error = 0;
  let cancelled = 0;
  let latencyCount = 0;
  let latencySum = 0;
  let tokenTotal = 0;
  let tokenEntries = 0;
  let costMicroUsd = 0;
  let costEntries = 0;
  for (const entry of entries) {
    const outcome = classifyOutcome(entry);
    if (outcome === "success") {
      success += 1;
    } else if (outcome === "error") {
      error += 1;
    } else if (outcome === "cancelled") {
      cancelled += 1;
    }
    if (typeof entry.durationMs === "number") {
      latencyCount += 1;
      latencySum += entry.durationMs;
    }
    const tokens = entryTokens(entry);
    if (tokens !== null) {
      tokenTotal += tokens;
      tokenEntries += 1;
    }
    if (typeof entry.costMicroUsd === "number") {
      costMicroUsd += entry.costMicroUsd;
      costEntries += 1;
    }
  }

  const terminal = success + error + cancelled;
  const successRate = terminal > 0 ? (success / terminal) * 100 : null;
  const avgLatency = latencyCount > 0 ? latencySum / latencyCount : null;

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile
        loading={loading}
        label="Total Requests"
        value={entries.length.toLocaleString()}
        caption="in view"
      />
      <StatTile
        loading={loading}
        label="Success Rate"
        value={successRate === null ? "N/A" : `${successRate.toFixed(2)}%`}
        caption={successRate === null
          ? "no completed requests"
          : `${success.toLocaleString()} ok`}
      />
      <StatTile
        loading={loading}
        label="Avg Latency"
        value={avgLatency === null ? "N/A" : `${avgLatency.toFixed(2)}ms`}
        caption={avgLatency === null ? "no latency recorded" : undefined}
      />
      <StatTile
        loading={loading}
        label="Total Tokens"
        value={tokenEntries === 0 ? "N/A" : tokenTotal.toLocaleString()}
        caption={tokenEntries === 0
          ? "no usage recorded"
          : `over ${tokenEntries.toLocaleString()} ${
            tokenEntries === 1 ? "request" : "requests"
          }`}
      />
      <StatTile
        loading={loading}
        label="Total Cost"
        value={costEntries === 0 ? "N/A" : formatCostUsd(costMicroUsd)}
        caption={costEntries === 0 ? "no cost recorded" : "priced requests"}
      />
    </div>
  );
}

/**
 * Collapsible Request Volume card: success vs error counts bucketed over the
 * visible logs' time range. Both series are derived from recorded status/level;
 * an empty window shows the standard "No data available" state.
 */
export function RequestVolumeCard({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState(true);

  const series = buildSeries(entries, 12);
  const volume: ChartSeries[] = [
    { name: "Success", color: "2", values: series.map((b) => b.success) },
    { name: "Error", color: "4", values: series.map((b) => b.errors) },
  ];
  const hasData = volume.some((s) => s.values.some((v) => v > 0));

  return (
    <Card className="mb-5">
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="hit-target -ml-1 inline-flex items-center gap-2 rounded px-1 text-left"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              "transition-transform duration-(--motion-default)",
              !open && "-rotate-90",
            )}
          />
          <CardTitle className="text-base">Request Volume</CardTitle>
        </button>
        <ChartLegend
          items={[
            { name: "Success", color: "2" },
            { name: "Error", color: "4" },
          ]}
        />
      </CardHeader>
      {open && (
        <CardContent>
          {hasData
            ? (
              <Chart
                type="bar"
                series={volume}
                ariaLabel="Request volume by outcome over time"
                height={160}
              />
            )
            : (
              <div className="flex h-40 items-center justify-center rounded-md bg-muted/40">
                <p className="text-sm text-muted-foreground">
                  No data available
                </p>
              </div>
            )}
        </CardContent>
      )}
    </Card>
  );
}
