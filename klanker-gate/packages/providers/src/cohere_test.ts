import { assertEquals } from "@std/assert";
import { ProviderClient } from "./client.ts";
import { CohereAdapter } from "./cohere.ts";
import { readSSE } from "../../testing/src/mod.ts";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: {} },
  },
};

Deno.test("CohereAdapter maps tools, tool_calls and tool results into the v2 request", async () => {
  let url = "";
  let body: {
    tools?: Array<{ function: { name: string } }>;
    tool_choice?: string;
    messages?: Array<Record<string, unknown>>;
  } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "c1",
          message: { content: [{ type: "text", text: "done" }] },
          finish_reason: "COMPLETE",
          usage: { billed_units: { input_tokens: 5, output_tokens: 2 } },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new CohereAdapter("co-key", "http://mock", client);
  const res = await adapter.chatCompletions({
    model: "command-r",
    messages: [
      { role: "user", content: "weather in Oslo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
        }],
      },
      { role: "tool", tool_call_id: "tc1", content: '{"temp":21}' },
    ],
    tools: [weatherTool],
    tool_choice: "auto",
  });
  await res.body?.cancel();

  assertEquals(url, "http://mock/v2/chat");
  assertEquals(body.tools?.[0].function.name, "get_weather");
  // "auto" is Cohere's default; it is omitted rather than sent.
  assertEquals("tool_choice" in body, false);
  assertEquals(body.messages?.[1], {
    role: "assistant",
    tool_calls: [{
      id: "tc1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
    }],
  });
  assertEquals(body.messages?.[2], {
    role: "tool",
    tool_call_id: "tc1",
    content: '{"temp":21}',
  });
});

Deno.test("CohereAdapter maps tool_choice required to REQUIRED", async () => {
  let body: { tool_choice?: string } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ id: "c", message: { content: [] } }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new CohereAdapter("co-key", "http://mock", client);
  const res = await adapter.chatCompletions({
    model: "command-r",
    messages: [{ role: "user", content: "hi" }],
    tools: [weatherTool],
    tool_choice: "required",
  });
  await res.body?.cancel();
  assertEquals(body.tool_choice, "REQUIRED");
});

Deno.test("CohereAdapter parses v2 tool_calls in a non-streaming response", async () => {
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() =>
      new Response(
        JSON.stringify({
          id: "c2",
          message: {
            tool_plan: "I will call the tool",
            tool_calls: [{
              id: "tc9",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
            }],
          },
          finish_reason: "TOOL_CALL",
          usage: { billed_units: { input_tokens: 10, output_tokens: 5 } },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    ),
  );
  const adapter = new CohereAdapter("co-key", "http://mock", client);
  const res = await adapter.chatCompletions({
    model: "command-r",
    messages: [{ role: "user", content: "weather?" }],
    tools: [weatherTool],
  });
  const chat = await res.json() as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<
          { id: string; function: { name: string; arguments: string } }
        >;
      };
      finish_reason: string;
    }>;
  };

  assertEquals(chat.choices[0].finish_reason, "tool_calls");
  assertEquals(chat.choices[0].message.content, null);
  const call = chat.choices[0].message.tool_calls![0];
  assertEquals(call.id, "tc9");
  assertEquals(call.function.name, "get_weather");
  assertEquals(JSON.parse(call.function.arguments), { city: "Oslo" });
});

Deno.test("CohereAdapter streams tool-call events as OpenAI tool_call deltas", async () => {
  const upstream = [
    `data: {"type":"tool-call-start","index":0,"delta":{"message":{"tool_calls":{"id":"tc1","type":"function","function":{"name":"get_weather","arguments":""}}}}}\n\n`,
    `data: {"type":"tool-call-delta","index":0,"delta":{"message":{"tool_calls":{"function":{"arguments":"{\\"city\\":"}}}}}\n\n`,
    `data: {"type":"tool-call-delta","index":0,"delta":{"message":{"tool_calls":{"function":{"arguments":"\\"Oslo\\"}"}}}}}\n\n`,
    `data: {"type":"message-end","delta":{"finish_reason":"TOOL_CALL"}}\n\n`,
  ].join("");
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() =>
      new Response(upstream, {
        headers: { "Content-Type": "text/event-stream" },
      })
    ),
  );
  const adapter = new CohereAdapter("co-key", "http://mock", client);
  const res = await adapter.chatCompletions({
    model: "command-r",
    messages: [{ role: "user", content: "weather?" }],
    tools: [weatherTool],
    stream: true,
  });

  type ToolDelta = {
    delta: {
      tool_calls?: Array<{
        index: number;
        id?: string;
        function: { name?: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  };
  const events = await readSSE(res);
  const chunks = events.filter((e): e is Record<string, unknown> =>
    e !== "[DONE]"
  );
  const toolChunks = chunks
    .map((c) => (c.choices as ToolDelta[])[0])
    .filter((c) => c.delta.tool_calls);

  assertEquals(toolChunks[0].delta.tool_calls![0].id, "tc1");
  assertEquals(toolChunks[0].delta.tool_calls![0].function.name, "get_weather");
  const args = toolChunks.slice(1)
    .map((c) => c.delta.tool_calls![0].function.arguments)
    .join("");
  assertEquals(JSON.parse(args), { city: "Oslo" });

  const finish = chunks
    .map((c) => (c.choices as ToolDelta[])[0]?.finish_reason)
    .filter(Boolean);
  assertEquals(finish, ["tool_calls"]);
  assertEquals(events.at(-1), "[DONE]");
});

Deno.test("CohereAdapter.countTokens uses the native /v1/tokenize endpoint", async () => {
  let url = "";
  let body: { model?: string; text?: string } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          tokens: [1, 2, 3, 4],
          token_strings: ["a", "b", "c", "d"],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new CohereAdapter("co-key", "http://mock", client);
  const counted = await adapter.countTokens({
    model: "command-r",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  });

  assertEquals(url, "http://mock/v1/tokenize");
  assertEquals(body.model, "command-r");
  assertEquals(body.text, "hello\nhi");
  assertEquals(counted, { input_tokens: 4, estimated: false });
});
