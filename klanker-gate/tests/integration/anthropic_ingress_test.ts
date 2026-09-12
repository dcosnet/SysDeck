// WP8a: the Anthropic front door. Three things are proven here.
//
// 1. /v1/messages runs the SHARED canonical execution (runChatCompletion), so
//    plugins, the tool loop and the rest of the pipeline apply to the Anthropic
//    surface exactly as they do to /v1/chat/completions.
// 2. Request/response/stream FIDELITY: images, tool_choice, unmapped native
//    fields, thinking blocks, and the streamed input_tokens that used to be
//    hardcoded to 0.
// 3. The dialect front door in compat_families.ts: credential promotion
//    (x-api-key, ?key=), URL hygiene, and native error envelopes.

import { assert, assertEquals, assertFalse } from "@std/assert";
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
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

const MODEL = "openai/gpt-4o";

function makeContext(
  mockUrl: string,
  plugins = new PluginManager(),
): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: mockUrl,
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins,
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

/** POST /v1/messages with an Anthropic-native body. */
function messages(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: MODEL, max_tokens: 64, ...body }),
    ...init,
  });
}

interface CanonicalEgress {
  model: string;
  messages: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

interface AnthropicBody {
  type: string;
  role: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface NamedEvent {
  event?: string;
  data: Record<string, unknown> | "[DONE]";
}

/** readSSE variant that keeps `event:` names alongside the data payloads. */
async function readNamedSSE(response: Response): Promise<NamedEvent[]> {
  const text = await response.text();
  const events: NamedEvent[] = [];
  let event: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      events.push({
        event,
        data: data === "[DONE]"
          ? "[DONE]"
          : JSON.parse(data) as Record<string, unknown>,
      });
      event = undefined;
    }
  }
  return events;
}

/** One canonical chat.completion.chunk SSE frame. */
function chunk(
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return `data: ${
    JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "mock-model",
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })
  }\n\n`;
}

/**
 * Canonical stream carrying reasoning fragments ahead of the answer text and a
 * usage-bearing finish chunk. `prompt_tokens` is the value the Anthropic
 * message_delta must report as `input_tokens`.
 */
function reasoningStreamFrames(promptTokens: number): string[] {
  return [
    chunk({ role: "assistant", reasoning_content: "Let me " }),
    chunk({ reasoning_content: "think." }),
    chunk({ content: "Answer" }),
    `data: ${
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 7,
          total_tokens: promptTokens + 7,
        },
      })
    }\n\n`,
    "data: [DONE]\n\n",
  ];
}

// --------------------------------------------------------- request fidelity

Deno.test("anthropic ingress: base64 image block becomes a canonical data URL part", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      }],
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as CanonicalEgress;
    // The base64 source is rebuilt as a data: URL, byte for byte - this is the
    // exact inverse of the Anthropic adapter's egress mapping.
    assertEquals(sent.messages, [{
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
        },
      ],
    }]);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: url image source reaches egress unchanged", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "url", url: "https://example.test/cat.png" },
        }],
      }],
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as CanonicalEgress;
    // No text block in this turn, so the part array holds the image alone.
    assertEquals(sent.messages, [{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: "https://example.test/cat.png" },
      }],
    }]);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: every tool_choice shape maps to its canonical form", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(makeContext(mock.url));
  const cases: Array<{ anthropic: unknown; canonical: unknown }> = [
    { anthropic: { type: "auto" }, canonical: "auto" },
    { anthropic: { type: "any" }, canonical: "required" },
    { anthropic: { type: "none" }, canonical: "none" },
    {
      anthropic: { type: "tool", name: "get_weather" },
      canonical: { type: "function", function: { name: "get_weather" } },
    },
  ];
  try {
    for (const [i, testCase] of cases.entries()) {
      const res = await handler(messages({
        messages: [{ role: "user", content: "weather?" }],
        tools: [{
          name: "get_weather",
          description: "Current weather",
          input_schema: { type: "object", properties: {} },
        }],
        tool_choice: testCase.anthropic,
      }));
      assertEquals(res.status, 200);
      await res.body?.cancel();
      const sent = mock.calls[i].body as CanonicalEgress;
      assertEquals(
        sent.tool_choice,
        testCase.canonical,
        `tool_choice ${JSON.stringify(testCase.anthropic)}`,
      );
    }
    assertEquals(mock.calls.length, cases.length);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: unmapped native fields ride through to egress", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{ role: "user", content: "hei" }],
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 1024 },
      metadata: { user_id: "u-1" },
      service_tier: "auto",
      // An entirely unknown vendor key: the passthrough schema admits it and
      // the canonical translation must not silently drop it either.
      frosty_unknown_field: "carried",
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as CanonicalEgress;
    assertEquals(sent.top_k, 40);
    assertEquals(sent.thinking, { type: "enabled", budget_tokens: 1024 });
    assertEquals(sent.metadata, { user_id: "u-1" });
    assertEquals(sent.service_tier, "auto");
    assertEquals(sent.frosty_unknown_field, "carried");
    // The mapped fields still map (the passthrough spread must not shadow them).
    assertEquals(sent.model, "gpt-4o");
    assertEquals(sent.max_tokens, 64);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: text-only turns keep plain-string content", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      system: "Vaer presis.",
      messages: [
        { role: "user", content: "hei" },
        { role: "assistant", content: "hallo" },
        // A text-only BLOCK ARRAY must still collapse to a plain string: the
        // image work must not churn the shape of existing text-only traffic.
        { role: "user", content: [{ type: "text", text: "and again" }] },
      ],
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as CanonicalEgress;
    assertEquals(sent.messages, [
      { role: "system", content: "Vaer presis." },
      { role: "user", content: "hei" },
      { role: "assistant", content: "hallo" },
      { role: "user", content: "and again" },
    ]);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: tool_use and tool_result round trip", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("12 degrees"))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: { city: "Oslo" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "12C",
          }],
        },
      ],
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as CanonicalEgress;
    assertEquals(sent.messages, [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "toolu_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: JSON.stringify({ city: "Oslo" }),
          },
        }],
      },
      // A tool_result turn becomes a canonical `tool` message and does NOT
      // also emit an empty user turn.
      { role: "tool", tool_call_id: "toolu_1", content: "12C" },
    ]);
  } finally {
    await mock.close();
  }
});

