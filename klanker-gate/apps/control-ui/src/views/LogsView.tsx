import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeft, Radio, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  ApiError,
  clearStoredLogs,
  getStoredLogs,
  type LogEntry,
  readLogStream,
  type StoredLogsResult,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Banner } from "../components/ui/banner";
import { ConfirmDialog } from "../components/ui/dialog";
import { DropdownMenu } from "../components/ui/dropdown-menu";
import { TimeRangePicker } from "../components/ui/time-range-picker";
import { useToast } from "../components/ui/toast";
import { withinWindow } from "../lib/analytics";
import { cn } from "../lib/utils";
import { LogsFacetRail } from "../components/logs/LogsFacetRail";
import { ColumnPicker } from "../components/logs/ColumnPicker";
import {
  LogsKpiRow,
  RequestVolumeCard,
} from "../components/logs/LogsAnalytics";
import { type Connection, LogsTable } from "../components/logs/LogsTable";
import {
  ALL_COLUMNS,
  applyValueFacets,
  classifyOutcome,
  DEFAULT_VISIBLE_COLUMNS,
  type FacetSelection,
  type Outcome,
  outcomeCounts,
  type ValueFacet,
  WINDOW_MS,
} from "../components/logs/logs-model";

const MAX_LIVE = 500;

function sameEntry(a: LogEntry, b: LogEntry): boolean {
  return a.ts === b.ts && a.message === b.message &&
    (a.requestId ?? "") === (b.requestId ?? "");
}

/**
 * Logs: the faceted request-log console. A Live/Stored toggle switches the data
 * source (SSE ring vs the KV-backed history); the left facet rail, free-text
 * search, time range, and outcome facet all refine whichever source is active.
 * Only recorded fields are wired; absent dimensions render an honest "N/A".
 */
