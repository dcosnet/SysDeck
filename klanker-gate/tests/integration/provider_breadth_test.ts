// Wave-3 provider breadth: OpenAI-wire vendors through the shared adapter,
// native cohere/bedrock/vertex/elevenlabs adapters, and /v1/count_tokens.

import { assert, assertEquals } from "@std/assert";
import {
  BedrockAdapter,
  CohereAdapter,
  ElevenLabsAdapter,
  OPENAI_COMPAT_BASE_URLS,
  ProviderManager,
  VertexAdapter,
} from "../../packages/providers/src/mod.ts";
import type { ProviderAccountConfig } from "../../packages/contracts/src/mod.ts";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
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

Deno.test("openai-compat vendors dispatch through the OpenAI wire", async (t) => {
  const types: ProviderAccountConfig["type"][] = [
    "groq",
    "mistral",
    "ollama",
    "xai",
    "perplexity",
    "cerebras",
    "nebius",
    "sgl",
    "parasail",
    "huggingface",
  ];
  // Every compat vendor has a default base URL registered.
  for (const type of types) {
    assert(OPENAI_COMPAT_BASE_URLS[type], `missing default baseUrl: ${type}`);
  }

  const mock = new MockProvider(() => jsonResponse(openAIChatBody("pong")));
  try {
    for (const type of types) {
      await t.step(type, async () => {
        const manager = new ProviderManager([{
          id: type,
          type,
          apiKey: `key-${type}`,
          baseUrl: mock.url,
          enabled: true,
          models: ["m1"],
          priority: 0,
          retry: { maxRetries: 0 },
        }]);
        const target = manager.resolve(`${type}/m1`);
        const res = await target.adapter.chatCompletions({
          model: target.model,
          messages: [{ role: "user", content: "ping" }],
        });
        const body = await res.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        assertEquals(body.choices[0].message.content, "pong");
        const call = mock.calls.at(-1)!;
        assertEquals(call.path, "/chat/completions");
        assertEquals(
          call.headers.get("Authorization"),
          `Bearer key-${type}`,
        );
      });
    }
  } finally {
    await mock.close();
  }
});

Deno.test("cohere: v2/chat translation both directions", async () => {
  const mock = new MockProvider(() =>
    jsonResponse({
      id: "ch_1",
      message: { content: [{ type: "text", text: "Hei fra Cohere" }] },
      finish_reason: "COMPLETE",
      usage: { billed_units: { input_tokens: 7, output_tokens: 3 } },
    })
  );
  try {
    const adapter = new CohereAdapter("co-key", mock.url);
    const res = await adapter.chatCompletions({
      model: "command-r-plus",
      messages: [
        { role: "system", content: "Vær hyggelig." },
        { role: "user", content: "Hei" },
      ],
      max_tokens: 100,
      top_p: 0.9,
    });
    const chat = await res.json() as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    assertEquals(chat.object, "chat.completion");
    assertEquals(chat.choices[0].message.content, "Hei fra Cohere");
    assertEquals(chat.choices[0].finish_reason, "stop");
    assertEquals(chat.usage.prompt_tokens, 7);

    const sent = mock.calls[0].body as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      p: number;
    };
    assertEquals(mock.calls[0].path, "/v2/chat");
    assertEquals(sent.messages[0], {
      role: "system",
      content: "Vær hyggelig.",
    });
    assertEquals(sent.max_tokens, 100);
    assertEquals(sent.p, 0.9);
    assertEquals(mock.calls[0].headers.get("Authorization"), "Bearer co-key");
  } finally {
    await mock.close();
  }
});

Deno.test("cohere: stream events normalize to canonical chunks", async () => {
  const frames = [
    `data: ${JSON.stringify({ type: "message-start" })}\n\n`,
    `data: ${
      JSON.stringify({
        type: "content-delta",
        delta: { message: { content: { text: "Str" } } },
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: "content-delta",
        delta: { message: { content: { text: "øm" } } },
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: "message-end",
        delta: {
          finish_reason: "COMPLETE",
          usage: { billed_units: { input_tokens: 2, output_tokens: 5 } },
        },
      })
    }\n\n`,
  ];
  const mock = new MockProvider(() => sseResponse(frames));
  try {
    const adapter = new CohereAdapter("co-key", mock.url);
    const res = await adapter.chatCompletions({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hei" }],
      stream: true,
    });
    const events = await readSSE(res);
    assertEquals(events.at(-1), "[DONE]");
    const chunks = events.slice(0, -1) as Array<{
      choices: Array<{
        delta: { content?: string };
        finish_reason: string | null;
      }>;
      usage?: { completion_tokens: number };
    }>;
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    assertEquals(text, "Strøm");
    assertEquals(chunks.at(-1)!.choices[0].finish_reason, "stop");
    assertEquals(chunks.at(-1)!.usage?.completion_tokens, 5);
  } finally {
    await mock.close();
  }
});

