// Wave-4 MCP hardening (decisions D10/D11): stdio transport is disabled by
// default behind FROSTY_MCP_ALLOW_STDIO, http-sse is the default transport
// for new configs, persisted configs never brick boot, and one dead server
// no longer blocks syncing the rest.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  MCPClient,
  MCPClientConfigSchema,
  MCPError,
} from "../../packages/mcp/src/client.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { MCPHealthMonitor } from "../../packages/mcp/src/monitor.ts";
import { createHandler } from "../../apps/gateway/main.ts";
import { type AppContext, VERSION } from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";

const STDIO_CONFIG = {
  id: "local-tool",
  transport: "stdio" as const,
  command: [Deno.execPath(), "run", "-"],
};

Deno.test("stdio configs are rejected by default with an actionable error", () => {
  const registry = new MCPRegistry();
  const error = assertThrows(
    () => registry.upsert(STDIO_CONFIG),
    MCPError,
    "FROSTY_MCP_ALLOW_STDIO",
  );
  assertEquals(error.code, 403);
  assertEquals(registry.list().length, 0);
});

Deno.test("allowStdio option re-enables stdio upserts", () => {
  const registry = new MCPRegistry([], undefined, { allowStdio: true });
  const client = registry.upsert(STDIO_CONFIG);
  assertEquals(client.config.transport, "stdio");
});

Deno.test("persisted stdio clients are skipped at load, not fatal", () => {
  // Upgrade path: a stdio client stored before the default flipped must not
  // prevent boot, and the surviving HTTP clients must still register.
  const registry = new MCPRegistry([
    STDIO_CONFIG,
    { id: "http-ok", url: "http://127.0.0.1:1", transport: "streamable-http" },
  ]);
  assertEquals(registry.list().map((c) => c.config.id), ["http-ok"]);
});

Deno.test("new configs default to http-sse; stored transports round-trip", () => {
  const fresh = MCPClientConfigSchema.parse({ id: "a", url: "http://x" });
  assertEquals(fresh.transport, "http-sse");
  // Persisted records carry a materialized transport and must not be
  // rewritten by the new default on re-parse.
  const stored = MCPClientConfigSchema.parse({
    id: "b",
    url: "http://x",
    transport: "streamable-http",
  });
  assertEquals(stored.transport, "streamable-http");
});

/** Minimal streamable-http MCP double answering initialize/tools/list. */
function healthyMCP() {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json() as { id?: number; method: string };
    if (body.id === undefined) {
      return new Response(null, { status: 202 });
    }
    const result = body.method === "tools/list"
      ? { tools: [{ name: "ping", annotations: { readOnlyHint: true } }] }
      : { protocolVersion: "2025-06-18" };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test("syncAll isolates per-client failures", async () => {
  const upstream = healthyMCP();
  const registry = new MCPRegistry([
    { id: "good", url: upstream.url, transport: "streamable-http" },
    {
      id: "dead",
      url: "http://127.0.0.1:9",
      transport: "streamable-http",
      requestTimeoutMs: 500,
    },
  ]);
  try {
    const summary = await registry.syncAll();
    assertEquals(summary["good"], 1); // synced despite the dead sibling
    assertEquals(summary["dead"], -1); // failure reported, not thrown
    assertEquals(registry.toolCatalog().map((t) => t.name), ["ping"]);
  } finally {
    await upstream.shutdown();
  }
});

function apiContext(): AppContext {
  const mcp = new MCPRegistry();
  return {
    providers: new ProviderManager(),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp,
    mcpMonitor: new MCPHealthMonitor(mcp),
    plugins: new PluginManager(),
    toolExecutor: mcp.executor(),
    version: VERSION,
  };
}

Deno.test("POST /api/mcp/clients with stdio returns a governed 400", async () => {
  const handler = createHandler(apiContext());
  const res = await handler(
    new Request("http://gateway.test/api/mcp/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(STDIO_CONFIG),
    }),
  );
  assertEquals(res.status, 400);
  const body = await res.json() as { error: { message: string } };
  assert(body.error.message.includes("FROSTY_MCP_ALLOW_STDIO"));
});

Deno.test("http-sse endpoint announcement times out instead of hanging", async () => {
  // A server that accepts the GET but never announces an endpoint (e.g. a
  // streamable-http-only server) must fail within requestTimeoutMs — a hang
  // here would block boot, sync, and health checks (now that http-sse is
  // the default transport).
  let open: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Deno.serve({ port: 0, onListen: () => {} }, () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          open = c;
        },
        cancel() {
          open = undefined;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
  const client = new MCPClient(MCPClientConfigSchema.parse({
    id: "silent",
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    transport: "http-sse",
    requestTimeoutMs: 300,
  }));
  try {
    await assertRejects(() => client.sync(), MCPError, "did not announce");
  } finally {
    await client.dispose();
    try {
      open?.close();
    } catch {
      // already errored by the aborted fetch
    }
    await server.shutdown();
  }
});

Deno.test("failed legacy POST does not leave a process-killing orphan", async () => {
  const enc = new TextEncoder();
  const fetchStub = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    if (!init?.method || init.method === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode("event: endpoint\ndata: /messages\n\n"),
          );
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("aborted", "AbortError"));
            } catch {
              // already closed
            }
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    return Promise.reject(new TypeError("connection reset"));
  }) as typeof fetch;

  const client = new MCPClient(
    MCPClientConfigSchema.parse({
      id: "flaky",
      url: "http://mcp.test/",
      transport: "http-sse",
      requestTimeoutMs: 100,
    }),
    fetchStub,
  );
  try {
    await assertRejects(() => client.sync(), TypeError);
    // The orphaned pending timer would reject a promise nobody awaits after
    // requestTimeoutMs; surviving 3x that window proves the cleanup.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await client.dispose();
  }
});
