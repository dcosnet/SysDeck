// Opt-in MCP tool auto-injection through the real chat route: the
// `x-frosty-mcp-tools: auto` header advertises the aggregated MCP catalog
// (client-namespaced names) to the model and runs the existing tool loop.
// Absent the header, the request is left byte-unchanged (default behavior).

import { assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import { type AppContext, VERSION } from "../../apps/gateway/context.ts";
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

/** Real HTTP JSON-RPC MCP server recording every tools/call. */
function startMCPServer(
  tools: Array<Record<string, unknown>>,
  onCall: (name: string, args: unknown) => string,
) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json();
    let result: unknown = {};
    if (body.method === "initialize") {
      result = { protocolVersion: "2025-06-18" };
    } else if (body.method === "tools/list") {
      result = { tools };
    } else if (body.method === "tools/call") {
      calls.push({ name: body.params.name, args: body.params.arguments });
      result = {
        content: [{
          type: "text",
          text: onCall(body.params.name, body.params.arguments),
        }],
      };
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    calls,
    close: () => server.shutdown(),
  };
}

async function makeContext(providerUrl: string): Promise<AppContext> {
  const mcp = new MCPRegistry();
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: providerUrl,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp,
    plugins: new PluginManager(),
    toolExecutor: mcp.executor(),
    version: VERSION,
    config: await ConfigService.open(":memory:"),
  };
}

/** Assistant turn that calls a tool by its (possibly qualified) name. */
function toolCallBody(name: string, args = "{}") {
  return openAIChatBody("", {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name, arguments: args },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

function requestTools(
  provider: MockProvider,
  callIndex: number,
): string[] {
  const body = provider.calls[callIndex].body as {
    tools?: Array<{ function?: { name?: string } }>;
  };
  return (body.tools ?? []).map((t) => t.function?.name ?? "");
}

Deno.test("chat auto-injects MCP tools when x-frosty-mcp-tools: auto is set", async () => {
  const mcpServer = startMCPServer(
    [{
      name: "get_weather",
      description: "Weather lookup",
      annotations: { readOnlyHint: true },
    }],
    () => JSON.stringify({ temp: 21 }),
  );
  const provider = new MockProvider((_call, index) =>
    jsonResponse(
      index === 0
        ? toolCallBody("weather__get_weather")
        : openAIChatBody("21 degrees in Oslo"),
    )
  );
  const ctx = await makeContext(provider.url);
  ctx.mcp.upsert({
    id: "weather",
    url: `${mcpServer.url}/rpc`,
    transport: "streamable-http",
    enabled: true,
  });
  await ctx.mcp.syncAll();
  const handler = createHandler(ctx);

  try {
    const res = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-frosty-mcp-tools": "auto",
        },
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "weather in Oslo?" }],
        }),
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.choices[0].message.content, "21 degrees in Oslo");
    // The aggregated catalog was advertised to the model under its qualified
    // (client-namespaced) name.
    assertEquals(requestTools(provider, 0), ["weather__get_weather"]);
    // The read-only tool ran (no confirmation) with the RAW upstream name.
    assertEquals(mcpServer.calls, [{ name: "get_weather", args: {} }]);
  } finally {
    ctx.config!.close();
    await provider.close();
    await mcpServer.close();
  }
});

Deno.test("chat leaves the request unchanged without the auto header", async () => {
  const mcpServer = startMCPServer(
    [{ name: "get_weather", annotations: { readOnlyHint: true } }],
    () => "unused",
  );
  const provider = new MockProvider(() =>
    jsonResponse(openAIChatBody("plain answer"))
  );
  const ctx = await makeContext(provider.url);
  ctx.mcp.upsert({
    id: "weather",
    url: `${mcpServer.url}/rpc`,
    transport: "streamable-http",
    enabled: true,
  });
  await ctx.mcp.syncAll();
  const handler = createHandler(ctx);

  try {
    const res = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // no auto header
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).choices[0].message.content, "plain answer");
    // No tools injected, no MCP call, a single provider dispatch: default path.
    assertEquals(
      (provider.calls[0].body as { tools?: unknown[] }).tools,
      undefined,
    );
    assertEquals(mcpServer.calls.length, 0);
    assertEquals(provider.calls.length, 1);
  } finally {
    ctx.config!.close();
    await provider.close();
    await mcpServer.close();
  }
});

Deno.test("auto-injection honors the per-client toolsToExecute allowlist", async () => {
  const mcpServer = startMCPServer(
    [
      { name: "get_weather", annotations: { readOnlyHint: true } },
      { name: "delete_city", description: "destructive" },
    ],
    () => "ok",
  );
  const provider = new MockProvider(() => jsonResponse(openAIChatBody("done")));
  const ctx = await makeContext(provider.url);
  ctx.mcp.upsert({
    id: "weather",
    url: `${mcpServer.url}/rpc`,
    transport: "streamable-http",
    enabled: true,
    toolsToExecute: ["get_weather"],
  });
  await ctx.mcp.syncAll();
  const handler = createHandler(ctx);

  try {
    const res = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-frosty-mcp-tools": "auto",
        },
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    assertEquals(res.status, 200);
    // Only the allowlisted tool is advertised; delete_city is withheld.
    assertEquals(requestTools(provider, 0), ["weather__get_weather"]);
  } finally {
    ctx.config!.close();
    await provider.close();
    await mcpServer.close();
  }
});
