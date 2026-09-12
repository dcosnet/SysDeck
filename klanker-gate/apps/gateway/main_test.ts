import { assert, assertEquals } from "@std/assert";
import { createHandler } from "./main.ts";
import { type AppContext, NullToolExecutor, VERSION } from "./context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";

function makeContext(providers = new ProviderManager([])): AppContext {
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

const base = "http://gateway.test";

Deno.test("GET /healthz reports ok with version", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(new Request(`${base}/healthz`));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.version, VERSION);
});

Deno.test("GET /api/version reports gateway and runtime versions", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(new Request(`${base}/api/version`));
  const body = await res.json();
  assertEquals(body.version, VERSION);
  assertEquals(body.deno, Deno.version.deno);
});

Deno.test("transport plugin hooks wrap routing with transformed request and response", async () => {
  const ctx = makeContext();
  const observed: string[] = [];
  ctx.plugins.register({
    name: "transport-test",
    onTransportPre: (req) => {
      observed.push(`pre:${new URL(req.url).pathname}`);
      const headers = new Headers(req.headers);
      headers.set("x-plugin-request", "present");
      return Promise.resolve(new Request(req, { headers }));
    },
    onTransportPost: (res) => {
      observed.push(`post:${res.status}`);
      const headers = new Headers(res.headers);
      headers.set("x-plugin-response", "present");
      return Promise.resolve(
        new Response(res.body, { status: res.status, headers }),
      );
    },
  });

  const res = await createHandler(ctx)(new Request(`${base}/healthz`));
  assertEquals(observed, ["pre:/healthz", "post:200"]);
  assertEquals(res.headers.get("x-plugin-response"), "present");
  await res.body?.cancel();
});

Deno.test("POST /v1/chat/completions rejects invalid JSON", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.type, "invalid_request_error");
});

Deno.test("POST /v1/chat/completions rejects schema-invalid payloads", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ garbage: true }),
    }),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.type, "invalid_request_error");
  assert(String(body.error.message).includes("model"));
});

Deno.test("POST /v1/chat/completions with no providers returns 503", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.type, "provider_error");
});

Deno.test("GET /v1/models lists the aggregated catalog", async () => {
  const providers = new ProviderManager([{
    id: "openai",
    type: "openai",
    apiKey: "k",
    enabled: true,
    models: ["gpt-4o"],
    priority: 0,
  }]);
  const handler = createHandler(makeContext(providers));
  const res = await handler(new Request(`${base}/v1/models`));
  const body = await res.json();
  assertEquals(body.object, "list");
  assertEquals(body.data[0].id, "openai/gpt-4o");
});

Deno.test("unknown routes return 404", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(new Request(`${base}/nope`));
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
