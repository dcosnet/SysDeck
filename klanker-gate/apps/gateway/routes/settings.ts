import type { AppContext } from "../context.ts";
import { errorResponse, type Router } from "../../../packages/core/src/mod.ts";
import {
  jsonResponse,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";
import { SettingsStore } from "./settings_store.ts";
// Direct-path import (not via contracts/src/mod.ts): the mod re-export is an
// orchestrator-applied wiring line, so this route must compile without it.
import {
  type CachingSettings,
  CachingSettingsSchema,
  CompatibilitySettingsSchema,
  DEFAULT_CACHING,
  DEFAULT_COMPATIBILITY,
  DEFAULT_MCP,
  DEFAULT_PERFORMANCE,
  DEFAULT_SECURITY,
  McpSettingsSchema,
  PerformanceSettingsSchema,
  SecurityOverrideSchema,
  type SecuritySettings,
  type SettingSource,
  type SettingsResponse,
  SettingsUpdateSchema,
} from "../../../packages/contracts/src/settings.ts";

/**
 * ADMIN-LOCKOUT INVARIANT (guardrail): admin surfaces that MUST remain
 * reachable no matter what security settings are persisted. Nothing consumes
 * these paths for enforcement today — security settings are persist + reflect
 * only, and none is wired into adminAuthMiddleware, the /api/* routing, or the
 * origin-guard — so the FROSTY_ADMIN_TOKEN path and every /api/* admin route
 * stay reachable regardless of what an operator persists. Any FUTURE wiring
 * that honors whitelistedRoutes / passwordProtect / disableInferenceAuth MUST
 * union with this set so the control plane can never be gated off. Flagged for
 * the Phase-4 security review.
 */
export const ADMIN_ALWAYS_REACHABLE = [
  "/api/",
  "/api/settings",
  "/api/session/",
] as const;

/** Defensive env read: a missing --allow-env must degrade to "unset". */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Environment layer for the security group (FROSTY_ALLOWED_HOSTS). */
function securityEnv(): Partial<SecuritySettings> {
  const raw = env("FROSTY_ALLOWED_HOSTS");
  if (!raw) return {};
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return origins.length ? { allowedOrigins: origins } : {};
}

/** Environment layer for the caching group (FROSTY_CACHE*). */
function cachingEnv(): Partial<CachingSettings> {
  const layer: Partial<CachingSettings> = {};
  const mode = env("FROSTY_CACHE");
  if (mode === "exact" || mode === "semantic") layer.enabled = true;
  const ttlMs = Number(env("FROSTY_CACHE_TTL_MS"));
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    const secs = Math.floor(ttlMs / 1000);
    if (secs >= 1) layer.ttlSeconds = secs;
  }
  const model = env("FROSTY_CACHE_EMBED_MODEL");
  if (model) layer.embeddingModel = model;
  return layer;
}

/**
 * Resolves one group into effective values + per-field provenance by layering
 * default <- env <- override. Only keys present in `defaults` are considered,
 * so an override carrying extra markers (e.g. security.hasPassword) is ignored
 * here and handled by the caller.
 */
function viewOf<T extends Record<string, unknown>>(
  defaults: T,
  envLayer: Partial<T>,
  override: Partial<T>,
): { values: T; sources: Record<string, SettingSource> } {
  const values = { ...defaults };
  const sources: Record<string, SettingSource> = {};
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    if (key in override && override[key] !== undefined) {
      values[key] = override[key] as T[keyof T];
      sources[key as string] = "override";
    } else if (key in envLayer && envLayer[key] !== undefined) {
      values[key] = envLayer[key] as T[keyof T];
      sources[key as string] = "env";
    } else {
      sources[key as string] = "default";
    }
  }
  return { values, sources };
}

/** Per-field enforcement map: false everywhere except live cache tuning. */
function enforcementMap(ctx: AppContext): Record<string, boolean> {
  const groups: Record<string, string[]> = {
    security: [...Object.keys(DEFAULT_SECURITY), "hasPassword"],
    compatibility: Object.keys(DEFAULT_COMPATIBILITY),
    performance: Object.keys(DEFAULT_PERFORMANCE),
    caching: Object.keys(DEFAULT_CACHING),
    mcp: Object.keys(DEFAULT_MCP),
  };
  const map: Record<string, boolean> = {};
  for (const [group, fields] of Object.entries(groups)) {
    for (const field of fields) map[`${group}.${field}`] = false;
  }
  // Wired live only when a cache is actually running (FROSTY_CACHE set).
  const cacheActive = Boolean(ctx.cache);
  map["caching.ttlSeconds"] = cacheActive;
  map["caching.similarityThreshold"] = cacheActive;
  map["caching.cacheByProvider"] = cacheActive;
  map["caching.cacheByModel"] = cacheActive;
  map["caching.excludeSystemPrompt"] = cacheActive;
  map["caching.conversationHistoryThreshold"] = cacheActive;
  return map;
}

