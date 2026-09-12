import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  type AnalyticsModelRow,
  type AnalyticsRollup,
  type AnalyticsWindow,
  ApiError,
  getAnalytics,
  getStoredLogs,
  type LogEntry,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Banner } from "../components/ui/banner";
import { Combobox } from "../components/ui/combobox";
import { DataTable } from "../components/ui/data-table";
import { ExportButton } from "../components/ui/export-button";
import { SubTabs } from "../components/ui/nav-tabs";
import { tabPanelProps } from "../components/ui/tabs";
import {
  DEFAULT_TIME_RANGES,
  TimeRangePicker,
} from "../components/ui/time-range-picker";
import { ChartCard } from "../components/dashboard/ChartCard";
import * as adapt from "../components/dashboard/adapters";
import { withinWindow } from "../lib/analytics";
import {
  ensureEurRate,
  formatEurFromMicroUsd,
  getEurRate,
} from "../lib/currency";

const WINDOW_MS: Record<AnalyticsWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const BUCKETS = 12;

const SECTION_TABS = [
  { value: "overview", label: "Overview" },
  { value: "provider-usage", label: "Provider Usage" },
  { value: "model-rankings", label: "Model Rankings" },
  { value: "mcp-usage", label: "MCP usage" },
  { value: "user-rankings", label: "User Rankings" },
];

type Section = (typeof SECTION_TABS)[number]["value"];

/** Three evenly spaced clock/date ticks spanning the selected window. */
function axisTicks(range: AnalyticsWindow, endIso?: string): string[] {
  const parsed = endIso ? Date.parse(endIso) : Number.NaN;
  const end = Number.isNaN(parsed) ? Date.now() : parsed;
  const span = WINDOW_MS[range];
  const format = (t: number) => {
    const date = new Date(t);
    return range === "7d"
      ? date.toLocaleDateString(undefined, { month: "short", day: "2-digit" })
      : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  };
  return [0, 0.5, 1].map((fraction) => format(end - span + fraction * span));
}

interface DashState {
  rollup: AnalyticsRollup | null;
  entries: LogEntry[];
  storeOn: boolean | null;
  loaded: boolean;
  error: string | null;
}

const INITIAL: DashState = {
  rollup: null,
  entries: [],
  storeOn: null,
  loaded: false,
  error: null,
};

