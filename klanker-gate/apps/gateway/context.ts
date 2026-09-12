import { fromFileUrl } from "@std/path";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import {
  LogBus,
  logExcludedPathsFromEnv,
} from "../../packages/telemetry/src/logbus.ts";
import { LogEnrichmentBridge } from "../../packages/telemetry/src/logenrich.ts";
import { LogStore } from "../../packages/telemetry/src/logstore.ts";
import { OtelExporter } from "../../packages/telemetry/src/otel.ts";
import {
  modelCardinalityCapFromEnv,
  SpanModelCardinalityGuard,
} from "../../packages/telemetry/src/span_cardinality.ts";
import { UsageTracker } from "../../packages/telemetry/src/usagestore.ts";
import { ConcurrencyGauge } from "../../packages/telemetry/src/concurrency.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import { ProviderBudgetTracker } from "../../packages/governance/src/provider_budgets.ts";
import { PricingCatalog } from "../../packages/governance/src/pricing.ts";
import { BudgetEpochStore } from "../../packages/governance/src/budget_epochs.ts";
import {
  pruneRateWindows,
  SharedRateLimiter,
} from "../../packages/governance/src/shared_rate_limit.ts";
import { syncPricingFromLiteLLM } from "../../packages/governance/src/pricing_sync.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { MCPHealthMonitor } from "../../packages/mcp/src/monitor.ts";
import { initCodeModeCapability } from "../../packages/mcp/src/codemode/executor.ts";
import { appGateOn as codeModeAppGateOn } from "../../packages/mcp/src/codemode/flag.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";
import type { VectorStore } from "../../packages/cache/src/vector.ts";
import {
  PgCacheStore,
  runCacheJanitor,
} from "../../packages/cache/src/pg_cache.ts";
import { InvalidationBus } from "../../packages/cache/src/invalidation.ts";
import type { ToolExecutor } from "../../packages/core/src/mod.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import {
  assertDirectUrlDistinct,
  assertReachable,
  openPg,
  pgDirectUrlFromEnv,
  pgUrlFromEnv,
  poolSizeFromEnv,
} from "../../packages/config/src/pg.ts";
import { PostgresStateStore } from "../../packages/config/src/store_postgres.ts";
import {
  defaultProviderFromEnv,
  loadProvidersFromEnv,
} from "../../packages/config/src/env.ts";
import { SettingsStore } from "./routes/settings_store.ts";
import { ConfigCrypto } from "../../packages/config/src/crypto.ts";
import {
  jsonRepairEnabledFromEnv,
  jsonRepairPlugin,
} from "../../packages/plugins/src/jsonparser.ts";
import {
  loadMockerConfigFromEnv,
  mockerEnabledFromEnv,
  mockerPlugin,
} from "../../packages/plugins/src/mocker.ts";

export const VERSION = "0.9.0";

/** Default executor: owns no tools, so all tool calls pass through to the client. */
export class NullToolExecutor implements ToolExecutor {
  has(_name: string): boolean {
    return false;
  }
  isSideEffect(_name: string): boolean {
    return false;
  }
  execute(_name: string, _args: unknown): Promise<string> {
    return Promise.reject(new Error("no gateway tools registered"));
  }
}

