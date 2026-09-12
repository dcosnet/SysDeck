import type { ProviderAccountConfig } from "../../../packages/contracts/src/mod.ts";
import {
  GatewayConfigSchema,
  GlobalProxyConfigSchema,
  ProviderAccountConfigSchema,
  redactGlobalProxy,
  redactProviderAccount,
} from "../../../packages/contracts/src/mod.ts";
import {
  errorResponse,
  GatewayError,
  type Router,
} from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import {
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";

/** Browser-safe view for create/update responses: identical redaction to the
 * provider listing (drops apiKey, cloud creds, proxyUrl, proxy.proxyPassword,
 * network.caCertPem; surfaces hasApiKey/hasProxyPassword/hasCaCert flags). */
function publicView(config: ProviderAccountConfig) {
  return redactProviderAccount(config);
}

/**
 * Operator EUR-per-USD display rate (FROSTY_EUR_RATE). Cost stays canonical
 * micro-USD in the gateway; the UI multiplies by this to present euros. Defaults
 * to 0.92 and ignores non-positive / non-finite values.
 */
function eurRateFromEnv(): number {
  const raw = Number(Deno.env.get("FROSTY_EUR_RATE"));
  return Number.isFinite(raw) && raw > 0 ? raw : 0.92;
}

/** Live provider health, mirroring the MCP health surface. */
interface ProviderHealth {
  id: string;
  type: string;
  status: "ok" | "error" | "unknown" | "disabled";
  lastError?: string;
  checkedAt: string;
}

interface HealthProbeInput {
  id: string;
  type: string;
  enabled: boolean;
  hasApiKey?: boolean;
  hasCloudCredentials?: boolean;
}

const HEALTH_TTL_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/** Collapse whitespace + cap length so a probe error never leaks a big body;
 * adapter list-model errors carry status/URL text, never the stored key. */
function sanitizeHealthError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Probe one provider's reachability with a cheap live model list. Disabled
 * accounts and accounts with no credentials are reported without a network call
 * (nothing to probe); "unknown" means "cannot determine", never "healthy".
 */
async function probeProvider(
  ctx: AppContext,
  p: HealthProbeInput,
): Promise<ProviderHealth> {
  const base = { id: p.id, type: p.type, checkedAt: new Date().toISOString() };
  if (!p.enabled) {
    return { ...base, status: "disabled" };
  }
  if (!p.hasApiKey && !p.hasCloudCredentials) {
    return { ...base, status: "unknown" };
  }
  let adapter;
  try {
    adapter = ctx.providers.accountTarget(p.id).adapter;
  } catch {
    return { ...base, status: "unknown" };
  }
  if (!adapter.listModels) {
    return { ...base, status: "unknown" };
  }
  try {
    await adapter.listModels({
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return { ...base, status: "ok" };
  } catch (error) {
    return { ...base, status: "error", lastError: sanitizeHealthError(error) };
  }
}

async function persist(
  ctx: AppContext,
  config: ProviderAccountConfig,
): Promise<void> {
  ctx.providers.upsert(config);
  await ctx.config?.upsertProvider(config);
}

export function registerAdminRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/providers", () => {
    return jsonResponse({ providers: ctx.providers.listPublic() });
  });

  router.post("/api/providers", async (req) => {
    const parsed = ProviderAccountConfigSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    await persist(ctx, parsed.data);
    return jsonResponse(publicView(parsed.data), 201);
  });

  router.put("/api/providers/:id", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.providers.get(id);
    if (!existing) {
      return errorResponse(404, `Unknown provider "${id}".`);
    }
    const patch = await parseJsonBody(req);
    if (typeof patch !== "object" || patch === null) {
      return errorResponse(400, "Request body must be a JSON object.");
    }
    const merged = ProviderAccountConfigSchema.safeParse({
      ...existing,
      ...(patch as Record<string, unknown>),
      id, // the path segment wins
    });
    if (!merged.success) {
      return validationErrorResponse(merged.error);
    }
    await persist(ctx, merged.data);
    return jsonResponse(publicView(merged.data));
  });

  router.delete("/api/providers/:id", async (_req, match) => {
    const id = match.pathname.groups.id!;
    if (!ctx.providers.get(id)) {
      return errorResponse(404, `Unknown provider "${id}".`);
    }
    ctx.providers.remove(id);
    await ctx.config?.deleteProvider(id);
    return new Response(null, { status: 204 });
  });

  router.post("/api/providers/:id/refresh-models", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.providers.get(id);
    if (!existing) {
      return errorResponse(404, `Unknown provider "${id}".`);
    }
    try {
      const target = ctx.providers.resolve(`${id}/_refresh`);
      if (!target.adapter.listModels) {
        throw new GatewayError(
          400,
          `Provider type "${existing.type}" does not support live model listing.`,
        );
      }
      const models = await target.adapter.listModels({ signal: req.signal });
      const updated = { ...existing, models };
      await persist(ctx, updated);
      return jsonResponse({ id, models });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Read-only companion to refresh-models: returns the provider's full live
  // model list WITHOUT persisting it. The account's `models` stays the enabled
  // set the gateway routes on; the Model Catalog grid diffs the two so an
  // operator can toggle individual models on and off.
  router.get("/api/providers/:id/available-models", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.providers.get(id);
    if (!existing) {
      return errorResponse(404, `Unknown provider "${id}".`);
    }
    try {
      const target = ctx.providers.resolve(`${id}/_list`);
      if (!target.adapter.listModels) {
        throw new GatewayError(
          400,
          `Provider type "${existing.type}" does not support live model listing.`,
        );
      }
      const models = await target.adapter.listModels({ signal: req.signal });
      return jsonResponse({ id, models });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Live provider health for the Providers-page status badge. Probes are cached
  // per provider (60s TTL) so polling the badge never hammers upstreams; each
  // probe is a cheap list-models call with a short timeout.
  const healthCache = new Map<
    string,
    { entry: ProviderHealth; expiresAt: number }
  >();
  router.get("/api/providers/health", async () => {
    const now = Date.now();
    const health = await Promise.all(
      ctx.providers.listPublic().map(async (p) => {
        const cached = healthCache.get(p.id);
        if (cached && cached.expiresAt > now) {
          return cached.entry;
        }
        const entry = await probeProvider(ctx, p);
        healthCache.set(p.id, { entry, expiresAt: now + HEALTH_TTL_MS });
        return entry;
      }),
    );
    // Drop cache rows for providers that no longer exist.
    const live = new Set(health.map((h) => h.id));
    for (const id of [...healthCache.keys()]) {
      if (!live.has(id)) {
        healthCache.delete(id);
      }
    }
    return jsonResponse({ health });
  });

  router.get("/api/config", () => {
    return jsonResponse({
      defaultProvider: ctx.providers.getDefaultProvider(),
      providers: ctx.providers.listPublic(),
      eurRate: eurRateFromEnv(),
    });
  });

  router.put("/api/config", async (req) => {
    const body = await parseJsonBody(req);
    const parsed = GatewayConfigSchema.pick({ defaultProvider: true })
      .strip()
      .safeParse(body);
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.providers.setDefaultProvider(parsed.data.defaultProvider);
    await ctx.config?.setDefaultProvider(parsed.data.defaultProvider);
    return jsonResponse({ defaultProvider: parsed.data.defaultProvider });
  });

  router.get("/api/proxy-config", () => {
    return jsonResponse(redactGlobalProxy(ctx.providers.getGlobalProxy()));
  });

  router.put("/api/proxy-config", async (req) => {
    if (!ctx.config) {
      return errorResponse(400, "No persistent config store is attached.");
    }
    if (!ctx.config.hasActiveEncryption()) {
      return errorResponse(
        409,
        "Global proxy configuration requires FROSTY_ENCRYPTION_KEY.",
      );
    }
    const parsed = GlobalProxyConfigSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const previous = ctx.providers.getGlobalProxy();
    try {
      // Prepare/swap runtime clients before writing, then roll back that swap if
      // persistence fails. Neither rejected input nor a failed KV write changes
      // the effective proxy policy.
      ctx.providers.configureGlobalProxy(parsed.data);
      try {
        await ctx.config.setGlobalProxy(parsed.data);
      } catch (error) {
        ctx.providers.configureGlobalProxy(previous);
        throw error;
      }
      return jsonResponse(redactGlobalProxy(parsed.data));
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.delete("/api/proxy-config", async () => {
    if (!ctx.config) {
      return errorResponse(400, "No persistent config store is attached.");
    }
    const previous = ctx.providers.getGlobalProxy();
    try {
      ctx.providers.configureGlobalProxy(undefined);
      try {
        await ctx.config.deleteGlobalProxy();
      } catch (error) {
        ctx.providers.configureGlobalProxy(previous);
        throw error;
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/api/config/reload", async () => {
    if (!ctx.config) {
      return errorResponse(400, "No persistent config store is attached.");
    }
    const loaded = await ctx.config.loadAll();
    ctx.providers.configureGlobalProxy(await ctx.config.getGlobalProxy());
    for (const existing of ctx.providers.list()) {
      ctx.providers.remove(existing.id);
    }
    for (const provider of loaded.providers) {
      ctx.providers.upsert(provider);
    }
    ctx.providers.setDefaultProvider(loaded.defaultProvider);
    return jsonResponse({
      reloaded: true,
      providers: loaded.providers.length,
      defaultProvider: loaded.defaultProvider,
    });
  });

  router.get("/api/config/export", async (req) => {
    if (!ctx.config) {
      return errorResponse(400, "No persistent config store is attached.");
    }
    const includeSecrets =
      new URL(req.url).searchParams.get("include_secrets") === "true";
    return jsonResponse(await ctx.config.exportConfig(includeSecrets));
  });

  router.post("/api/config/import", async (req) => {
    if (!ctx.config) {
      return errorResponse(400, "No persistent config store is attached.");
    }
    try {
      const imported = await ctx.config.importConfig(await parseJsonBody(req));
      for (const existing of ctx.providers.list()) {
        ctx.providers.remove(existing.id);
      }
      for (const provider of imported.providers) {
        ctx.providers.upsert(provider);
      }
      ctx.providers.setDefaultProvider(imported.defaultProvider);
      return jsonResponse({
        imported: true,
        providers: imported.providers.length,
      });
    } catch (error) {
      if (error instanceof GatewayError) {
        return mapDispatchError(error);
      }
      // Log the detail server-side; return a fixed message so an internal
      // error/stack is never echoed to the client (cf. sanitizeHealthError).
      console.error(`config import failed: ${String(error)}`);
      return errorResponse(
        400,
        "Import failed: invalid configuration payload.",
      );
    }
  });
}

/** Bearer-token gate for /api/* when FROSTY_ADMIN_TOKEN is configured. */
export function adminAuthMiddleware(
  adminToken: string | undefined,
): (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response> {
  return async (req, next) => {
    if (!adminToken) {
      return await next(req); // explicit local-admin mode
    }
    const url = new URL(req.url);
    // /metrics carries per-key traffic labels, so a locked-down control
    // plane locks it too (Prometheus supports bearer_token scrape config).
    const isAdminSurface = (url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/version") ||
      url.pathname === "/metrics";
    if (!isAdminSurface) {
      return await next(req);
    }
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${adminToken}`) {
      return errorResponse(
        401,
        "Missing or invalid admin token.",
        "auth_error",
      );
    }
    return await next(req);
  };
}