export function DashboardView() {
  const [state, setState] = useState<DashState>(INITIAL);
  const [range, setRange] = useState<AnalyticsWindow>("24h");
  const [section, setSection] = useState<Section>("overview");
  // Per-card filters (structure parity with the reference).
  const [costModel, setCostModel] = useState("all");
  const [usageModel, setUsageModel] = useState("all");
  const [costProvider, setCostProvider] = useState("all");
  const [tokenProvider, setTokenProvider] = useState("all");

  const load = useCallback(async () => {
    await ensureEurRate().catch(() => {});
    const [analytics, stored] = await Promise.allSettled([
      getAnalytics(range),
      getStoredLogs({ limit: 500 }),
    ]);
    setState((prev) => {
      const next: DashState = { ...prev, loaded: true, error: null };
      // Analytics is an optional surface: any failure degrades to the honest
      // empty state (null rollup) without hijacking the error banner.
      next.rollup = analytics.status === "fulfilled" ? analytics.value : null;
      if (stored.status === "fulfilled") {
        next.entries = stored.value.entries;
        next.storeOn = true;
      } else if (
        stored.reason instanceof ApiError && stored.reason.status === 404
      ) {
        next.storeOn = false;
        next.entries = [];
      } else {
        next.storeOn = true;
        next.error = stored.reason instanceof Error
          ? stored.reason.message
          : String(stored.reason);
      }
      return next;
    });
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const { rollup, entries, storeOn, loaded, error } = state;
  const storeOff = storeOn === false;
  const ticks = axisTicks(range, rollup?.generatedAt);

  /* ------------------------------- overview ---------------------------- */
  const volume = rollup ? adapt.requestVolumeSeries(rollup) : [];
  const tokens = rollup ? adapt.tokenUsageSeries(rollup) : [];
  const costTrend = rollup ? adapt.costTrendSeries(rollup) : [];
  const usageTrend = rollup ? adapt.tokenTrendSeries(rollup) : [];
  const latency = useMemo(
    () =>
      adapt.latencyTrendSeries(
        withinWindow(entries, WINDOW_MS[range]),
        BUCKETS,
      ),
    [entries, range],
  );
  const modelChoices = rollup
    ? adapt.modelOptions(rollup)
    : [{ value: "all", label: "All Models" }];

  /* --------------------------- provider usage -------------------------- */
  const providerChoices = rollup
    ? adapt.providerOptions(rollup)
    : [{ value: "all", label: "All Providers" }];
  const providerCost = rollup
    ? adapt.providerCostSeries(rollup, costProvider)
    : [];
  const providerToken = rollup
    ? adapt.providerTokenSeries(rollup, tokenProvider)
    : [];

  /* --------------------------- model rankings -------------------------- */
  const rankedByTokens = useMemo(
    () =>
      rollup
        ? [...rollup.byModel].sort((a, b) => b.totalTokens - a.totalTokens)
        : [],
    [rollup],
  );
  const rankedByCost = useMemo(
    () =>
      rollup
        ? [...rollup.byModel].sort((a, b) => b.costMicroUsd - a.costMicroUsd)
        : [],
    [rollup],
  );
  const topTokens = rankedByTokens.slice(0, 8);
  const topCost = rankedByCost.slice(0, 8);

  const exportButton = renderExport(section, rollup, rankedByTokens);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            {exportButton}
            <TimeRangePicker
              value={range}
              onChange={(value) => setRange(value as AnalyticsWindow)}
              options={DEFAULT_TIME_RANGES}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Reload analytics"
              onClick={() => void load()}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </>
        }
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <SubTabs
        label="Dashboard sections"
        value={section}
        onValueChange={(value) => setSection(value as Section)}
        tabs={SECTION_TABS}
        className="mb-5"
      />

      {section === "overview" && (
        <div
          {...tabPanelProps("overview")}
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          <ChartCard
            title="Request Volume"
            ariaLabel="Request volume chart"
            series={volume}
            legend={[
              { name: "Success", color: "2" },
              { name: "Error", color: "4" },
            ]}
            defaultType="bar"
            xTicks={ticks}
            loading={!loaded}
          />
          <ChartCard
            title="Token Usage"
            ariaLabel="Token usage chart"
            series={tokens}
            legend={[
              { name: "Input", color: "1" },
              { name: "Output", color: "2" },
              { name: "Cached", color: "5" },
            ]}
            defaultType="bar"
            unit="tokens"
            xTicks={ticks}
            loading={!loaded}
          />
          <ChartCard
            title="External Cache Hit Rate"
            ariaLabel="External cache hit rate chart"
            hideToggle
            empty
            loading={!loaded}
          />
          <ChartCard
            title="Local Cache Hit Rate"
            ariaLabel="Local cache hit rate chart"
            hideToggle
            empty
            loading={!loaded}
          />
          <ChartCard
            title="Cost"
            ariaLabel="Cost chart"
            series={costModel === "all" ? costTrend : []}
            legend={[{ name: "Cost", color: "3" }]}
            defaultType="bar"
            unit="EUR"
            xTicks={ticks}
            loading={!loaded}
            empty={costModel !== "all"}
            emptyNote={costModel !== "all"
              ? "Per-model cost over time is not recorded yet."
              : undefined}
            filter={
              <Combobox
                className="w-40"
                label="Filter cost by model"
                options={modelChoices}
                value={costModel}
                onChange={setCostModel}
              />
            }
          />
          <ChartCard
            title="Model Usage"
            ariaLabel="Model usage chart"
            series={usageModel === "all" ? usageTrend : []}
            legend={[{ name: "Total tokens", color: "1" }]}
            defaultType="bar"
            unit="tokens"
            xTicks={ticks}
            loading={!loaded}
            empty={usageModel !== "all"}
            emptyNote={usageModel !== "all"
              ? "Per-model usage over time is not recorded yet."
              : undefined}
            filter={
              <Combobox
                className="w-40"
                label="Filter usage by model"
                options={modelChoices}
                value={usageModel}
                onChange={setUsageModel}
              />
            }
          />
          <ChartCard
            title="Latency"
            ariaLabel="Latency chart"
            series={latency}
            legend={[
              { name: "Avg", color: "1" },
              { name: "P90", color: "2" },
              { name: "P95", color: "3" },
              { name: "P99", color: "4" },
            ]}
            defaultType="line"
            unit="ms"
            xTicks={ticks}
            loading={!loaded}
            empty={storeOff}
            emptyNote={storeOff
              ? "Stored logs are off (set FROSTY_LOG_STORE=pg on the gateway)."
              : undefined}
          />
        </div>
      )}

      {section === "provider-usage" && (
        <div
          {...tabPanelProps("provider-usage")}
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          <ChartCard
            title="Provider Cost"
            ariaLabel="Provider cost chart"
            series={providerCost}
            legend={rollup
              ? adapt.providerLegend(rollup, costProvider, "3")
              : []}
            defaultType="bar"
            unit="EUR"
            loading={!loaded}
            filter={
              <Combobox
                className="w-44"
                label="Filter cost by provider"
                options={providerChoices}
                value={costProvider}
                onChange={setCostProvider}
              />
            }
          />
          <ChartCard
            title="Provider Token Usage"
            ariaLabel="Provider token usage chart"
            series={providerToken}
            legend={rollup
              ? adapt.providerLegend(rollup, tokenProvider, "1")
              : []}
            defaultType="bar"
            unit="tokens"
            loading={!loaded}
            filter={
              <Combobox
                className="w-44"
                label="Filter tokens by provider"
                options={providerChoices}
                value={tokenProvider}
                onChange={setTokenProvider}
              />
            }
          />
          <ChartCard
            title="Provider Latency"
            ariaLabel="Provider latency chart"
            hideToggle
            empty
            loading={!loaded}
            emptyNote="Per-provider latency is not recorded by the gateway yet."
          />
        </div>
      )}

      {section === "model-rankings" && (
        <div
          {...tabPanelProps("model-rankings")}
          className="flex flex-col gap-5"
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="Top Models by Tokens"
              ariaLabel="Top models by tokens chart"
              series={[{
                name: "Total tokens",
                color: "1",
                values: topTokens.map((row) => row.totalTokens),
              }]}
              legend={topTokens.map((row) => ({
                name: row.model,
                color: "1" as const,
              }))}
              defaultType="bar"
              unit="tokens"
              loading={!loaded}
            />
            <ChartCard
              title="Top Models by Cost"
              ariaLabel="Top models by cost chart"
              series={[{
                name: "Cost",
                color: "3",
                values: topCost.map((row) =>
                  (row.costMicroUsd / 1_000_000) * getEurRate()
                ),
              }]}
              legend={topCost.map((row) => ({
                name: row.model,
                color: "3" as const,
              }))}
              defaultType="bar"
              unit="EUR"
              loading={!loaded}
            />
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold text-foreground">
              Model rankings
            </h3>
            <DataTable<AnalyticsModelRow>
              caption="Model rankings by usage"
              rows={rankedByTokens}
              getRowId={(row) => row.model}
              minWidth="42rem"
              pageSize={10}
              loading={!loaded}
              empty="No data available"
              initialSort={{ key: "tokens", dir: "desc" }}
              columns={[
                {
                  key: "model",
                  header: "Model",
                  sortValue: (row) => row.model,
                  cell: (row) => (
                    <span className="font-mono text-sm text-foreground">
                      {row.model}
                    </span>
                  ),
                },
                {
                  key: "provider",
                  header: "Provider",
                  sortValue: (row) => row.provider,
                  cell: (row) => (
                    <span className="text-sm text-muted-foreground">
                      {row.provider}
                    </span>
                  ),
                },
                {
                  key: "requests",
                  header: "Requests",
                  align: "right",
                  sortValue: (row) => row.requests,
                  cell: (row) => (
                    <span className="font-mono text-sm">
                      {row.requests.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "tokens",
                  header: "Tokens",
                  align: "right",
                  sortValue: (row) => row.totalTokens,
                  cell: (row) => (
                    <span className="font-mono text-sm">
                      {row.totalTokens.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "cost",
                  header: "Cost",
                  align: "right",
                  sortValue: (row) => row.costMicroUsd,
                  cell: (row) => (
                    <span className="font-mono text-sm">
                      {formatEurFromMicroUsd(row.costMicroUsd, 2)}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}

      {section === "mcp-usage" && (
        <div {...tabPanelProps("mcp-usage")} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            MCP-level usage is not recorded by the gateway yet.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ChartCard
              title="MCP Tool Calls"
              ariaLabel="MCP tool calls chart"
              hideToggle
              empty
            />
            <ChartCard
              title="MCP Tool Latency"
              ariaLabel="MCP tool latency chart"
              hideToggle
              empty
            />
            <ChartCard
              title="MCP Errors"
              ariaLabel="MCP errors chart"
              hideToggle
              empty
            />
          </div>
        </div>
      )}

      {section === "user-rankings" && (
        <div
          {...tabPanelProps("user-rankings")}
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-muted-foreground">
            Per-user usage is not recorded by the gateway yet.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ChartCard
              title="Top Users by Tokens"
              ariaLabel="Top users by tokens chart"
              hideToggle
              empty
            />
            <ChartCard
              title="Top Users by Cost"
              ariaLabel="Top users by cost chart"
              hideToggle
              empty
            />
            <ChartCard
              title="Top Users by Requests"
              ariaLabel="Top users by requests chart"
              hideToggle
              empty
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** The Export button exports the active section's underlying rollup rows. */
function renderExport(
  section: Section,
  rollup: AnalyticsRollup | null,
  rankedModels: AnalyticsModelRow[],
) {
  if (section === "provider-usage") {
    return (
      <ExportButton
        label="Export"
        rows={rollup?.byProvider ?? []}
        columns={adapt.providerCsvColumns}
        filename="dashboard-provider-usage.csv"
      />
    );
  }
  if (section === "model-rankings") {
    return (
      <ExportButton
        label="Export"
        rows={rankedModels}
        columns={adapt.modelCsvColumns}
        filename="dashboard-model-rankings.csv"
      />
    );
  }
  if (section === "overview") {
    return (
      <ExportButton
        label="Export"
        rows={rollup?.series ?? []}
        columns={adapt.overviewCsvColumns}
        filename="dashboard-overview.csv"
      />
    );
  }
  // MCP usage / User Rankings have no recorded rows: the button self-disables.
  return (
    <ExportButton
      label="Export"
      rows={[]}
      columns={adapt.overviewCsvColumns}
      filename="dashboard.csv"
    />
  );
}
