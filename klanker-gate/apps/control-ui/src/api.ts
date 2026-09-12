import type {
  ConfigExport,
  ProviderAccountConfig,
  ProviderAccountPublic,
} from "../../../packages/contracts/src/config.ts";
import type { LogEntry } from "../../../packages/telemetry/src/logbus.ts";

export type {
  ConfigExport,
  LogEntry,
  ProviderAccountConfig,
  ProviderAccountPublic,
};

/* ----------------------------- auth state ------------------------------ */

const TOKEN_KEY = "frosty.admin-token";

export type AuthState = "unknown" | "ok" | "denied";

let authState: AuthState = "unknown";
const authListeners = new Set<(state: AuthState) => void>();

function setAuthState(next: AuthState): void {
  if (next === authState) {
    return;
  }
  authState = next;
  for (const listener of authListeners) {
    listener(next);
  }
}

export function getAuthState(): AuthState {
  return authState;
}

export function subscribeAuth(
  listener: (state: AuthState) => void,
): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function hasAdminToken(): boolean {
  return Boolean(getAdminToken());
}

export function saveAdminToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable: the token lives for this page only
  }
  setAuthState("unknown");
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  setAuthState("unknown");
}

/* ------------------------------ transport ------------------------------ */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function isAdminSurface(path: string): boolean {
  return path.startsWith("/api/") || path === "/metrics";
}

