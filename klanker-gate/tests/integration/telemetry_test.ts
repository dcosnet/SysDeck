// Always-on telemetry, /api/analytics, and the pricing force-sync route,
// end-to-end through createHandler. Telemetry must capture even with ZERO
// virtual keys (tokenless local dev is how the stack is verified live).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { UsageTracker } from "../../packages/telemetry/src/usagestore.ts";
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

function makeContext(mockUrl: string, adminToken?: string): AppContext {
  const metrics = new Metrics();
  const pricing = new PricingCatalog();
  metrics.setKnownModels(pricing.modelKeys());
  return {
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
    logBus: new LogBus(),
    usage: new UsageTracker(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    pricing,
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    adminToken,
  };
}

function chat(body: unknown): Request {
  return new Request("http://gw.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("telemetry: JSON usage captured with zero virtual keys", async () => {
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
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const res = await handler(
      chat({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();

    // No virtual keys, yet the request is fully observed.
    assert(!ctx.virtualKeys.active());
    assertEquals(ctx.usage!.count(), 1);

    const prom = ctx.metrics.renderPrometheus();
    assertStringIncludes(
      prom,
      'frosty_input_tokens_total{provider="openai",model="gpt-4o"} 1000',
    );
    assertStringIncludes(
      prom,
      'frosty_output_tokens_total{provider="openai",model="gpt-4o"} 500',
    );
    assertStringIncludes(
      prom,
      'frosty_llm_requests_total{provider="openai",model="gpt-4o",status_class="2xx"} 1',
    );
    // Backward-compat: with no virtual key, no tenant labels are emitted.
    assert(!prom.includes("virtual_key="));

    const analytics = await (await handler(
      new Request("http://gw.test/api/analytics?window=24h"),
    ))
      .json();
    assertEquals(analytics.tracked, true);
    assertEquals(analytics.totals.requests, 1);
    assertEquals(analytics.totals.promptTokens, 1000);
    assertEquals(analytics.totals.totalTokens, 1500);
    assertEquals(analytics.byModel[0].model, "gpt-4o");
    assertEquals(analytics.byProvider[0].provider, "openai");
    // No key resolved -> no per-tenant rollup rows.
    assertEquals(analytics.byVirtualKey, []);
  } finally {
    await mock.close();
  }
});

Deno.test("telemetry: per-tenant attribution flows from governance to metrics + analytics", async () => {
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
  const ctx = makeContext(mock.url);
  // A full key -> team -> customer chain, created before the handler so the
  // known-virtual-key allowlist is seeded at route registration.
  ctx.hierarchy!.upsertCustomer({
    id: "cust-1",
    name: "acme",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  ctx.hierarchy!.upsertTeam({
    id: "team-1",
    name: "core",
    enabled: true,
    customerId: "cust-1",
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  ctx.virtualKeys.upsert({
    id: "vk-1",
    name: "alpha",
    token: "vk-alpha-token-123",
    enabled: true,
    teamId: "team-1",
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  try {
    const res = await handler(
      new Request("http://gw.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer vk-alpha-token-123",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();

    // Metrics carry the tenant labels; the vk id is bounded to the known store.
    const prom = ctx.metrics.renderPrometheus();
    assertStringIncludes(
      prom,
      'frosty_input_tokens_total{provider="openai",model="gpt-4o",virtual_key="vk-1",team="team-1",customer="cust-1"} 1000',
    );
    assertStringIncludes(
      prom,
      'frosty_llm_requests_total{provider="openai",model="gpt-4o",status_class="2xx",virtual_key="vk-1",team="team-1",customer="cust-1"} 1',
    );

    // The usage record carries the resolved identity (ids + name).
    const r = await ctx.usage!.rollup({ window: "24h" });
    assertEquals(r.byVirtualKey.length, 1);
    assertEquals(r.byVirtualKey[0].virtualKeyId, "vk-1");
    assertEquals(r.byVirtualKey[0].virtualKeyName, "alpha");
    assertEquals(r.byVirtualKey[0].teamId, "team-1");
    assertEquals(r.byVirtualKey[0].customerId, "cust-1");
    assertEquals(r.byVirtualKey[0].totalTokens, 1500);
  } finally {
    await mock.close();
  }
});

Deno.test("telemetry: streaming usage captured after the stream is consumed", async () => {
  const frames = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
    "data: [DONE]\n\n",
  ];
  const mock = new MockProvider(() => sseResponse(frames));
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const res = await handler(chat({
      model: "openai/gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }));
    assertEquals(res.status, 200);
    const text = await res.text(); // consume fully -> triggers the tap flush
    assertStringIncludes(text, "[DONE]");
    // The flush + fire-and-forget record complete on stream close; settle a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assertEquals(ctx.usage!.count(), 1);
    const r = await ctx.usage!.rollup({ window: "24h" });
    assertEquals(r.totals.promptTokens, 8);
    assertEquals(r.totals.completionTokens, 3);
    assertEquals(r.totals.totalTokens, 11);
  } finally {
    await mock.close();
  }
});

Deno.test("analytics: empty tracker reports tracked=false; window validated", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("x")));
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const empty = await (await handler(
      new Request("http://gw.test/api/analytics"),
    )).json();
    assertEquals(empty.tracked, false);
    assertEquals(empty.window, "24h"); // default
    assertEquals(empty.series.length, 12);

    const bad = await (await handler(
      new Request("http://gw.test/api/analytics?window=99y"),
    )).json();
    assertEquals(bad.window, "24h"); // invalid falls back to default

    const ok = await (await handler(
      new Request("http://gw.test/api/analytics?window=7d"),
    )).json();
    assertEquals(ok.window, "7d");
  } finally {
    await mock.close();
  }
});

Deno.test("analytics inherits admin auth (401 without the token)", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("x")));
  const ctx = makeContext(mock.url, "s3cret");
  const handler = createHandler(ctx);
  try {
    const denied = await handler(new Request("http://gw.test/api/analytics"));
    assertEquals(denied.status, 401);
    await denied.body?.cancel();

    const ok = await handler(
      new Request("http://gw.test/api/analytics", {
        headers: { "Authorization": "Bearer s3cret" },
      }),
    );
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  } finally {
    await mock.close();
  }
});

Deno.test("force-sync route refreshes pricing from the env URL", async () => {
  const payload = {
    "gpt-4o": {
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
      mode: "chat",
    },
    "brand-new-model": {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    },
  };
  const source = Deno.serve(
    { port: 0, onListen: () => {} },
    () => jsonResponse(payload),
  );
  const url = `http://127.0.0.1:${
    (source.addr as Deno.NetAddr).port
  }/prices.json`;
  const prev = Deno.env.get("FROSTY_PRICING_URL");
  Deno.env.set("FROSTY_PRICING_URL", url);

  const mock = new MockProvider(() => jsonResponse(openAIChatBody("x")));
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const res = await handler(
      new Request("http://gw.test/api/pricing/force-sync", { method: "POST" }),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as { synced: number; updatedAt: string };
    assertEquals(body.synced, 2);
    assert(typeof body.updatedAt === "string");
    // The previously-unknown model is now priced.
    assert(ctx.pricing!.get("brand-new-model") !== undefined);
  } finally {
    if (prev === undefined) {
      Deno.env.delete("FROSTY_PRICING_URL");
    } else {
      Deno.env.set("FROSTY_PRICING_URL", prev);
    }
    await source.shutdown();
    await mock.close();
  }
});
