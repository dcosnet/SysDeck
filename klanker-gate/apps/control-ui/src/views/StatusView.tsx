import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApiError,
  getConfig,
  getHealth,
  getLogs,
  getMCPClients,
  getModels,
  getRuntime,
  getVersion,
  getVirtualKeys,
  type HealthInfo,
  type LogEntry,
  type ModelInfo,
  type VersionInfo,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Banner } from "../components/ui/banner";
import { StatTile } from "../components/ui/stat-tile";
import { PanelSkeleton, TableSkeleton } from "../components/ui/skeleton";
import {
  ScrollContainer,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import type { RuntimeView } from "../api";
import { clockTime } from "../lib/utils";

interface ModelRow {
  id: string;
  owned_by: string;
}

interface StatusState {
  health: HealthInfo | null;
  version: VersionInfo | null;
  models: ModelRow[];
  governedNote: boolean;
  logs: LogEntry[];
  providerCount: number | null;
  enabledCount: number;
  mcpCount: number | null;
  vkCount: number | null;
  runtime: RuntimeView | null;
  checkedAt: string;
  loaded: boolean;
  netError: boolean;
}

const INITIAL: StatusState = {
  health: null,
  version: null,
  models: [],
  governedNote: false,
  logs: [],
  providerCount: null,
  enabledCount: 0,
  mcpCount: null,
  vkCount: null,
  runtime: null,
  checkedAt: "",
  loaded: false,
  netError: false,
};

export function StatusView() {
  // Single state object so each poll applies exactly one update (act-clean).
  const [state, setState] = useState<StatusState>(INITIAL);
  // Guards trailing state updates so a late fetch after unmount stays act-clean.
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      getHealth(),
      getVersion(),
      getConfig(),
      getMCPClients(),
      getLogs(500),
      getVirtualKeys(),
      getModels(),
      getRuntime(),
    ]);
    if (!aliveRef.current) {
      return;
    }
    const [h, v, cfg, clients, logEntries, keys, modelsRes, runtimeRes] =
      results;

    setState((prev) => {
      const next: StatusState = {
        ...prev,
        checkedAt: clockTime(),
        loaded: true,
      };

      if (h.status === "fulfilled") {
        next.health = h.value;
        next.netError = false;
      } else {
        next.health = prev.health ??
          { status: "unreachable", version: "", timestamp: "" };
        if (h.reason instanceof TypeError) {
          next.netError = true;
        }
      }
      if (v.status === "fulfilled") {
        next.version = v.value;
      }
      if (cfg.status === "fulfilled") {
        next.providerCount = cfg.value.providers.length;
        next.enabledCount = cfg.value.providers.filter((p) => p.enabled).length;
      }
      if (clients.status === "fulfilled") {
        next.mcpCount = clients.value.length;
      }
      if (logEntries.status === "fulfilled") {
        next.logs = logEntries.value;
      }
      if (keys.status === "fulfilled") {
        next.vkCount = keys.value.length;
      }
      if (runtimeRes.status === "fulfilled") {
        next.runtime = runtimeRes.value;
      }

      // Model catalog: live /v1/models, falling back to configured models when
      // governance forces a 401 (admin token is not a virtual key, R2).
      if (modelsRes.status === "fulfilled") {
        next.models = modelsRes.value.map((m: ModelInfo) => ({
          id: m.id,
          owned_by: m.owned_by,
        }));
        next.governedNote = false;
      } else if (
        modelsRes.reason instanceof ApiError &&
        modelsRes.reason.status === 401 &&
        cfg.status === "fulfilled"
      ) {
        const rows: ModelRow[] = [];
        for (const provider of cfg.value.providers) {
          for (const model of provider.models) {
            rows.push({ id: `${provider.id}/${model}`, owned_by: provider.id });
          }
        }
        next.models = rows;
        next.governedNote = true;
      }

      return next;
    });
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    aliveRef.current = true;
    void loadRef.current();
    const timer = setInterval(() => void loadRef.current(), 10_000);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, []);

  const {
    health,
    version,
    models,
    governedNote,
    logs,
    providerCount,
    enabledCount,
    mcpCount,
    vkCount,
    runtime,
    checkedAt,
    loaded,
    netError,
  } = state;

  const requestLines = logs.filter((l) => typeof l.status === "number");
  const errorLines = requestLines.filter((l) => (l.status ?? 0) >= 400);
  const durations = logs
    .map((l) => l.durationMs)
    .filter((d): d is number => typeof d === "number");
  const avg = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  return (
    <div>
      <PageHeader
        title="Status"
        subtitle="Process topology, saturation, limits, and live traffic"
        actions={
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh"
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
        }
      />

      {netError && (
        <Banner
          tone="error"
          className="mb-4"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
            >
              Retry
            </Button>
          }
        >
          Could not reach the gateway API. Check that the server is running,
          then retry.
        </Banner>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          loading={!loaded}
          label="Total requests"
          value={String(requestLines.length)}
        />
        <StatTile
          loading={!loaded}
          label="Error rate"
          value={requestLines.length === 0
            ? "-"
            : `${
              ((errorLines.length / requestLines.length) * 100).toFixed(1)
            }%`}
        />
        <StatTile
          loading={!loaded}
          label="Avg duration"
          value={avg === null ? "-" : `${avg} ms`}
        />
        <StatTile
          loading={!loaded}
          label="Providers"
          value={providerCount === null ? "-" : String(providerCount)}
          caption={providerCount === null
            ? "unavailable"
            : `${enabledCount} enabled`}
        />
        <StatTile
          loading={!loaded}
          label="MCP servers"
          value={mcpCount === null ? "-" : String(mcpCount)}
          caption={mcpCount === null ? "unavailable" : undefined}
        />
        <StatTile
          loading={!loaded}
          label="Virtual keys"
          value={vkCount === null ? "-" : String(vkCount)}
          caption={vkCount === null
            ? "unavailable"
            : vkCount > 0
            ? "governance on"
            : "governance off"}
        />
      </div>
      <p className="mb-6 text-xs text-muted-foreground">
        Derived from the last {logs.length}{" "}
        in-memory log entries (max 500), resets on gateway restart.
      </p>

      <RuntimeSection runtime={runtime} loaded={loaded} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Gateway health</CardTitle>
        </CardHeader>
        <CardContent>
          {health
            ? (
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={health.status === "ok" ? "ok" : "err"}>
                  {health.status}
                </Badge>
                {version
                  ? (
                    <span className="font-mono text-sm">
                      {`gateway v${version.version} on Deno ${version.deno}`}
                    </span>
                  )
                  : (
                    <span className="text-sm text-muted-foreground">
                      runtime version pending
                    </span>
                  )}
                {checkedAt && (
                  <span className="text-xs text-muted-foreground">
                    checked {checkedAt}
                  </span>
                )}
              </p>
            )
            : <PanelSkeleton />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model catalog</CardTitle>
          <span className="text-sm text-muted-foreground">
            {models.length} models
          </span>
        </CardHeader>
        <CardContent>
          {governedNote && (
            <p className="mb-3 text-sm text-muted-foreground">
              Live catalog requires a virtual key, showing configured models
              instead.
            </p>
          )}
          {!loaded
            ? <TableSkeleton cols={2} />
            : models.length === 0
            ? (
              <p className="text-sm text-muted-foreground">
                No models advertised yet. Add a provider on the Providers
                screen, then use its Refresh models action.
              </p>
            )
            : (
              <ScrollContainer label="Model catalog" minWidth="24rem">
                <Table>
                  <TableCaption>Model catalog</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Provider</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {models.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono">{m.id}</TableCell>
                        <TableCell>{m.owned_by}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollContainer>
            )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Formats a measured duration; sub-second values keep millisecond detail. */
function durationLabel(ms: number): string {
  if (ms <= 0) return "0";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Formats a window length as the unit an operator actually thinks in. */
function windowLabel(ms: number): string {
  if (ms <= 0) return "-";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms} ms`;
}

function uptimeLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Process topology, saturation, and limit state.
 *
 * Two numbers here are PER-PROCESS and are labelled as such on the tile itself,
 * not only in a footnote. Under FROSTY_WORKERS=N the kernel spreads connections
 * across N processes, so an unqualified "12 in flight" reads as fleet-wide and
 * under-reports load by a factor of N. Budgets are not affected - those run on
 * shared atomic counters - which is why only concurrency and the rate-limit
 * windows carry the qualifier.
 */
function RuntimeSection(
  { runtime, loaded }: { runtime: RuntimeView | null; loaded: boolean },
) {
  const multi = (runtime?.workers.effective ?? 1) > 1;
  const scopeCaption = multi ? "this worker only" : "single process";

  return (
    <>
      <h3 className="mb-3 text-sm font-semibold text-foreground">Runtime</h3>
      <div className="mb-2 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          loading={!loaded}
          label="Worker processes"
          value={runtime === null ? "-" : String(runtime.workers.effective)}
          caption={runtime === null
            ? "unavailable"
            : runtime.workers.configured !== runtime.workers.effective
            // Configured != effective means the platform refused to fan out
            // (no SO_REUSEPORT). Say so on the tile rather than showing a
            // number that silently disagrees with the operator's env var.
            ? `${runtime.workers.configured} requested, ${runtime.workers.platform} limit`
            : runtime.workers.index !== null
            ? `worker ${runtime.workers.index}`
            : "sharing one port"}
        />
        <StatTile
          loading={!loaded}
          label="Connections open"
          value={runtime === null ? "-" : String(runtime.concurrency.active)}
          caption={runtime === null
            ? "unavailable"
            : `peak ${runtime.concurrency.peak}, ${scopeCaption}`}
        />
        <StatTile
          loading={!loaded}
          label="Longest open"
          value={runtime === null
            ? "-"
            : durationLabel(runtime.concurrency.longestOpenMs)}
          caption={runtime === null
            ? "unavailable"
            : runtime.concurrency.active === 0
            ? "nothing open"
            : "oldest live connection"}
        />
        <StatTile
          loading={!loaded}
          label="Avg lifetime"
          value={runtime === null
            ? "-"
            : durationLabel(runtime.concurrency.avgLifetimeMs)}
          caption={runtime === null
            ? "unavailable"
            : runtime.concurrency.completed === 0
            ? "no completed connections"
            : `last ${Math.min(runtime.concurrency.completed, 1000)}, max ${
              durationLabel(runtime.concurrency.maxLifetimeMs)
            }`}
        />
        <StatTile
          loading={!loaded}
          label="Dispatching"
          value={runtime === null
            ? "-"
            : String(runtime.concurrency.dispatching)}
          caption={runtime === null
            ? "unavailable"
            : "handlers executing, excludes streaming"}
        />
        <StatTile
          loading={!loaded}
          label="Rate-limited keys"
          value={runtime === null
            ? "-"
            : `${runtime.rateLimit.keysWithLimits}/${runtime.rateLimit.totalKeys}`}
          caption={runtime === null
            ? "unavailable"
            : !runtime.rateLimit.enforced
            ? "no limits set"
            : runtime.rateLimit.scope === "fleet"
            ? "fleet-wide"
            : scopeCaption}
        />
        <StatTile
          loading={!loaded}
          label="DB connections"
          value={runtime === null
            ? "-"
            : String(runtime.postgres.estimatedFleetConnections)}
          caption={runtime === null
            ? "unavailable"
            : `${runtime.postgres.poolSize} per process`}
        />
        <StatTile
          loading={!loaded}
          label="Uptime"
          value={runtime === null
            ? "-"
            : uptimeLabel(runtime.process.uptimeSeconds)}
          caption={runtime === null ? "unavailable" : "this process"}
        />
      </div>

      {runtime !== null && multi && (
        <p className="mb-6 text-xs text-muted-foreground">
          Connection counts and lifetimes are measured{" "}
          <strong className="font-medium text-foreground">per process</strong>
          {" "}
          - with {runtime.workers.effective}{" "}
          workers the fleet-wide figure is higher.{" "}
          {runtime.rateLimit.scope === "fleet"
            ? "Rate limits and budgets are fleet-wide: every worker reserves against one shared counter."
            : `A per-window rate limit admits up to ${runtime.workers.effective} times its stated value. Budgets are unaffected: those use shared counters.`}
        </p>
      )}
      {runtime !== null && !multi && (
        <p className="mb-6 text-xs text-muted-foreground">
          {runtime.workers.reason}
        </p>
      )}

      {runtime !== null && runtime.rateLimit.windows.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Rate limits</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollContainer label="Rate limits">
              <Table>
                <TableCaption>
                  Per-key request windows, enforced per process
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Virtual key</TableHead>
                    <TableHead align="right">Max requests</TableHead>
                    <TableHead align="right">Window</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runtime.rateLimit.windows.map((w) => (
                    <TableRow key={w.keyId}>
                      <TableCell className="font-mono">{w.keyId}</TableCell>
                      <TableCell align="right" className="font-mono">
                        {w.maxRequests ?? "-"}
                      </TableCell>
                      <TableCell align="right" className="font-mono">
                        {windowLabel(w.windowMs)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollContainer>
          </CardContent>
        </Card>
      )}

      {runtime !== null && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Shared state</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">PostgreSQL</span>
              <span className="font-mono text-foreground">
                {runtime.postgres.target}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                Cross-process invalidation
              </span>
              <Badge tone={runtime.postgres.listenerActive ? "ok" : "warn"}>
                {runtime.postgres.listenerActive ? "listening" : "not active"}
              </Badge>
              {!runtime.postgres.listenerActive && (
                <span className="text-xs text-muted-foreground">
                  other workers keep cached entries until TTL
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Response cache</span>
              <Badge tone={runtime.cache.mode === "off" ? "muted" : "ok"}>
                {runtime.cache.mode}
              </Badge>
              {runtime.cache.mode !== "off" && (
                <span className="text-xs text-muted-foreground">
                  {runtime.cache.localEntries} entries in this process
                  {runtime.cache.sharedTier ? ", shared tier attached" : ""}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
