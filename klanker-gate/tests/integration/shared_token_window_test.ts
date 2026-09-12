// REGRESSION (decision-log 77): the fleet token window must consume the
// request's token ESTIMATE, not one unit per request.
//
// `enforceSharedLimits` accepts an `estimatedTokens` argument, but the
// middleware called it without one and the parameter defaulted to 1. Every
// deployment with FROSTY_WORKERS>1 therefore metered its token window in
// requests rather than tokens, so a `maxTokens: 100` key admitted 100 requests
// of any size instead of roughly one 400-character request. These cases fail on
// that code and pass on the fix.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import { MemoryStateStore } from "../../packages/config/src/store_memory.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { SharedRateLimiter } from "../../packages/governance/src/shared_rate_limit.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

/** Mirrors the fleet wiring in `createDefaultContext`: shared limiter attached
 * and the in-process windows stood down, so exactly one authority counts. */
async function fleetContext(mockUrl: string): Promise<AppContext> {
  const virtualKeys = new VirtualKeyManager();
  const sharedRateLimit = new SharedRateLimiter(new MemoryStateStore());
  virtualKeys.useExternalRateLimit(true);
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mockUrl,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys,
    sharedRateLimit,
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    config: await ConfigService.open(":memory:"),
  };
}

/** A chat request whose serialized body is at least `chars` long, so the
 * `ceil(len/4)` estimate is predictable and well above 1. */
function bigChatRequest(token: string, chars: number): Request {
  const body = JSON.stringify({
    model: "m1",
    messages: [{ role: "user", content: "x".repeat(chars) }],
  });
  return new Request(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

Deno.test("REGRESSION: fleet token window meters tokens, not requests", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await fleetContext(mock.url);
  // 4000 characters of content is an estimate of ~1000 tokens, ten times the
  // window. One request must exhaust it.
  ctx.virtualKeys.upsert({
    id: "k",
    name: "tokens",
    token: "vk-token-window",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    tokenLimit: { maxTokens: 100, windowMs: 60_000 },
  });
  const handler = createHandler(ctx);
  try {
    const res = await handler(bigChatRequest("vk-token-window", 4000));
    // Pre-fix this consumed 1 unit against a 100-unit window and returned 200.
    assertEquals(res.status, 429);
    const body = await res.json() as { error?: { code?: string } };
    assertEquals(body.error?.code, "token_limited");
  } finally {
    ctx.config?.close();
    await mock.close();
  }
});

Deno.test("fleet token window still admits a request inside the limit", async () => {
  // Guards the opposite direction: the fix must not deny everything.
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await fleetContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "k",
    name: "tokens",
    token: "vk-token-ok",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    tokenLimit: { maxTokens: 100_000, windowMs: 60_000 },
  });
  const handler = createHandler(ctx);
  try {
    const res = await handler(bigChatRequest("vk-token-ok", 4000));
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    ctx.config?.close();
    await mock.close();
  }
});

Deno.test("fleet request window is unaffected by the token estimate", async () => {
  // The requests window must keep consuming exactly 1 per request regardless of
  // body size, or a large prompt would burn a rate limit measured in requests.
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await fleetContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "k",
    name: "requests",
    token: "vk-request-window",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    rateLimit: { maxRequests: 2, windowMs: 60_000 },
  });
  const handler = createHandler(ctx);
  try {
    const first = await handler(bigChatRequest("vk-request-window", 4000));
    assertEquals(first.status, 200);
    await first.body?.cancel();
    const second = await handler(bigChatRequest("vk-request-window", 4000));
    assertEquals(second.status, 200);
    await second.body?.cancel();
    const third = await handler(bigChatRequest("vk-request-window", 4000));
    assertEquals(third.status, 429);
    const body = await third.json() as { error?: { code?: string } };
    assert(body.error?.code === "rate_limited");
  } finally {
    ctx.config?.close();
    await mock.close();
  }
});
