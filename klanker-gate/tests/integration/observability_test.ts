// Wave-3 observability + misc: durable KV log store, OTLP exporter,
// cache-invalidation API, JSON repair plugin, per-account proxy plumbing.

import { assert, assertEquals } from "@std/assert";
import { MemoryStateStore } from "../../packages/config/src/store_memory.ts";
import { LogStore } from "../../packages/telemetry/src/logstore.ts";
import { OtelExporter } from "../../packages/telemetry/src/otel.ts";
import type { RequestLogEntry } from "../../packages/core/src/middleware.ts";
import {
  jsonRepairPlugin,
  repairJson,
} from "../../packages/plugins/src/jsonparser.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { ProviderClient } from "../../packages/providers/src/client.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";
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

function entry(path: string, status: number): RequestLogEntry {
  return {
    ts: new Date().toISOString(),
    level: status >= 500 ? "error" : "info",
    message: `${status}`,
    requestId: crypto.randomUUID(),
    method: "POST",
    path,
    status,
    durationMs: 1,
  };
}

Deno.test("log store: query filters, pagination, cap pruning, clear", async () => {
  const dir = await Deno.makeTempDir();
  const store = MemoryStateStore.named(`${dir}/logs.kv`);
  try {
    const logs = new LogStore(store, 3, 1); // cap 3, prune on every append
    await logs.append(entry("/v1/chat/completions", 200));
    await logs.append(entry("/v1/messages", 200));
    await logs.append(entry("/v1/chat/completions", 500));
    await logs.append(entry("/api/providers", 200));
    await logs.append(entry("/v1/responses", 429));

    // Cap enforced at write time: only the newest 3 remain.
    const all = await logs.query({});
    assertEquals(all.total, 3);
    // Newest first.
    assertEquals(all.entries[0].path, "/v1/responses");

    const filtered = await logs.query({ q: "responses" });
    assertEquals(filtered.total, 1);
    const byStatus = await logs.query({ status: 429 });
    assertEquals(byStatus.total, 1);
    const page = await logs.query({ limit: 1, offset: 1 });
    assertEquals(page.entries.length, 1);
    assertEquals(page.total, 3);

    assertEquals(await logs.clear(), 3);
    assertEquals((await logs.query({})).total, 0);
  } finally {
    store.close();
  }
});

Deno.test("otel exporter: OTLP JSON shape, bounded buffer, failure drops", async () => {
  const batches: unknown[] = [];
  const collector = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    batches.push(await req.json());
    return new Response(null, { status: 200 });
  });
  const endpoint = `http://127.0.0.1:${(collector.addr as Deno.NetAddr).port}`;
  try {
    const otel = new OtelExporter(endpoint, "frosty-test");
    otel.record({
      name: "POST /v1/chat/completions",
      startMs: 1000,
      endMs: 1250,
      attributes: { "http.response.status_code": 200 },
    });
    await otel.flush();
    assertEquals(batches.length, 1);
    const batch = batches[0] as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: unknown }> };
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            traceId: string;
            startTimeUnixNano: string;
            status: { code: number };
          }>;
        }>;
      }>;
    };
    const span = batch.resourceSpans[0].scopeSpans[0].spans[0];
    assertEquals(span.name, "POST /v1/chat/completions");
    assertEquals(span.traceId.length, 32);
    assertEquals(span.startTimeUnixNano, "1000000000");
    assertEquals(span.status.code, 1);
    assertEquals(
      batch.resourceSpans[0].resource.attributes[0],
      { key: "service.name", value: { stringValue: "frosty-test" } },
    );

    // Bounded buffer: overflow increments the drop counter, never blocks.
    const tiny = new OtelExporter(endpoint, "t", undefined, 1);
    tiny.record({ name: "a", startMs: 0, endMs: 1 });
    tiny.record({ name: "b", startMs: 0, endMs: 1 });
    assertEquals(tiny.dropped, 1);
    assertEquals(tiny.buffered(), 1);

    // Collector failure counts spans as dropped instead of throwing.
    const dead = new OtelExporter("http://127.0.0.1:9");
    dead.record({ name: "x", startMs: 0, endMs: 1 });
    await dead.flush();
    assertEquals(dead.dropped, 1);
  } finally {
    await collector.shutdown();
  }
});

Deno.test("repairJson completes truncated model output", () => {
  assertEquals(
    repairJson('{"a": {"b": [1, 2'),
    '{"a": {"b": [1, 2]}}',
  );
  assertEquals(repairJson('{"a": "hel'), '{"a": "hel"}');
  assertEquals(repairJson('{"a": 1,'), '{"a": 1}');
  assertEquals(repairJson('{"a":'), '{"a": null}');
  // Valid JSON passes through untouched; non-JSON is returned as-is.
  assertEquals(repairJson('{"ok": true}'), '{"ok": true}');
  assertEquals(repairJson("plain text"), "plain text");
});

Deno.test("jsonparser plugin repairs JSON-looking content post-response", async () => {
  const plugins = new PluginManager();
  plugins.register(jsonRepairPlugin());
  const repaired = await plugins.executePostHooks({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content: '{"result": [1, 2' },
      finish_reason: "length",
    }],
  });
  assertEquals(
    repaired.choices[0].message.content,
    '{"result": [1, 2]}',
  );
});

Deno.test("provider client wires the egress proxy into fetch", async () => {
  const sentinel = { close: () => {} };
  const factoryCalls: unknown[] = [];
  let seenClient: unknown;
  const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seenClient = (init as { client?: unknown } | undefined)?.client;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;

  const client = new ProviderClient(
    { proxyUrl: "http://proxy.local:8888", maxRetries: 0 },
    fakeFetch,
    (options) => {
      factoryCalls.push(options);
      return sentinel;
    },
  );
  await (await client.fetchWithRetry("http://upstream.test/")).body?.cancel();
  assertEquals(factoryCalls, [{ proxy: { url: "http://proxy.local:8888" } }]);
  assert(seenClient === sentinel);
});

Deno.test("cache invalidation API clears and deletes entries", async () => {
  const cache = new SemanticCache();
  const request = { model: "m", messages: [{ role: "user", content: "q" }] };
  await cache.set(request, {
    id: "chatcmpl-c",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "cached" },
      finish_reason: "stop",
    }],
  });
  assertEquals(cache.size(), 1);

  const ctx: AppContext = {
    providers: new ProviderManager(),
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

  const byKey = await handler(
    new Request("http://gateway.test/api/cache/by-key", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  assertEquals(await byKey.json(), { deleted: true });
  assertEquals(cache.size(), 0);

  await cache.set(request, {
    id: "chatcmpl-targeted",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [],
  }, "11111111-1111-4111-8111-111111111111");
  const byRequestId = await handler(
    new Request(
      "http://gateway.test/api/cache/clear/11111111-1111-4111-8111-111111111111",
      { method: "DELETE" },
    ),
  );
  assertEquals(await byRequestId.json(), { deleted: true });
  assertEquals(cache.size(), 0);

  await cache.set(
    request,
    (await cache.get(request)) ?? {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [],
    },
  );
  const clear = await handler(
    new Request("http://gateway.test/api/cache", { method: "DELETE" }),
  );
  assertEquals(await clear.json(), { cleared: 1 });
  assertEquals(cache.size(), 0);
});