// -------------------------------------------------------- response fidelity

Deno.test("anthropic ingress: reasoning_content becomes a leading thinking block", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("", {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "The answer is 4.",
          reasoning_content: "Two plus two.",
        },
        finish_reason: "stop",
      }],
    }))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(
      messages({ messages: [{ role: "user", content: "2+2" }] }),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as AnthropicBody;
    // Thinking leads the block list, exactly where extended thinking puts it
    // on the real wire; the text block follows it.
    assertEquals(body.content[0], {
      type: "thinking",
      thinking: "Two plus two.",
    });
    assertEquals(body.content[1], { type: "text", text: "The answer is 4." });
    assertEquals(body.content.length, 2);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: tool_calls become tool_use blocks", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("", {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ city: "Oslo" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(
      messages({ messages: [{ role: "user", content: "weather?" }] }),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as AnthropicBody;
    assertEquals(body.content, [{
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "Oslo" },
    }]);
    assertEquals(body.stop_reason, "tool_use");
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------- stream fidelity

Deno.test("anthropic ingress: stream opens a thinking block before the text block", async () => {
  const mock = new MockProvider(() => sseResponse(reasoningStreamFrames(11)));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{ role: "user", content: "2+2" }],
      stream: true,
    }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    // `stream` must survive anthropicToCanonical or the upstream call is not
    // a streaming one at all.
    assertEquals((mock.calls[0].body as CanonicalEgress).stream, true);

    const events = await readNamedSSE(res);
    assertEquals(events.map((e) => e.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const starts = events.filter((e) => e.event === "content_block_start")
      .map((e) => e.data as { index: number; content_block: { type: string } });
    assertEquals(starts[0].content_block.type, "thinking");
    assertEquals(starts[1].content_block.type, "text");
    // The thinking block is opened FIRST, so its index precedes the text block.
    assert(
      starts[0].index < starts[1].index,
      `thinking index ${starts[0].index} must precede text ${starts[1].index}`,
    );

    const deltas = events.filter((e) => e.event === "content_block_delta")
      .map((
        e,
      ) => (e.data as { index: number; delta: Record<string, unknown> }));
    assertEquals(deltas[0].delta, {
      type: "thinking_delta",
      thinking: "Let me ",
    });
    assertEquals(deltas[1].delta, {
      type: "thinking_delta",
      thinking: "think.",
    });
    assertEquals(deltas[0].index, starts[0].index);
    assertEquals(deltas[2].delta, { type: "text_delta", text: "Answer" });
    assertEquals(deltas[2].index, starts[1].index);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: stream message_delta reports the canonical prompt_tokens", async () => {
  const mock = new MockProvider(() => sseResponse(reasoningStreamFrames(1234)));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{ role: "user", content: "2+2" }],
      stream: true,
    }));
    assertEquals(res.status, 200);
    const events = await readNamedSSE(res);
    const delta = events.find((e) => e.event === "message_delta")!
      .data as { usage: { input_tokens: number; output_tokens: number } };
    // Regression guard: input_tokens was hardcoded to 0 here, which silently
    // under-billed every streamed Anthropic request.
    assertEquals(delta.usage.input_tokens, 1234);
    assertEquals(delta.usage.output_tokens, 7);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: stream ends message_delta then message_stop with no [DONE]", async () => {
  const mock = new MockProvider(() => sseResponse(reasoningStreamFrames(3)));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(messages({
      messages: [{ role: "user", content: "2+2" }],
      stream: true,
    }));
    assertEquals(res.status, 200);
    const events = await readNamedSSE(res);
    assertEquals(events.at(-2)!.event, "message_delta");
    assertEquals(events.at(-1)!.event, "message_stop");
    // The Anthropic surface has no [DONE] sentinel; that is canonical-only.
    assertFalse(events.some((e) => e.data === "[DONE]"));
    const stop = events.at(-2)!.data as { delta: { stop_reason: string } };
    assertEquals(stop.delta.stop_reason, "end_turn");
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------ front door / admission

