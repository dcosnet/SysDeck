// Advanced API families through the real handler: embeddings, images,
// speech, transcription, files, batches — with capability enforcement.

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
import { jsonResponse, MockProvider } from "../../packages/testing/src/mod.ts";
import {
  ImageGenerationRequestSchema,
  MAX_TTS_INPUT_CHARS,
} from "../../packages/contracts/src/mod.ts";

const base = "http://gateway.test";

// A real RSA private key so VertexAdapter.getToken() can sign the SA JWT
// offline; token_uri points at the in-process mock's /token route.
async function serviceAccountJson(tokenUri: string): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", kp.privateKey),
  );
  let binary = "";
  for (const b of pkcs8) {
    binary += String.fromCharCode(b);
  }
  const b64 = btoa(binary).match(/.{1,64}/g)!.join("\n");
  const pem =
    `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    client_email: "svc@test.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: tokenUri,
  });
}

function makeContext(mockUrl: string, vertexSaJson: string): AppContext {
  return {
    providers: new ProviderManager([
      {
        id: "openai",
        type: "openai",
        apiKey: "sk-adv",
        baseUrl: mockUrl,
        enabled: true,
        models: ["gpt-4o"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "anthropic",
        type: "anthropic",
        apiKey: "sk-ant",
        baseUrl: mockUrl,
        enabled: true,
        models: ["claude-x"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        // Gemini Imagen via the native generativelanguage :predict surface.
        id: "gemini",
        type: "gemini",
        apiKey: "g-key",
        baseUrl: `${mockUrl}/v1beta/openai`,
        enabled: true,
        models: ["imagen-3.0-generate-002"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        // Vertex Imagen via the publishers/google :predict surface (OAuth).
        id: "vertex",
        type: "vertex",
        baseUrl: mockUrl,
        projectId: "proj",
        location: "us-central1",
        serviceAccountJson: vertexSaJson,
        enabled: true,
        models: ["imagen-3.0-generate-002"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
    ], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

Deno.test("advanced APIs: embeddings, images, speech, files, batches", async (t) => {
  const mock = new MockProvider((call) => {
    // Vertex OAuth token exchange (SA JWT -> access token).
    if (call.path === "/token") {
      return jsonResponse({ access_token: "vertex-token", expires_in: 3600 });
    }
    // Google Imagen :predict, shared by the gemini (native generativelanguage)
    // and vertex (publishers/google) surfaces; both return base64 image bytes.
    if (call.path.endsWith(":predict")) {
      return jsonResponse({
        predictions: [
          { bytesBase64Encoded: "aW1hZ2VieXRlcw==", mimeType: "image/png" },
        ],
      });
    }
    switch (call.path) {
      case "/embeddings":
        return jsonResponse({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      case "/images/generations":
        return jsonResponse({
          created: 1,
          data: [{ url: "https://img.example/1.png" }],
        });
      case "/audio/speech":
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      case "/audio/transcriptions":
        return jsonResponse({ text: "transcribed words" });
      case "/files":
        return jsonResponse({
          id: "file-1",
          object: "file",
          bytes: 10,
          created_at: 1,
          filename: "data.jsonl",
          purpose: "batch",
        });
      case "/batches":
        return jsonResponse({
          id: "batch-1",
          object: "batch",
          input_file_id: "file-1",
          endpoint: "/v1/chat/completions",
          status: "validating",
        });
      default:
        return jsonResponse({ error: `unexpected path ${call.path}` }, 500);
    }
  });
  const handler = createHandler(
    makeContext(mock.url, await serviceAccountJson(`${mock.url}/token`)),
  );

  try {
    await t.step("embeddings dispatch with model prefix stripped", async () => {
      const res = await handler(
        new Request(`${base}/v1/embeddings`, {
          method: "POST",
          body: JSON.stringify({
            model: "openai/text-embedding-3-small",
            input: "hello",
          }),
        }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data[0].embedding, [0.1, 0.2]);
      const sent = mock.calls.at(-1)!;
      assertEquals(sent.path, "/embeddings");
      assertEquals(
        (sent.body as { model: string }).model,
        "text-embedding-3-small",
      );
      assertEquals(sent.headers.get("Authorization"), "Bearer sk-adv");
    });

    await t.step(
      "embeddings rejected for providers without support",
      async () => {
        const res = await handler(
          new Request(`${base}/v1/embeddings`, {
            method: "POST",
            body: JSON.stringify({ model: "anthropic/claude-x", input: "x" }),
          }),
        );
        assertEquals(res.status, 400);
        assert(
          (await res.json()).error.message.includes("does not support"),
        );
      },
    );

    await t.step("image generation (OpenAI rawProxy passthrough)", async () => {
      const res = await handler(
        new Request(`${base}/v1/images/generations`, {
          method: "POST",
          body: JSON.stringify({
            model: "openai/gpt-image-1",
            prompt: "a frosty fjord",
            // The five vendor fields the request schema stripped before it
            // became .passthrough(). Asserted at the WIRE below, not at the
            // schema: a parse-level assertion passes while the widening is
            // still being dropped somewhere between parse and egress.
            quality: "high",
            style: "vivid",
            background: "transparent",
            output_format: "webp",
            moderation: "low",
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(
        (await res.json()).data[0].url,
        "https://img.example/1.png",
      );
      // Byte-identical passthrough: forwarded to the OpenAI /images surface.
      const sentImage = mock.calls.at(-1)!;
      assertEquals(sentImage.path, "/images/generations");
      assertEquals(sentImage.body, {
        model: "gpt-image-1",
        prompt: "a frosty fjord",
        quality: "high",
        style: "vivid",
        background: "transparent",
        output_format: "webp",
        moderation: "low",
      });
    });

    // D1-T28, envelope half: the bound has to surface as the canonical 400
    // naming the offending field, and it has to refuse BEFORE the provider is
    // reached - an over-n request that still dispatches has bought the memory
    // the bound exists to deny.
    await t.step("D1-T28: over-bound n and sampleCount are 400", async () => {
      for (const field of ["n", "sampleCount"]) {
        const before = mock.calls.length;
        const res = await handler(
          new Request(`${base}/v1/images/generations`, {
            method: "POST",
            body: JSON.stringify({
              model: "openai/gpt-image-1",
              prompt: "a frosty fjord",
              [field]: 50,
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.type, "invalid_request_error");
        assertEquals(body.error.param, field);
        assert(body.error.message.includes(field));
        assertEquals(mock.calls.length, before);
      }
    });

    await t.step(
      "D1-T28: n = 10 is admitted, n = 0 / -1 / 2.5 are not",
      async () => {
        const ok = await handler(
          new Request(`${base}/v1/images/generations`, {
            method: "POST",
            body: JSON.stringify({
              model: "openai/gpt-image-1",
              prompt: "a frosty fjord",
              n: 10,
            }),
          }),
        );
        assertEquals(ok.status, 200);
        await ok.body?.cancel();

        for (const value of [0, -1, 2.5]) {
          const res = await handler(
            new Request(`${base}/v1/images/generations`, {
              method: "POST",
              body: JSON.stringify({
                model: "openai/gpt-image-1",
                prompt: "a frosty fjord",
                n: value,
              }),
            }),
          );
          assertEquals(res.status, 400, `n = ${value} must be refused`);
          assertEquals((await res.json()).error.param, "n");
        }
      },
    );

    // D1-T28's companion on the TTS surface: the same envelope, from the same
    // class of gateway-set quantity ceiling.
    await t.step("speech input over MAX_TTS_INPUT_CHARS is 400", async () => {
      const before = mock.calls.length;
      const res = await handler(
        new Request(`${base}/v1/audio/speech`, {
          method: "POST",
          body: JSON.stringify({
            model: "openai/tts-1",
            input: "a".repeat(MAX_TTS_INPUT_CHARS + 1),
            voice: "alloy",
          }),
        }),
      );
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error.type, "invalid_request_error");
      assertEquals(body.error.param, "input");
      assertEquals(mock.calls.length, before);
    });

    await t.step("image generation (Gemini Imagen :predict)", async () => {
      const res = await handler(
        new Request(`${base}/v1/images/generations`, {
          method: "POST",
          body: JSON.stringify({
            model: "gemini/imagen-3.0-generate-002",
            prompt: "a frosty fjord",
          }),
        }),
      );
      assertEquals(res.status, 200);
      // Imagen returns base64 bytes -> mapped to b64_json (no hosted URL).
      assertEquals((await res.json()).data[0].b64_json, "aW1hZ2VieXRlcw==");
      assertEquals(
        mock.calls.at(-1)!.path,
        "/v1beta/models/imagen-3.0-generate-002:predict",
      );
    });

    await t.step("image generation (Vertex Imagen :predict)", async () => {
      const res = await handler(
        new Request(`${base}/v1/images/generations`, {
          method: "POST",
          body: JSON.stringify({
            model: "vertex/imagen-3.0-generate-002",
            prompt: "a frosty fjord",
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).data[0].b64_json, "aW1hZ2VieXRlcw==");
      assertEquals(
        mock.calls.at(-1)!.path,
        "/v1/projects/proj/locations/us-central1" +
          "/publishers/google/models/imagen-3.0-generate-002:predict",
      );
    });

    await t.step("speech returns binary audio", async () => {
      const res = await handler(
        new Request(`${base}/v1/audio/speech`, {
          method: "POST",
          body: JSON.stringify({
            model: "openai/tts-1",
            input: "hello",
            voice: "alloy",
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), "audio/mpeg");
      assertEquals((await res.arrayBuffer()).byteLength, 3);
    });

    await t.step("transcription multipart passthrough", async () => {
      const form = new FormData();
      form.set("model", "whisper-1");
      form.set("file", new Blob([new Uint8Array(4)]), "audio.mp3");
      const res = await handler(
        new Request(`${base}/v1/audio/transcriptions?provider=openai`, {
          method: "POST",
          body: form,
        }),
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).text, "transcribed words");
      const sent = mock.calls.at(-1)!;
      assert(sent.headers.get("Content-Type")?.includes("multipart/form-data"));
    });

    await t.step("file upload and batch creation", async () => {
      const form = new FormData();
      form.set("purpose", "batch");
      form.set("file", new Blob([new Uint8Array(4)]), "data.jsonl");
      const upload = await handler(
        new Request(`${base}/v1/files?provider=openai`, {
          method: "POST",
          body: form,
        }),
      );
      assertEquals(upload.status, 200);
      assertEquals((await upload.json()).id, "file-1");

      const batch = await handler(
        new Request(`${base}/v1/batches?provider=openai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input_file_id: "file-1",
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          }),
        }),
      );
      assertEquals(batch.status, 200);
      assertEquals((await batch.json()).status, "validating");
    });

    await t.step("files rejected for providers without support", async () => {
      const form = new FormData();
      form.set("purpose", "batch");
      const res = await handler(
        new Request(`${base}/v1/files?provider=anthropic`, {
          method: "POST",
          body: form,
        }),
      );
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });
  } finally {
    await mock.close();
  }
});

Deno.test("ImageGenerationRequest: legacy shape parses; Imagen params optional", () => {
  // Backward compatibility: the original {model?, prompt, n?, size?} shape
  // still parses with none of the new fields present.
  const legacy = ImageGenerationRequestSchema.safeParse({
    model: "openai/gpt-image-1",
    prompt: "a frosty fjord",
    n: 2,
    size: "1024x1024",
  });
  assert(legacy.success);
  if (legacy.success) {
    assertEquals(legacy.data.aspectRatio, undefined);
    assertEquals(legacy.data.sampleCount, undefined);
    assertEquals(legacy.data.negativePrompt, undefined);
    assertEquals(legacy.data.seed, undefined);
  }

  // The additive Imagen parameters are accepted when supplied.
  const imagen = ImageGenerationRequestSchema.safeParse({
    prompt: "a frosty fjord",
    aspectRatio: "16:9",
    sampleCount: 3,
    negativePrompt: "blurry",
    seed: 42,
  });
  assert(imagen.success);
  if (imagen.success) {
    assertEquals(imagen.data.aspectRatio, "16:9");
    assertEquals(imagen.data.sampleCount, 3);
    assertEquals(imagen.data.seed, 42);
  }
});
