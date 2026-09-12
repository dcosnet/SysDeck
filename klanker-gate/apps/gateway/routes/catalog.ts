import type { Router } from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import { jsonResponse } from "./helpers.ts";

/**
 * Provider types that are user-defined generic endpoints (operator supplies the
 * base URL) rather than a first-class built-in vendor. Surfaced as `custom` so
 * the catalog UI can flag them.
 */
const CUSTOM_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "openai-compatible",
  "anthropic-compatible",
  "lmstudio",
]);

/**
 * GET /api/catalog (admin-gated, inherits the /api/* auth + origin guard).
 *
 * Joins the configured providers (id/type/models) with the 24h analytics
 * rollup (byProvider is keyed by the same account id telemetry records) into
 * the model-catalog shape the control UI renders:
 *
 *   {
 *     providers: [{ id, type, custom, models, traffic24h, cost24h }],
 *     totals: { providers, models, requests24h, cost24h }
 *   }
 *
 * traffic24h is the provider's request count over the last 24h; cost24h is its
 * spend in USD. totals.models counts distinct advertised model names across the
 * whole catalog. No secrets are read — only id/type/models are projected.
 */
export function registerCatalogRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/catalog", async () => {
    const analytics = ctx.usage
      ? await ctx.usage.rollup({ window: "24h" })
      : undefined;
    const byProvider = new Map(
      (analytics?.byProvider ?? []).map((p) => [p.provider, p]),
    );

    const providers = ctx.providers.list()
      .filter((cfg) => cfg.enabled)
      .map((cfg) => {
        const stats = byProvider.get(cfg.id);
        return {
          id: cfg.id,
          type: cfg.type,
          custom: CUSTOM_PROVIDER_TYPES.has(cfg.type),
          models: cfg.models,
          traffic24h: stats?.requests ?? 0,
          cost24h: (stats?.costMicroUsd ?? 0) / 1_000_000,
        };
      });

    const distinctModels = new Set<string>();
    for (const provider of providers) {
      for (const model of provider.models) {
        distinctModels.add(model);
      }
    }

    return jsonResponse({
      providers,
      totals: {
        providers: providers.length,
        models: distinctModels.size,
        requests24h: analytics?.totals.requests ?? 0,
        cost24h: analytics?.totals.costUsd ?? 0,
      },
    });
  });
}
