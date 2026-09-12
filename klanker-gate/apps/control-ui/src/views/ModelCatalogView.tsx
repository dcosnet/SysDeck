import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Info, RefreshCw } from "lucide-react";
import {
  type CatalogProviderRow,
  type CatalogView,
  getCatalog,
  refreshModels,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardContent } from "../components/ui/card";
import { StatTile } from "../components/ui/stat-tile";
import { DataTable } from "../components/ui/data-table";
import { Badge } from "../components/ui/badge";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Combobox, type ComboboxOption } from "../components/ui/combobox";
import { EmptyState } from "../components/ui/empty-state";
import { CustomBadge, ProviderIcon } from "../components/ui/provider-icon";
import { ProviderModelsDialog } from "../components/catalog/ProviderModelsDialog";
import { useToast } from "../components/ui/toast";
import { ensureEurRate, formatEurFromUsd } from "../lib/currency";
import { cn } from "../lib/utils";

/* --------------------------------- format -------------------------------- */

const INT = new Intl.NumberFormat("en-US");

/** Thousands-grouped integer for counts and traffic (mono telemetry). */
function fmtInt(value: number): string {
  return INT.format(value);
}

/** Cost is shown in EUR at four decimals (converted from the canonical USD). */
function fmtCost(value: number): string {
  return formatEurFromUsd(value, 4);
}

/* ------------------------------- model chips ----------------------------- */

/** Chips shown before a long model list collapses behind a "+N more" toggle. */
const COLLAPSED_LIMIT = 6;

/**
 * Model ids rendered as wrapping monospace chips. A provider with no advertised
 * models shows a plain hyphen; a long list caps at COLLAPSED_LIMIT with a
 * keyboard-operable toggle that expands to the full set (and back).
 */
function ModelChips({ models }: { models: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (models.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  const overflow = models.length - COLLAPSED_LIMIT;
  const shown = expanded ? models : models.slice(0, COLLAPSED_LIMIT);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((model) => (
        <Badge
          key={model}
          tone="muted"
          className="font-mono text-2xs"
          title={model}
        >
          {model}
        </Badge>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
          className={cn(
            "hit-target inline-flex items-center rounded-sm border border-border",
            "bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground",
            "transition-colors duration-(--motion-fast) hover:text-foreground",
          )}
        >
          {expanded ? "Show less" : `+${overflow} more`}
        </button>
      )}
    </div>
  );
}

/* ---------------------------------- view --------------------------------- */

export function ModelCatalogView() {
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<CatalogProviderRow | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      // Apply the operator EUR rate before the first paint so money renders
      // converted; a failure falls back to the default rate.
      await ensureEurRate().catch(() => {});
      const view = await getCatalog();
      setCatalog(view);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Per-row refresh: re-pull a provider's advertised models, then reload the
  // catalog. Failures surface via toast ONLY - never the page-level error
  // state, which would unmount the whole table behind a full-page banner.
  const onRefresh = useCallback(async (row: CatalogProviderRow) => {
    setRefreshingId(row.id);
    try {
      await refreshModels(row.id);
      await load();
      toast.success(`Models refreshed for "${row.id}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingId(null);
    }
  }, [load, toast]);

  const providers = catalog?.providers ?? [];
  const totals = catalog?.totals ?? null;

  const filterOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All Providers" },
      ...providers.map((provider) => ({
        value: provider.id,
        label: provider.id,
      })),
    ],
    [providers],
  );

  const rows = useMemo(
    () => (filter === "all"
      ? providers
      : providers.filter((provider) => provider.id === filter)),
    [providers, filter],
  );

  const header = (
    <PageHeader
      title="Model Catalog"
      subtitle="Overview of all configured providers, models, and usage."
    />
  );

  // A real transport failure (getCatalog already normalizes a 404 to an empty
  // catalog, so anything thrown here is a genuine error worth surfacing).
  if (error) {
    return (
      <div>
        {header}
        <Banner tone="error">{error}</Banner>
      </div>
    );
  }

  // Feature-off or genuinely empty: both normalize to zero providers. Show an
  // honest notice rather than a wall of zeroed tiles that implies live data.
  if (loaded && providers.length === 0) {
    return (
      <div>
        {header}
        <Card>
          <CardContent className="py-2">
            <EmptyState
              icon={Boxes}
              tone="info"
              title="No data available"
              body="No providers are configured, or this gateway does not expose the model catalog yet."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          loading={!loaded}
          label="Total Providers"
          value={totals ? fmtInt(totals.providers) : "-"}
        />
        <StatTile
          loading={!loaded}
          label="Total Models"
          value={totals ? fmtInt(totals.models) : "-"}
        />
        <StatTile
          loading={!loaded}
          label="Total Requests (24h)"
          value={totals ? fmtInt(totals.requests24h) : "-"}
        />
        <StatTile
          loading={!loaded}
          label="Total Cost (24h)"
          value={totals ? fmtCost(totals.cost24h) : "-"}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <Combobox
          className="w-full sm:w-56"
          label="Filter by provider"
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          placeholder="All Providers"
          disabled={!loaded}
        />
      </div>

      <DataTable<CatalogProviderRow>
        caption="Model catalog by provider"
        rows={rows}
        getRowId={(row) => row.id}
        loading={!loaded}
        minWidth="52rem"
        empty="No data available"
        onRowClick={(row) => setSelectedRow(row)}
        rowMenuLabel="Refresh"
        rowMenu={(row) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Refresh models for ${row.id}`}
            isLoading={refreshingId === row.id}
            disabled={refreshingId !== null}
            onClick={(e) => {
              e.stopPropagation();
              void onRefresh(row);
            }}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        )}
        columns={[
          {
            key: "provider",
            header: "Provider",
            cell: (row) => (
              <div className="flex items-center gap-2.5">
                <ProviderIcon
                  provider={row.type}
                  name={row.id}
                  custom={row.custom}
                  size="sm"
                />
                <span className="font-medium text-foreground">{row.id}</span>
                {row.custom && <CustomBadge />}
              </div>
            ),
          },
          {
            key: "models",
            header: (
              <span
                className="inline-flex items-center gap-1"
                title="Models each provider advertises"
              >
                Models
                <Info aria-hidden="true" className="size-3.5" />
              </span>
            ),
            cell: (row) => <ModelChips models={row.models} />,
          },
          {
            key: "traffic",
            header: "Total Traffic (24h)",
            headerLabel: "total traffic",
            align: "right",
            width: "12rem",
            sortValue: (row) => row.traffic24h,
            cell: (row) => (
              <span className="font-mono tabular-nums text-foreground">
                {fmtInt(row.traffic24h)}
              </span>
            ),
          },
          {
            key: "cost",
            header: "Total Cost (24h)",
            headerLabel: "total cost",
            align: "right",
            width: "11rem",
            sortValue: (row) => row.cost24h,
            cell: (row) => (
              <span className="font-mono tabular-nums text-foreground">
                {fmtCost(row.cost24h)}
              </span>
            ),
          },
        ]}
      />

      <ProviderModelsDialog
        provider={selectedRow}
        onClose={() => setSelectedRow(null)}
        onSaved={() => void load()}
      />
    </div>
  );
}
