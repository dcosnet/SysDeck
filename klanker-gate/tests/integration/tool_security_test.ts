// Side-effect tool security through the real gateway route: unconfirmed
// side-effect tools are refused; the explicit confirmation header allows them.

import { assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import { type AppContext, VERSION } from "../../apps/gateway/context.ts";
import type { ToolExecutor } from "../../packages/core/src/mod.ts";
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

class DeleterExecutor implements ToolExecutor {
  executed = 0;
  has(name: string): boolean {
    return name === "delete_everything";
  }
  isSideEffect(_name: string): boolean {
    return true;
  }
  execute(_name: string, _args: unknown): Promise<string> {
    this.executed++;
    return Promise.resolve("deleted");
  }
}

function toolCallResponse() {
  return openAIChatBody("", {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "delete_everything", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

function makeContext(mockUrl: string, executor: ToolExecutor): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mockUrl,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: executor,
    version: VERSION,
  };
}

function chatWithTools(confirm: boolean): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(confirm ? { "x-frosty-confirm-side-effects": "true" } : {}),
    },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "clean up" }],
      tools: [{
        type: "function",
        function: { name: "delete_everything", parameters: {} },
      }],
    }),
  });
}

Deno.test("gateway refuses unconfirmed side-effect tools with 403", async () => {
  const mock = new MockProvider(() => jsonResponse(toolCallResponse()));
  const executor = new DeleterExecutor();
  try {
    const handler = createHandler(makeContext(mock.url, executor));
    const res = await handler(chatWithTools(false));
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error.type, "side_effect_denied");
    assertEquals(executor.executed, 0); // nothing ran
  } finally {
    await mock.close();
  }
});

Deno.test("explicit confirmation header allows side-effect execution", async () => {
  const executor = new DeleterExecutor();
  const mock = new MockProvider((_call, index) =>
    jsonResponse(
      index === 0 ? toolCallResponse() : openAIChatBody("all clean"),
    )
  );
  try {
    const handler = createHandler(makeContext(mock.url, executor));
    const res = await handler(chatWithTools(true));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.choices[0].message.content, "all clean");
    assertEquals(executor.executed, 1);
    // the tool result went back upstream on the second call
    const second = mock.calls[1].body as {
      messages: Array<{ role: string; content?: string }>;
    };
    assertEquals(second.messages.at(-1)?.role, "tool");
    assertEquals(second.messages.at(-1)?.content, "deleted");
  } finally {
    await mock.close();
  }
});
