import type { Router } from "../../../packages/core/src/mod.ts";
import type { AnalyticsWindow } from "../../../packages/telemetry/src/usagestore.ts";
import type { AppContext } from "../context.ts";
import { jsonResponse } from "./helpers.ts";

const WINDOWS: ReadonlySet<string> = new Set(["1h", "24h", "7d"]);

/**
 * GET /api/analytics?window=1h|24h|7d (default 24h). An /api/* surface, so it
 * inherits admin auth and the origin guard. Returns the fixed analytics
 * contract from the usage tracker; tracked=false when no records exist.
 */
export function registerAnalyticsRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/analytics", async (req) => {
    const requested = new URL(req.url).searchParams.get("window");
    const window: AnalyticsWindow = WINDOWS.has(requested ?? "")
      ? (requested as AnalyticsWindow)
      : "24h";

    if (!ctx.usage) {
      // Tracker not wired (only possible in hand-built contexts): report empty.
      return jsonResponse({
        tracked: false,
        window,
        generatedAt: new Date().toISOString(),
        totals: {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costMicroUsd: 0,
          costUsd: 0,
          errorRatePct: 0,
          cacheHits: 0,
          cacheMisses: 0,
        },
        series: [],
        byModel: [],
        byProvider: [],
      });
    }

    return jsonResponse(await ctx.usage.rollup({ window }));
  });
}
