// Response cache through the live chat route: identical non-streaming
// requests are served from cache without a second provider call.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import {
  type VirtualKey,
  VirtualKeyManager,
} from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  openAIStreamFrames,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

function chat(content: string): Request {
  return new Request(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content }],
    }),
  });
}

Deno.test("cache: second identical request is a hit and skips the provider", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("cached!")));
  const ctx: AppContext = {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mock.url,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    cache: new SemanticCache(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
  const handler = createHandler(ctx);

  try {
    const first = await handler(chat("same question"));
    assertEquals(first.status, 200);
    assertEquals(first.headers.get("x-frosty-cache"), "miss");
    assertEquals(
      (await first.json()).choices[0].message.content,
      "cached!",
    );
    assertEquals(mock.calls.length, 1);

    const requestId = first.headers.get("x-request-id");
    if (!requestId) {
      throw new Error("gateway response did not contain x-request-id");
    }

    const second = await handler(chat("same question"));
    assertEquals(second.headers.get("x-frosty-cache"), "hit");
    assertEquals(
      (await second.json()).choices[0].message.content,
      "cached!",
    );
    assertEquals(mock.calls.length, 1); // provider NOT called again

    const cleared = await handler(
      new Request(`${base}/api/cache/clear/${requestId}`, { method: "DELETE" }),
    );
    assertEquals(cleared.status, 200);
    assertEquals(await cleared.json(), { deleted: true });

    const afterClear = await handler(chat("same question"));
    assertEquals(afterClear.headers.get("x-frosty-cache"), "miss");
    await afterClear.body?.cancel();
    assertEquals(mock.calls.length, 2);

    const different = await handler(chat("different question"));
    assertEquals(different.headers.get("x-frosty-cache"), "miss");
    await different.body?.cancel();
    assertEquals(mock.calls.length, 3);

    assertEquals(ctx.metrics.get("cache.hit"), 1);
    assertEquals(ctx.metrics.get("cache.miss"), 3);
  } finally {
    await mock.close();
  }
});

// A scoped virtual key must never be SERVED a completion it would not have
// been allowed to produce. The response cache is the only dispatch path that
// runs before the key's allowlist is applied, so it is the one place where an
// out-of-scope provider's answer could reach a scoped key.
Deno.test("cache: a scoped key is never served another scope's entry", async (t) => {
  // A always fails, so unscoped traffic fails over to B and caches B's answer.
  const a = new MockProvider(() =>
    jsonResponse({ error: { message: "down" } }, 500)
  );
  const b = new MockProvider(() => jsonResponse(openAIChatBody("from-B")));

  const key = (
    id: string,
    token: string,
    scope: Partial<VirtualKey>,
  ): VirtualKey => ({
    id,
    name: id,
    token,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    ...scope,
  });
  // Tokens are >= 8 chars or VirtualKeyManager drops the key at load.
  const OPEN = "vk-unscoped-token";
  const PIN_A = "vk-pinned-to-A-token";
  const M1 = "vk-model-m1-token";
  const M1M2 = "vk-model-m1-m2-token";
  const keys = [
    key("open", OPEN, {}),
    key("pin-A", PIN_A, { allowedProviders: ["A"] }),
    key("m1-only", M1, { allowedModels: ["m1"] }),
    key("m1-and-m2", M1M2, { allowedModels: ["m1", "m2"] }),
  ];
  const ctx: AppContext = {
    providers: new ProviderManager([
      {
        id: "A",
        type: "openai",
        apiKey: "k",
        baseUrl: a.url,
        enabled: true,
        models: ["m1"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "B",
        type: "openai",
        apiKey: "k",
        baseUrl: b.url,
        enabled: true,
        models: ["m1"],
        priority: 1,
        retry: { maxRetries: 0 },
      },
    ], "A"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(keys),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    cache: new SemanticCache(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
  const handler = createHandler(ctx);
  const ask = (token: string) =>
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "m1",
        messages: [{ role: "user", content: "same question" }],
      }),
    });

  try {
    await t.step(
      "unscoped key fails over to B and caches B's answer",
      async () => {
        const res = await handler(ask(OPEN));
        assertEquals(res.status, 200);
        assertEquals(res.headers.get("x-frosty-cache"), "miss");
        assertEquals((await res.json()).choices[0].message.content, "from-B");
        assertEquals(b.calls.length, 1);
      },
    );

    await t.step(
      "the A-scoped key is not served B's cached answer",
      async () => {
        // Byte-identical request body, so before scoping the key this was a
        // cache hit carrying a completion from a provider it may not use.
        const res = await handler(ask(PIN_A));
        assertEquals(res.headers.get("x-frosty-cache"), null);
        // Scoped dispatch cannot fail over to B either, so the only honest
        // outcome is the upstream failure.
        assert(res.status >= 500, `expected 5xx all-failed, got ${res.status}`);
        await res.body?.cancel();
        assertEquals(b.calls.length, 1); // B was never reached for this key
      },
    );

    await t.step(
      "two different scoped keys do not share an entry",
      async () => {
        const first = await handler(ask(M1));
        assertEquals(first.status, 200);
        assertEquals(first.headers.get("x-frosty-cache"), "miss");
        assertEquals((await first.json()).choices[0].message.content, "from-B");
        assertEquals(b.calls.length, 2);

        // Same request, same permitted model, different key -> different
        // namespace, so it must reach the provider rather than read across.
        const second = await handler(ask(M1M2));
        assertEquals(second.headers.get("x-frosty-cache"), "miss");
        await second.body?.cancel();
        assertEquals(b.calls.length, 3);

        // ...and each scoped key still caches for itself.
        const repeat = await handler(ask(M1));
        assertEquals(repeat.headers.get("x-frosty-cache"), "hit");
        assertEquals(
          (await repeat.json()).choices[0].message.content,
          "from-B",
        );
        assertEquals(b.calls.length, 3);
      },
    );

    await t.step("the unscoped namespace is unchanged", async () => {
      const res = await handler(ask(OPEN));
      assertEquals(res.headers.get("x-frosty-cache"), "hit");
      assertEquals((await res.json()).choices[0].message.content, "from-B");
      assertEquals(b.calls.length, 3);
    });
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test("cache: completed stream is stored without altering its SSE response", async () => {
  const mock = new MockProvider(() =>
    sseResponse(openAIStreamFrames([
      "streamed ",
      "answer",
    ]))
  );
  const cache = new SemanticCache();
  const ctx: AppContext = {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mock.url,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    cache,
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
  const handler = createHandler(ctx);

  try {
    const streamed = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "stream me" }],
          stream: true,
        }),
      }),
    );
    assertEquals(streamed.headers.get("x-frosty-cache"), "miss");
    assertEquals(streamed.headers.get("x-frosty-cache-type"), "miss");
    const body = await streamed.text();
    assertEquals(body, openAIStreamFrames(["streamed ", "answer"]).join(""));
    assertEquals(mock.calls.length, 1);

    const cached = await handler(chat("stream me"));
    assertEquals(cached.headers.get("x-frosty-cache"), "hit");
    assertEquals(cached.headers.get("x-frosty-cache-type"), "direct");
    assertEquals(
      (await cached.json()).choices[0].message.content,
      "streamed answer",
    );
    assertEquals(mock.calls.length, 1);
    assertEquals(ctx.metrics.get("cache.miss"), 1);
    assertEquals(ctx.metrics.get("cache.hit"), 1);
  } finally {
    await mock.close();
  }
});
