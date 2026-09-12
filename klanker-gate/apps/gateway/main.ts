import { serveDir } from "@std/http/file-server";
import {
  applyMiddleware,
  errorHandler,
  makeRequestLogger,
  Router,
} from "../../packages/core/src/mod.ts";
import {
  type AppContext,
  createContext,
  createDefaultContext,
  VERSION,
} from "./context.ts";
import { registerInferenceRoutes } from "./routes/inference.ts";
import { registerCompatRoutes } from "./routes/compat.ts";
import { adminAuthMiddleware, registerAdminRoutes } from "./routes/admin.ts";
import {
  adminOriginGuard,
  allowedHostsFromEnv,
} from "./routes/origin-guard.ts";
import { registerLogRoutes } from "./routes/logs.ts";
import {
  governanceMiddleware,
  metricsMiddleware,
  registerGovernanceRoutes,
} from "./routes/governance.ts";
import { telemetryMiddleware } from "./routes/telemetry.ts";
import { registerAnalyticsRoutes } from "./routes/analytics.ts";
import { registerExtensionRoutes } from "./routes/extensions.ts";
import { registerRuntimeRoutes } from "./routes/runtime.ts";
import { registerAdvancedRoutes } from "./routes/advanced.ts";
import { registerMCPServerRoutes } from "./routes/mcpserver.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerCatalogRoutes } from "./routes/catalog.ts";
import { registerCodeModeRoutes } from "./routes/codemode.ts";
import {
  compatPrefixMiddleware,
  registerCompatFamilyRoutes,
} from "./routes/compat_families.ts";
import { registerAzureIngressRoutes } from "./routes/azure_ingress.ts";
import { registerOpenRouterIngressRoutes } from "./routes/openrouter_ingress.ts";
import { isWorkerChild, planCluster, superviseCluster } from "./cluster.ts";

const API_PREFIXES = [
  "/v1/",
  "/v1beta/",
  "/api/",
  "/healthz",
  "/metrics",
  "/mcp",
  "/genai/",
  "/cohere/",
  "/openai/",
  "/openrouter/",
];

