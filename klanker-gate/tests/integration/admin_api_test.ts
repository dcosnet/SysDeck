// Admin API integration: provider CRUD, model refresh, import/export,
// reload, and the optional bearer-token gate — against the real handler.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import { ConfigCrypto } from "../../packages/config/src/crypto.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { jsonResponse, MockProvider } from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

async function makeContext(
  adminToken?: string,
  encrypted = false,
): Promise<AppContext> {
  const config = await ConfigService.open(":memory:");
  if (encrypted) {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    config.setCrypto(await ConfigCrypto.fromRawDek(dek));
  }
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    config,
    adminToken,
  };
}

Deno.test("admin API: full provider CRUD lifecycle", async (t) => {
  const ctx = await makeContext();
  const handler = createHandler(ctx);

  await t.step("create", async () => {
    const res = await handler(
      new Request(`${base}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "openai",
          type: "openai",
          apiKey: "sk-secret",
          enabled: true,
          models: ["gpt-4o"],
          priority: 0,
        }),
      }),
    );
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.hasApiKey, true);
    assertEquals("apiKey" in body, false); // never echo secrets
  });

  await t.step("list is redacted", async () => {
    const res = await handler(new Request(`${base}/api/providers`));
    const body = await res.json();
    assertEquals(body.providers.length, 1);
    assertEquals(body.providers[0].hasApiKey, true);
    assertEquals("apiKey" in body.providers[0], false);
  });

  await t.step("update merges patch", async () => {
    const res = await handler(
      new Request(`${base}/api/providers/openai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: ["gpt-4o", "gpt-4o-mini"] }),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).models, ["gpt-4o", "gpt-4o-mini"]);
    // secret survives a patch that does not mention it
    const persisted = await ctx.config!.getProvider("openai");
    assertEquals(persisted?.apiKey, "sk-secret");
  });

  await t.step("default provider setting", async () => {
    const res = await handler(
      new Request(`${base}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultProvider: "openai" }),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(ctx.providers.getDefaultProvider(), "openai");
  });

  await t.step("reload rebuilds the manager from KV", async () => {
    ctx.providers.remove("openai"); // simulate in-memory drift
    assertEquals(ctx.providers.list().length, 0);
    const res = await handler(
      new Request(`${base}/api/config/reload`, { method: "POST" }),
    );
    assertEquals((await res.json()).providers, 1);
    assertEquals(ctx.providers.list()[0].id, "openai");
  });

  await t.step("delete", async () => {
    const res = await handler(
      new Request(`${base}/api/providers/openai`, { method: "DELETE" }),
    );
    assertEquals(res.status, 204);
    assertEquals(ctx.providers.list().length, 0);
    assertEquals(await ctx.config!.getProvider("openai"), null);
  });

  ctx.config!.close();
});

Deno.test("admin API: model refresh pulls the live catalog", async () => {
  const mock = new MockProvider(() =>
    jsonResponse({
      data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o3-mini" }],
    })
  );
  try {
    const ctx = await makeContext();
    const handler = createHandler(ctx);
    await handler(
      new Request(`${base}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "openai",
          type: "openai",
          apiKey: "k",
          baseUrl: mock.url,
          enabled: true,
          models: [],
          priority: 0,
          retry: { maxRetries: 0 },
        }),
      }),
    );
    const res = await handler(
      new Request(`${base}/api/providers/openai/refresh-models`, {
        method: "POST",
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.models, ["gpt-4o", "gpt-4o-mini", "o3-mini"]);
    assertEquals(ctx.providers.get("openai")?.models.length, 3);
    assertEquals((await ctx.config!.getProvider("openai"))?.models.length, 3);
    ctx.config!.close();
  } finally {
    await mock.close();
  }
});