const VK_TOKEN = "vk-anthropic-frontdoor-token";

/** Context with governance ACTIVE (one enabled virtual key). */
function guardedContext(
  mockUrl: string,
  rateLimit?: { maxRequests: number; windowMs: number },
): AppContext {
  const ctx = makeContext(mockUrl);
  ctx.virtualKeys.upsert({
    id: "vk",
    name: "gate",
    token: VK_TOKEN,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    ...(rateLimit ? { rateLimit } : {}),
  });
  return ctx;
}

Deno.test("anthropic front door: x-api-key admits, no credential is 401", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  const body = { messages: [{ role: "user", content: "hei" }] };
  try {
    // A stock Anthropic SDK cannot send Authorization: Bearer at all.
    const admitted = await handler(
      messages(body, { "x-api-key": VK_TOKEN }),
    );
    assertEquals(admitted.status, 200);
    await admitted.body?.cancel();

    const denied = await handler(messages(body));
    assertEquals(denied.status, 401);
    await denied.body?.cancel();
    // The denied request never reached a provider.
    assertEquals(mock.calls.length, 1);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic front door: an existing bearer is never overridden by x-api-key", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  try {
    const res = await handler(messages(
      { messages: [{ role: "user", content: "hei" }] },
      {
        "Authorization": `Bearer ${VK_TOKEN}`,
        // Garbage that WOULD 401 if promotion clobbered the bearer.
        "x-api-key": "vk-garbage-not-a-real-key",
      },
    ));
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic front door: a governance 401 uses the Anthropic error envelope", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  try {
    const res = await handler(
      messages({ messages: [{ role: "user", content: "hei" }] }),
    );
    assertEquals(res.status, 401);
    const body = await res.json() as {
      type: string;
      error: { type: string; message: string };
    };
    // The Anthropic SDK parses THIS shape, not the canonical
    // {error:{message,type,param,code}} envelope.
    assertEquals(body.type, "error");
    assertEquals(body.error.type, "authentication_error");
    assert(body.error.message.length > 0);
    // Reshaping must carry the response headers over intact.
    assert(res.headers.get("x-request-id"));
    assertEquals(res.headers.get("Content-Type"), "application/json");
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic front door: a reshaped 429 keeps Retry-After", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(
    guardedContext(mock.url, { maxRequests: 1, windowMs: 60_000 }),
  );
  const body = { messages: [{ role: "user", content: "hei" }] };
  try {
    const first = await handler(messages(body, { "x-api-key": VK_TOKEN }));
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const limited = await handler(messages(body, { "x-api-key": VK_TOKEN }));
    assertEquals(limited.status, 429);
    // Retry-After survives the envelope rewrite - a client that loses it has
    // no way to back off correctly.
    const retryAfter = limited.headers.get("Retry-After");
    assert(retryAfter, "Retry-After was dropped by the dialect reshape");
    assert(Number(retryAfter) >= 1, `Retry-After ${retryAfter} must be >= 1`);
    assert(limited.headers.get("x-request-id"));

    const envelope = await limited.json() as {
      type: string;
      error: { type: string };
    };
    assertEquals(envelope.type, "error");
    assertEquals(envelope.error.type, "rate_limit_error");
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------- URL hygiene

/**
 * Captures the access log the request logger writes. It prints the FULL URL
 * after the front-door rewrite, which is the only place the rewritten URL is
 * observable - and is exactly the sink `?key=` stripping exists to protect.
 */
async function withAccessLog(
  run: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines
    .filter((line) => /^\[[0-9a-f-]{36}\] POST http/.test(line))
    .map((line) => line.split(" ").at(-1)!);
}

function genaiPath(query: string): string {
  return `http://gateway.test/genai/v1beta/models/${
    encodeURIComponent(MODEL)
  }:generateContent${query}`;
}

function genaiPost(
  query: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(genaiPath(query), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hei" }] }],
    }),
  });
}

