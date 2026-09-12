// Wave-3 compat route families: alias prefixes must be byte-identical to the
// canonical routes (and equally governed); GenAI and Cohere surfaces
// translate both directions.

import { assertEquals } from "@std/assert";
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
  readSSE,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

function makeContext(mockUrl: string): AppContext {
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
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

const chatBody = JSON.stringify({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "hei" }],
});

function post(path: string, body: string, token?: string): Request {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    },
    body,
  });
}

Deno.test("alias prefixes are byte-identical to the canonical routes", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("aliased")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const canonical = await (await handler(
      post("/v1/chat/completions", chatBody),
    )).text();
    for (const prefix of ["/openai", "/litellm", "/langchain", "/pydanticai"]) {
      const aliased = await (await handler(
        post(`${prefix}/v1/chat/completions`, chatBody),
      )).text();
      assertEquals(aliased, canonical, `${prefix} diverged from canonical`);
    }

    // Anthropic SDK base URL: /anthropic/v1/messages hits the compat route.
    const messages = await handler(post(
      "/anthropic/v1/messages",
      JSON.stringify({
        model: "openai/gpt-4o",
        max_tokens: 32,
        messages: [{ role: "user", content: "hei" }],
      }),
    ));
    assertEquals(messages.status, 200);
    const anthropic = await messages.json() as { type: string; role: string };
    assertEquals(anthropic.type, "message");
    assertEquals(anthropic.role, "assistant");
  } finally {
    await mock.close();
  }
});

Deno.test("alias prefixes are governed exactly like /v1", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("x")));
  const ctx = makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk",
    name: "gate",
    token: "vk-compat-gate-token",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  try {
    const denied = await handler(post("/openai/v1/chat/completions", chatBody));
    assertEquals(denied.status, 401);
    await denied.body?.cancel();
    const allowed = await handler(
      post("/openai/v1/chat/completions", chatBody, "vk-compat-gate-token"),
    );
    assertEquals(allowed.status, 200);
    await allowed.body?.cancel();
  } finally {
    await mock.close();
  }
});

Deno.test("genai compat: generateContent translates both directions", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("Hei fra GenAI", {
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(
      `/genai/v1beta/models/${
        encodeURIComponent("openai/gpt-4o")
      }:generateContent`,
      JSON.stringify({
        systemInstruction: { parts: [{ text: "Vær presis." }] },
        contents: [
          { role: "user", parts: [{ text: "Hei" }, { text: " der" }] },
        ],
        generationConfig: { temperature: 0.3, maxOutputTokens: 99 },
      }),
    ));
    assertEquals(res.status, 200);
    const body = await res.json() as {
      candidates: Array<{
        content: { role: string; parts: Array<{ text: string }> };
        finishReason: string;
      }>;
      usageMetadata: { totalTokenCount: number };
    };
    assertEquals(body.candidates[0].content.parts[0].text, "Hei fra GenAI");
    assertEquals(body.candidates[0].finishReason, "STOP");
    assertEquals(body.usageMetadata.totalTokenCount, 12);

    const sent = mock.calls[0].body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      temperature: number;
    };
    assertEquals(sent.model, "gpt-4o");
    assertEquals(sent.messages[0], { role: "system", content: "Vær presis." });
    assertEquals(sent.messages[1], { role: "user", content: "Hei der" });
    assertEquals(sent.max_tokens, 99);
  } finally {
    await mock.close();
  }
});

