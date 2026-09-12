// Integration tests for the operator settings API through the production
// middleware slice (errorHandler -> origin-guard -> admin-token gate). Covers
// the FROSTY_ADMIN_TOKEN gate, the ADMIN-LOCKOUT INVARIANT (persisting hostile
// security overrides can never break the admin surface or the token gate), and
// the caching live-enforcement flag.
//
// The settings route is composed here directly rather than via createHandler
// because its main.ts registration is an orchestrator-applied wiring line; this
// mirrors the exact middleware order createHandler uses around /api/*.

import { assert, assertEquals } from "@std/assert";
import {
  applyMiddleware,
  errorHandler,
  Router,
} from "../../packages/core/src/mod.ts";
import { registerSettingsRoutes } from "../../apps/gateway/routes/settings.ts";
import { adminAuthMiddleware } from "../../apps/gateway/routes/admin.ts";
import {
  adminOriginGuard,
  allowedHostsFromEnv,
} from "../../apps/gateway/routes/origin-guard.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";

const base = "http://gateway.test";

async function makeContext(
  opts: { adminToken?: string; withCache?: boolean } = {},
): Promise<AppContext> {
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    config: await ConfigService.open(":memory:"),
    cache: opts.withCache ? new SemanticCache() : undefined,
    adminToken: opts.adminToken,
  };
}

/** Mirrors the createHandler middleware order around the /api/* control plane. */
function handlerFor(ctx: AppContext): (req: Request) => Promise<Response> {
  const router = new Router();
  registerSettingsRoutes(router, ctx);
  return applyMiddleware((req) => router.handle(req), [
    errorHandler,
    adminOriginGuard(allowedHostsFromEnv()),
    adminAuthMiddleware(ctx.adminToken),
  ]);
}

Deno.test("settings API: bearer-token gate protects /api/settings", async () => {
  const ctx = await makeContext({ adminToken: "s3cret" });
  const handler = handlerFor(ctx);

  const denied = await handler(new Request(`${base}/api/settings`));
  assertEquals(denied.status, 401);

  const allowed = await handler(
    new Request(`${base}/api/settings`, {
      headers: { Authorization: "Bearer s3cret" },
    }),
  );
  assertEquals(allowed.status, 200);
  await allowed.body?.cancel();

  ctx.config!.close();
});

Deno.test("settings API: admin-lockout invariant holds under hostile security overrides", async () => {
  const ctx = await makeContext({ adminToken: "s3cret" });
  const handler = handlerFor(ctx);
  const auth = { Authorization: "Bearer s3cret" };

  // Persist the most dangerous security mutations at once: disable inference
  // auth, force VK enforcement, wipe the route whitelist, restrict origins,
  // and enable password protection.
  const put = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        security: {
          disableInferenceAuth: true,
          enforceVirtualKeys: true,
          whitelistedRoutes: [],
          allowedOrigins: ["https://evil.example"],
          passwordProtectEnabled: true,
          password: "lockme-out",
        },
      }),
    }),
  );
  assertEquals(put.status, 200);
  const putBody = await put.json();
  // Values are persisted + reflected...
  assertEquals(putBody.settings.security.values.disableInferenceAuth, true);
  assertEquals(
    putBody.settings.security.sources.disableInferenceAuth,
    "override",
  );
  assertEquals(putBody.settings.security.values.hasPassword, true);
  // ...but NONE of them is actually enforced (persist + reflect only).
  assertEquals(putBody.enforcement["security.disableInferenceAuth"], false);
  assertEquals(putBody.enforcement["security.enforceVirtualKeys"], false);
  assertEquals(putBody.enforcement["security.whitelistedRoutes"], false);
  // Secret never leaks.
  assert(!JSON.stringify(putBody).includes("lockme-out"));

  // INVARIANT: the admin surface is still reachable with the token...
  const stillReachable = await handler(
    new Request(`${base}/api/settings`, { headers: auth }),
  );
  assertEquals(stillReachable.status, 200);
  await stillReachable.body?.cancel();

  // ...and the token gate itself is still intact (no bypass introduced).
  const stillGated = await handler(new Request(`${base}/api/settings`));
  assertEquals(stillGated.status, 401);

  ctx.config!.close();
});

Deno.test("settings API: caching enforcement flag tracks a live cache", async () => {
  // With a cache present, its live key/tuning controls report enforced.
  const withCache = await makeContext({ withCache: true });
  const withHandler = handlerFor(withCache);
  const res = await withHandler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caching: {
          ttlSeconds: 120,
          similarityThreshold: 0.7,
          cacheByProvider: true,
          excludeSystemPrompt: true,
          conversationHistoryThreshold: 5,
        },
      }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enforcement["caching.ttlSeconds"], true);
  assertEquals(body.enforcement["caching.similarityThreshold"], true);
  assertEquals(body.enforcement["caching.cacheByProvider"], true);
  assertEquals(body.enforcement["caching.excludeSystemPrompt"], true);
  assertEquals(body.enforcement["caching.conversationHistoryThreshold"], true);
  assertEquals(body.settings.caching.values.ttlSeconds, 120);
  withCache.config!.close();

  // Without a cache, the same knobs report persist-only (enforced:false).
  const noCache = await makeContext();
  const noHandler = handlerFor(noCache);
  const res2 = await noHandler(new Request(`${base}/api/settings`));
  const body2 = await res2.json();
  assertEquals(body2.enforcement["caching.ttlSeconds"], false);
  assertEquals(body2.enforcement["caching.similarityThreshold"], false);
  assertEquals(body2.enforcement["caching.cacheByProvider"], false);
  noCache.config!.close();
});
