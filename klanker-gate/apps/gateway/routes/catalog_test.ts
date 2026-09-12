import { assert, assertEquals } from "@std/assert";
import { Router } from "../../../packages/core/src/mod.ts";
import { registerCatalogRoutes } from "./catalog.ts";
import { type AppContext, NullToolExecutor, VERSION } from "../context.ts";
import { ProviderManager } from "../../../packages/providers/src/mod.ts";
import { Metrics } from "../../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../../packages/governance/src/virtual_keys.ts";
import { UsageTracker } from "../../../packages/telemetry/src/usagestore.ts";
import { MCPRegistry } from "../../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../../packages/plugins/src/lifecycle.ts";

// The catalog route is not yet wired into main.ts (the orchestrator applies the
// registration lines), so these tests register it on a bare Router directly.

const base = "http://gateway.test";

function usageRecord(provider: string, model: string, cost: number) {
  return {
    ts: new Date().toISOString(),
    provider,
    model,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    costMicroUsd: cost,
    durationMs: 5,
    status: 200,
    stream: false,
    cacheHit: false,
  };
}

function baseContext(
  providers: ProviderManager,
  usage: UsageTracker,
): AppContext {
  return {
    providers,
    metrics: new Metrics(),
    logBus: new LogBus(),
    usage,
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

function makeContext(): AppContext {
  const providers = new ProviderManager([
    {
      id: "openai",
      type: "openai",
      apiKey: "k",
      enabled: true,
      models: ["gpt-4o", "gpt-4o-mini"],
      priority: 0,
    },
    {
      id: "local",
      type: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      enabled: true,
      models: ["gpt-4o", "local-llama"], // gpt-4o shared with openai
      priority: 0,
    },
  ]);
  const usage = new UsageTracker();
  usage.record(usageRecord("openai", "gpt-4o", 2_000_000));
  usage.record(usageRecord("openai", "gpt-4o-mini", 500_000));
  usage.record(usageRecord("local", "local-llama", 1_000_000));
  return baseContext(providers, usage);
}

function catalogRouter(ctx: AppContext): Router {
  const router = new Router();
  registerCatalogRoutes(router, ctx);
  return router;
}

Deno.test("GET /api/catalog joins providers with 24h analytics", async () => {
  const router = catalogRouter(makeContext());
  const res = await router.handle(new Request(`${base}/api/catalog`));
  assertEquals(res.status, 200);
  const body = await res.json();

  const byId = new Map(body.providers.map((p: { id: string }) => [p.id, p]));
  const openai = byId.get("openai") as {
    type: string;
    custom: boolean;
    models: string[];
    traffic24h: number;
    cost24h: number;
  };
  assertEquals(openai.type, "openai");
  assertEquals(openai.custom, false);
  assertEquals(openai.models, ["gpt-4o", "gpt-4o-mini"]);
  assertEquals(openai.traffic24h, 2);
  assertEquals(openai.cost24h, 2.5); // (2_000_000 + 500_000) micro-USD

  const local = byId.get("local") as { custom: boolean; traffic24h: number };
  assertEquals(local.custom, true); // lmstudio is a generic custom endpoint
  assertEquals(local.traffic24h, 1);

  // Totals: 2 providers, 3 distinct models (gpt-4o shared), 3 requests, 3.5c.
  assertEquals(body.totals.providers, 2);
  assertEquals(body.totals.models, 3);
  assertEquals(body.totals.requests24h, 3);
  assertEquals(body.totals.cost24h, 3.5);
});

Deno.test("GET /api/catalog omits disabled providers", async () => {
  const providers = new ProviderManager([
    {
      id: "openai",
      type: "openai",
      apiKey: "k",
      enabled: true,
      models: ["gpt-4o", "gpt-4o-mini"],
      priority: 0,
    },
    {
      id: "retired",
      type: "openai",
      apiKey: "k",
      enabled: false,
      // gpt-4o-mini shared with openai; retired-only exposes the exclusion.
      models: ["gpt-4o-mini", "retired-only"],
      priority: 0,
    },
  ]);
  const router = catalogRouter(baseContext(providers, new UsageTracker()));
  const res = await router.handle(new Request(`${base}/api/catalog`));
  assertEquals(res.status, 200);
  const body = await res.json();

  const ids = body.providers.map((p: { id: string }) => p.id);
  assert(ids.includes("openai"));
  assert(!ids.includes("retired")); // disabled provider absent from listing

  // Totals derive from the enabled provider only: 1 provider, 2 distinct
  // models (the disabled account's retired-only is excluded).
  assertEquals(body.totals.providers, 1);
  assertEquals(body.totals.models, 2);
});

Deno.test("GET /api/catalog reports zeros when no analytics exist", async () => {
  const providers = new ProviderManager([
    {
      id: "openai",
      type: "openai",
      apiKey: "k",
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
    },
  ]);
  const router = catalogRouter(baseContext(providers, new UsageTracker()));
  const res = await router.handle(new Request(`${base}/api/catalog`));
  const body = await res.json();
  assertEquals(body.providers[0].traffic24h, 0);
  assertEquals(body.providers[0].cost24h, 0);
  assertEquals(body.totals.requests24h, 0);
  assert(Array.isArray(body.providers));
});
