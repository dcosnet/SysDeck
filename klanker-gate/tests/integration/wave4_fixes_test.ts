// Wave-4 verification-pass fixes: governance coverage of the translated
// compat families, usage-shape normalization, streaming cost accounting,
// cache-hit exemption, binary-body estimates, Retry-After fidelity,
// /metrics auth, /mcp batch rejection, rate-limit window integrity,
// fail-open semantic cache, and plugin isolation.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import { type AppContext, VERSION } from "../../apps/gateway/context.ts";
import { governanceMiddleware } from "../../apps/gateway/routes/governance.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import {
  type VirtualKey,
  VirtualKeyManager,
} from "../../packages/governance/src/virtual_keys.ts";
import { PricingCatalog } from "../../packages/governance/src/pricing.ts";
import { RateLimiter } from "../../packages/governance/src/rate_limit.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";
import { InMemoryVectorStore } from "../../packages/cache/src/vector.ts";

const TOKEN = "vk-wave4-secret";

function keyed(overrides: Partial<VirtualKey> = {}): VirtualKey {
  return {
    id: "k1",
    name: "wave4",
    token: TOKEN,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    ...overrides,
  };
}

function govContext(key: VirtualKey = keyed()): AppContext {
  const mcp = new MCPRegistry();
  return {
    providers: new ProviderManager(),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager([key]),
    pricing: new PricingCatalog(),
    mcp,
    plugins: new PluginManager(),
    toolExecutor: mcp.executor(),
    version: VERSION,
  };
}

function authed(
  url: string,
  body = "{}",
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

Deno.test("governance covers the /genai and /cohere translated families", async () => {
  const handler = createHandler(govContext());
  for (
    const path of [
      "/genai/v1beta/models/gpt-4o:generateContent",
      "/cohere/v2/chat",
    ]
  ) {
    const res = await handler(
      new Request(`http://g.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assertEquals(res.status, 401, path);
    // A genai path answers in the GenAI error envelope (decision-log 86), so
    // the gateway code rides `details[].reason`; /cohere keeps the canonical
    // envelope. Admission itself is identical on both - that is what this
    // test guards.
    const body = await res.json() as {
      error: { code: unknown; details?: Array<{ reason?: string }> };
    };
    const gatewayCode = typeof body.error.code === "string"
      ? body.error.code
      : body.error.details?.[0]?.reason;
    assertEquals(gatewayCode, "missing_virtual_key", path);
  }
});

Deno.test("Anthropic-shaped usage (input/output_tokens) is billed", async () => {
  const ctx = govContext(keyed({ budget: { maxCostUsd: 10 } }));
  const mw = governanceMiddleware(ctx);
  const res = await mw(
    authed("http://g.test/v1/messages"),
    () =>
      Promise.resolve(Response.json({
        model: "gpt-4o",
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      })),
  );
  assertEquals(res.status, 200);
  // 1M in @ $2.5/M + 0.5M out @ $10/M = $7.50 = 7_500_000 micro-USD.
  assertEquals(ctx.virtualKeys.get("k1")?.usedCostMicroUsd, 7_500_000);
});

Deno.test("streaming responses are billed from the SSE usage tail", async () => {
  const ctx = govContext(keyed({ budget: { maxCostUsd: 10 } }));
  const mw = governanceMiddleware(ctx);
  const sse = [
    `data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}`,
    "",
    `data: {"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":500000}}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const res = await mw(
    authed("http://g.test/v1/chat/completions"),
    () =>
      Promise.resolve(
        new Response(sse, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  );
  const body = await res.text(); // consume: accounting runs at flush
  assert(body.includes("[DONE]"));
  assertEquals(ctx.virtualKeys.get("k1")?.usedCostMicroUsd, 7_500_000);
});

Deno.test("cache hits are not billed against cost budgets", async () => {
  const ctx = govContext(keyed({ budget: { maxCostUsd: 10 } }));
  const mw = governanceMiddleware(ctx);
  const res = await mw(
    authed("http://g.test/v1/chat/completions"),
    () => {
      const hit = Response.json({
        model: "gpt-4o",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      });
      hit.headers.set("x-frosty-cache", "hit");
      return Promise.resolve(hit);
    },
  );
  assertEquals(res.status, 200);
  assertEquals(ctx.virtualKeys.get("k1")?.usedCostMicroUsd, 0);
});

Deno.test("binary bodies are not token-estimated (JSON only)", async () => {
  const ctx = govContext(
    keyed({ tokenLimit: { maxTokens: 10, windowMs: 60_000 } }),
  );
  const mw = governanceMiddleware(ctx);
  const next = () => Promise.resolve(new Response("ok"));

  // 4KB binary upload: estimate must be 0 (admitted, consuming 1 token).
  const binary = await mw(
    new Request("http://g.test/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(4096),
    }),
    next,
  );
  assertEquals(binary.status, 200);

  // The same size as JSON blows the 10-token window.
  const json = await mw(
    authed("http://g.test/v1/chat/completions", "x".repeat(4096)),
    next,
  );
  assertEquals(json.status, 429);
});

Deno.test("Retry-After reflects the actual window, not a fixed 60s", async () => {
  const ctx = govContext(
    keyed({ rateLimit: { maxRequests: 1, windowMs: 5_000 } }),
  );
  const mw = governanceMiddleware(ctx);
  const next = () => Promise.resolve(new Response("ok"));
  assertEquals((await mw(authed("http://g.test/v1/x"), next)).status, 200);
  const limited = await mw(authed("http://g.test/v1/x"), next);
  assertEquals(limited.status, 429);
  const retryAfter = Number(limited.headers.get("Retry-After"));
  assert(retryAfter >= 1 && retryAfter <= 5, `Retry-After=${retryAfter}`);
});

Deno.test("/metrics requires the admin token when one is configured", async () => {
  const ctx = { ...govContext(), adminToken: "admin-secret-1" };
  const handler = createHandler(ctx);
  const anon = await handler(new Request("http://g.test/metrics"));
  assertEquals(anon.status, 401);
  const authed_ = await handler(
    new Request("http://g.test/metrics", {
      headers: { Authorization: "Bearer admin-secret-1" },
    }),
  );
  assertEquals(authed_.status, 200);
});

Deno.test("/mcp rejects JSON-RPC batches instead of swallowing them", async () => {
  const ctx = govContext();
  ctx.virtualKeys = new VirtualKeyManager(); // ungoverned for this test
  const handler = createHandler(ctx);
  const res = await handler(
    new Request("http://g.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }]),
    }),
  );
  const body = await res.json() as { error: { code: number } };
  assertEquals(body.error.code, -32600);
});

Deno.test("rate limiter: denied oversized request cannot poison a fresh window", () => {
  const limiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });
  assertEquals(limiter.consume("k", 8000, 60_000, 10_000), false);
  // The window must still admit normal traffic afterwards.
  assertEquals(limiter.consume("k", 8000, 60_000, 10), true);
});