export interface AppContext {
  providers: ProviderManager;
  metrics: Metrics;
  logBus: LogBus;
  /** Durable PostgreSQL request-log store (FROSTY_LOG_STORE=pg). */
  logStore?: LogStore;
  /**
   * Carries provider/model/token/cost from the innermost telemetry middleware
   * out to the request-log trail, which otherwise only sees method/path/status.
   * See packages/telemetry/src/logenrich.ts for the ordering contract.
   *
   * Optional for the same reason as {@link AppContext.logStore}: both context
   * factories always populate it, and the only contexts that omit it are the
   * hand-built literals in tests. Absent, log entries simply carry no inference
   * fields - byte-identical to the behavior before enrichment existed.
   */
  logEnrichment?: LogEnrichmentBridge;
  /**
   * True for paths kept OUT of the dashboard log trail (FROSTY_LOG_EXCLUDE_PATHS,
   * default `/healthz,/metrics,/favicon.ico`). Machine probes would otherwise
   * dominate the capped trail. Console access logging is unaffected.
   *
   * Optional on the same grounds as {@link AppContext.logEnrichment}; absent,
   * nothing is excluded.
   */
  logExcludedPath?: (path: string | undefined) => boolean;
  /** OTLP/HTTP trace exporter (OTEL_EXPORTER_OTLP_ENDPOINT). */
  otel?: OtelExporter;
  /**
   * Bounds the distinct model values promoted to span-derived METRIC labels
   * (`frosty.metrics.model`). The span itself keeps the real model id, so
   * Tempo drill-down is unaffected. Present only when `otel` is.
   */
  spanCardinality?: SpanModelCardinalityGuard;
  /** Always-on per-request usage tracker feeding /api/analytics. */
  usage?: UsageTracker;
  /**
   * In-flight request gauge for THIS process, surfaced by GET /api/runtime.
   * Optional so hand-built test contexts stay valid; the metrics middleware
   * guards every call with `?.`.
   */
  concurrency?: ConcurrencyGauge;
  virtualKeys: VirtualKeyManager;
  /** Teams/customers hierarchy for budget collection up the chain. */
  hierarchy?: GovernanceHierarchy;
  /** Per-provider request, token, and cost limits with durable counter sinks. */
  providerBudgets?: ProviderBudgetTracker;
  /** Model pricing feeding $-cost budgets and cost metrics. */
  pricing?: PricingCatalog;
  /** Durable authority for opt-in scheduled governance budgets. */
  budgetEpochs?: BudgetEpochStore;
  /**
   * Fleet-wide fixed-window rate limiting. Present only on the production path,
   * where a shared store exists. When set, `VirtualKeyManager` stands its own
   * in-process windows down so exactly one authority counts
   * (TODO.md D-SHARED-RATE-LIMIT).
   */
  sharedRateLimit?: SharedRateLimiter;
  mcp: MCPRegistry;
  /** Per-client MCP health (on-demand via /api/mcp/health; timer opt-in). */
  mcpMonitor?: MCPHealthMonitor;
  /**
   * Boot verdict of the Code Mode worker-permission enforceability probe. Only
   * populated (probe only spawned) when `FROSTY_CODE_MODE=on`; stays `false`
   * otherwise. The runtime gate reads the memoized flag, not this field — this
   * is for health/observability.
   */
  codeModeCapable?: boolean;
  plugins: PluginManager;
  /** Present when response caching is enabled (FROSTY_CACHE=exact|semantic). */
  cache?: SemanticCache;
  /**
   * Cross-process invalidation fanout. Present on the production path; absent
   * in unit-test contexts, where there is only one process and nothing to fan
   * out to. Every call site uses `?.` for exactly that reason.
   */
  invalidation?: InvalidationBus;
  toolExecutor: ToolExecutor;
  version: string;
  /** Present when a persistent config store is attached. */
  config?: ConfigService;
  adminToken?: string;
  /** Absolute path of the built control-plane UI, when served same-origin. */
  uiRoot?: string;
  /**
   * Releases every resource this context owns (connection pools, the LISTEN
   * subscription, background timers). Called on SIGINT/SIGTERM so a rolling
   * restart returns its PostgreSQL connections instead of waiting for them to
   * time out server-side.
   */
  shutdown?: () => Promise<void>;
}

/**
 * stdio (subprocess) MCP servers are opt-in (decision D10): only an explicit
 * FROSTY_MCP_ALLOW_STDIO=1|true unlocks them, and --allow-run is still
 * required at the permission layer.
 */
function allowStdioFromEnv(): boolean {
  const value = (Deno.env.get("FROSTY_MCP_ALLOW_STDIO") ?? "").toLowerCase();
  return value === "1" || value === "true";
}

/** Env-only context (no persistence). Used directly by unit tests. */
/**
 * Builds the telemetry -> log-trail bridge together with its late-patch sink.
 *
 * A streamed response only resolves its token/cost figures when the SSE tap
 * flushes, which is after the request logger has already published and appended
 * the entry. The sink patches that entry in place, by request id, in the live
 * ring and (when durable storage is on) the stored row.
 */
