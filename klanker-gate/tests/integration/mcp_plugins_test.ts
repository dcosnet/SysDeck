// MCP + plugin runtime through the real gateway: client CRUD + sync via the
// admin API, MCP tool execution inside the chat loop (with side-effect
// confirmation), and plugin pre/post/stream-complete hooks.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import { type AppContext, VERSION } from "../../apps/gateway/context.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import {
  MCPClientConfigSchema,
  redactMCPClientConfig,
} from "../../packages/mcp/src/client.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  openAIStreamFrames,
} from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

/** Real HTTP JSON-RPC MCP server for integration coverage. */
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

async function makeContext(
  providerUrl: string,
  mcp = new MCPRegistry(),
): Promise<AppContext> {
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

function weatherToolCall() {
  return openAIChatBody("", {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

Deno.test("MCP: admin CRUD, sync, catalog, and tool execution in the chat loop", async (t) => {
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
      index === 0 ? weatherToolCall() : openAIChatBody("21 degrees in Oslo"),
    )
  );
  const ctx = await makeContext(provider.url);
  const handler = createHandler(ctx);

  try {
    await t.step("register the MCP client via the admin API", async () => {
      const res = await handler(
        new Request(`${base}/api/mcp/clients`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "weather",
            url: `${mcpServer.url}/rpc`,
            transport: "streamable-http",
            enabled: true,
          }),
        }),
      );
      assertEquals(res.status, 201);
      assertEquals((await res.json()).toolCount, 0); // not synced yet
      assertEquals((await ctx.config!.listMCPClients()).length, 1);
    });

    await t.step("sync pulls the tool catalog", async () => {
      const res = await handler(
        new Request(`${base}/api/mcp/clients/weather/sync`, {
          method: "POST",
        }),
      );
      assertEquals(await res.json(), { id: "weather", tools: 1 });

      const catalog = await (await handler(
        new Request(`${base}/api/mcp/tools`),
      )).json();
      assertEquals(catalog.tools[0].name, "get_weather");
      assertEquals(catalog.tools[0].clientId, "weather");
    });

    await t.step(
      "chat executes the read-only MCP tool without confirmation",
      async () => {
        const res = await handler(
          new Request(`${base}/v1/chat/completions`, {
            method: "POST",
            body: JSON.stringify({
              model: "m1",
              messages: [{ role: "user", content: "weather in Oslo?" }],
              tools: [{
                type: "function",
                function: { name: "get_weather", parameters: {} },
              }],
            }),
          }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.choices[0].message.content, "21 degrees in Oslo");
        assertEquals(mcpServer.calls, [
          { name: "get_weather", args: { city: "Oslo" } },
        ]);
        // the tool result was fed back upstream
        const second = provider.calls[1].body as {
          messages: Array<{ role: string; content?: string }>;
        };
        assertEquals(second.messages.at(-1)?.role, "tool");
        assertEquals(second.messages.at(-1)?.content, '{"temp":21}');
      },
    );

    await t.step("delete removes the client and its tools", async () => {
      const res = await handler(
        new Request(`${base}/api/mcp/clients/weather`, { method: "DELETE" }),
      );
      assertEquals(res.status, 204);
      const catalog = await (await handler(
        new Request(`${base}/api/mcp/tools`),
      )).json();
      assertEquals(catalog.tools, []);
      assertEquals(await ctx.config!.listMCPClients(), []);
    });
  } finally {
    ctx.config!.close();
    await provider.close();
    await mcpServer.close();
  }
});

Deno.test("MCP: control-plane views redact connection secrets", async () => {
  const provider = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = await makeContext(provider.url);
  const handler = createHandler(ctx);
  const secret = "mcp-test-secret-not-for-control-plane";
  try {
    const create = await handler(
      new Request(`${base}/api/mcp/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "private-client",
          url: `http://operator:${secret}@mcp.example.test/rpc`,
          transport: "streamable-http",
          headers: { Authorization: `Bearer ${secret}`, "X-Workspace": "ops" },
        }),
      }),
    );
    assertEquals(create.status, 201);
    const created = await create.json() as Record<string, unknown>;
    assertEquals(created.headerNames, ["Authorization", "X-Workspace"]);
    assertEquals(created.hasUrlCredentials, true);
    assertEquals(created.hasCommand, false);
    assert(!JSON.stringify(created).includes(secret));
    assert(!("headers" in created));

    const listed = await handler(new Request(`${base}/api/mcp/clients`));
    const listedText = await listed.text();
    assert(!listedText.includes(secret));
    assertEquals(JSON.parse(listedText).clients[0].headerNames, [
      "Authorization",
      "X-Workspace",
    ]);

    const update = await handler(
      new Request(`${base}/api/mcp/clients/private-client`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    assertEquals(update.status, 200);
    assert(!JSON.stringify(await update.json()).includes(secret));
    assertEquals(
      ctx.mcp.get("private-client")!.config.headers?.Authorization,
      `Bearer ${secret}`,
    );
  } finally {
    ctx.config!.close();
    await provider.close();
  }
});

