import type { AppContext } from "../context.ts";
import type { Router } from "../../../packages/core/src/mod.ts";
import { jsonResponse } from "./helpers.ts";
import { planCluster, reusePortSupported } from "../cluster.ts";
import { poolSizeFromEnv } from "../../../packages/config/src/pg.ts";
import type { ConcurrencySnapshot } from "../../../packages/telemetry/src/concurrency.ts";

export interface WorkerTopology {
  /** FROSTY_WORKERS as configured. 1 means single-process. */
  configured: number;
  /** Processes actually serving. Equals `configured` only where reusePort works. */
  effective: number;
  /** This process's index, or null in single-process mode. */
  index: number | null;
  /** Whether this platform can share a port across processes. */
  reusePortSupported: boolean;
  platform: string;
  /** Why the effective count is what it is - surfaced verbatim in the UI. */
  reason: string;
}

export interface RateLimitState {
  /** Whether any virtual key carries a rate-limit policy. */
  enforced: boolean;
  /** Virtual keys that declare a rate limit. */
  keysWithLimits: number;
  /** Total virtual keys, for the "N of M" reading. */
  totalKeys: number;
  /**
   * `fleet` when a shared authority enforces the windows (decision-log 71) -
   * one budget however many workers serve. `per-process` is the fallback when
   * no shared store is attached, where N workers admit up to N times the
   * stated value. Budgets are always fleet-wide (shared atomic counters).
   */
  scope: "fleet" | "per-process";
  windows: Array<{ keyId: string; maxRequests?: number; windowMs: number }>;
}

export interface RuntimeView {
  workers: WorkerTopology;
  concurrency: ConcurrencySnapshot & { scope: "per-process" };
  rateLimit: RateLimitState;
  postgres: {
    /** Connections this process may hold. */
    poolSize: number;
    /** poolSize x effective workers, plus one LISTEN connection per worker. */
    estimatedFleetConnections: number;
    /** host:port/database - never credentials. */
    target: string;
    /** Whether the cross-process invalidation listener is registered. */
    listenerActive: boolean;
  };
  cache: {
    /** exact | semantic | off. */
    mode: string;
    /** Whether a shared L2 tier is attached. */
    sharedTier: boolean;
    /** Entries in THIS process's L1. */
    localEntries: number;
  };
  process: {
    uptimeSeconds: number;
    denoVersion: string;
    v8Version: string;
  };
}

/** Strips credentials from a connection URL, keeping host:port/database. */
export function redactPgTarget(raw: string | undefined): string {
  if (!raw) {
    return "not configured";
  }
  try {
    const url = new URL(raw);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.host}/${database}`;
  } catch {
    // An unparseable URL must not be echoed back - it could be a
    // paste-accident containing a password in an unexpected shape.
    return "(unparseable)";
  }
}

const BOOT_MS = Date.now();

export function registerRuntimeRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/runtime", () => {
    const plan = planCluster();
    const configured = Number(Deno.env.get("FROSTY_WORKERS") ?? "1");
    const validConfigured = Number.isInteger(configured) && configured > 0
      ? configured
      : 1;
    const effective = reusePortSupported() ? validConfigured : 1;
    const rawIndex = Number(Deno.env.get("FROSTY_WORKER_INDEX") ?? "");
    const poolSize = poolSizeFromEnv();

    const keys = ctx.virtualKeys.list();
    const windows = keys
      .filter((key) => key.rateLimit !== undefined)
      .map((key) => ({
        keyId: key.id,
        maxRequests: key.rateLimit?.maxRequests,
        windowMs: key.rateLimit?.windowMs ?? 0,
      }));

    const view: RuntimeView = {
      workers: {
        configured: validConfigured,
        effective,
        index: Number.isInteger(rawIndex) ? rawIndex : null,
        reusePortSupported: reusePortSupported(),
        platform: Deno.build.os,
        reason: plan.reason,
      },
      concurrency: {
        ...(ctx.concurrency?.snapshot() ?? {
          active: 0,
          peak: 0,
          total: 0,
          completed: 0,
          avgLifetimeMs: 0,
          maxLifetimeMs: 0,
          longestOpenMs: 0,
          dispatching: 0,
          peakDispatching: 0,
          since: new Date(BOOT_MS).toISOString(),
        }),
        scope: "per-process",
      },
      rateLimit: {
        enforced: windows.length > 0,
        keysWithLimits: windows.length,
        totalKeys: keys.length,
        scope: ctx.sharedRateLimit ? "fleet" : "per-process",
        windows,
      },
      postgres: {
        poolSize,
        // Each worker holds a pool AND one session connection for LISTEN.
        estimatedFleetConnections: effective * poolSize + effective,
        target: redactPgTarget(Deno.env.get("FROSTY_PG_URL")),
        listenerActive: ctx.invalidation !== undefined,
      },
      cache: {
        mode: Deno.env.get("FROSTY_CACHE") || "off",
        sharedTier: Boolean(ctx.cache) &&
          Deno.env.get("FROSTY_CACHE") !== undefined,
        localEntries: ctx.cache?.size() ?? 0,
      },
      process: {
        uptimeSeconds: Math.floor((Date.now() - BOOT_MS) / 1000),
        denoVersion: Deno.version.deno,
        v8Version: Deno.version.v8,
      },
    };
    return jsonResponse(view);
  });
}