Deno.test("bedrock: signed converse call translates to canonical chat", async () => {
  const mock = new MockProvider(() =>
    jsonResponse({
      output: { message: { content: [{ text: "Fra Bedrock" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    })
  );
  try {
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      accessKeyId: "AKIDTEST",
      secretAccessKey: "secret",
      endpoint: mock.url,
    });
    const res = await adapter.chatCompletions({
      model: "anthropic.claude-3-haiku",
      messages: [
        { role: "system", content: "Kort." },
        { role: "user", content: "Hei" },
      ],
      max_tokens: 64,
    });
    const chat = await res.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    assertEquals(chat.choices[0].message.content, "Fra Bedrock");
    assertEquals(chat.choices[0].finish_reason, "stop");
    assertEquals(chat.usage.total_tokens, 15);

    const call = mock.calls[0];
    assertEquals(call.path, "/model/anthropic.claude-3-haiku/converse");
    const auth = call.headers.get("Authorization") ?? "";
    assert(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=.*host.*x-amz-date.*, Signature=[0-9a-f]{64}$/
        .test(auth),
      `unexpected Authorization shape: ${auth}`,
    );
    const sent = call.body as {
      system: Array<{ text: string }>;
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
      inferenceConfig: { maxTokens: number };
    };
    assertEquals(sent.system[0].text, "Kort.");
    assertEquals(sent.messages[0].content[0].text, "Hei");
    assertEquals(sent.inferenceConfig.maxTokens, 64);
  } finally {
    await mock.close();
  }
});

async function pemPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

Deno.test("vertex: SA-JWT token exchange + OpenAI-compat dispatch + cache", async () => {
  let tokenCalls = 0;
  const tokenServer = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      tokenCalls++;
      const form = new URLSearchParams(await req.text());
      assertEquals(
        form.get("grant_type"),
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      // A structurally valid JWS: three base64url segments.
      assertEquals(form.get("assertion")!.split(".").length, 3);
      return Response.json({ access_token: "tok-vertex", expires_in: 3600 });
    },
  );
  const tokenUrl = `http://127.0.0.1:${
    (tokenServer.addr as Deno.NetAddr).port
  }/token`;

  const mock = new MockProvider(() => jsonResponse(openAIChatBody("vertex!")));
  try {
    const adapter = new VertexAdapter({
      projectId: "proj-1",
      location: "europe-west1",
      serviceAccountJson: JSON.stringify({
        client_email: "svc@proj-1.iam.gserviceaccount.com",
        private_key: await pemPrivateKey(),
      }),
      baseUrl: mock.url,
      tokenUrl,
    });
    for (let i = 0; i < 2; i++) {
      const res = await adapter.chatCompletions({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hei" }],
      });
      await res.body?.cancel();
    }
    assertEquals(tokenCalls, 1); // token cached across calls
    const call = mock.calls[0];
    assertEquals(
      call.path,
      "/v1/projects/proj-1/locations/europe-west1/endpoints/openapi/chat/completions",
    );
    assertEquals(call.headers.get("Authorization"), "Bearer tok-vertex");
    assertEquals(
      (call.body as { model: string }).model,
      "google/gemini-2.5-pro",
    );
  } finally {
    await mock.close();
    await tokenServer.shutdown();
  }
});

Deno.test("elevenlabs: OpenAI speech body translates to the EL wire", async () => {
  const mock = new MockProvider(() =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "audio/mpeg" },
    })
  );
  try {
    const adapter = new ElevenLabsAdapter("el-key", mock.url);
    const res = await adapter.rawProxy(
      "/audio/speech",
      new Request("http://internal/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "eleven_multilingual_v2",
          input: "Hei verden",
          voice: "Rachel",
        }),
      }),
    );
    assertEquals(res.headers.get("Content-Type"), "audio/mpeg");
    await res.body?.cancel();
    const call = mock.calls[0];
    assertEquals(call.path, "/v1/text-to-speech/Rachel");
    assertEquals(call.headers.get("xi-api-key"), "el-key");
    assertEquals(call.body, {
      text: "Hei verden",
      model_id: "eleven_multilingual_v2",
    });
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/count_tokens: native where the provider offers it, estimate otherwise", async () => {
  const anthMock = new MockProvider((call) => {
    if (call.path === "/messages/count_tokens") {
      return jsonResponse({ input_tokens: 42 });
    }
    return jsonResponse({}, 404);
  });
  // Real OpenAI counts natively via /responses/input_tokens.
  const openaiMock = new MockProvider((call) => {
    if (call.path === "/responses/input_tokens") {
      return jsonResponse({ input_tokens: 5 });
    }
    return jsonResponse({}, 404);
  });
  try {
    const providers = new ProviderManager([
      {
        id: "anthropic",
        type: "anthropic",
        apiKey: "a-key",
        baseUrl: anthMock.url,
        enabled: true,
        models: ["claude-x"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "openai",
        type: "openai",
        apiKey: "o-key",
        baseUrl: openaiMock.url,
        enabled: true,
        models: ["gpt-x"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        // groq reuses the shared OpenAI adapter but has no native counter,
        // so it keeps the documented chars/4 estimate (no upstream call).
        id: "groq",
        type: "groq",
        apiKey: "g-key",
        enabled: true,
        models: ["mixtral"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
    ]);
    const handler = createHandler(makeContext(providers));

    const countTokens = (model: string, content: string) =>
      handler(
        new Request("http://gateway.test/v1/count_tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content }],
          }),
        }),
      );

    // Anthropic: native /messages/count_tokens.
    const anthropic = await countTokens("anthropic/claude-x", "tell noe");
    assertEquals(await anthropic.json(), {
      input_tokens: 42,
      estimated: false,
    });

    // OpenAI: native /responses/input_tokens.
    const openai = await countTokens("openai/gpt-x", "tell noe");
    assertEquals(await openai.json(), { input_tokens: 5, estimated: false });

    // Groq: no native surface -> chars/4 estimate (8 chars -> 2 tokens).
    const estimated = await countTokens("groq/mixtral", "abcdefgh");
    assertEquals(await estimated.json(), { input_tokens: 2, estimated: true });
  } finally {
    await anthMock.close();
    await openaiMock.close();
  }
});