export function createHandler(
  ctx: AppContext = createContext(),
): (req: Request) => Promise<Response> {
  const router = new Router();

  router.get("/healthz", () =>
    new Response(
      JSON.stringify({
        status: "ok",
        version: VERSION,
        timestamp: new Date().toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

  router.get("/api/version", () =>
    new Response(
      JSON.stringify({ version: VERSION, deno: Deno.version.deno }),
      { headers: { "Content-Type": "application/json" } },
    ));

  registerInferenceRoutes(router, ctx);
  registerCompatRoutes(router, ctx);
  registerAdminRoutes(router, ctx);
  registerLogRoutes(router, ctx);
  registerGovernanceRoutes(router, ctx);
  registerAnalyticsRoutes(router, ctx);
  registerExtensionRoutes(router, ctx);
  registerRuntimeRoutes(router, ctx);
  registerAdvancedRoutes(router, ctx);
  registerMCPServerRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerCatalogRoutes(router, ctx);
  registerCodeModeRoutes(router, ctx);
  registerAzureIngressRoutes(router, ctx);
  registerOpenRouterIngressRoutes(router, ctx);
  registerCompatFamilyRoutes(router, ctx);

  // The built SPA index.html is immutable at runtime; read it once and reuse
  // the cached string instead of hitting disk on every client-route GET.
  let indexHtmlCache: string | undefined;

  const routed = async (req: Request): Promise<Response> => {
    const response = await router.handle(req);
    if (response.status !== 404 || req.method !== "GET" || !ctx.uiRoot) {
      return response;
    }
    const pathname = new URL(req.url).pathname;
    if (API_PREFIXES.some((p) => pathname.startsWith(p))) {
      return response;
    }
    // Same-origin SPA serving: static asset, falling back to index.html.
    await response.body?.cancel();
    const served = await serveDir(req, { fsRoot: ctx.uiRoot, quiet: true });
    if (served.status !== 404) {
      return served;
    }
    await served.body?.cancel();
    if (indexHtmlCache === undefined) {
      indexHtmlCache = await Deno.readTextFile(`${ctx.uiRoot}/index.html`);
    }
    return new Response(indexHtmlCache, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  return applyMiddleware(routed, [
    errorHandler,
    async (req, next) => {
      const transformedRequest = await ctx.plugins.executeTransportPre(req);
      const response = await next(transformedRequest);
      return await ctx.plugins.executeTransportPost(response);
    },
    // Alias prefixes (/openai, /anthropic, /litellm, …) rewrite to the
    // canonical paths BEFORE auth/governance so admission always applies.
    compatPrefixMiddleware(),
    makeRequestLogger((entry) => {
      if (ctx.logExcludedPath?.(entry.path)) {
        return;
      }
      // Merge provider/model/token/cost resolved by telemetryMiddleware. For a
      // non-streamed inference response those are already waiting; for a
      // streamed one they arrive later and patch this entry by request id.
      const enriched = ctx.logEnrichment?.attach(entry) ?? entry;
      ctx.logBus.publish(enriched);
      ctx.logStore?.append(enriched).catch(() => {
        // The durable trail must never block or fail a request.
      });
    }),
    metricsMiddleware(ctx),
    // RR-3: reject cross-site / DNS-rebound / non-JSON state-changing /api/*
    // requests BEFORE the admin-token check and BEFORE any body parsing.
    adminOriginGuard(allowedHostsFromEnv()),
    adminAuthMiddleware(ctx.adminToken),
    governanceMiddleware(ctx),
    // Innermost: always-on usage capture wraps the route response directly, so
    // it observes every inference request even with zero virtual keys.
    telemetryMiddleware(ctx),
  ]);
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "8080");

  // Decide the process topology BEFORE opening PostgreSQL: a supervisor holds
  // no state and must not burn a connection pool it will never use.
  const plan = planCluster();
  if (plan.workers > 0) {
    console.log(
      `Frosty Gateway v${VERSION} supervisor: ${plan.reason}, port ${port}`,
    );
    await superviseCluster(plan.workers);
    Deno.exit(0);
  }

  // Boot failures are OPERATOR problems - an unreachable database, a missing
  // encryption key - not bugs. A stack trace buries the one line that says what
  // to do about it, so the message is printed alone and the process exits 1.
  let ctx: AppContext;
  try {
    ctx = await createDefaultContext();
  } catch (error) {
    console.error(
      `\nFATAL: ${error instanceof Error ? error.message : error}\n`,
    );
    Deno.exit(1);
  }

  // Return PostgreSQL connections and drop the LISTEN registration on the way
  // out. Without this a rolling restart leaves N pools to time out server-side,
  // which is how a redeploy exhausts max_connections.
  const shutdown = async () => {
    await ctx.shutdown?.().catch((error) => {
      console.error("shutdown failed", error);
    });
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => void shutdown());
    } catch {
      // Signal not available on this platform.
    }
  }

  const providerIds = ctx.providers.list().map((p) => p.id);
  console.log(`Frosty Gateway v${VERSION} booting on http://localhost:${port}`);
  console.log(`Process topology: ${plan.reason}`);
  console.log(`Diagnostic: Deno ${Deno.version.deno}, V8 ${Deno.version.v8}`);
  console.log(
    providerIds.length > 0
      ? `Providers configured: ${providerIds.join(", ")}`
      : "No providers configured. Set provider env keys or use /api/providers.",
  );
  console.log(
    ctx.adminToken
      ? "Admin API: bearer-token protected (FROSTY_ADMIN_TOKEN)."
      : "Admin API: local admin mode (no FROSTY_ADMIN_TOKEN set).",
  );
  console.log(
    ctx.uiRoot
      ? `Control UI: served same-origin from ${ctx.uiRoot}`
      : "Control UI: not built (run `deno task build-ui`); API-only mode.",
  );
  // reusePort only when this process is one of several sharing the port.
  // Setting it unconditionally would let a stray second gateway silently steal
  // traffic from a running one instead of failing loudly on a bound port.
  Deno.serve(
    isWorkerChild() ? { port, reusePort: true } : { port },
    createHandler(ctx),
  );
}