Deno.test("admin API: export redacts secrets unless explicitly included", async () => {
  const ctx = await makeContext();
  const handler = createHandler(ctx);
  await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "openai",
        type: "openai",
        apiKey: "sk-secret",
        enabled: true,
        models: [],
        priority: 0,
      }),
    }),
  );

  const redacted = await (await handler(
    new Request(`${base}/api/config/export`),
  )).json();
  // Redacted export strips the secret entirely via canonical redaction (no
  // "***redacted***" placeholder, no value); only a hasApiKey marker remains.
  assertEquals(redacted.config.providers[0].apiKey, undefined);
  assertEquals(redacted.config.providers[0].hasApiKey, true);

  const full = await (await handler(
    new Request(`${base}/api/config/export?include_secrets=true`),
  )).json();
  assertEquals(full.config.providers[0].apiKey, "sk-secret");

  // import the full export into a fresh context
  const ctx2 = await makeContext();
  const handler2 = createHandler(ctx2);
  const res = await handler2(
    new Request(`${base}/api/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(full),
    }),
  );
  assertEquals((await res.json()).imported, true);
  assertEquals(ctx2.providers.get("openai")?.apiKey, "sk-secret");
  ctx.config!.close();
  ctx2.config!.close();
});

Deno.test("admin API: malformed import wrapper is a 400, never a silent wipe", async () => {
  const ctx = await makeContext();
  const handler = createHandler(ctx);
  // Seed one provider that must survive a rejected import.
  await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "keep",
        type: "openai",
        apiKey: "sk-keep",
        enabled: true,
        models: [],
        priority: 0,
      }),
    }),
  );

  // A ConfigExport wrapper missing the required `exportedAt`. Before the
  // GatewayConfigSchema-strict fix this parsed as a bare config with zero
  // providers and WIPED the set; now it is rejected.
  const res = await handler(
    new Request(`${base}/api/config/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        config: { defaultProvider: "gone", providers: [] },
      }),
    }),
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();

  // Both the runtime manager and the persisted store still hold "keep".
  assertEquals(ctx.providers.get("keep")?.apiKey, "sk-keep");
  const persisted = await ctx.config!.loadAll();
  assertEquals(persisted.providers.map((p) => p.id), ["keep"]);
  ctx.config!.close();
});

Deno.test("admin API: bearer token gate protects /api/* when configured", async () => {
  const ctx = await makeContext("s3cret");
  const handler = createHandler(ctx);

  const denied = await handler(new Request(`${base}/api/providers`));
  assertEquals(denied.status, 401);

  const wrongToken = await handler(
    new Request(`${base}/api/providers`, {
      headers: { Authorization: "Bearer wrong" },
    }),
  );
  assertEquals(wrongToken.status, 401);

  const allowed = await handler(
    new Request(`${base}/api/providers`, {
      headers: { Authorization: "Bearer s3cret" },
    }),
  );
  assertEquals(allowed.status, 200);
  await allowed.body?.cancel();

  // health and inference surfaces stay open
  const health = await handler(new Request(`${base}/healthz`));
  assertEquals(health.status, 200);
  await health.body?.cancel();
  const version = await handler(new Request(`${base}/api/version`));
  assertEquals(version.status, 200);
  await version.body?.cancel();

  assert(ctx.config);
  ctx.config.close();
});

Deno.test("admin API: global provider proxy is encrypted, redacted, and reloadable", async () => {
  const ctx = await makeContext(undefined, true);
  const handler = createHandler(ctx);
  const proxy = {
    proxyUrl: "http://proxy.internal:8080",
    proxyUsername: "operator",
    proxyPassword: "secret",
    noProxy: [".private.example"],
  };

  const put = await handler(
    new Request(`${base}/api/proxy-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proxy),
    }),
  );
  assertEquals(put.status, 200);
  const putBody = await put.json();
  assertEquals(putBody, {
    enabled: true,
    proxyType: "http",
    hasCredentials: true,
    noProxyCount: 1,
  });
  assertEquals(await ctx.config!.getGlobalProxy(), proxy);

  const getBody = await (await handler(
    new Request(`${base}/api/proxy-config`),
  )).json();
  const serialized = JSON.stringify(getBody);
  for (
    const secret of ["proxy.internal", "operator", "secret", "private.example"]
  ) {
    assert(!serialized.includes(secret), `GET leaked ${secret}`);
  }

  const rejected = await handler(
    new Request(`${base}/api/proxy-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyUrl: "ftp://bad.proxy" }),
    }),
  );
  assertEquals(rejected.status, 400);
  assertEquals(await ctx.config!.getGlobalProxy(), proxy);

  ctx.providers.configureGlobalProxy(undefined); // simulate in-memory drift
  const reload = await handler(
    new Request(`${base}/api/config/reload`, {
      method: "POST",
    }),
  );
  assertEquals(reload.status, 200);
  assertEquals(ctx.providers.getGlobalProxy(), proxy);

  const deleted = await handler(
    new Request(`${base}/api/proxy-config`, {
      method: "DELETE",
    }),
  );
  assertEquals(deleted.status, 204);
  assertEquals(await ctx.config!.getGlobalProxy(), undefined);
  ctx.config!.close();
});

Deno.test("admin API: global provider proxy refuses plaintext persistence", async () => {
  const ctx = await makeContext();
  const response = await createHandler(ctx)(
    new Request(`${base}/api/proxy-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyUrl: "http://proxy.internal:8080" }),
    }),
  );
  assertEquals(response.status, 409);
  assertEquals(await ctx.config!.getGlobalProxy(), undefined);
  ctx.config!.close();
});