function storeFor(ctx: AppContext): SettingsStore | undefined {
  // Reuses the shared KV handle; opens no new connection.
  return ctx.config ? new SettingsStore(ctx.config.raw()) : undefined;
}

/** Reads + schema-sanitizes a group's persisted override (empty when unset). */
async function loadOverride(
  store: SettingsStore | undefined,
  group: Parameters<SettingsStore["getOverride"]>[0],
  schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
): Promise<Record<string, unknown>> {
  if (!store) return {};
  const raw = await store.getOverride(group);
  if (!raw) return {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return {};
  const data = parsed.data as Record<string, unknown>;
  const stored = raw as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (key in stored) kept[key] = data[key];
  }
  return kept;
}

/** Builds the full GET/PUT response from the persisted overrides + env + defaults. */
async function buildResponse(ctx: AppContext): Promise<SettingsResponse> {
  const store = storeFor(ctx);
  const securityOv = await loadOverride(
    store,
    "security",
    SecurityOverrideSchema,
  );
  const compatOv = await loadOverride(
    store,
    "compatibility",
    CompatibilitySettingsSchema.partial(),
  );
  const perfOv = await loadOverride(
    store,
    "performance",
    PerformanceSettingsSchema.partial(),
  );
  const cacheOv = await loadOverride(
    store,
    "caching",
    CachingSettingsSchema.partial(),
  );
  const mcpOv = await loadOverride(store, "mcp", McpSettingsSchema.partial());

  const secBase = viewOf(
    DEFAULT_SECURITY,
    securityEnv(),
    securityOv as Partial<SecuritySettings>,
  );
  const hasPassword = securityOv.hasPassword === true;

  return {
    settings: {
      security: {
        values: { ...secBase.values, hasPassword },
        sources: {
          ...secBase.sources,
          hasPassword: securityOv.hasPassword !== undefined
            ? "override"
            : "default",
        },
      },
      compatibility: viewOf(DEFAULT_COMPATIBILITY, {}, compatOv),
      performance: viewOf(DEFAULT_PERFORMANCE, {}, perfOv),
      caching: viewOf(DEFAULT_CACHING, cachingEnv(), cacheOv),
      mcp: viewOf(DEFAULT_MCP, {}, mcpOv),
    },
    enforcement: enforcementMap(ctx),
  };
}

export function registerSettingsRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/settings", async () => {
    return jsonResponse(await buildResponse(ctx));
  });

  router.put("/api/settings", async (req) => {
    const store = storeFor(ctx);
    if (!store) {
      return errorResponse(400, "No persistent settings store is attached.");
    }
    const raw = await parseJsonBody(req);
    const parsed = SettingsUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const update = parsed.data;
    const sent = <T extends Record<string, unknown>>(
      group: string,
      values: T,
    ): Partial<T> => {
      const rawGroup = (raw as Record<string, unknown> | null)?.[group];
      if (rawGroup === null || typeof rawGroup !== "object") {
        return values;
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(values)) {
        if (key in (rawGroup as Record<string, unknown>)) {
          out[key] = values[key];
        }
      }
      return out as Partial<T>;
    };

    if (update.security) {
      const { password, ...rest } = sent("security", update.security);
      const override: Record<string, unknown> = { ...rest };
      if (password !== undefined) override.hasPassword = true;
      await store.merge("security", override);
    }
    if (update.compatibility) {
      await store.merge(
        "compatibility",
        sent("compatibility", update.compatibility),
      );
    }
    if (update.performance) {
      await store.merge("performance", sent("performance", update.performance));
    }
    if (update.caching) {
      await store.merge("caching", sent("caching", update.caching));
    }
    if (update.mcp) {
      await store.merge("mcp", sent("mcp", update.mcp));
    }

    const response = await buildResponse(ctx);

    // Live enforcement: push the new cache-key and tuning controls into the
    // running cache. Values are schema-validated and cache failures stay off
    // the inference path.
    if (update.caching && ctx.cache) {
      const caching = response.settings.caching.values;
      ctx.cache.configure({
        ttlMs: caching.ttlSeconds * 1000,
        similarityThreshold: caching.similarityThreshold,
        cacheByProvider: caching.cacheByProvider,
        cacheByModel: caching.cacheByModel,
        excludeSystemPrompt: caching.excludeSystemPrompt,
        conversationHistoryThreshold: caching.conversationHistoryThreshold,
      });
    }

    return jsonResponse(response);
  });
}