Deno.test("cohere compat: v2/chat translates both directions", async () => {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("Hei fra Cohere-compat", {
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(
      "/cohere/v2/chat",
      JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Hei" }],
        max_tokens: 50,
        p: 0.8,
      }),
    ));
    assertEquals(res.status, 200);
    const body = await res.json() as {
      message: { content: Array<{ type: string; text: string }> };
      finish_reason: string;
      usage: { billed_units: { output_tokens: number } };
    };
    assertEquals(body.message.content[0].text, "Hei fra Cohere-compat");
    assertEquals(body.finish_reason, "COMPLETE");
    assertEquals(body.usage.billed_units.output_tokens, 4);

    const sent = mock.calls[0].body as { top_p: number };
    assertEquals(sent.top_p, 0.8);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- streaming translation

/** Canonical chat.completion.chunk frames with a usage-bearing finish chunk. */
function canonicalStreamFrames(
  texts: string[],
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
): string[] {
  const frames = texts.map((text, i) =>
    `data: ${
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "mock-model",
        choices: [{
          index: 0,
          delta: i === 0
            ? { role: "assistant", content: text }
            : { content: text },
          finish_reason: null,
        }],
      })
    }\n\n`
  );
  frames.push(
    `data: ${
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      })
    }\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

function streamAwareMock(frames: string[], jsonText: string): MockProvider {
  return new MockProvider((call) =>
    (call.body as { stream?: boolean }).stream
      ? sseResponse(frames)
      : jsonResponse(openAIChatBody(jsonText))
  );
}

interface GenAIChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string }> };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

Deno.test("genai compat: streamGenerateContent emits GenAI SSE chunks", async () => {
  const mock = streamAwareMock(
    canonicalStreamFrames(["Hei", " fra", " GenAI"], {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    }),
    "unused",
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(
      `/genai/v1beta/models/${
        encodeURIComponent("openai/gpt-4o")
      }:streamGenerateContent`,
      JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hei" }] }],
      }),
    ));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    // The upstream received a streaming request.
    assertEquals((mock.calls[0].body as { stream?: boolean }).stream, true);

    const raw = await readSSE(res);
    // GenAI's SSE surface has no [DONE] sentinel.
    assertEquals(raw.some((e) => e === "[DONE]"), false);
    const events = raw as unknown as GenAIChunk[];
    const text = events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    assertEquals(text, "Hei fra GenAI");
    const last = events.at(-1)!;
    assertEquals(last.candidates?.[0].finishReason, "STOP");
    assertEquals(last.candidates?.[0].content?.role, "model");
    assertEquals(last.usageMetadata?.totalTokenCount, 12);
    assertEquals(last.usageMetadata?.candidatesTokenCount, 7);
  } finally {
    await mock.close();
  }
});

interface CohereEvent {
  type: string;
  delta?: {
    message?: {
      role?: string;
      content?: { type?: string; text?: string };
      tool_calls?: { function?: { arguments?: string } };
    };
    finish_reason?: string;
    usage?: {
      billed_units?: { input_tokens?: number; output_tokens?: number };
    };
  };
}

Deno.test("cohere compat: v2/chat stream emits Cohere events", async () => {
  const mock = streamAwareMock(
    canonicalStreamFrames(["Hei", " fra", " Cohere"], {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    }),
    "unused",
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(
      "/cohere/v2/chat",
      JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Hei" }],
        stream: true,
      }),
    ));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    assertEquals((mock.calls[0].body as { stream?: boolean }).stream, true);

    const raw = await readSSE(res);
    assertEquals(raw.some((e) => e === "[DONE]"), false);
    const events = raw as unknown as CohereEvent[];
    assertEquals(events[0].type, "message-start");
    const text = events
      .filter((e) => e.type === "content-delta")
      .map((e) => e.delta?.message?.content?.text ?? "")
      .join("");
    assertEquals(text, "Hei fra Cohere");
    const end = events.at(-1)!;
    assertEquals(end.type, "message-end");
    assertEquals(end.delta?.finish_reason, "COMPLETE");
    assertEquals(end.delta?.usage?.billed_units?.input_tokens, 3);
    assertEquals(end.delta?.usage?.billed_units?.output_tokens, 4);
  } finally {
    await mock.close();
  }
});

// --------------------------------------------- aggregator ingress broadening

Deno.test("aggregator prefixes accept GenAI + Cohere native shapes", async () => {
  const mock = streamAwareMock(
    canonicalStreamFrames(["ag"], {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    }),
    "agg",
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    for (const prefix of ["/litellm", "/langchain", "/pydanticai"]) {
      // GenAI native shape under the aggregator prefix (was 404 pre-broadening).
      const genai = await handler(post(
        `${prefix}/genai/v1beta/models/${
          encodeURIComponent("openai/gpt-4o")
        }:generateContent`,
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "x" }] }],
        }),
      ));
      assertEquals(genai.status, 200, `${prefix} genai`);
      const g = await genai.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      assertEquals(g.candidates[0].content.parts[0].text, "agg");

      // Cohere native shape under the aggregator prefix.
      const cohere = await handler(post(
        `${prefix}/cohere/v2/chat`,
        JSON.stringify({
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "x" }],
        }),
      ));
      assertEquals(cohere.status, 200, `${prefix} cohere`);
      const c = await cohere.json() as {
        message: { content: Array<{ text: string }> };
      };
      assertEquals(c.message.content[0].text, "agg");
    }

    // Streaming also works under an aggregator prefix (GenAI SSE).
    const stream = await handler(post(
      `/litellm/genai/v1beta/models/${
        encodeURIComponent("openai/gpt-4o")
      }:streamGenerateContent`,
      JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }),
    ));
    assertEquals(stream.status, 200);
    assertEquals(stream.headers.get("Content-Type"), "text/event-stream");
    await stream.body?.cancel();

    // Every upstream call landed on the OpenAI /chat/completions surface.
    assertEquals(
      mock.calls.every((call) => call.path === "/chat/completions"),
      true,
    );
  } finally {
    await mock.close();
  }
});

Deno.test("aggregator prefixes answer Bedrock shapes with a documented 501", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("x")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const paths = [
      "/litellm/bedrock/model/anthropic.claude-3/converse",
      "/litellm/bedrock/model/anthropic.claude-3/converse-stream",
      "/litellm/model/anthropic.claude-3/converse",
      "/langchain/bedrock/model/x/converse",
      "/pydanticai/model/x/converse-stream",
    ];
    for (const path of paths) {
      const res = await handler(post(path, JSON.stringify({ messages: [] })));
      assertEquals(res.status, 501, path);
      const body = await res.json() as {
        error: { type: string; message: string };
      };
      assertEquals(body.error.type, "not_implemented");
      // The 501 is self-documenting: it names Bedrock (not a silent 404).
      assertEquals(body.error.message.includes("Bedrock"), true, path);
    }
    // No Bedrock-shaped request was dispatched to a provider.
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});
