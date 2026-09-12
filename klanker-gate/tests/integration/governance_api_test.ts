// Governance integration: virtual-key admission on /v1/*, rate limits,
// budgets, admin CRUD, and the metrics endpoint.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
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
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

async function makeContext(
  mockUrl: string,
  models: string[] = ["m1"],
): Promise<AppContext> {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mockUrl,
      enabled: true,
      models,
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    config: await ConfigService.open(":memory:"),
  };
}

function chatRequest(token?: string): Request {
  return new Request(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

Deno.test("governance: concurrent requests cannot exceed a lifetime request budget", async () => {
  // Regression for the over-admission race: N requests fired at once must never
  // admit more than maxRequests. Before the reserve-before-admit fix, they could
  // all pass the read in check() during the async admit() window and each be let
  // through, overshooting the budget by up to N-1.
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "k",
    name: "burst",
    token: "vk-burst-concurrency",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    budget: { maxRequests: 5 },
  });
  const handler = createHandler(ctx);
  try {
    const N = 25;
    const results = await Promise.all(
      Array.from(
        { length: N },
        () => handler(chatRequest("vk-burst-concurrency")),
      ),
    );
    let admitted = 0;
    let denied = 0;
    for (const res of results) {
      if (res.status === 200) admitted++;
      else if (res.status === 402) denied++;
      await res.body?.cancel();
    }
    assertEquals(admitted, 5); // exactly the budget — never more
    assertEquals(denied, N - 5);
    assertEquals(ctx.virtualKeys.get("k")!.usedRequests, 5);
  } finally {
    ctx.config?.close();
    await mock.close();
  }
});

Deno.test("governance: open access until a virtual key exists, then enforced", async (t) => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await makeContext(mock.url);
  const handler = createHandler(ctx);
  let token = "";

  try {
    await t.step("no keys configured: /v1 is open", async () => {
      const res = await handler(chatRequest());
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("create a virtual key via the admin API", async () => {
      const res = await handler(
        new Request(`${base}/api/virtual-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "team-a",
            rateLimit: { maxRequests: 3, windowMs: 60_000 },
            budget: { maxRequests: 5 },
          }),
        }),
      );
      assertEquals(res.status, 201);
      const body = await res.json();
      token = body.token;
      assert(token.startsWith("vk-"));
      // persisted to KV
      assertEquals((await ctx.config!.listVirtualKeys()).length, 1);
    });

    await t.step("list shows only a token hint", async () => {
      const res = await handler(new Request(`${base}/api/virtual-keys`));
      const body = await res.json();
      assertEquals(body.virtualKeys.length, 1);
      assert(!("token" in body.virtualKeys[0]));
      assert(!("tokenHash" in body.virtualKeys[0]));
      // Hint reveals only the last 4 chars (leading "…"), never the token body.
      assert(body.virtualKeys[0].tokenHint.startsWith("…"));
      assert(!body.virtualKeys[0].tokenHint.includes(token));
    });

    await t.step("missing key is now rejected with 401", async () => {
      const res = await handler(chatRequest());
      assertEquals(res.status, 401);
      assertEquals((await res.json()).error.code, "missing_virtual_key");
    });

    await t.step("valid key is admitted", async () => {
      const res = await handler(chatRequest(token));
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("rate limit returns 429 with Retry-After", async () => {
      // 1 request used above; limit is 3/min
      await (await handler(chatRequest(token))).body?.cancel();
      await (await handler(chatRequest(token))).body?.cancel();
      const res = await handler(chatRequest(token));
      assertEquals(res.status, 429);
      assertEquals(res.headers.get("Retry-After"), "60");
      assertEquals((await res.json()).error.code, "rate_limited");
    });

    await t.step("admin surface is not governed by virtual keys", async () => {
      const res = await handler(new Request(`${base}/api/providers`));
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("disable via PUT locks the key out", async () => {
      const list = await (await handler(
        new Request(`${base}/api/virtual-keys`),
      )).json();
      const id = list.virtualKeys[0].id;
      const res = await handler(
        new Request(`${base}/api/virtual-keys/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }),
      );
      assertEquals(res.status, 200);
      const denied = await handler(chatRequest(token));
      assertEquals(denied.status, 401);
      await denied.body?.cancel();
    });

    await t.step(
      "metrics endpoint exposes counters and latencies",
      async () => {
        const res = await handler(new Request(`${base}/metrics`));
        assertEquals(res.status, 200);
        const text = await res.text();
        assert(text.includes("frosty_requests_total"));
        assert(text.includes('route="/v1/chat/completions"'));
        assert(text.includes("frosty_request_duration_ms"));
        assert(text.includes("governance.denied.missing_virtual_key"));
      },
    );
  } finally {
    ctx.config!.close();
    await mock.close();
  }
});

