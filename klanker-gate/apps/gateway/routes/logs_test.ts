import { assert, assertEquals } from "@std/assert";
import { Router } from "../../../packages/core/src/mod.ts";
import { registerLogRoutes } from "./logs.ts";
import { type AppContext, NullToolExecutor, VERSION } from "../context.ts";
import { ProviderManager } from "../../../packages/providers/src/mod.ts";
import { Metrics } from "../../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../../packages/telemetry/src/logbus.ts";
import type { LogEntry } from "../../../packages/telemetry/src/logbus.ts";
import { LogStore } from "../../../packages/telemetry/src/logstore.ts";
import { PricingCatalog } from "../../../packages/governance/src/pricing.ts";
import { VirtualKeyManager } from "../../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../../packages/plugins/src/lifecycle.ts";
import { MemoryStateStore } from "../../../packages/config/src/store_memory.ts";

const base = "http://gateway.test";

function makeCtx(logStore?: LogStore): AppContext {
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    logStore,
    pricing: new PricingCatalog(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

function routerFor(ctx: AppContext): Router {
  const router = new Router();
  registerLogRoutes(router, ctx);
  return router;
}

function entry(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: "info",
    message: "ok",
    requestId: crypto.randomUUID(),
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    durationMs: 10,
    ...partial,
  };
}

async function withStore(
  fn: (store: LogStore) => Promise<void>,
  opts?: { maxEntries?: number; pruneEvery?: number },
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const cs = MemoryStateStore.named(`${dir}/logs.kv`);
  try {
    await fn(new LogStore(cs, opts?.maxEntries, opts?.pruneEvery));
  } finally {
    cs.close();
  }
}

Deno.test("GET /api/logs/stats returns the aggregate contract", async () => {
  await withStore(async (store) => {
    await store.append(entry({
      status: 200,
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 50,
      costMicroUsd: 500,
    }));
    await store.append(entry({ status: 500 }));

    const res = await routerFor(makeCtx(store)).handle(
      new Request(`${base}/api/logs/stats`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 2);
    assertEquals(body.byStatusClass["2xx"], 1);
    assertEquals(body.byStatusClass["5xx"], 1);
    assertEquals(body.successCount, 1);
    assertEquals(body.errorCount, 1);
    assertEquals(body.promptTokens, 100);
    assertEquals(body.totalTokens, 150);
    assertEquals(body.costMicroUsd, 500);
    assertEquals(body.costUsd, 0.0005);
  });
});

Deno.test("GET /api/logs/dropped answers 0 honestly without a store", async () => {
  const res = await routerFor(makeCtx(undefined)).handle(
    new Request(`${base}/api/logs/dropped`),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { dropped: 0, bufferEvicted: 0 });
});

Deno.test("GET /api/logs/dropped reports store cap-prune evictions", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.append(entry({ requestId: String(i) }));
    }
    const res = await routerFor(makeCtx(store)).handle(
      new Request(`${base}/api/logs/dropped`),
    );
    const body = await res.json();
    assertEquals(body.dropped, 3);
  }, { maxEntries: 2, pruneEvery: 1 });
});

Deno.test("GET /api/logs/filterdata returns distinct facets", async () => {
  await withStore(async (store) => {
    await store.append(entry({
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "gpt-4o",
      provider: "openai",
    }));
    await store.append(
      entry({ method: "GET", path: "/api/logs", status: 200 }),
    );

    const res = await routerFor(makeCtx(store)).handle(
      new Request(`${base}/api/logs/filterdata`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.methods, ["GET", "POST"]);
    assertEquals(body.models, ["gpt-4o"]);
    assertEquals(body.providers, ["openai"]);
    assert(body.statuses.includes(200));
  });
});

Deno.test("POST /api/logs/recalculate-cost derives cost from the pricing catalog", async () => {
  await withStore(async (store) => {
    // 1000 prompt tokens * $2.5/Mtok (gpt-4o) = 2500 micro-USD.
    await store.append(entry({ model: "gpt-4o", promptTokens: 1000 }));
    // Unpriced model => no derivable cost => left untouched.
    await store.append(entry({ model: "no-such-model", promptTokens: 100 }));

    const res = await routerFor(makeCtx(store)).handle(
      new Request(`${base}/api/logs/recalculate-cost`, { method: "POST" }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.recalculated, 1);
    assertEquals(body.scanned, 2);

    const priced = (await store.query({ q: "chat" })).entries
      .find((e) => e.model === "gpt-4o");
    assertEquals(priced?.costMicroUsd, 2500);
  });
});

Deno.test("store-backed log endpoints 404 when the store is disabled", async () => {
  const router = routerFor(makeCtx(undefined));
  // All five store-backed routes answer with the canonical error envelope; the
  // message names `pg`, the live "on" value (the retired `kv` is still an
  // accepted input, but must never be advertised).
  const routes: Array<[string, string]> = [
    ["GET", "/api/logs/stored"],
    ["GET", "/api/logs/stats"],
    ["GET", "/api/logs/filterdata"],
    ["POST", "/api/logs/recalculate-cost"],
    ["DELETE", "/api/logs/stored"],
  ];
  for (const [method, path] of routes) {
    const res = await router.handle(new Request(`${base}${path}`, { method }));
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body, {
      error: {
        message:
          "Log store is disabled; set FROSTY_LOG_STORE=pg to enable the durable request log.",
        type: "not_found",
        param: null,
        code: null,
      },
    });
  }
});
