import {
  createSSEResponse,
  errorResponse,
  type Router,
  sseEncode,
} from "../../../packages/core/src/mod.ts";
import type { LogEntry } from "../../../packages/telemetry/src/logbus.ts";
import type { LogQuery } from "../../../packages/telemetry/src/logstore.ts";
import type { AppContext } from "../context.ts";
import { jsonResponse } from "./helpers.ts";

/**
 * Canonical 404 for the store-backed routes when no durable log store is wired.
 * Uses the same `not_found` type the other disabled-surface 404s use.
 */
function logStoreDisabled(): Response {
  return errorResponse(
    404,
    "Log store is disabled; set FROSTY_LOG_STORE=pg to enable the durable " +
      "request log.",
    "not_found",
  );
}

/** Shared substring (q) + status filter parsing for the store-backed routes. */
function parseLogFilters(req: Request): LogQuery {
  const params = new URL(req.url).searchParams;
  return {
    q: params.get("q") ?? undefined,
    status: params.get("status") ? Number(params.get("status")) : undefined,
  };
}

export function registerLogRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/logs", (req) => {
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 100;
    return jsonResponse({ logs: ctx.logBus.recent(limit) });
  });

  // Durable log store (FROSTY_LOG_STORE=pg): searchable audit trail.
  router.get("/api/logs/stored", async (req) => {
    if (!ctx.logStore) {
      return logStoreDisabled();
    }
    const params = new URL(req.url).searchParams;
    const result = await ctx.logStore.query({
      q: params.get("q") ?? undefined,
      status: params.get("status") ? Number(params.get("status")) : undefined,
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
      offset: params.get("offset") ? Number(params.get("offset")) : undefined,
    });
    return jsonResponse(result);
  });

  // Aggregate stats over the durable trail (optionally q/status filtered):
  // totals, per-status-class counts, success rate, avg latency, token/cost
  // totals where recorded (honest zeros for dimensions no producer records yet).
  router.get("/api/logs/stats", async (req) => {
    if (!ctx.logStore) {
      return logStoreDisabled();
    }
    return jsonResponse(await ctx.logStore.stats(parseLogFilters(req)));
  });

  // Dropped-request counter. `dropped` counts durable-trail entries the store
  // had to evict at its cap; `bufferEvicted` counts entries aged out of the live
  // in-memory ring. Always answers (0 honestly when nothing has dropped).
  router.get("/api/logs/dropped", () => {
    return jsonResponse({
      dropped: ctx.logStore?.dropped() ?? 0,
      bufferEvicted: ctx.logBus.dropped(),
    });
  });

  // Distinct filter facet values (statuses, status classes, methods, paths, and
  // models/providers where recorded — honestly empty where a dimension is not).
  router.get("/api/logs/filterdata", async () => {
    if (!ctx.logStore) {
      return logStoreDisabled();
    }
    return jsonResponse(await ctx.logStore.filterData());
  });

  // Re-derive per-entry cost from the pricing catalog for stored entries that
  // carry token counts + a model; rewrites entries whose cost is missing/stale.
  router.post("/api/logs/recalculate-cost", async () => {
    if (!ctx.logStore) {
      return logStoreDisabled();
    }
    const pricing = ctx.pricing;
    const result = await ctx.logStore.recalculateCost((entry: LogEntry) => {
      if (!pricing || !entry.model) {
        return null;
      }
      const prompt = entry.promptTokens ?? 0;
      const completion = entry.completionTokens ?? 0;
      if (prompt === 0 && completion === 0) {
        return null; // no tokens => nothing to price
      }
      return pricing.costMicroUsd(entry.model, {
        prompt_tokens: prompt,
        completion_tokens: completion,
      });
    });
    return jsonResponse(result);
  });

  router.delete("/api/logs/stored", async () => {
    if (!ctx.logStore) {
      return logStoreDisabled();
    }
    return jsonResponse({ deleted: await ctx.logStore.clear() });
  });

  // Live log stream for the control-plane UI.
  router.get("/api/logs/stream", (req) => {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const entry of ctx.logBus.recent(50)) {
          controller.enqueue(encoder.encode(sseEncode(entry)));
        }
        unsubscribe = ctx.logBus.subscribe((entry) => {
          try {
            controller.enqueue(encoder.encode(sseEncode(entry)));
          } catch {
            unsubscribe();
          }
        });
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        unsubscribe();
      },
    });
    return createSSEResponse(stream);
  });
}