Deno.test("governance: budget exhaustion returns 402", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk1",
    name: "tiny-budget",
    token: "vk-tiny-budget-token",
    enabled: true,
    budget: { maxRequests: 1 },
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);

  try {
    const first = await handler(chatRequest("vk-tiny-budget-token"));
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const second = await handler(chatRequest("vk-tiny-budget-token"));
    assertEquals(second.status, 402);
    assertEquals((await second.json()).error.code, "budget_exhausted");
  } finally {
    ctx.config!.close();
    await mock.close();
  }
});

Deno.test("governance: per-key model/provider scope enforcement", async (t) => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await makeContext(mock.url, ["m1", "m2"]);
  const handler = createHandler(ctx);
  let token = "";

  const chat = (model: string, tok: string, contentType = "application/json") =>
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  try {
    await t.step("empty allowlist array is rejected at create", async () => {
      const res = await handler(
        new Request(`${base}/api/virtual-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "bad", allowedModels: [] }),
        }),
      );
      assertEquals(res.status, 400);
    });

    await t.step("create a model-scoped key (allowedModels: m1)", async () => {
      const res = await handler(
        new Request(`${base}/api/virtual-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "scoped", allowedModels: ["m1"] }),
        }),
      );
      assertEquals(res.status, 201);
      token = (await res.json()).token;
    });

    await t.step("in-scope model is admitted", async () => {
      const res = await handler(chat("m1", token));
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("in-scope model with a known provider prefix", async () => {
      const res = await handler(chat("openai/m1", token));
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("out-of-scope model is refused with 403", async () => {
      const res = await handler(chat("m2", token));
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error.code, "model_not_permitted");
    });

    await t.step(
      "a provider prefix cannot smuggle an out-of-scope model",
      async () => {
        const res = await handler(chat("openai/m2", token));
        assertEquals(res.status, 403);
        assertEquals((await res.json()).error.code, "model_not_permitted");
      },
    );

    await t.step(
      "a scoped key fails closed when the model is undeterminable",
      async () => {
        // multipart: the middleware cannot read a JSON model -> deny.
        const res = await handler(
          new Request(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "multipart/form-data; boundary=xx",
              Authorization: `Bearer ${token}`,
            },
            body: "--xx--",
          }),
        );
        assertEquals(res.status, 403);
        assertEquals((await res.json()).error.code, "model_not_permitted");
      },
    );

    await t.step(
      "a provider-scoped key refuses an off-list provider",
      async () => {
        const res = await handler(
          new Request(`${base}/api/virtual-keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "prov-scoped",
              allowedProviders: ["anthropic"],
            }),
          }),
        );
        const provToken = (await res.json()).token;
        // Model m1 resolves to provider "openai", which is not on the allowlist.
        const denied = await handler(chat("m1", provToken));
        assertEquals(denied.status, 403);
        assertEquals(
          (await denied.json()).error.code,
          "provider_not_permitted",
        );
      },
    );

    await t.step(
      "genai colon-tagged model cannot smuggle past a model scope",
      async () => {
        const res = await handler(
          new Request(`${base}/api/virtual-keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "genai-scoped",
              allowedModels: ["m1"],
            }),
          }),
        );
        const gToken = (await res.json()).token;
        const genai = (modelAction: string) =>
          new Request(`${base}/genai/v1beta/models/${modelAction}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${gToken}`,
            },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
          });
        // Dispatch splits on the LAST colon -> model "m1:pro"; enforcement must
        // see the same, not the first-colon-truncated "m1".
        const denied = await handler(genai("m1:pro:generateContent"));
        assertEquals(denied.status, 403);
        // A genai path answers in the GenAI error envelope (decision-log 86),
        // where `code` is the HTTP status; the gateway's own code rides
        // `details[].reason` so operators do not lose it.
        const deniedBody = await denied.json() as {
          error: {
            code: number;
            status: string;
            details?: Array<{ reason?: string }>;
          };
        };
        assertEquals(deniedBody.error.code, 403);
        assertEquals(deniedBody.error.status, "PERMISSION_DENIED");
        assertEquals(
          deniedBody.error.details?.[0]?.reason,
          "model_not_permitted",
        );
        // Exact in-scope model still admits.
        const ok = await handler(genai("m1:generateContent"));
        assertEquals(ok.status, 200);
        await ok.body?.cancel();
      },
    );

    await t.step(
      "clearing the model scope via null re-opens all models",
      async () => {
        const list =
          await (await handler(new Request(`${base}/api/virtual-keys`)))
            .json();
        const scopedKey = list.virtualKeys.find(
          (k: { name: string }) => k.name === "scoped",
        );
        assertEquals(scopedKey.allowedModels, ["m1"]);
        const put = await handler(
          new Request(`${base}/api/virtual-keys/${scopedKey.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ allowedModels: null }),
          }),
        );
        assertEquals(put.status, 200);
        assertEquals((await put.json()).allowedModels, undefined);
        // m2 was refused before the clear; it is admitted now.
        const admitted = await handler(chat("m2", token));
        assertEquals(admitted.status, 200);
        await admitted.body?.cancel();
      },
    );
  } finally {
    ctx.config!.close();
    await mock.close();
  }
});

Deno.test("governance: scoped key is not served by an off-list failover target", async (t) => {
  const primary = new MockProvider(() =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  );
  const backup = new MockProvider(() => jsonResponse(openAIChatBody("from-B")));
  const ctx: AppContext = {
    providers: new ProviderManager([
      {
        id: "A",
        type: "openai",
        apiKey: "k",
        baseUrl: primary.url,
        enabled: true,
        models: ["m"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "B",
        type: "openai",
        apiKey: "k",
        baseUrl: backup.url,
        enabled: true,
        models: ["m"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
    ], "A"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    config: await ConfigService.open(":memory:"),
  };
  const handler = createHandler(ctx);
  const chat = (tok: string) =>
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  try {
    let unscoped = "";
    let scoped = "";
    await t.step("create an unscoped key and a key scoped to A", async () => {
      unscoped = (await (await handler(
        new Request(`${base}/api/virtual-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "open" }),
        }),
      )).json()).token;
      scoped = (await (await handler(
        new Request(`${base}/api/virtual-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "pin-A", allowedProviders: ["A"] }),
        }),
      )).json()).token;
    });

    await t.step(
      "failover works for an unscoped key (A 500 -> B 200)",
      async () => {
        const res = await handler(chat(unscoped));
        assertEquals(res.status, 200);
        assertEquals((await res.json()).choices[0].message.content, "from-B");
      },
    );

    await t.step("A-scoped key is NOT served by B on failover", async () => {
      const res = await handler(chat(scoped));
      assert(res.status >= 500, `expected 5xx all-failed, got ${res.status}`);
      await res.body?.cancel();
    });
  } finally {
    ctx.config!.close();
    await primary.close();
    await backup.close();
  }
});