Deno.test("genai front door: a CR/LF ?key= is treated as no credential (401, not 500)", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  try {
    // A header can never carry CR/LF (Headers rejects it client-side), but the
    // query-parameter credential can - and it lands straight on Headers.set.
    const res = await handler(genaiPost("?key=a%0D%0Ab"));
    assertEquals(res.status, 401);
    const body = await res.json() as {
      error: { code: number; status: string; message: string };
    };
    assertEquals(body.error.code, 401);
    assertEquals(body.error.status, "UNAUTHENTICATED");
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

Deno.test("genai front door: ?key= authenticates and never reaches the access log", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  try {
    let status = 0;
    const urls = await withAccessLog(async () => {
      const res = await handler(genaiPost(`?key=${VK_TOKEN}`));
      status = res.status;
      await res.body?.cancel();
    });
    assertEquals(status, 200);
    assertEquals(urls.length, 1);
    // Promoted to a bearer, then scrubbed off the URL before anything logs it.
    assertFalse(urls[0].includes("key="), urls[0]);
    assertFalse(urls[0].includes(VK_TOKEN), urls[0]);
  } finally {
    await mock.close();
  }
});

Deno.test("genai front door: a query string without key= is not re-serialized", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const handler = createHandler(guardedContext(mock.url));
  try {
    let status = 0;
    const urls = await withAccessLog(async () => {
      const res = await handler(
        genaiPost("?alt=sse&flag", { "x-goog-api-key": VK_TOKEN }),
      );
      status = res.status;
      await res.body?.cancel();
    });
    assertEquals(status, 200);
    // Byte-identical: a valueless `flag` must NOT come back as `flag=`, which
    // is what URLSearchParams re-serialization would do to it.
    assertEquals(urls[0], genaiPath("?alt=sse&flag"));
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- shared execution (WP1)

Deno.test("anthropic ingress: plugin pre and post hooks run on /v1/messages", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("upstream")));
  const seen: string[] = [];
  const plugins = new PluginManager();
  plugins.register({
    name: "anthropic-shared-path",
    onPreRequest: (req) => {
      seen.push("pre");
      return Promise.resolve({ ...req, temperature: 0.5 });
    },
    onPostRequest: (res) => {
      seen.push("post");
      return Promise.resolve({
        ...res,
        choices: [{
          ...res.choices[0],
          message: { role: "assistant", content: "plugin-rewritten" },
        }],
      });
    },
  });
  const handler = createHandler(makeContext(mock.url, plugins));
  try {
    const res = await handler(
      messages({ messages: [{ role: "user", content: "hei" }] }),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as AnthropicBody;

    // Both halves of the shared canonical execution are observable from the
    // Anthropic surface: the pre-hook edit reached provider egress, and the
    // post-hook edit reached the translated Anthropic response.
    assertEquals(seen, ["pre", "post"]);
    assertEquals((mock.calls[0].body as CanonicalEgress).temperature, 0.5);
    assertEquals(body.content, [{ type: "text", text: "plugin-rewritten" }]);
  } finally {
    await mock.close();
  }
});

Deno.test("anthropic ingress: a client abort mid-stream tears down the upstream", async () => {
  let cancelled = false;
  let resolveCancel: () => void = () => {};
  const upstreamCancelled = new Promise<void>((resolve) => {
    resolveCancel = resolve;
  });
  const mock = new MockProvider(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One frame, then the upstream holds the connection open forever.
        controller.enqueue(
          new TextEncoder().encode(chunk({ role: "assistant", content: "a" })),
        );
      },
      cancel() {
        cancelled = true;
        resolveCancel();
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const handler = createHandler(makeContext(mock.url));
  const aborter = new AbortController();
  try {
    const res = await handler(messages(
      { messages: [{ role: "user", content: "hei" }], stream: true },
      {},
      { signal: aborter.signal },
    ));
    assertEquals(res.status, 200);
    // Nothing has torn the upstream down yet; only the abort below may.
    assertFalse(cancelled);

    aborter.abort();
    // The front door rebuilds the Request for every /v1/messages call. A naive
    // rebuild mints a FRESH signal, and this await would then hang forever.
    await upstreamCancelled;
    assert(cancelled);
    await res.body?.cancel().catch(() => {});
  } finally {
    await mock.close();
  }
});
