// The Logs dashboard trail, end-to-end through createHandler.
//
// Regression cover for two defects found on a live deployment (2026-07-25):
//
//   1. NO producer populated provider/model/token/cost on a LogEntry. The
//      request-logger middleware is the only publisher and it sees just
//      method/path/status, so the Logs view rendered "N/A" for every inference
//      dimension no matter how much real traffic flowed. On the old code every
//      assertion about ctx.logBus entry.model / totalTokens / costMicroUsd
//      below fails with `undefined`.
//   2. Machine probes (/healthz, /metrics) were 4982 of 5000 stored entries,
//      so the capped trail pruned real requests away. On the old code the
//      health-probe exclusion test below fails, because the probe is stored.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  createLogEnrichment,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import {
  LogBus,
  makePathExcluder,
} from "../../packages/telemetry/src/logbus.ts";
import { LogStore } from "../../packages/telemetry/src/logstore.ts";
import { UsageTracker } from "../../packages/telemetry/src/usagestore.ts";
import type { StateStore } from "../../packages/config/src/store.ts";
import { MemoryStateStore } from "../../packages/config/src/store_memory.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import { PricingCatalog } from "../../packages/governance/src/pricing.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

interface Harness {
  ctx: AppContext;
  handler: (req: Request) => Promise<Response>;
  close: () => void;
}

/**
 * Wires the log trail exactly as the composition root does, so these tests
 * exercise the production sink rather than a re-implementation of it.
 */
async function makeHarness(
  mockUrl: string,
  opts: { store?: boolean; excludePaths?: string } = {},
): Promise<Harness> {
  const metrics = new Metrics();
  const pricing = new PricingCatalog();
  metrics.setKnownModels(pricing.modelKeys());

  const logBus = new LogBus();
  let configStore: StateStore | undefined;
  let logStore: LogStore | undefined;
  if (opts.store) {
    const dir = await Deno.makeTempDir();
    configStore = MemoryStateStore.named(`${dir}/logs.kv`);
    logStore = new LogStore(configStore);
  }

  const ctx: AppContext = {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: mockUrl,
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics,
    logBus,
    logStore,
    logEnrichment: createLogEnrichment(logBus, logStore),
    logExcludedPath: makePathExcluder(opts.excludePaths),
    usage: new UsageTracker(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    pricing,
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };

  return {
    ctx,
    handler: createHandler(ctx),
    close: () => configStore?.close(),
  };
}

function chat(body: unknown): Request {
  return new Request("http://gw.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CHAT_BODY = {
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "hi" }],
};

/** The log entry for the inference request (probes are excluded by default). */
function inferenceEntry(ctx: AppContext) {
  return ctx.logBus.recent(50).find((e) => e.path === "/v1/chat/completions");
}

Deno.test("log trail: a non-streamed completion records provider, model, tokens, cost", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("hi", {
      model: "gpt-4o",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      },
    }))
  );
  const h = await makeHarness(mock.url);
  try {
    const res = await h.handler(chat(CHAT_BODY));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const entry = inferenceEntry(h.ctx);
    assert(entry, "the inference request must be logged");
    assertEquals(entry.provider, "openai");
    assertEquals(entry.model, "gpt-4o");
    assertEquals(entry.promptTokens, 1000);
    assertEquals(entry.completionTokens, 500);
    assertEquals(entry.totalTokens, 1500);
    assert(
      typeof entry.costMicroUsd === "number",
      "a priced model records integer micro-USD cost",
    );
    // Base fields are untouched by enrichment.
    assertEquals(entry.status, 200);
    assertEquals(entry.method, "POST");
    assert(typeof entry.durationMs === "number");
  } finally {
    await mock.close();
    h.close();
  }
});

