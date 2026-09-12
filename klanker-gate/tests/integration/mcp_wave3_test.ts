// Wave-3 MCP: stdio transport (subprocess JSON-RPC), the gateway exposed AS
// an MCP server (with the fail-closed side-effect gate), and health checks.

import { assert, assertEquals, assertRejects } from "@std/assert";
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

const STDIO_SERVER = `
const dec = new TextDecoder();
const enc = new TextEncoder();
let buf = "";
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2025-06-18" };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [{
          name: "stdio-echo",
          description: "echoes over stdio",
          annotations: { readOnlyHint: true },
        }],
      };
    } else if (msg.method === "tools/call") {
      result = { content: [{ type: "text", text: "from-stdio" }] };
    } else {
      result = {};
    }
    await Deno.stdout.write(
      enc.encode(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n"),
    );
  }
}
`;

Deno.test("stdio transport: subprocess JSON-RPC round-trip + dispose", async () => {
  const script = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(script, STDIO_SERVER);
  const client = new MCPClient(MCPClientConfigSchema.parse({
    id: "stdio-t",
    transport: "stdio",
    command: [Deno.execPath(), "run", "--quiet", script],
  }));
  try {
    const tools = await client.sync();
    assertEquals(tools.map((t) => t.name), ["stdio-echo"]);
    assertEquals(await client.callTool("stdio-echo", { a: 1 }), "from-stdio");
    assertEquals(client.resolvedTransport, "stdio");
  } finally {
    await client.dispose();
    await Deno.remove(script);
  }
});

Deno.test("stdio config validation: command required, url not", () => {
  const bad = MCPClientConfigSchema.safeParse({
    id: "x",
    transport: "stdio",
  });
  assert(!bad.success);
  const badHttp = MCPClientConfigSchema.safeParse({ id: "y" });
  assert(!badHttp.success); // http transports (default http-sse) need a url
});

interface RpcRequest {
  id?: number;
  method: string;
  params?: { name?: string };
}

/** Upstream MCP double with one read-only and one side-effecting tool. */
function upstreamMCP() {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json() as RpcRequest;
    if (body.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18" },
      });
    }
    if (body.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "lookup", annotations: { readOnlyHint: true } },
            { name: "write-db" },
          ],
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: `ran:${body.params?.name}` }],
      },
    });
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    shutdown: () => server.shutdown(),
  };
}

function serverContext(mcp: MCPRegistry): AppContext {
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

Deno.test("gateway as MCP server: list/call with side-effect gate", async () => {
  const upstream = upstreamMCP();
  const mcp = new MCPRegistry([
    { id: "up", url: upstream.url, transport: "streamable-http" },
  ]);
  await mcp.syncAll();
  const gateway = Deno.serve(
    { port: 0, onListen: () => {} },
    createHandler(serverContext(mcp)),
  );
  const gatewayUrl = `http://127.0.0.1:${
    (gateway.addr as Deno.NetAddr).port
  }/mcp`;

  const plain = new MCPClient(MCPClientConfigSchema.parse({
    id: "host",
    url: gatewayUrl,
    transport: "streamable-http",
  }));
  const confirming = new MCPClient(MCPClientConfigSchema.parse({
    id: "host2",
    url: gatewayUrl,
    transport: "streamable-http",
    headers: { "x-frosty-confirm-side-effects": "true" },
  }));
  try {
    // Our own MCP client speaks to the gateway's server surface.
    const tools = await plain.sync();
    assertEquals(tools.map((t) => t.name).sort(), ["lookup", "write-db"]);

    // Read-only tools execute freely and proxy through to the upstream.
    assertEquals(await plain.callTool("lookup", {}), "ran:lookup");

    // Side-effecting tools fail closed without the confirmation header…
    await assertRejects(
      () => plain.callTool("write-db", {}),
      MCPError,
      "side effects",
    );

    // …and run when the host explicitly confirms.
    await confirming.sync();
    assertEquals(await confirming.callTool("write-db", {}), "ran:write-db");

    // Unknown methods are proper JSON-RPC errors.
    await assertRejects(
      () => plain.callTool("no-such-tool", {}),
      MCPError,
      "Unknown tool",
    );
  } finally {
    await plain.dispose();
    await confirming.dispose();
    await gateway.shutdown();
    await upstream.shutdown();
  }
});

Deno.test("gateway MCP server: GET opens a governed SSE channel", async () => {
  const ctx = serverContext(new MCPRegistry());
  ctx.virtualKeys.upsert({
    id: "mcp-sse-key",
    name: "mcp-sse",
    token: "vk-mcp-sse-test-token",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);

  const denied = await handler(new Request("http://gateway.test/mcp"));
  assertEquals(denied.status, 401);

  const opened = await handler(
    new Request("http://gateway.test/mcp", {
      headers: { Authorization: "Bearer vk-mcp-sse-test-token" },
    }),
  );
  assertEquals(opened.status, 200);
  assertEquals(opened.headers.get("content-type"), "text/event-stream");
  assertEquals(opened.headers.get("cache-control"), "no-cache");
  assertEquals(opened.headers.get("connection"), "keep-alive");
  const reader = opened.body!.getReader();
  const first = await reader.read();
  assertEquals(first.done, false);
  assertEquals(
    new TextDecoder().decode(first.value),
    'data: {"jsonrpc":"2.0","method":"connection/opened"}\n\n',
  );
  await reader.cancel();
});

Deno.test("gateway MCP server: SSE remains open over real HTTP", async () => {
  const gateway = Deno.serve(
    { port: 0, onListen: () => {} },
    createHandler(serverContext(new MCPRegistry())),
  );
  const url = `http://127.0.0.1:${(gateway.addr as Deno.NetAddr).port}/mcp`;
  try {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assertEquals(first.done, false);
    const pending = reader.read();
    const stillOpen = await Promise.race([
      pending.then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 25)),
    ]);
    assertEquals(stillOpen, true);
    await reader.cancel();
  } finally {
    await gateway.shutdown();
  }
});

Deno.test("/api/mcp/health reports healthy and unhealthy servers", async () => {
  const upstream = upstreamMCP();
  const mcp = new MCPRegistry([
    { id: "good", url: upstream.url, transport: "streamable-http" },
    {
      id: "dead",
      url: "http://127.0.0.1:9",
      transport: "streamable-http",
      requestTimeoutMs: 500,
    },
  ]);
  const handler = createHandler(serverContext(mcp));
  try {
    const res = await handler(
      new Request("http://gateway.test/api/mcp/health"),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as {
      health: Array<{ clientId: string; status: string }>;
    };
    const byId = Object.fromEntries(
      body.health.map((h) => [h.clientId, h.status]),
    );
    assertEquals(byId["good"], "healthy");
    assertEquals(byId["dead"], "unhealthy");
  } finally {
    await upstream.shutdown();
  }
});
