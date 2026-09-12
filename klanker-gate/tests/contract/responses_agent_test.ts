// Responses "agent loop" + native passthrough contract tests.
//
// Covers: (a) the non-streaming /v1/responses agent loop executing a
// gateway-owned function tool across turns and returning the Responses
// envelope; (b) the side-effect confirmation gate is preserved on that loop;
// (c) opt-in native passthrough forwards the untranslated body to the
// provider's rawProxy /responses surface and returns it verbatim; and (d) the
// DEFAULT path (no header, no tools) is byte-identical to the translation path.

import { assert, assertEquals } from "@std/assert";
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
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import type { ToolExecutor } from "../../packages/core/src/mod.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

function makeContext(
  providers: ProviderManager,
  toolExecutor: ToolExecutor = new NullToolExecutor(),
): AppContext {
  return {
    providers,
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor,
    version: VERSION,
  };
}

function openAIProvider(mockUrl: string): ProviderManager {
  return new ProviderManager([{
    id: "openai",
    type: "openai",
    apiKey: "sk-test",
    baseUrl: mockUrl,
    enabled: true,
    models: ["mock-model"],
    priority: 0,
    retry: { maxRetries: 0 },
  }], "openai");
}

function toolCallBody(name: string, args: string): Record<string, unknown> {
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

Deno.test("/v1/responses runs the agent loop over a gateway-owned function tool", async () => {
  const mock = new MockProvider((_call, index) =>
    index === 0
      // Turn 1: the model asks the gateway to run the tool.
      ? jsonResponse(toolCallBody("get_weather", '{"city":"Paris"}'))
      // Turn 2: with the tool result in context, it answers.
      : jsonResponse(openAIChatBody("It is sunny in Paris."))
  );
  try {
    const executor: ToolExecutor = {
      has: (name) => name === "get_weather",
      isSideEffect: () => false,
      execute: (_name, _args) =>
        Promise.resolve(JSON.stringify({ temp: "sunny" })),
    };
    const handler = createHandler(
      makeContext(openAIProvider(mock.url), executor),
    );
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "What's the weather in Paris?",
          tools: [
            {
              type: "function",
              name: "get_weather",
              parameters: { type: "object" },
            },
          ],
        }),
      }),
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.object, "response");
    assertEquals(body.status, "completed");
    assertEquals(body.output_text, "It is sunny in Paris.");
    assertEquals(body.output[0].content[0].type, "output_text");

    // Two upstream turns: the tool call, then the follow-up with the result.
    assertEquals(mock.calls.length, 2);
    // The Responses `function` tool was forwarded (flat -> nested chat shape).
    const first = mock.calls[0].body as {
      tools: Array<{ type: string; function: { name: string } }>;
    };
    assertEquals(first.tools[0].type, "function");
    assertEquals(first.tools[0].function.name, "get_weather");
    // The second turn carried the tool result back to the model.
    const second = mock.calls[1].body as {
      messages: Array<{ role: string }>;
    };
    assert(second.messages.some((m) => m.role === "tool"));
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/responses agent loop preserves the side-effect confirmation gate", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(toolCallBody("delete_file", "{}"))
  );
  try {
    const executor: ToolExecutor = {
      has: (name) => name === "delete_file",
      isSideEffect: () => true, // side-effecting: must be confirmed
      execute: () => Promise.resolve("deleted"),
    };
    const handler = createHandler(
      makeContext(openAIProvider(mock.url), executor),
    );
    // No x-frosty-confirm-side-effects header -> the call is denied.
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "delete the file",
          tools: [
            {
              type: "function",
              name: "delete_file",
              parameters: { type: "object" },
            },
          ],
        }),
      }),
    );

    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error.type, "side_effect_denied");
    // The side-effecting tool never executed (no second upstream turn).
    assertEquals(mock.calls.length, 1);
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/responses native passthrough forwards to rawProxy verbatim", async () => {
  const nativeBody = {
    id: "resp_native_1",
    object: "response",
    created_at: 123,
    status: "completed",
    model: "mock-model",
    output: [{
      id: "msg_x",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "native!", annotations: [] }],
    }],
    output_text: "native!",
  };
  const mock = new MockProvider(() => jsonResponse(nativeBody));
  try {
    const handler = createHandler(makeContext(openAIProvider(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-frosty-responses-passthrough": "native",
        },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "hi",
          // A built-in tool the gateway never executes: forwarded verbatim.
          tools: [{ type: "web_search" }],
          reasoning: { effort: "high" },
        }),
      }),
    );

    assertEquals(res.status, 200);
    // Returned byte-for-byte from the provider's native surface.
    assertEquals(await res.json(), nativeBody);

    // Forwarded to the provider's NATIVE /responses endpoint (not chat).
    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0].path, "/responses");
    // Untranslated: the built-in tool + reasoning survive; only the provider
    // prefix was stripped from `model`.
    const sent = mock.calls[0].body as {
      model: string;
      tools: Array<{ type: string }>;
      reasoning: { effort: string };
    };
    assertEquals(sent.model, "mock-model");
    assertEquals(sent.tools[0].type, "web_search");
    assertEquals(sent.reasoning.effort, "high");
    // rawProxy attached the provider's bearer auth.
    assertEquals(
      mock.calls[0].headers.get("Authorization"),
      "Bearer sk-test",
    );
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/responses DEFAULT path is unchanged (translation, no tools fabricated)", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("Hello there."))
  );
  try {
    const handler = createHandler(makeContext(openAIProvider(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "Hello, world!",
          instructions: "Be helpful.",
        }),
      }),
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.object, "response");
    assertEquals(body.output_text, "Hello there.");
    assertEquals(body.output[0].content[0].type, "output_text");

    // Translation path: the upstream is chat/completions, NOT native /responses.
    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0].path, "/chat/completions");
    const sent = mock.calls[0].body as {
      messages: Array<{ role: string; content: string }>;
    } & Record<string, unknown>;
    // No tools/tool_choice invented onto the default request.
    assert(!("tools" in sent));
    assert(!("tool_choice" in sent));
    // instructions -> system, input -> user, exactly as before.
    assertEquals(sent.messages[0], { role: "system", content: "Be helpful." });
    assertEquals(sent.messages[1], { role: "user", content: "Hello, world!" });
  } finally {
    await mock.close();
  }
});