Deno.test("log trail: a streamed completion is patched in place when usage arrives", async () => {
  const frames = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],' +
    '"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\n',
    "data: [DONE]\n\n",
  ];
  const mock = new MockProvider(() => sseResponse(frames));
  const h = await makeHarness(mock.url);
  try {
    const res = await h.handler(chat({ ...CHAT_BODY, stream: true }));
    assertEquals(res.status, 200);

    // The entry is published while the body is still unread, so at this point
    // the request logger has emitted with no usage available.
    const beforeDrain = inferenceEntry(h.ctx);
    assert(beforeDrain, "the streamed request is logged immediately");
    assertEquals(beforeDrain.totalTokens, undefined);
    assert(typeof beforeDrain.durationMs === "number");

    // Draining the stream flushes the usage tap, which patches the entry.
    await res.text();

    const entry = inferenceEntry(h.ctx);
    assertEquals(entry?.model, "gpt-4o");
    assertEquals(entry?.promptTokens, 20);
    assertEquals(entry?.completionTokens, 10);
    assertEquals(entry?.totalTokens, 30);
    // Patched in place: one row per request, not a duplicate.
    assertEquals(
      h.ctx.logBus.recent(50).filter((e) => e.path === "/v1/chat/completions")
        .length,
      1,
    );
  } finally {
    await mock.close();
    h.close();
  }
});

Deno.test("log trail: the durable store carries the same enrichment", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("hi", {
      model: "gpt-4o",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }))
  );
  const h = await makeHarness(mock.url, { store: true });
  try {
    await (await h.handler(chat(CHAT_BODY))).body?.cancel();

    const { entries } = await h.ctx.logStore!.query({ limit: 50 });
    const stored = entries.find((e) => e.path === "/v1/chat/completions");
    assert(stored, "the inference request reaches the durable trail");
    assertEquals(stored.model, "gpt-4o");
    assertEquals(stored.totalTokens, 10);

    // The dimensions the UI facets read are no longer honestly-empty.
    const facets = await h.ctx.logStore!.filterData();
    assertEquals(facets.models, ["gpt-4o"]);
    assertEquals(facets.providers, ["openai"]);

    const stats = await h.ctx.logStore!.stats();
    assertEquals(stats.totalTokens, 10);
  } finally {
    await mock.close();
    h.close();
  }
});

Deno.test("log trail: health probes are excluded from bus and store, not from stdout", async () => {
  const mock = new MockProvider(() => jsonResponse({ ok: true }));
  const h = await makeHarness(mock.url, { store: true });
  try {
    for (let i = 0; i < 5; i++) {
      await (await h.handler(new Request("http://gw.test/healthz"))).body
        ?.cancel();
    }
    await (await h.handler(new Request("http://gw.test/metrics"))).body
      ?.cancel();

    assertEquals(
      h.ctx.logBus.recent(50).length,
      0,
      "probe traffic never reaches the dashboard trail",
    );
    assertEquals((await h.ctx.logStore!.query({ limit: 50 })).total, 0);

    // A real request still lands.
    await (await h.handler(new Request("http://gw.test/api/logs/dropped")))
      .body?.cancel();
    assertEquals(h.ctx.logBus.recent(50).length, 1);
    assertEquals(h.ctx.logBus.recent(50)[0].path, "/api/logs/dropped");
  } finally {
    await mock.close();
    h.close();
  }
});

Deno.test("log trail: exclusion is overridable, so the trail can stay complete", async () => {
  const mock = new MockProvider(() => jsonResponse({ ok: true }));
  const h = await makeHarness(mock.url, { excludePaths: "off" });
  try {
    await (await h.handler(new Request("http://gw.test/healthz"))).body
      ?.cancel();
    assertEquals(h.ctx.logBus.recent(50).length, 1);
    assertEquals(h.ctx.logBus.recent(50)[0].path, "/healthz");
  } finally {
    await mock.close();
    h.close();
  }
});

Deno.test("log trail: non-inference requests gain no borrowed enrichment", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("hi", {
      model: "gpt-4o",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }))
  );
  const h = await makeHarness(mock.url);
  try {
    await (await h.handler(chat(CHAT_BODY))).body?.cancel();
    await (await h.handler(new Request("http://gw.test/api/logs/dropped")))
      .body?.cancel();

    const admin = h.ctx.logBus.recent(50).find((e) =>
      e.path === "/api/logs/dropped"
    );
    assert(admin);
    assertEquals(admin.model, undefined);
    assertEquals(admin.provider, undefined);
    assertEquals(admin.totalTokens, undefined);
    assertEquals(admin.costMicroUsd, undefined);
  } finally {
    await mock.close();
    h.close();
  }
});