Deno.test("semantic cache fails open when the embedder is down", async () => {
  const cache = new SemanticCache({
    embedder: () => Promise.reject(new Error("embeddings outage")),
    vectorStore: new InMemoryVectorStore(),
  });
  const request = { model: "m", messages: [{ role: "user", content: "q" }] };
  assertEquals(await cache.get(request), null); // miss, not throw
  const response = {
    id: "r1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [],
  };
  await cache.set(request, response as never); // stores exact, skips vector
  assert(cache.size() > 0);
});

Deno.test("expired vector entries do not shadow fresh ones", async () => {
  const store = new InMemoryVectorStore();
  const vector = [1, 0, 0];
  const fresh = { id: "fresh" };
  await store.upsert("old", vector, {
    response: { id: "stale" },
    storedAt: Date.now() - 3_600_000,
  });
  await store.upsert("new", vector, {
    response: fresh,
    storedAt: Date.now(),
  });
  const cache = new SemanticCache({
    ttlMs: 60_000,
    embedder: () => Promise.resolve(vector),
    vectorStore: store,
  });
  const got = await cache.get({
    model: "m",
    messages: [{ role: "user", content: "q" }],
  }) as { id: string } | null;
  assertEquals(got?.id, "fresh");
});

Deno.test("a throwing stream-complete plugin neither aborts nor starves peers", async () => {
  const plugins = new PluginManager();
  const seen: string[] = [];
  plugins.register({
    name: "boom",
    onStreamComplete: () => Promise.reject(new Error("down")),
  });
  plugins.register({
    name: "tail",
    onStreamComplete: (text) => {
      seen.push(text);
      return Promise.resolve();
    },
  });
  await plugins.executeStreamComplete("hello"); // must not throw
  assertEquals(seen, ["hello"]);
});