export function LogsView() {
  const toast = useToast();

  const [live, setLive] = useState(true);
  const [storeOn, setStoreOn] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [range, setRange] = useState("1h");
  const [outcome, setOutcome] = useState<string[]>([]);
  const [facets, setFacets] = useState<FacetSelection>({});
  const [railOpen, setRailOpen] = useState(true);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(DEFAULT_VISIBLE_COLUMNS),
  );
  const [confirmClear, setConfirmClear] = useState(false);

  // Live source (SSE ring buffer).
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [manualReconnect, setManualReconnect] = useState(0);

  // Stored source (KV history).
  const [stored, setStored] = useState<StoredLogsResult>({
    entries: [],
    total: 0,
  });
  const [storedLoading, setStoredLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One-shot probe: a 404 means the durable log store is off, so Stored is
  // unavailable.
  useEffect(() => {
    let cancelled = false;
    getStoredLogs({ limit: 1 })
      .then(() => {
        if (!cancelled) {
          setStoreOn(true);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const off = err instanceof ApiError && err.status === 404;
        setStoreOn(!off);
        if (off) {
          setLive(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Upsert by request id. The gateway republishes an entry when a STREAMED
   * response finally resolves its token/cost figures, which happens after the
   * original entry was already sent. Appending that patch would duplicate the
   * row, and the sameEntry guard would instead discard it (ts/message/requestId
   * are unchanged by enrichment), losing the usage data. Replacing in place
   * keeps one row per request and lets it fill in as the stream completes.
   */
  const append = useCallback((entry: LogEntry) => {
    setLiveEntries((prev) => {
      if (entry.requestId) {
        const index = prev.findIndex((row) =>
          row.requestId === entry.requestId
        );
        if (index !== -1) {
          const next = [...prev];
          next[index] = { ...prev[index], ...entry };
          return next;
        }
      } else if (prev.length > 0 && sameEntry(prev[prev.length - 1], entry)) {
        return prev;
      }
      const next = [...prev, entry];
      return next.length > MAX_LIVE ? next.slice(-MAX_LIVE) : next;
    });
  }, []);

  // SSE stream with exponential-backoff reconnect, only while Live is on.
  useEffect(() => {
    if (!live) {
      return;
    }
    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function connect() {
      if (cancelled) {
        return;
      }
      controller = new AbortController();
      setConnection("connecting");
      try {
        await readLogStream(append, controller.signal, () => {
          attempt = 0;
          setConnection("streaming");
        });
      } catch {
        // surfaced as the disconnected state below
      }
      if (cancelled) {
        return;
      }
      setConnection("disconnected");
      attempt += 1;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      timer = setTimeout(connect, delay);
    }

    void connect();
    return () => {
      cancelled = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [live, append, manualReconnect]);

  const runStored = useCallback(async () => {
    setStoredLoading(true);
    try {
      const res = await getStoredLogs({ q: search || undefined, limit: 500 });
      setStored(res);
      setStoreOn(true);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStoreOn(false);
        setLive(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStoredLoading(false);
    }
  }, [search]);

  // Debounced stored query (server-side free-text search), only while Stored.
  useEffect(() => {
    if (live) {
      return;
    }
    const timer = setTimeout(() => void runStored(), 300);
    return () => clearTimeout(timer);
  }, [live, runStored]);

  const sourceEntries = live ? liveEntries : stored.entries;

  // Pipeline: time window -> free-text -> (counts) -> outcome facet.
  const timeSearchFiltered = useMemo(() => {
    const windowMs = WINDOW_MS[range] ?? 0;
    const needle = search.trim().toLowerCase();
    return withinWindow(sourceEntries, windowMs).filter((entry) => {
      if (!needle) {
        return true;
      }
      const haystack = `${entry.message} ${entry.path ?? ""} ${
        entry.method ?? ""
      }`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [sourceEntries, range, search]);

  const counts = useMemo(
    () => outcomeCounts(timeSearchFiltered),
    [timeSearchFiltered],
  );

  const visible = useMemo(() => {
    const byFacet = applyValueFacets(timeSearchFiltered, facets);
    if (outcome.length === 0) {
      return byFacet;
    }
    const selected = new Set(outcome as Outcome[]);
    return byFacet.filter((entry) => selected.has(classifyOutcome(entry)));
  }, [timeSearchFiltered, outcome, facets]);

  const setFacet = useCallback((id: ValueFacet["id"], values: string[]) => {
    setFacets((prev) => ({ ...prev, [id]: values }));
  }, []);

  const toggleLive = () => {
    if (storeOn === false) {
      return;
    }
    setLive((value) => !value);
  };

  const refresh = () => {
    if (live) {
      setManualReconnect((n) => n + 1);
    } else {
      void runStored();
    }
  };

  const toggleColumn = (key: string, checked: boolean) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  async function clearStored() {
    try {
      const res = await clearStoredLogs();
      toast.success(`Deleted ${res.deleted} stored log entries`);
      setConfirmClear(false);
      void runStored();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const storedDisabled = live || storeOn === false;
  const initialStoredLoad = !live && storedLoading &&
    stored.entries.length === 0;

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle="Live request stream and stored history"
        actions={
          <>
            <Button
              variant={live ? "default" : "outline"}
              size="sm"
              aria-pressed={live}
              disabled={storeOn === false}
              title={storeOn === false
                ? "Stored history is off; showing the live stream"
                : undefined}
              onClick={toggleLive}
            >
              <Radio aria-hidden="true" />
              Live
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh"
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </>
        }
      />

      {storeOn === false && (
        <Banner tone="info" className="mb-4">
          Stored logs are off. Set FROSTY_LOG_STORE=pg on the gateway to keep a
          searchable history (up to 5,000 entries). Showing the live stream
          only.
        </Banner>
      )}
      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <div
        className={cn(
          "grid gap-4",
          railOpen ? "md:grid-cols-[14rem_1fr]" : "grid-cols-1",
        )}
      >
        {railOpen && (
          <aside className="rounded-lg border border-border bg-card p-3">
            <LogsFacetRail
              outcome={outcome}
              onOutcomeChange={setOutcome}
              counts={counts}
              entries={timeSearchFiltered}
              selection={facets}
              onSelectionChange={setFacet}
              onHide={() => setRailOpen(false)}
            />
          </aside>
        )}

        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {!railOpen && (
              <Button
                variant="outline"
                size="icon"
                aria-label="Show filters"
                onClick={() => setRailOpen(true)}
              >
                <PanelLeft aria-hidden="true" />
              </Button>
            )}
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search log entries"
                placeholder="Search logs"
                value={search}
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <TimeRangePicker value={range} onChange={setRange} />
            <ColumnPicker
              columns={ALL_COLUMNS}
              visible={visibleColumns}
              onToggle={toggleColumn}
            />
            <DropdownMenu
              label="More actions"
              items={[
                {
                  id: "clear",
                  label: "Clear stored logs",
                  icon: Trash2,
                  destructive: true,
                  disabled: storedDisabled,
                  onSelect: () => setConfirmClear(true),
                },
              ]}
            />
          </div>

          <LogsKpiRow entries={visible} loading={initialStoredLoad} />
          <RequestVolumeCard entries={visible} />
          <LogsTable
            entries={visible}
            visibleColumns={visibleColumns}
            live={live}
            connection={connection}
            loading={initialStoredLoad}
            onReconnect={() => setManualReconnect((n) => n + 1)}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearStored}
        title="Clear stored logs?"
        confirmLabel="Clear stored logs"
        body={`This permanently deletes all ${stored.total} stored entries from the durable store. The live stream and its in-memory buffer are not affected.`}
      />
    </div>
  );
}
