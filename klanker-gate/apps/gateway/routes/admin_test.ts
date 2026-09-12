import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../main.ts";
import { type AppContext, NullToolExecutor, VERSION } from "../context.ts";
import { ProviderManager } from "../../../packages/providers/src/mod.ts";
import { Metrics } from "../../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../../packages/plugins/src/lifecycle.ts";

function makeContext(): AppContext {
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

const base = "http://gateway.test";
const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.test("POST /api/providers round-trips 6-tab fields and redacts secrets", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: "anthropic",
        type: "anthropic",
        apiKey: "sk-ant-secret",
        models: ["claude-3-5-sonnet"],
        proxyUrl: "http://user:pw@proxy.local",
        network: {
          maxRetries: 4,
          extraHeaders: [{ name: "X-Org", value: "acme" }],
          caCertPem: "-----BEGIN CERTIFICATE-----secret",
        },
        proxy: {
          proxyType: "http",
          proxyUsername: "u",
          proxyPassword: "shh",
          noProxy: [".private"],
        },
        governance: { budgetUsd: 50, budgetResetPeriod: "monthly" },
        betaHeaders: { overrides: { "prompt-caching-2024-07-31": "enabled" } },
        debugging: { sendBackRawResponse: true },
      }),
    }),
  );
  assertEquals(res.status, 201);
  const body = await res.json();

  // Non-secret 6-tab fields survive the round-trip.
  assertEquals(body.network.maxRetries, 4);
  assertEquals(body.network.extraHeaders[0], { name: "X-Org", hasValue: true });
  assertEquals(body.proxy.proxyUsername, "u");
  assertEquals(body.proxy.noProxyCount, 1);
  assertEquals(body.governance.budgetUsd, 50);
  assertEquals(
    body.betaHeaders.overrides["prompt-caching-2024-07-31"],
    "enabled",
  );
  assertEquals(body.debugging.sendBackRawResponse, true);

  // Presence flags replace secrets.
  assertEquals(body.hasApiKey, true);
  assertEquals(body.hasProxy, true);
  assertEquals(body.hasProxyPassword, true);
  assertEquals(body.hasCaCert, true);

  // No secret material is echoed anywhere in the response.
  const serialized = JSON.stringify(body);
  for (
    const secret of [
      "sk-ant-secret",
      "pw@proxy.local",
      "shh",
      "BEGIN CERTIFICATE",
      "acme",
      ".private",
    ]
  ) {
    assert(!serialized.includes(secret), `leaked secret: ${secret}`);
  }
});

Deno.test("PUT /api/providers/:id merges new-group fields", async () => {
  const ctx = makeContext();
  const handler = createHandler(ctx);
  await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: "openai",
        type: "openai",
        apiKey: "sk",
        models: ["gpt-4o"],
      }),
    }),
  );
  const res = await handler(
    new Request(`${base}/api/providers/openai`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        performance: { maxConcurrentRequests: 8 },
        network: { timeoutSec: 30 },
      }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.performance.maxConcurrentRequests, 8);
  assertEquals(body.network.timeoutSec, 30);
  // Existing fields are preserved through the merge.
  assertEquals(body.hasApiKey, true);
  assertEquals(body.models, ["gpt-4o"]);

  // The stored config carries the secret internally but the listing hides it.
  const stored = ctx.providers.get("openai");
  assertEquals(stored?.apiKey, "sk");
  const listRes = await handler(new Request(`${base}/api/providers`));
  const list = await listRes.json();
  assertEquals(list.providers[0].network.timeoutSec, 30);
  assert(!("apiKey" in list.providers[0]));
});

Deno.test("GET /api/config exposes the EUR display rate", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(new Request(`${base}/api/config`));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.eurRate, "number");
  assert(body.eurRate > 0);
});

Deno.test("GET /api/providers/health reports per-provider status", async () => {
  const handler = createHandler(makeContext());
  // Disabled account: reported without a probe.
  await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "off", type: "openai", enabled: false }),
    }),
  );
  // Enabled but no credentials: cannot be probed -> "unknown", never "ok".
  await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "nokey", type: "openai", enabled: true }),
    }),
  );

  const res = await handler(new Request(`${base}/api/providers/health`));
  assertEquals(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(
    body.health.map((h: { id: string }) => [h.id, h]),
  );
  assertEquals(byId["off"].status, "disabled");
  assertEquals(byId["nokey"].status, "unknown");
  // Un-probed accounts carry no error text.
  assertEquals(byId["off"].lastError, undefined);
  assertEquals(byId["nokey"].lastError, undefined);
});

Deno.test("GET /api/providers/health reports 'ok' for a reachable enabled provider", async () => {
  // Regression: the probe must invoke listModels AS A METHOD (bound `this`).
  // A detached call throws a TypeError before any I/O, which the probe would
  // mislabel as "error" for every enabled provider (the vLLM online-badge bug).
  const originalFetch = globalThis.fetch;
  let hitModels = false;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).endsWith("/models")) {
      hitModels = true;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  try {
    const handler = createHandler(makeContext());
    await handler(
      new Request(`${base}/api/providers`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: "live",
          type: "openai",
          apiKey: "sk-test",
          enabled: true,
        }),
      }),
    );

    const res = await handler(new Request(`${base}/api/providers/health`));
    assertEquals(res.status, 200);
    const body = await res.json();
    const live = body.health.find((h: { id: string }) => h.id === "live");
    assertEquals(live.status, "ok");
    assertEquals(live.lastError, undefined);
    assert(hitModels, "probe should have hit the live /models endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET /api/providers/:id/available-models lists live models without persisting", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).endsWith("/models")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o1" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  try {
    const ctx = makeContext();
    const handler = createHandler(ctx);
    // Enabled subset is a single model; the live provider advertises three.
    await handler(
      new Request(`${base}/api/providers`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: "oai",
          type: "openai",
          apiKey: "sk-test",
          models: ["gpt-4o"],
          enabled: true,
        }),
      }),
    );

    const res = await handler(
      new Request(`${base}/api/providers/oai/available-models`),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.id, "oai");
    assertEquals(body.models, ["gpt-4o", "gpt-4o-mini", "o1"]);

    // Read-only: the enabled set the gateway routes on is left untouched.
    assertEquals(ctx.providers.get("oai")?.models, ["gpt-4o"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET /api/providers/:id/available-models 404s an unknown provider", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/api/providers/nope/available-models`),
  );
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