async function extractError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: unknown };
    const err = body?.error;
    if (
      typeof err === "object" && err !== null &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
    if (typeof err === "string") {
      // Defensive fallback. The canonical envelope above is the contract; the
      // stored-logs 404 no longer uses a flat {error: string} body, and only
      // the pricing force-sync divergences (api-endpoints.md E2/E3) still do.
      return err;
    }
  } catch {
    // non-JSON body: fall through to the status line
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const admin = isAdminSurface(path);
  if (admin) {
    const token = getAdminToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  // fetch must receive a plain string URL (test mocks key on String(input)).
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    if (admin) {
      setAuthState("denied");
    }
    throw new ApiError(401, await extractError(res));
  }
  if (!res.ok) {
    throw new ApiError(res.status, await extractError(res));
  }
  if (admin) {
    setAuthState("ok");
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return await res.json() as T;
}

/* ------------------------------- shapes -------------------------------- */

export interface HealthInfo {
  status: string;
  version: string;
  timestamp: string;
}

export interface VersionInfo {
  version: string;
  deno: string;
}

export interface ModelInfo {
  id: string;
  object: string;
  owned_by: string;
}

export interface GatewayConfigView {
  defaultProvider?: string;
  providers: ProviderAccountPublic[];
  /** Operator EUR-per-USD display rate (FROSTY_EUR_RATE); micro-USD stays canonical. */
  eurRate?: number;
}

export interface MCPClientView {
  id: string;
  url?: string;
  enabled: boolean;
  /** Header names only. Stored values never leave the gateway. */
  headerNames: string[];
  transport?: "auto" | "streamable-http" | "http-sse" | "stdio";
  requestTimeoutMs?: number;
  /** True when a server-side stdio command is configured. */
  hasCommand: boolean;
  /** True when stored URL user-info was removed from `url`. */
  hasUrlCredentials: boolean;
  toolCount: number;
  lastSyncAt?: string;
}

export interface MCPClientInput {
  id: string;
  url?: string;
  enabled: boolean;
  headers?: Record<string, string>;
  transport?: string;
  requestTimeoutMs?: number;
  command?: string[];
}

export interface MCPToolView {
  name: string;
  description?: string;
  clientId: string;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface MCPHealthView {
  clientId: string;
  status: "healthy" | "unhealthy" | "disabled";
  toolCount: number;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt: string;
}

export interface LimitWindow {
  maxRequests?: number;
  maxTokens?: number;
  windowMs: number;
}

export interface Budget {
  maxRequests?: number;
  maxCostUsd?: number;
}

export interface VirtualKeyPublic {
  id: string;
  name: string;
  enabled: boolean;
  rateLimit?: { maxRequests: number; windowMs: number };
  tokenLimit?: { maxTokens: number; windowMs: number };
  budget?: Budget;
  teamId?: string;
  /** Admission scope; absent = unrestricted. */
  allowedProviders?: string[];
  allowedModels?: string[];
  usedRequests: number;
  usedCostMicroUsd: number;
  tokenHint: string;
  usedCostUsd: number;
}

export interface VirtualKeyInput {
  name: string;
  enabled?: boolean;
  rateLimit?: { maxRequests: number; windowMs: number };
  tokenLimit?: { maxTokens: number; windowMs: number };
  budget?: Budget;
  teamId?: string;
  /**
   * Admission scope. Create: omit for unrestricted (empty array is rejected).
   * Update: an array sets scope, `null` explicitly clears it, omit leaves it.
   */
  allowedProviders?: string[] | null;
  allowedModels?: string[] | null;
}

export interface Team {
  id: string;
  name: string;
  enabled: boolean;
  customerId?: string;
  budget?: Budget;
  usedRequests: number;
  usedCostMicroUsd: number;
}

export interface Customer {
  id: string;
  name: string;
  enabled: boolean;
  budget?: Budget;
  usedRequests: number;
  usedCostMicroUsd: number;
}

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export interface StoredLogsResult {
  entries: LogEntry[];
  total: number;
}

/* ------------------------------ analytics ------------------------------ */

/** Server rollup window; the dashboard only surfaces 1h/24h today. */
export type AnalyticsWindow = "1h" | "24h" | "7d";

export interface AnalyticsTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  costUsd: number;
  errorRatePct: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface AnalyticsBucket {
  /** 1-based bucket ordinal ("1".."12"), aligned with buildSeries labels. */
  label: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  errors: number;
}

export interface AnalyticsModelRow {
  model: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface AnalyticsProviderRow {
  provider: string;
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface AnalyticsRollup {
  /** False when the gateway does not track token/cost analytics. */
  tracked: boolean;
  window: AnalyticsWindow;
  generatedAt: string;
  totals: AnalyticsTotals;
  series: AnalyticsBucket[];
  byModel: AnalyticsModelRow[];
  byProvider: AnalyticsProviderRow[];
}

/* ---------------------------- status surface --------------------------- */

/** Process topology, saturation, and limit state. GET /api/runtime. */
export interface RuntimeView {
  workers: {
    configured: number;
    /** Processes actually serving; 1 wherever reusePort is unsupported. */
    effective: number;
    index: number | null;
    reusePortSupported: boolean;
    platform: string;
    /** Human-readable explanation, rendered verbatim. */
    reason: string;
  };
  concurrency: {
    /** Connections open right now, counted for their full lifetime. */
    active: number;
    peak: number;
    total: number;
    completed: number;
    /** Mean lifetime over the last 1000 completed connections, ms. */
    avgLifetimeMs: number;
    maxLifetimeMs: number;
    /** Age of the oldest connection still open, ms. */
    longestOpenMs: number;
    /** Handlers executing right now; excludes time spent streaming a body. */
    dispatching: number;
    peakDispatching: number;
    since: string;
    /** Always "per-process" - never render this number as fleet-wide. */
    scope: string;
  };
  rateLimit: {
    enforced: boolean;
    keysWithLimits: number;
    totalKeys: number;
    /** "fleet" when one shared counter governs every worker. */
    scope: string;
    windows: Array<{ keyId: string; maxRequests?: number; windowMs: number }>;
  };
  postgres: {
    poolSize: number;
    estimatedFleetConnections: number;
    /** host:port/database - the gateway strips credentials before sending. */
    target: string;
    listenerActive: boolean;
  };
  cache: { mode: string; sharedTier: boolean; localEntries: number };
  process: { uptimeSeconds: number; denoVersion: string; v8Version: string };
}

/**
 * Runtime view. Normalized like every other client so a partial body from an
 * older gateway renders as zeros instead of throwing mid-page.
 */
export async function getRuntime(): Promise<RuntimeView> {
  const raw = await apiFetch<Partial<RuntimeView>>("/api/runtime");
  return {
    workers: {
      configured: raw.workers?.configured ?? 1,
      effective: raw.workers?.effective ?? 1,
      index: raw.workers?.index ?? null,
      reusePortSupported: raw.workers?.reusePortSupported ?? false,
      platform: raw.workers?.platform ?? "unknown",
      reason: raw.workers?.reason ?? "",
    },
    concurrency: {
      active: raw.concurrency?.active ?? 0,
      peak: raw.concurrency?.peak ?? 0,
      total: raw.concurrency?.total ?? 0,
      completed: raw.concurrency?.completed ?? 0,
      avgLifetimeMs: raw.concurrency?.avgLifetimeMs ?? 0,
      maxLifetimeMs: raw.concurrency?.maxLifetimeMs ?? 0,
      longestOpenMs: raw.concurrency?.longestOpenMs ?? 0,
      dispatching: raw.concurrency?.dispatching ?? 0,
      peakDispatching: raw.concurrency?.peakDispatching ?? 0,
      since: raw.concurrency?.since ?? "",
      scope: raw.concurrency?.scope ?? "per-process",
    },
    rateLimit: {
      enforced: raw.rateLimit?.enforced ?? false,
      keysWithLimits: raw.rateLimit?.keysWithLimits ?? 0,
      totalKeys: raw.rateLimit?.totalKeys ?? 0,
      scope: raw.rateLimit?.scope ?? "per-process",
      windows: raw.rateLimit?.windows ?? [],
    },
    postgres: {
      poolSize: raw.postgres?.poolSize ?? 0,
      estimatedFleetConnections: raw.postgres?.estimatedFleetConnections ?? 0,
      target: raw.postgres?.target ?? "unknown",
      listenerActive: raw.postgres?.listenerActive ?? false,
    },
    cache: {
      mode: raw.cache?.mode ?? "off",
      sharedTier: raw.cache?.sharedTier ?? false,
      localEntries: raw.cache?.localEntries ?? 0,
    },
    process: {
      uptimeSeconds: raw.process?.uptimeSeconds ?? 0,
      denoVersion: raw.process?.denoVersion ?? "",
      v8Version: raw.process?.v8Version ?? "",
    },
  };
}

export function getHealth(): Promise<HealthInfo> {
  return apiFetch<HealthInfo>("/healthz");
}

export function getVersion(): Promise<VersionInfo> {
  return apiFetch<VersionInfo>("/api/version");
}

export async function getModels(): Promise<ModelInfo[]> {
  const body = await apiFetch<{ data?: ModelInfo[] }>("/v1/models");
  return Array.isArray(body?.data) ? body.data : [];
}

/* -------------------------- providers / config ------------------------- */

export async function getConfig(): Promise<GatewayConfigView> {
  const body = await apiFetch<GatewayConfigView>("/api/config");
  return {
    defaultProvider: body?.defaultProvider,
    providers: Array.isArray(body?.providers) ? body.providers : [],
    eurRate: typeof body?.eurRate === "number" ? body.eurRate : undefined,
  };
}

export function createProvider(
  input: ProviderAccountConfig,
): Promise<ProviderAccountPublic> {
  return apiFetch<ProviderAccountPublic>("/api/providers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProvider(
  id: string,
  patch: Partial<ProviderAccountConfig>,
): Promise<ProviderAccountPublic> {
  return apiFetch<ProviderAccountPublic>(
    `/api/providers/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
}

export function deleteProvider(id: string): Promise<void> {
  return apiFetch<void>(`/api/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function refreshModels(
  id: string,
): Promise<{ id: string; models: string[] }> {
  return apiFetch<{ id: string; models: string[] }>(
    `/api/providers/${encodeURIComponent(id)}/refresh-models`,
    { method: "POST" },
  );
}

/** Read-only: the provider's full live model list, without changing which
 * models are enabled (the account's `models`). Powers the catalog toggle grid. */
export function getProviderAvailableModels(
  id: string,
): Promise<{ id: string; models: string[] }> {
  return apiFetch<{ id: string; models: string[] }>(
    `/api/providers/${encodeURIComponent(id)}/available-models`,
  );
}

/** Live provider reachability for the status badge. */
export interface ProviderHealthView {
  id: string;
  type: string;
  status: "ok" | "error" | "unknown" | "disabled";
  lastError?: string;
  checkedAt: string;
}

export async function getProviderHealth(): Promise<ProviderHealthView[]> {
  const body = await apiFetch<{ health?: ProviderHealthView[] }>(
    "/api/providers/health",
  );
  return Array.isArray(body?.health) ? body.health : [];
}

export function setDefaultProvider(
  id: string | undefined,
): Promise<{ defaultProvider?: string }> {
  return apiFetch<{ defaultProvider?: string }>("/api/config", {
    method: "PUT",
    body: JSON.stringify({ defaultProvider: id }),
  });
}

export function exportConfig(includeSecrets: boolean): Promise<ConfigExport> {
  return apiFetch<ConfigExport>(
    includeSecrets
      ? "/api/config/export?include_secrets=true"
      : "/api/config/export",
  );
}

export function importConfig(
  payload: unknown,
): Promise<{ imported: boolean; providers: number }> {
  return apiFetch<{ imported: boolean; providers: number }>(
    "/api/config/import",
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function reloadConfig(): Promise<
  { reloaded: boolean; providers: number; defaultProvider?: string }
> {
  return apiFetch<
    { reloaded: boolean; providers: number; defaultProvider?: string }
  >("/api/config/reload", { method: "POST" });
}

/* --------------------------------- logs -------------------------------- */

export async function getLogs(limit: number): Promise<LogEntry[]> {
  const body = await apiFetch<{ logs?: LogEntry[] }>(
    `/api/logs?limit=${limit}`,
  );
  return Array.isArray(body?.logs) ? body.logs : [];
}

export async function getStoredLogs(params: {
  q?: string;
  status?: number;
  limit?: number;
  offset?: number;
}): Promise<StoredLogsResult> {
  const search = new URLSearchParams();
  if (params.q) {
    search.set("q", params.q);
  }
  if (typeof params.status === "number" && !Number.isNaN(params.status)) {
    search.set("status", String(params.status));
  }
  if (typeof params.limit === "number") {
    search.set("limit", String(params.limit));
  }
  if (typeof params.offset === "number") {
    search.set("offset", String(params.offset));
  }
  const body = await apiFetch<Partial<StoredLogsResult>>(
    `/api/logs/stored?${search.toString()}`,
  );
  return {
    entries: Array.isArray(body?.entries) ? body.entries : [],
    total: typeof body?.total === "number" ? body.total : 0,
  };
}

export function clearStoredLogs(): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>("/api/logs/stored", {
    method: "DELETE",
  });
}

/**
 * Fetch-based SSE reader for /api/logs/stream (EventSource is forbidden:
 * it cannot carry the admin bearer header). Resolves when the stream ends;
 * the caller owns reconnection. Abort via the provided signal.
 */
export async function readLogStream(
  onEntry: (entry: LogEntry) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const headers = new Headers({ Accept: "text/event-stream" });
  const token = getAdminToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch("/api/logs/stream", { headers, signal });
  if (res.status === 401) {
    setAuthState("denied");
    throw new ApiError(401, "Missing or invalid admin token.");
  }
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`);
  }
  setAuthState("ok");
  onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) {
            continue;
          }
          try {
            onEntry(JSON.parse(line.slice(5).trim()) as LogEntry);
          } catch {
            // malformed frame: drop silently (security seed #11)
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/* ------------------------------ analytics ------------------------------ */

const EMPTY_ANALYTICS_TOTALS: AnalyticsTotals = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  costUsd: 0,
  errorRatePct: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

/** A well-formed rollup that reads as "not tracked" for the empty state. */
function emptyAnalyticsRollup(window: AnalyticsWindow): AnalyticsRollup {
  return {
    tracked: false,
    window,
    generatedAt: new Date().toISOString(),
    totals: { ...EMPTY_ANALYTICS_TOTALS },
    series: [],
    byModel: [],
    byProvider: [],
  };
}

/**
 * Token/cost/model rollup for the dashboard. A 404 (older gateway) means the
 * feature is off, so we resolve to a well-formed untracked rollup instead of
 * throwing (mirrors the stored-logs 404 = "feature off" pattern). Partial or
 * malformed bodies are normalized so downstream chart helpers stay total.
 */
export async function getAnalytics(
  window: AnalyticsWindow,
): Promise<AnalyticsRollup> {
  try {
    const body = await apiFetch<Partial<AnalyticsRollup>>(
      `/api/analytics?window=${window}`,
    );
    return {
      tracked: body?.tracked === true,
      window: body?.window ?? window,
      generatedAt: typeof body?.generatedAt === "string"
        ? body.generatedAt
        : new Date().toISOString(),
      totals: { ...EMPTY_ANALYTICS_TOTALS, ...(body?.totals ?? {}) },
      series: Array.isArray(body?.series) ? body.series : [],
      byModel: Array.isArray(body?.byModel) ? body.byModel : [],
      byProvider: Array.isArray(body?.byProvider) ? body.byProvider : [],
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return emptyAnalyticsRollup(window);
    }
    throw err;
  }
}

/* ----------------------------- MCP / plugins --------------------------- */

export async function getMCPClients(): Promise<MCPClientView[]> {
  const body = await apiFetch<{ clients?: MCPClientView[] }>(
    "/api/mcp/clients",
  );
  return Array.isArray(body?.clients) ? body.clients : [];
}

export function createMCPClient(input: MCPClientInput): Promise<MCPClientView> {
  return apiFetch<MCPClientView>("/api/mcp/clients", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMCPClient(
  id: string,
  patch: Partial<MCPClientInput>,
): Promise<MCPClientView> {
  return apiFetch<MCPClientView>(
    `/api/mcp/clients/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
}

export function deleteMCPClient(id: string): Promise<void> {
  return apiFetch<void>(`/api/mcp/clients/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function syncMCPClient(
  id: string,
): Promise<{ id: string; tools: number }> {
  return apiFetch<{ id: string; tools: number }>(
    `/api/mcp/clients/${encodeURIComponent(id)}/sync`,
    { method: "POST" },
  );
}

export function syncAllMCP(): Promise<{ synced: number }> {
  return apiFetch<{ synced: number }>("/api/mcp/sync", { method: "POST" });
}

export async function getMCPTools(): Promise<MCPToolView[]> {
  const body = await apiFetch<{ tools?: MCPToolView[] }>("/api/mcp/tools");
  return Array.isArray(body?.tools) ? body.tools : [];
}

export async function getMCPHealth(): Promise<MCPHealthView[]> {
  const body = await apiFetch<{ health?: MCPHealthView[] }>("/api/mcp/health");
  return Array.isArray(body?.health) ? body.health : [];
}

export async function getPlugins(): Promise<string[]> {
  const body = await apiFetch<{ plugins?: string[] }>("/api/plugins");
  return Array.isArray(body?.plugins) ? body.plugins : [];
}

/* -------------------------------- cache -------------------------------- */

export function clearCache(): Promise<{ cleared: number }> {
  return apiFetch<{ cleared: number }>("/api/cache", { method: "DELETE" });
}

export function deleteCacheEntry(
  requestBody: unknown,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>("/api/cache/by-key", {
    method: "DELETE",
    body: JSON.stringify(requestBody),
  });
}

/* ------------------------------ governance ----------------------------- */

export async function getVirtualKeys(): Promise<VirtualKeyPublic[]> {
  const body = await apiFetch<{ virtualKeys?: VirtualKeyPublic[] }>(
    "/api/virtual-keys",
  );
  return Array.isArray(body?.virtualKeys) ? body.virtualKeys : [];
}

/** The 201 body carries the full token exactly once; never store it. */
export function createVirtualKey(
  input: VirtualKeyInput,
): Promise<VirtualKeyPublic & { token: string }> {
  return apiFetch<VirtualKeyPublic & { token: string }>("/api/virtual-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateVirtualKey(
  id: string,
  patch: Partial<VirtualKeyInput>,
): Promise<VirtualKeyPublic> {
  return apiFetch<VirtualKeyPublic>(
    `/api/virtual-keys/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
}

export function deleteVirtualKey(id: string): Promise<void> {
  return apiFetch<void>(`/api/virtual-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getTeams(): Promise<Team[]> {
  const body = await apiFetch<{ teams?: Team[] }>("/api/teams");
  return Array.isArray(body?.teams) ? body.teams : [];
}

export function createTeam(
  input: {
    name: string;
    enabled?: boolean;
    customerId?: string;
    budget?: Budget;
  },
): Promise<Team> {
  return apiFetch<Team>("/api/teams", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTeam(
  id: string,
  patch: Partial<
    { name: string; enabled: boolean; customerId: string; budget: Budget }
  >,
): Promise<Team> {
  return apiFetch<Team>(`/api/teams/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteTeam(id: string): Promise<void> {
  return apiFetch<void>(`/api/teams/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getCustomers(): Promise<Customer[]> {
  const body = await apiFetch<{ customers?: Customer[] }>("/api/customers");
  return Array.isArray(body?.customers) ? body.customers : [];
}

export function createCustomer(
  input: { name: string; enabled?: boolean; budget?: Budget },
): Promise<Customer> {
  return apiFetch<Customer>("/api/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCustomer(
  id: string,
  patch: Partial<{ name: string; enabled: boolean; budget: Budget }>,
): Promise<Customer> {
  return apiFetch<Customer>(`/api/customers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteCustomer(id: string): Promise<void> {
  return apiFetch<void>(`/api/customers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getPricing(): Promise<Record<string, ModelPrice>> {
  const body = await apiFetch<{ prices?: Record<string, ModelPrice> }>(
    "/api/pricing",
  );
  return body?.prices && typeof body.prices === "object" ? body.prices : {};
}

export function putPricing(
  prices: Record<string, ModelPrice>,
): Promise<{ prices: Record<string, ModelPrice> }> {
  return apiFetch<{ prices: Record<string, ModelPrice> }>("/api/pricing", {
    method: "PUT",
    body: JSON.stringify(prices),
  });
}

/* ------------------------------ model catalog -------------------------- */

/**
 * One row of the Model Catalog surface: a provider with its advertised models
 * and 24h traffic/cost rollup. `custom` marks bring-your-own providers
 * (openai-compatible / anthropic-compatible / lmstudio).
 */
export interface CatalogProviderRow {
  id: string;
  type: string;
  custom: boolean;
  models: string[];
  traffic24h: number;
  cost24h: number;
}

export interface CatalogTotals {
  providers: number;
  models: number;
  requests24h: number;
  cost24h: number;
}

export interface CatalogView {
  providers: CatalogProviderRow[];
  totals: CatalogTotals;
}

const EMPTY_CATALOG_TOTALS: CatalogTotals = {
  providers: 0,
  models: 0,
  requests24h: 0,
  cost24h: 0,
};

/**
 * Model + provider catalog for the Model Catalog view (Phase 3b). Partial or
 * malformed bodies are normalized so consumers stay total; a 404 (older
 * gateway) resolves to an empty catalog rather than throwing (mirrors the
 * analytics "feature off" pattern).
 */
export async function getCatalog(): Promise<CatalogView> {
  try {
    const body = await apiFetch<Partial<CatalogView>>("/api/catalog");
    const rows = Array.isArray(body?.providers) ? body.providers : [];
    return {
      providers: rows.map((row) => ({
        id: String(row?.id ?? ""),
        type: String(row?.type ?? ""),
        custom: row?.custom === true,
        models: Array.isArray(row?.models) ? row.models : [],
        traffic24h: typeof row?.traffic24h === "number" ? row.traffic24h : 0,
        cost24h: typeof row?.cost24h === "number" ? row.cost24h : 0,
      })),
      totals: { ...EMPTY_CATALOG_TOTALS, ...(body?.totals ?? {}) },
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { providers: [], totals: { ...EMPTY_CATALOG_TOTALS } };
    }
    throw err;
  }
}

/* -------------------------------- settings ----------------------------- */

/** Gateway settings groups surfaced by the Settings view (Phase 3b). */
export type SettingsGroup =
  | "security"
  | "compatibility"
  | "performance"
  | "caching"
  | "mcp";

/** Where a settings value came from: a built-in default, an env var, or an
 * operator override written through this UI. */
export type SettingSource = "default" | "env" | "override";

export interface SettingsSection {
  /** Field -> current value (shape is per-group; typed loosely on purpose). */
  values: Record<string, unknown>;
  /** Field -> provenance, drives the "default / env / override" pill. */
  sources: Record<string, SettingSource>;
}

export type SettingsMap = Partial<Record<SettingsGroup, SettingsSection>>;

export interface SettingsView {
  settings: SettingsMap;
  /** "group.field" -> whether the gateway currently enforces the value. */
  enforcement: Record<string, boolean>;
}

/**
 * Partial write payload accepted by PUT /api/settings. The gateway schema reads
 * groups FLAT off the root (e.g. `{ caching: {...} }`), not wrapped in
 * `settings`/`values` (a wrapped body is silently dropped by zod).
 */
export type SettingsUpdate = Partial<
  Record<SettingsGroup, Record<string, unknown>>
>;

function normalizeSettings(
  body: Partial<SettingsView> | undefined,
): SettingsView {
  const settings = (body?.settings && typeof body.settings === "object")
    ? body.settings as SettingsMap
    : {};
  const enforcement =
    (body?.enforcement && typeof body.enforcement === "object")
      ? body.enforcement as Record<string, boolean>
      : {};
  return { settings, enforcement };
}

/** Read the full settings tree. */
export async function getSettings(): Promise<SettingsView> {
  const body = await apiFetch<Partial<SettingsView>>("/api/settings");
  return normalizeSettings(body);
}

/** Write a partial settings update; returns the full re-read tree. */
export async function putSettings(
  update: SettingsUpdate,
): Promise<SettingsView> {
  const body = await apiFetch<Partial<SettingsView>>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(update),
  });
  return normalizeSettings(body);
}

/* ---------------------------- MCP code mode VFS ------------------------ */

/** Binding granularity for the generated Code Mode virtual file system. */
export type CodeModeBinding = "server" | "tool";

export interface CodeModeVfsFile {
  path: string;
  server: string;
  tools: string[];
  sizeBytes: number;
  sha256: string;
  source: string;
}

export interface CodeModeVfsView {
  bindingLevel: string;
  files: CodeModeVfsFile[];
  generatedAt: string;
}

/**
 * Generated Code Mode VFS listing for the MCP tooling surface (Phase 3b). The
 * binding query selects server- vs tool-level bundling. Bodies are normalized
 * so downstream tree/preview components stay total.
 */
export async function getCodeModeVfs(
  binding: CodeModeBinding,
): Promise<CodeModeVfsView> {
  const body = await apiFetch<Partial<CodeModeVfsView>>(
    `/api/mcp/codemode/vfs?binding=${binding}`,
  );
  const files = Array.isArray(body?.files) ? body.files : [];
  return {
    bindingLevel: typeof body?.bindingLevel === "string"
      ? body.bindingLevel
      : binding,
    files: files.map((file) => ({
      path: String(file?.path ?? ""),
      server: String(file?.server ?? ""),
      tools: Array.isArray(file?.tools) ? file.tools : [],
      sizeBytes: typeof file?.sizeBytes === "number" ? file.sizeBytes : 0,
      sha256: String(file?.sha256 ?? ""),
      source: String(file?.source ?? ""),
    })),
    generatedAt: typeof body?.generatedAt === "string"
      ? body.generatedAt
      : new Date().toISOString(),
  };
}
