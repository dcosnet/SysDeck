// Contract tests for the operator settings API surface: the exact GET/PUT
// /api/settings response shape (Wave-3 UI builds its forms against it),
// effective-value resolution (default <- env <- override), the write-only
// password rule, and 400 on invalid payloads. Exercised at the route level
// against a bare Router (no admin middleware; that is covered in the
// integration suite).

import { assert, assertEquals } from "@std/assert";
import { Router } from "../../packages/core/src/mod.ts";
import { registerSettingsRoutes } from "../../apps/gateway/routes/settings.ts";
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

const base = "http://gateway.test";

async function makeContext(): Promise<AppContext> {
  return {
    providers: new ProviderManager([]),
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

function handlerFor(ctx: AppContext): (req: Request) => Promise<Response> {
  const router = new Router();
  registerSettingsRoutes(router, ctx);
  return (req) => router.handle(req);
}

Deno.test("settings contract: GET returns defaults with source hints", async () => {
  const ctx = await makeContext();
  const handler = handlerFor(ctx);
  const res = await handler(new Request(`${base}/api/settings`));
  assertEquals(res.status, 200);
  const body = await res.json();

  // Every group is present.
  assertEquals(Object.keys(body.settings).sort(), [
    "caching",
    "compatibility",
    "mcp",
    "performance",
    "security",
  ]);

  // Representative defaults across every group.
  assertEquals(body.settings.security.values.passwordProtectEnabled, false);
  assertEquals(body.settings.security.values.hasPassword, false);
  assertEquals(body.settings.compatibility.values.convertTextToChat, false);
  assertEquals(body.settings.performance.values.initialPoolSize, 5000);
  assertEquals(body.settings.performance.values.maxRequestBodySizeMb, 100);
  assertEquals(body.settings.caching.values.ttlSeconds, 300);
  assertEquals(body.settings.caching.values.similarityThreshold, 0.85);
  assertEquals(body.settings.caching.values.dimension, 1536);
  assertEquals(body.settings.mcp.values.maxAgentDepth, 10);
  assertEquals(body.settings.mcp.values.toolExecutionTimeoutSec, 30);

  // Source hints: unset fields resolve to "default".
  assertEquals(
    body.settings.security.sources.passwordProtectEnabled,
    "default",
  );
  assertEquals(body.settings.caching.sources.ttlSeconds, "default");

  // Password is write-only: never present in the response, in any form.
  assert(!("password" in body.settings.security.values));
  assertEquals("hasPassword" in body.settings.security.values, true);

  // Enforcement map: false everywhere (no live cache in this context).
  assertEquals(body.enforcement["caching.ttlSeconds"], false);
  assertEquals(body.enforcement["security.disableInferenceAuth"], false);

  ctx.config!.close();
});

Deno.test("settings contract: PUT persists an override and GET reflects it", async () => {
  const ctx = await makeContext();
  const handler = handlerFor(ctx);

  const put = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caching: { ttlSeconds: 600, similarityThreshold: 0.9 },
        mcp: { maxAgentDepth: 4 },
      }),
    }),
  );
  assertEquals(put.status, 200);
  const putBody = await put.json();
  assertEquals(putBody.settings.caching.values.ttlSeconds, 600);
  assertEquals(putBody.settings.caching.sources.ttlSeconds, "override");
  assertEquals(putBody.settings.caching.values.similarityThreshold, 0.9);
  // Untouched fields keep falling through to defaults.
  assertEquals(putBody.settings.caching.values.dimension, 1536);
  assertEquals(putBody.settings.caching.sources.dimension, "default");
  assertEquals(putBody.settings.mcp.values.maxAgentDepth, 4);
  assertEquals(putBody.settings.mcp.sources.maxAgentDepth, "override");

  // A fresh GET reflects the persisted override durably.
  const get = await handler(new Request(`${base}/api/settings`));
  const getBody = await get.json();
  assertEquals(getBody.settings.caching.values.ttlSeconds, 600);
  assertEquals(getBody.settings.caching.sources.ttlSeconds, "override");
  assertEquals(getBody.settings.mcp.values.maxAgentDepth, 4);

  ctx.config!.close();
});

