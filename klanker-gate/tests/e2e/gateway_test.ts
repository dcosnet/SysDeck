// End-to-end: real HTTP server, real sockets, mock upstream providers.

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
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  openAIStreamFrames,
} from "../../packages/testing/src/mod.ts";

function makeContext(providers: ProviderManager): AppContext {
  return {
    providers,
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

Deno.test("e2e: gateway over real HTTP", async (t) => {
  const flaky = new MockProvider(() =>
    jsonResponse({ error: { message: "rate limited" } }, 429)
  );
  const stable = new MockProvider((call) => {
    const body = call.body as { stream?: boolean } | null;
    if (body?.stream) {
      return new Response(openAIStreamFrames(["str", "eam"]).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return jsonResponse(openAIChatBody("stable answer"));
  });

  const providers = new ProviderManager([
    {
      id: "flaky",
      type: "openai",
      apiKey: "k1",
      baseUrl: flaky.url,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    },
    {
      id: "stable",
      type: "openai",
      apiKey: "k2",
      baseUrl: stable.url,
      enabled: true,
      models: ["m1"],
      priority: 1,
      retry: { maxRetries: 0 },
    },
  ], "flaky");

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    createHandler(makeContext(providers)),
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

  try {
    await t.step("healthz", async () => {
      const res = await fetch(`${base}/healthz`);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).status, "ok");
    });

    await t.step("models catalog", async () => {
      const res = await fetch(`${base}/v1/models`);
      const body = await res.json();
      assertEquals(
        body.data.map((m: { id: string }) => m.id).sort(),
        ["flaky/m1", "stable/m1"],
      );
    });

    await t.step("schema validation rejects garbage", async () => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garbage: true }),
      });
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error.type, "invalid_request_error");
    });

    await t.step(
      "chat falls back from 429 provider to healthy one",
      async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "hi" }],
            fallbacks: [{ provider: "stable" }],
          }),
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.choices[0].message.content, "stable answer");
        assertEquals(flaky.calls.length, 1);
        assertEquals(stable.calls.length, 1);
        // the gateway extension must not leak upstream
        assert(
          !("fallbacks" in (stable.calls[0].body as Record<string, unknown>)),
        );
      },
    );

    await t.step(
      "unprefixed model auto-fails-over via the LB pool",
      async () => {
        // No explicit fallbacks: the pool sees "stable" also advertises m1.
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.choices[0].message.content, "stable answer");
      },
    );

    await t.step("exhausted fallbacks return a 502 envelope", async () => {
      // Only the flaky account can serve this model: no rescue pool.
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "flaky/exclusive-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error.code, "all_providers_failed");
    });

    await t.step("streaming end to end with [DONE]", async () => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "stable/m1",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      assertEquals(res.headers.get("Content-Type"), "text/event-stream");
      const text = await res.text();
      assert(text.includes(`"content":"str"`));
      assert(text.includes(`"content":"eam"`));
      assert(text.trimEnd().endsWith("data: [DONE]"));
    });

    await t.step(
      "client cancellation mid-stream leaves server healthy",
      async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "stable/m1",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read(); // take one chunk, then hang up
        controller.abort();
        await reader.cancel().catch(() => {});

        const health = await fetch(`${base}/healthz`);
        assertEquals(health.status, 200);
        await health.body?.cancel();
      },
    );

    await t.step("request id header is attached", async () => {
      const res = await fetch(`${base}/healthz`);
      assert(res.headers.get("x-request-id"));
      await res.body?.cancel();
    });
  } finally {
    await server.shutdown();
    await flaky.close();
    await stable.close();
  }
});
