// Golden-fixture contract tests: the gateway must reproduce the captured
// OpenAI-compatible wire shapes byte-for-byte (module ordering of JSON keys).

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
import { mockerPlugin } from "../../packages/plugins/src/mocker.ts";
import {
  jsonResponse,
  MockProvider,
  openAIStreamFrames,
  readSSE,
} from "../../packages/testing/src/mod.ts";

const requestFixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../docs/contracts/fixtures/chat_completion_req.json",
      import.meta.url,
    ),
  ),
);
const responseFixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../docs/contracts/fixtures/chat_completion_res.json",
      import.meta.url,
    ),
  ),
);

function makeContext(providers: ProviderManager): AppContext {
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

function providerFor(mockUrl: string): ProviderManager {
  return new ProviderManager([{
    id: "openai",
    type: "openai",
    apiKey: "sk-golden",
    baseUrl: mockUrl,
    enabled: true,
    models: ["gpt-4-turbo"],
    priority: 0,
    retry: { maxRetries: 0 },
  }], "openai");
}

Deno.test("mocker short-circuits non-streaming chat before provider egress", async () => {
  const mock = new MockProvider(() => jsonResponse(responseFixture));
  try {
    const ctx = makeContext(providerFor(mock.url));
    ctx.plugins.register(mockerPlugin({
      rules: [{
        name: "offline",
        responses: [{ type: "success", content: { message: "mocked" } }],
      }],
    }));
    const handler = createHandler(ctx);
    const res = await handler(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestFixture),
      }),
    );

    assertEquals(res.status, 200);
    assertEquals((await res.json()).choices[0].message.content, "mocked");
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

Deno.test("golden: /v1/chat/completions request and response bodies", async () => {
  const mock = new MockProvider(() => jsonResponse(responseFixture));
  try {
    const handler = createHandler(makeContext(providerFor(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestFixture),
      }),
    );

    assertEquals(res.status, 200);
    assertEquals(await res.json(), responseFixture);

    // The upstream must have received the fixture request unchanged.
    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0].path, "/chat/completions");
    assertEquals(mock.calls[0].body, requestFixture);
    assertEquals(
      mock.calls[0].headers.get("Authorization"),
      "Bearer sk-golden",
    );
  } finally {
    await mock.close();
  }
});

Deno.test("golden: streaming chunk framing and [DONE] semantics", async () => {
  const frames = openAIStreamFrames(["Hello", " world"]);
  const mock = new MockProvider(() =>
    new Response(frames.join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  );
  try {
    const handler = createHandler(makeContext(providerFor(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestFixture, stream: true }),
      }),
    );

    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const events = await readSSE(res);
    // 2 content deltas + finish chunk + [DONE]
    assertEquals(events.length, 4);
    const contents = events
      .filter((e): e is Record<string, unknown> => e !== "[DONE]")
      .map((e) =>
        (e.choices as Array<{ delta: { content?: string } }>)[0].delta.content
      )
      .filter((c): c is string => Boolean(c));
    assertEquals(contents.join(""), "Hello world");
    const last = events.at(-2) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    assertEquals(last.choices[0].finish_reason, "stop");
    assertEquals(events.at(-1), "[DONE]");
  } finally {
    await mock.close();
  }
});

Deno.test("golden: /v1/responses maps chat output to the Responses shape", async () => {
  const mock = new MockProvider(() => jsonResponse(responseFixture));
  try {
    const handler = createHandler(makeContext(providerFor(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4-turbo",
          input: "Hello, world!",
          instructions: "Be helpful.",
        }),
      }),
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.object, "response");
    assertEquals(body.status, "completed");
    assertEquals(body.output_text, "Hello! How can I assist you today?");
    assertEquals(body.output[0].content[0].type, "output_text");
    assertEquals(body.usage.total_tokens, 21);

    // instructions became the system message upstream
    const sent = mock.calls[0].body as {
      messages: Array<{ role: string; content: string }>;
    };
    assertEquals(sent.messages[0], { role: "system", content: "Be helpful." });
    assertEquals(sent.messages[1], { role: "user", content: "Hello, world!" });
  } finally {
    await mock.close();
  }
});

Deno.test("golden: /v1/messages Anthropic-compat translation round-trip", async () => {
  const mock = new MockProvider(() => jsonResponse(responseFixture));
  try {
    const handler = createHandler(makeContext(providerFor(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4-turbo",
          system: "Be helpful.",
          messages: [{ role: "user", content: "Hello, world!" }],
          max_tokens: 64,
        }),
      }),
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.type, "message");
    assertEquals(body.role, "assistant");
    assertEquals(body.content[0], {
      type: "text",
      text: "Hello! How can I assist you today?",
    });
    assertEquals(body.stop_reason, "end_turn");
    assertEquals(body.usage, { input_tokens: 9, output_tokens: 12 });

    const sent = mock.calls[0].body as {
      messages: Array<{ role: string }>;
      max_tokens: number;
    };
    assertEquals(sent.messages[0].role, "system");
    assertEquals(sent.max_tokens, 64);
    assert(!("fallbacks" in (mock.calls[0].body as Record<string, unknown>)));
  } finally {
    await mock.close();
  }
});