// Regression: zod 4 changed `.partial()` so it no longer suppresses a field's
// inner `.default()`. Parsing `{ttlSeconds: 600}` against
// `CachingSettingsSchema.partial()` therefore yields every defaulted sibling
// too. Persisting (or reporting) those would silently convert untouched
// defaults into operator overrides across ALL groups, permanently shadowing the
// env layer. Both the write path and the read path must keep only the fields
// actually sent/stored. Fails on zod 4 without the fix in routes/settings.ts.
Deno.test("settings contract: a partial PUT never promotes sibling defaults to overrides", async () => {
  const ctx = await makeContext();
  const handler = handlerFor(ctx);

  const put = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caching: { ttlSeconds: 600 },
        performance: { maxRequestBodySizeMb: 25 },
        mcp: { maxAgentDepth: 4 },
        compatibility: { dropUnsupportedParams: true },
      }),
    }),
  );
  assertEquals(put.status, 200);

  // Exactly one field per group is an override; every sibling stays "default"
  // and keeps its default VALUE. Asserted on the PUT body and again on a fresh
  // GET, because the write path and the read path re-parse independently.
  const touched: Record<string, string> = {
    caching: "ttlSeconds",
    performance: "maxRequestBodySizeMb",
    mcp: "maxAgentDepth",
    compatibility: "dropUnsupportedParams",
  };
  const defaults: Record<string, [string, unknown]> = {
    caching: ["dimension", 1536],
    performance: ["initialPoolSize", 5000],
    mcp: ["toolExecutionTimeoutSec", 30],
    compatibility: ["convertTextToChat", false],
  };

  for (
    const body of [
      await put.json(),
      await (await handler(new Request(`${base}/api/settings`))).json(),
    ]
  ) {
    for (const [group, field] of Object.entries(touched)) {
      const { values, sources } = body.settings[group];
      assertEquals(sources[field], "override");
      const overrides = Object.keys(sources).filter((k) =>
        sources[k] === "override"
      );
      assertEquals(
        overrides,
        [field],
        `${group} should have exactly one override`,
      );
      const [untouched, expected] = defaults[group];
      assertEquals(sources[untouched], "default");
      assertEquals(values[untouched], expected);
    }
  }

  ctx.config!.close();
});

Deno.test("settings contract: password is write-only and never returned", async () => {
  const ctx = await makeContext();
  const handler = handlerFor(ctx);

  const put = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        security: {
          passwordProtectEnabled: true,
          passwordUsername: "ops",
          password: "sup3r-s3cret",
        },
      }),
    }),
  );
  assertEquals(put.status, 200);
  const raw = JSON.stringify(await put.json());
  // The secret must not appear anywhere in the payload.
  assert(!raw.includes("sup3r-s3cret"));
  assert(!raw.includes('"password"'));

  const get = await handler(new Request(`${base}/api/settings`));
  const body = await get.json();
  // Presence marker flips on; the value itself is never stored/returned.
  assertEquals(body.settings.security.values.hasPassword, true);
  assertEquals(body.settings.security.sources.hasPassword, "override");
  assertEquals(body.settings.security.values.passwordUsername, "ops");
  assert(!("password" in body.settings.security.values));
  assert(!JSON.stringify(body).includes("sup3r-s3cret"));

  ctx.config!.close();
});

Deno.test("settings contract: invalid payloads are rejected with 400", async () => {
  const ctx = await makeContext();
  const handler = handlerFor(ctx);

  // Wrong-typed known field.
  const badType = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caching: { ttlSeconds: "soon" } }),
    }),
  );
  assertEquals(badType.status, 400);

  // Out-of-range similarity threshold.
  const badRange = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caching: { similarityThreshold: 2 } }),
    }),
  );
  assertEquals(badRange.status, 400);

  // Non-object body.
  const notObject = await handler(
    new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("nope"),
    }),
  );
  assertEquals(notObject.status, 400);

  ctx.config!.close();
});