export function createLogEnrichment(
  logBus: LogBus,
  logStore?: LogStore,
): LogEnrichmentBridge {
  const bridge = new LogEnrichmentBridge();
  bridge.setLateSink((requestId, enrichment) => {
    logBus.update(requestId, enrichment);
    logStore?.update(requestId, enrichment).catch(() => {
      // The durable trail must never block or fail a request.
    });
  });
  return bridge;
}

export function createContext(): AppContext {
  const mcp = new MCPRegistry([], undefined, {
    allowStdio: allowStdioFromEnv(),
  });
  const metrics = new Metrics();
  const pricing = new PricingCatalog();
  const providerBudgets = new ProviderBudgetTracker();
  // Bound the model metric label to the known catalog from the start.
  metrics.setKnownModels(pricing.modelKeys());
  const plugins = new PluginManager();
  // Opt-in JSON repair (default OFF; enable with FROSTY_JSON_REPAIR=on). The
  // stream sink only records a metric; the live client stream is untouched.
  if (jsonRepairEnabledFromEnv()) {
    plugins.register(jsonRepairPlugin({
      onStreamRepair: () =>
        metrics.increment("plugins.jsonparser.stream_repaired"),
    }));
  }
  if (mockerEnabledFromEnv()) {
    plugins.register(mockerPlugin(loadMockerConfigFromEnv()));
  }
  const logBus = new LogBus();
  return {
    mcpMonitor: new MCPHealthMonitor(mcp),
    providers: new ProviderManager(
      loadProvidersFromEnv(),
      defaultProviderFromEnv(),
      providerBudgets,
    ),
    metrics,
    logBus,
    logEnrichment: createLogEnrichment(logBus),
    logExcludedPath: logExcludedPathsFromEnv(),
    usage: new UsageTracker(),
    concurrency: new ConcurrencyGauge(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    budgetEpochs: new BudgetEpochStore(),
    providerBudgets,
    pricing,
    mcp,
    plugins,
    toolExecutor: mcp.executor(),
    version: VERSION,
  };
}

/**
 * Production context: opens PostgreSQL, seeds providers from env, then overlays
 * the persisted configuration (persisted accounts win on id collisions).
 *
 * PostgreSQL is a HARD dependency. An unreachable database aborts boot rather
 * than degrading to an empty in-memory store - the same fail-closed rule the
 * crypto boot and the durable budget authority already follow. A replica that
 * came up "healthy" with no governance state would serve unmetered traffic
 * against budgets it cannot see.
 */
export async function createDefaultContext(): Promise<AppContext> {
  const pg = await openPg({
    url: pgUrlFromEnv(),
    max: poolSizeFromEnv(),
    applicationName: "frosty-gateway",
  });
  await assertReachable(pg);
  assertDirectUrlDistinct();

  const stateStore = new PostgresStateStore(pg);
  await stateStore.init();
  const config = new ConfigService(stateStore);
  config.setCrypto(await ConfigCrypto.fromEnv(config.raw()));
  const persisted = await config.loadAll();
  const globalProxy = await config.getGlobalProxy();

  const providerBudgets = new ProviderBudgetTracker();
  const providers = new ProviderManager(
    loadProvidersFromEnv(),
    persisted.defaultProvider ?? defaultProviderFromEnv(),
    providerBudgets,
    globalProxy,
  );
  for (const account of persisted.providers) {
    providers.upsert(account);
  }

  const uiRoot = new URL("../control-ui/dist", import.meta.url);
  let uiRootPath: string | undefined;
  try {
    if (Deno.statSync(uiRoot).isDirectory) {
      uiRootPath = fromFileUrl(uiRoot);
    }
  } catch {
    uiRootPath = undefined; // UI not built; API-only mode
  }

  const mcp = new MCPRegistry(await config.listMCPClients(), undefined, {
    allowStdio: allowStdioFromEnv(),
  });
  try {
    await mcp.syncAll(); // boot sync; individual clients can re-sync via API
  } catch (error) {
    console.error("MCP boot sync failed:", error);
  }
  const mcpMonitor = new MCPHealthMonitor(mcp);
  const healthInterval = Number(
    Deno.env.get("FROSTY_MCP_HEALTH_INTERVAL_MS") ?? 0,
  );
  if (healthInterval > 0) {
    mcpMonitor.start(healthInterval);
  }

  let codeModeCapable = false;
  if (codeModeAppGateOn()) {
    try {
      codeModeCapable = await initCodeModeCapability();
    } catch (error) {
      console.error(
        "Code Mode capability probe failed (executor stays off):",
        error,
      );
      codeModeCapable = false;
    }
  }

  const cacheMode = Deno.env.get("FROSTY_CACHE");
  let vectorStore: VectorStore | undefined;
  // Only the semantic cache consumes vectors: without it, building the store
  // would create tables nothing reads.
  const storeKind = cacheMode === "semantic"
    ? Deno.env.get("FROSTY_VECTOR_STORE")
    : undefined;
  if (storeKind === "pgvector") {
    const { PgVectorStore } = await import(
      "../../packages/cache/src/pgvector.ts"
    );
    // Reuses the pool opened above rather than dialing a second time: the
    // embedding index is a table in the same database as the state and the
    // cache, which is the entire point of the consolidation.
    vectorStore = new PgVectorStore({
      executor: pg,
      table: Deno.env.get("FROSTY_PG_TABLE") ?? undefined,
    });
  }
  let embedder: ((text: string) => Promise<number[]>) | undefined;
  if (cacheMode === "semantic") {
    const embedModel = Deno.env.get("FROSTY_CACHE_EMBED_MODEL") ??
      "text-embedding-3-small";
    embedder = async (text: string) => {
      const target = providers.resolve(embedModel);
      if (!target.adapter.embeddings) {
        throw new Error(
          `Provider "${target.providerId}" has no embeddings surface for ` +
            `the semantic cache.`,
        );
      }
      const response = await target.adapter.embeddings({
        model: target.model,
        input: text,
      });
      const body = await response.json() as {
        data?: Array<{ embedding: number[] }>;
      };
      return body.data?.[0]?.embedding ?? [];
    };
  }
  const metrics = new Metrics();
  const cacheEnabled = cacheMode === "exact" || cacheMode === "semantic";

  let cacheStore: PgCacheStore | undefined;
  const janitorAbort = new AbortController();
  if (cacheEnabled) {
    cacheStore = new PgCacheStore({
      executor: pg,
      onError: (operation, error) => {
        // Fail-open is already handled inside the store; this only makes a
        // silently broken L2 visible instead of looking like a cold cache.
        metrics.increment("cache.l2_failures");
        console.warn(
          `L2 cache ${operation} failed (degraded to process-local): ${
            error instanceof Error ? error.message : error
          }`,
        );
      },
    });
    await cacheStore.init();
    // PostgreSQL has no active expiry cycle: expired rows are invisible to
    // reads but stay on disk until something deletes them.
    void runCacheJanitor(cacheStore, janitorAbort.signal);
  }

  const cache = cacheEnabled
    ? new SemanticCache({
      ttlMs: Number(Deno.env.get("FROSTY_CACHE_TTL_MS")) || undefined,
      embedder,
      vectorStore,
      cacheStore,
    })
    : undefined;

  // Re-apply any persisted caching overrides (PUT /api/settings) so runtime
  // Cache key/tuning overrides survive a restart. Cache creation remains an
  // environment decision; these controls only tune an already-enabled cache.
  if (cache) {
    const cachingOverride = await new SettingsStore(config.raw())
      .getOverride("caching") as
        | {
          ttlSeconds?: number;
          similarityThreshold?: number;
          cacheByProvider?: boolean;
          cacheByModel?: boolean;
          excludeSystemPrompt?: boolean;
          conversationHistoryThreshold?: number;
        }
        | null;
    if (cachingOverride) {
      cache.configure({
        ttlMs: cachingOverride.ttlSeconds !== undefined
          ? cachingOverride.ttlSeconds * 1000
          : undefined,
        similarityThreshold: cachingOverride.similarityThreshold,
        cacheByProvider: cachingOverride.cacheByProvider,
        cacheByModel: cachingOverride.cacheByModel,
        excludeSystemPrompt: cachingOverride.excludeSystemPrompt,
        conversationHistoryThreshold:
          cachingOverride.conversationHistoryThreshold,
      });
    }
  }

  // Fire-and-forget persistence must stay off the hot path, but failures
  // cannot stay invisible: stale durable counters silently re-open
  // exhausted budgets on the next boot. Log once, count every failure.
  let sinkFailureLogged = false;
  const sinkFailure = (what: string) => (error: unknown) => {
    metrics.increment("persistence.sink_failures");
    if (!sinkFailureLogged) {
      sinkFailureLogged = true;
      console.error(
        `durable ${what} counter write failed (budgets may regress on ` +
          `restart): ${error instanceof Error ? error.message : error}`,
      );
    }
  };

  const virtualKeys = new VirtualKeyManager(await config.listVirtualKeys());
  virtualKeys.hydrateUsage(await config.loadUsage());
  virtualKeys.hydrateCost(await config.loadCosts());
  virtualKeys.onUsage((id) => {
    config.addUsage(id).catch(sinkFailure("usage"));
  });
  virtualKeys.onCost((id, microUsd) => {
    config.addCost(id, microUsd).catch(sinkFailure("cost"));
  });

  const hierarchy = new GovernanceHierarchy(
    await config.listTeams(),
    await config.listCustomers(),
  );
  hierarchy.hydrate(
    "team",
    await config.loadCounters("team-usage"),
    await config.loadCounters("team-cost"),
  );
  hierarchy.hydrate(
    "customer",
    await config.loadCounters("customer-usage"),
    await config.loadCounters("customer-cost"),
  );
  hierarchy.onAccount((kind, id, field, amount) => {
    config.addCounter(`${kind}-${field}`, id, amount).catch(
      sinkFailure(`${kind} ${field}`),
    );
  });
  const budgetEpochs = new BudgetEpochStore(config.raw());

  providerBudgets.hydrate(
    "requests",
    await config.loadCounters("provider-requests"),
    await config.loadAnchors("provider-requests"),
  );
  providerBudgets.hydrate(
    "tokens",
    await config.loadCounters("provider-tokens"),
    await config.loadAnchors("provider-tokens"),
  );
  providerBudgets.hydrate(
    "cost",
    await config.loadCounters("provider-cost"),
    await config.loadAnchors("provider-cost"),
  );
  providerBudgets.onRecord((dimension, id, amount) => {
    config.addCounter(`provider-${dimension}`, id, amount).catch(
      sinkFailure(`provider ${dimension}`),
    );
  });
  providerBudgets.onAnchor((dimension, id, windowStart) => {
    config.setAnchor(`provider-${dimension}`, id, windowStart).catch(
      sinkFailure(`provider ${dimension} anchor`),
    );
  });

  const pricing = new PricingCatalog();
  const persistedPricing = await config.loadPricing();
  if (persistedPricing) {
    pricing.replace(persistedPricing);
  }
  // Bound the model metric label to the known catalog.
  metrics.setKnownModels(pricing.modelKeys());

  // Opt-in LiteLLM pricing sync (DEFAULT OFF to keep the offline/no-outbound
  // default). Sync applies upstream prices FIRST, then re-applies the persisted
  // /api/pricing overrides so operator prices always win.
  if ((Deno.env.get("FROSTY_PRICING_SYNC") ?? "").toLowerCase() === "on") {
    const runSync = async () => {
      // Reload operator overrides each run so a runtime PUT /api/pricing is not
      // reverted by the next scheduled sync (matches the force-sync path).
      const overrides = (await config.loadPricing().catch(() => null)) ??
        undefined;
      return await syncPricingFromLiteLLM(pricing, { metrics, overrides })
        .then(() => metrics.setKnownModels(pricing.modelKeys()))
        .catch(() => {
          // Sync must never throw into boot; failures are counted internally.
        });
    };
    void runSync(); // initial, non-blocking
    const rawInterval = Number(Deno.env.get("FROSTY_PRICING_SYNC_INTERVAL_MS"));
    // Clamp tiny/invalid intervals: default 24h, floor 60s.
    const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.max(rawInterval, 60_000)
      : 86_400_000;
    setInterval(runSync, intervalMs);
  }

  const logStoreMode = (Deno.env.get("FROSTY_LOG_STORE") ?? "pg")
    .trim().toLowerCase();
  const logStoreOff = ["off", "none", "0", "false", "disabled"].includes(
    logStoreMode,
  );
  const logStore = logStoreOff ? undefined : new LogStore(
    config.raw(),
    Number(Deno.env.get("FROSTY_LOG_STORE_MAX")) || undefined,
  );

  // Usage tracker: always-present in-memory ring, plus durable persistence
  // since a state store is attached here.
  const usage = new UsageTracker(config.raw());
  const concurrency = new ConcurrencyGauge();

  const otlpEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  let otel: OtelExporter | undefined;
  let spanCardinality: SpanModelCardinalityGuard | undefined;
  if (otlpEndpoint) {
    spanCardinality = new SpanModelCardinalityGuard(
      modelCardinalityCapFromEnv(),
    );
    otel = new OtelExporter(otlpEndpoint);
    // Guard against 0/negative/NaN intervals: setInterval clamps them to
    // ~0ms, which turns the flusher into a busy loop.
    const flushMs = Number(Deno.env.get("OTEL_FLUSH_INTERVAL_MS"));
    otel.start(Number.isFinite(flushMs) && flushMs >= 100 ? flushMs : 5000);
  }

  const plugins = new PluginManager();
  // Opt-in JSON repair (default OFF; enable with FROSTY_JSON_REPAIR=on). The
  // stream sink only records a metric; the live client stream is untouched.
  if (jsonRepairEnabledFromEnv()) {
    plugins.register(jsonRepairPlugin({
      onStreamRepair: () =>
        metrics.increment("plugins.jsonparser.stream_repaired"),
    }));
  }
  if (mockerEnabledFromEnv()) {
    plugins.register(mockerPlugin(loadMockerConfigFromEnv()));
  }
  const logBus = new LogBus();

  // Fleet-wide rate limiting, enabled only where it is actually needed.
  //
  // MEASURED (docs/benchmark-report.md; TODO.md D-SHARED-RATE-LIMIT): a shared
  // reservation costs ~1.8 ms at 50 concurrent against local PostgreSQL,
  // versus ~1 us for the in-process Map.
  // In SINGLE-process mode the Map is already fleet-accurate - one process is
  // the whole fleet - so paying that would buy nothing. It is therefore on by
  // default only when this process is one of several sharing the port, and
  // forceable either way for operators running separate replicas.
  const sharedRateLimit = sharedRateLimitEnabled()
    ? new SharedRateLimiter(stateStore)
    : undefined;
  virtualKeys.useExternalRateLimit(sharedRateLimit !== undefined);
  // Expired windows are unreachable but not self-removing, so without a sweep
  // the counters table grows one row per key per window forever.
  const rateWindowSweep = sharedRateLimit === undefined
    ? undefined
    : setInterval(() => {
      pruneRateWindows(stateStore)
        .then((removed) => {
          if (removed > 0) {
            metrics.increment("governance.rate_windows_pruned");
          }
        })
        .catch(() => {
          // Growth is a maintenance problem, never a request-path failure.
        });
    }, 600_000);
  if (rateWindowSweep !== undefined) {
    Deno.unrefTimer(rateWindowSweep);
  }

  const listener = await openListenerConnection();
  const invalidation = new InvalidationBus({
    publisher: pg,
    listener,
    handlers: {
      onCacheInvalidated: () => {
        const dropped = cache?.clearLocal() ?? 0;
        if (dropped > 0) {
          metrics.increment("cache.remote_invalidations");
        }
      },
      onConfigChanged: async () => {
        await reloadConfigInto(
          { config, providers, virtualKeys, hierarchy },
          metrics,
        );
        metrics.increment("config.remote_reloads");
      },
    },
  });
  await invalidation.start();

  // Every mutation announces itself, so peers converge in milliseconds.
  config.setMutationListener(() => invalidation.publishConfigChanged());

  // Backstop. NOTIFY is best-effort: a publish can fail, a listener can miss
  // events across a reconnect, and a worker that boots mid-write starts stale.
  // For a security property - a revoked key must stop working - "usually
  // instant" is not a guarantee, so staleness is also bounded by a poll.
  const reconcileMs = reconcileIntervalFromEnv();
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  if (reconcileMs > 0) {
    const timer = setInterval(() => {
      void reloadConfigInto(
        { config, providers, virtualKeys, hierarchy },
        metrics,
      )
        .then(() => metrics.increment("config.reconciles"))
        .catch((error) => {
          metrics.increment("config.reconcile_failures");
          console.warn(
            `config reconcile failed: ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
    }, reconcileMs);
    // Never hold the process open for a background refresh.
    Deno.unrefTimer(timer);
    reconcileTimer = timer;
  }

  return {
    providers,
    metrics,
    logBus,
    logStore,
    logEnrichment: createLogEnrichment(logBus, logStore),
    logExcludedPath: logExcludedPathsFromEnv(),
    otel,
    spanCardinality,
    usage,
    concurrency,
    virtualKeys,
    hierarchy,
    budgetEpochs,
    sharedRateLimit,
    providerBudgets,
    pricing,
    mcp,
    mcpMonitor,
    codeModeCapable,
    plugins,
    cache,
    invalidation,
    toolExecutor: mcp.executor(),
    version: VERSION,
    config,
    adminToken: Deno.env.get("FROSTY_ADMIN_TOKEN") ?? undefined,
    uiRoot: uiRootPath,
    shutdown: async () => {
      janitorAbort.abort();
      if (rateWindowSweep !== undefined) {
        clearInterval(rateWindowSweep);
      }
      if (reconcileTimer !== undefined) {
        clearInterval(reconcileTimer);
      }
      config.setMutationListener(undefined);
      await invalidation.stop();
      await listener?.end({ timeout: 5 }).catch(() => {});
      mcpMonitor.stop?.();
      await pg.close().catch(() => {});
    },
  };
}

/**
 * Opens the dedicated session connection used for LISTEN, or returns undefined
 * when one cannot be established.
 *
 * Undefined rather than throwing: cross-process invalidation is a fanout
 * OPTIMIZATION on top of an authoritative shared store. Losing it means other
 * replicas hold stale L1 entries until their TTL expires - degraded, not
 * incorrect - and that is not worth refusing to serve traffic over. The pooled
 * connection that the actual data depends on was already asserted reachable.
 */
async function openListenerConnection() {
  try {
    const postgres = await import("postgres");
    return postgres.default(pgDirectUrlFromEnv(), {
      // Exactly one connection, never reaped: LISTEN registration is session
      // state and dies with the socket.
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      connection: { application_name: "frosty-invalidation-listener" },
    }) as unknown as import("../../packages/config/src/pg_types.ts").Sql;
  } catch (error) {
    console.warn(
      `invalidation listener unavailable; other replicas will hold cached ` +
        `entries until TTL: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

/** Bound on how stale a peer's config may get when a NOTIFY is lost. */
const DEFAULT_RECONCILE_MS = 30_000;

/**
 * Bounded parse for FROSTY_CONFIG_RECONCILE_MS. `0` disables the poll and
 * leaves propagation entirely to LISTEN/NOTIFY.
 */
export function reconcileIntervalFromEnv(
  raw = Deno.env.get("FROSTY_CONFIG_RECONCILE_MS"),
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RECONCILE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3_600_000) {
    return DEFAULT_RECONCILE_MS;
  }
  return parsed;
}

/** The in-memory state a config reload has to bring back in step. */
export interface ReloadTargets {
  config: ConfigService;
  providers: ProviderManager;
  virtualKeys: VirtualKeyManager;
  hierarchy?: GovernanceHierarchy;
}

/**
 * Re-reads durable config into this process. Additions, policy edits, and
 * REMOVALS all apply - an upsert-only reload cannot propagate a revocation,
 * which is the whole point.
 *
 * Usage counters are reconciled to the HIGHER of durable and in-memory. A
 * reconcile races in-flight reservations, and lowering a counter would re-open
 * an exhausted budget; fail-closed says never admit more because of a refresh.
 */
export async function reloadConfigInto(
  targets: ReloadTargets,
  metrics?: { increment: (name: string) => void },
): Promise<void> {
  const { config, providers, virtualKeys, hierarchy } = targets;

  const durable = await config.loadAll();
  const liveProviderIds = new Set(durable.providers.map((p) => p.id));
  for (const account of durable.providers) {
    providers.upsert(account);
  }
  for (const account of providers.list()) {
    if (!liveProviderIds.has(account.id)) {
      providers.remove(account.id);
      metrics?.increment("config.providers_removed");
    }
  }

  const durableKeys = await config.listVirtualKeys();
  const liveKeyIds = new Set(durableKeys.map((k) => k.id));
  for (const key of durableKeys) {
    const current = virtualKeys.get(key.id);
    virtualKeys.upsert({
      ...key,
      usedRequests: Math.max(key.usedRequests ?? 0, current?.usedRequests ?? 0),
      usedCostMicroUsd: Math.max(
        key.usedCostMicroUsd ?? 0,
        current?.usedCostMicroUsd ?? 0,
      ),
    });
  }
  for (const key of virtualKeys.list()) {
    if (!liveKeyIds.has(key.id)) {
      virtualKeys.remove(key.id);
      metrics?.increment("config.keys_revoked");
    }
  }

  if (hierarchy) {
    const teams = await config.listTeams();
    const liveTeamIds = new Set(teams.map((t) => t.id));
    for (const team of teams) {
      const current = hierarchy.getTeam(team.id);
      hierarchy.upsertTeam({
        ...team,
        usedRequests: Math.max(
          team.usedRequests ?? 0,
          current?.usedRequests ?? 0,
        ),
        usedCostMicroUsd: Math.max(
          team.usedCostMicroUsd ?? 0,
          current?.usedCostMicroUsd ?? 0,
        ),
      });
    }
    for (const team of hierarchy.listTeams()) {
      if (!liveTeamIds.has(team.id)) {
        hierarchy.removeTeam(team.id);
      }
    }

    const customers = await config.listCustomers();
    const liveCustomerIds = new Set(customers.map((c) => c.id));
    for (const customer of customers) {
      const current = hierarchy.getCustomer(customer.id);
      hierarchy.upsertCustomer({
        ...customer,
        usedRequests: Math.max(
          customer.usedRequests ?? 0,
          current?.usedRequests ?? 0,
        ),
        usedCostMicroUsd: Math.max(
          customer.usedCostMicroUsd ?? 0,
          current?.usedCostMicroUsd ?? 0,
        ),
      });
    }
    for (const customer of hierarchy.listCustomers()) {
      if (!liveCustomerIds.has(customer.id)) {
        hierarchy.removeCustomer(customer.id);
      }
    }
  }
}

/**
 * Whether this process should reserve rate-limit windows against the shared
 * store rather than an in-process Map.
 *
 * `auto` (default) turns it on only when FROSTY_WORKERS puts more than one
 * process behind the port. A single process IS the whole fleet, so its Map is
 * already accurate and a ~1.8 ms round trip per governed request would buy
 * nothing (TODO.md D-SHARED-RATE-LIMIT). `on` forces it for operators running
 * separate replicas, which `auto` cannot detect; `off` accepts
 * N-times-the-limit.
 */
export function sharedRateLimitEnabled(
  raw = Deno.env.get("FROSTY_SHARED_RATE_LIMIT"),
  workers = Deno.env.get("FROSTY_WORKERS"),
): boolean {
  const mode = (raw ?? "auto").trim().toLowerCase();
  if (mode === "on" || mode === "1" || mode === "true") {
    return true;
  }
  if (mode === "off" || mode === "0" || mode === "false") {
    return false;
  }
  const count = Number(workers ?? "");
  return Number.isInteger(count) && count > 1;
}