Deno.test("MCP: public config redacts headers, commands, and URL user-info", () => {
  const secret = "mcp-test-secret-not-for-public-config";
  const view = redactMCPClientConfig(MCPClientConfigSchema.parse({
    id: "private-stdio",
    url: `http://operator:${secret}@mcp.example.test/rpc`,
    transport: "stdio",
    command: ["mcp-server", `--token=${secret}`],
    headers: { Authorization: `Bearer ${secret}` },
  }));
  assertEquals(view.headerNames, ["Authorization"]);
  assertEquals(view.hasCommand, true);
  assertEquals(view.hasUrlCredentials, true);
  assert(!("headers" in view));
  assert(!("command" in view));
  assert(!JSON.stringify(view).includes(secret));
});

Deno.test("MCP: sync errors do not reflect upstream response text", async () => {
  const secret = "mcp-test-secret-not-from-upstream";
  const provider = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const mcp = new MCPRegistry(
    [],
    (() =>
      Promise.resolve(new Response(secret, { status: 401 }))) as typeof fetch,
  );
  const ctx = await makeContext(provider.url, mcp);
  const handler = createHandler(ctx);
  mcp.upsert({
    id: "echoing-upstream",
    url: "http://mcp.example.test/rpc",
    transport: "streamable-http",
  });
  try {
    const response = await handler(
      new Request(`${base}/api/mcp/clients/echoing-upstream/sync`, {
        method: "POST",
      }),
    );
    assertEquals(response.status, 502);
    const body = await response.text();
    assert(!body.includes(secret));
    assert(body.includes("MCP sync failed."));
  } finally {
    ctx.config!.close();
    await provider.close();
  }
});

Deno.test("MCP: side-effect tools still require explicit confirmation", async () => {
  const mcpServer = startMCPServer(
    [{ name: "get_weather", description: "no readOnlyHint -> side effect" }],
    () => "done",
  );
  const provider = new MockProvider(() => jsonResponse(weatherToolCall()));
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
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "weather?" }],
          tools: [{
            type: "function",
            function: { name: "get_weather", parameters: {} },
          }],
        }),
      }),
    );
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error.type, "side_effect_denied");
    assertEquals(mcpServer.calls.length, 0);
  } finally {
    ctx.config!.close();
    await provider.close();
    await mcpServer.close();
  }
});

Deno.test("plugins: pre and post hooks run around non-streaming chat", async () => {
  const provider = new MockProvider(() =>
    jsonResponse(openAIChatBody("plain answer"))
  );
  const ctx = await makeContext(provider.url);
  ctx.plugins.register({
    name: "tagger",
    onPreRequest: (req) => Promise.resolve({ ...req, user: "plugin-user" }),
    onPostRequest: (res) =>
      Promise.resolve({ ...res, system_fingerprint: "post-hooked" }),
  });
  const handler = createHandler(ctx);

  try {
    const res = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await res.json();
    assertEquals(body.system_fingerprint, "post-hooked");
    // pre-hook mutation reached the provider
    const sent = provider.calls[0].body as { user?: string };
    assertEquals(sent.user, "plugin-user");
    // plugin listing exposed for the UI
    const plugins = await (await handler(
      new Request(`${base}/api/plugins`),
    )).json();
    assertEquals(plugins.plugins, ["tagger"]);
  } finally {
    ctx.config!.close();
    await provider.close();
  }
});

Deno.test("plugins: stream-completion hook receives the full assistant text", async () => {
  const provider = new MockProvider(() =>
    new Response(openAIStreamFrames(["Hel", "lo!"]).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  );
  const ctx = await makeContext(provider.url);
  const completions: string[] = [];
  ctx.plugins.register({
    name: "stream-capture",
    onStreamComplete: (text) => {
      completions.push(text);
      return Promise.resolve();
    },
  });
  const handler = createHandler(ctx);

  try {
    const res = await handler(
      new Request(`${base}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "m1",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    const text = await res.text(); // drain the stream fully
    assert(text.trimEnd().endsWith("data: [DONE]"));
    assertEquals(completions, ["Hello!"]);
  } finally {
    ctx.config!.close();
    await provider.close();
  }
});
