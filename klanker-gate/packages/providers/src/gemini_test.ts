import { assert, assertEquals, assertRejects } from "@std/assert";
import { TranscriptionResponseSchema } from "../../contracts/src/mod.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import { GeminiAdapter } from "./gemini.ts";
import { pcmToWav } from "./audio.ts";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

function mockedAdapter(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): GeminiAdapter {
  return new GeminiAdapter(
    "g-key",
    "http://mock/v1beta/openai",
    new ProviderClient({ maxRetries: 0 }, mockFetch(handler)),
  );
}

function jsonForward(path: string, body: unknown): Request {
  return new Request(`http://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("GeminiAdapter.embeddings proxies the OpenAI-compatible /embeddings surface", async () => {
  let url = "";
  let auth: string | null = null;
  let body: Record<string, unknown> = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization");
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          model: "text-embedding-004",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new GeminiAdapter(
    "g-key",
    "http://mock/v1beta/openai",
    client,
  );
  const res = await adapter.embeddings({
    model: "text-embedding-004",
    input: "hello",
  });
  const json = await res.json() as {
    data: Array<{ embedding: number[] }>;
  };

  assertEquals(url, "http://mock/v1beta/openai/embeddings");
  assertEquals(auth, "Bearer g-key");
  assertEquals(body.input, "hello");
  assertEquals(body.model, "text-embedding-004");
  assertEquals(json.data[0].embedding, [0.1, 0.2]);
});

Deno.test("GeminiAdapter.generateImage maps Imagen :predict instances and predictions", async () => {
  let url = "";
  let apiKeyHeader: string | null = null;
  let authHeader: string | null = null;
  let body: {
    instances?: Array<{ prompt: string }>;
    parameters?: Record<string, unknown>;
  } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      apiKeyHeader = headers.get("x-goog-api-key");
      authHeader = headers.get("Authorization");
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          predictions: [
            { bytesBase64Encoded: "aW1nMQ==", mimeType: "image/png" },
            { bytesBase64Encoded: "aW1nMg==", mimeType: "image/png" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new GeminiAdapter(
    "g-key",
    "http://mock/v1beta/openai",
    client,
  );
  const res = await adapter.generateImage({
    model: "imagen-3.0-generate-002",
    prompt: "a frosty fjord",
    n: 2,
    size: "1024x1024",
    negativePrompt: "blurry",
    seed: 7,
  });

  // Native base drops the OpenAI-compat "/openai" segment and calls :predict.
  assertEquals(
    url,
    "http://mock/v1beta/models/imagen-3.0-generate-002:predict",
  );
  // Native generativelanguage auth is the API key header, never a Bearer token.
  assertEquals(apiKeyHeader, "g-key");
  assertEquals(authHeader, null);
  assertEquals(body.instances, [{ prompt: "a frosty fjord" }]);
  assertEquals(body.parameters, {
    sampleCount: 2,
    aspectRatio: "1:1",
    negativePrompt: "blurry",
    seed: 7,
  });
  // Base64 predictions map to b64_json (Imagen returns bytes, not URLs).
  assertEquals(res.data.map((d) => d.b64_json), ["aW1nMQ==", "aW1nMg=="]);
  assertEquals(typeof res.created, "number");
});

Deno.test("GeminiAdapter.countTokens uses the native :countTokens endpoint", async () => {
  let url = "";
  let apiKeyHeader: string | null = null;
  let authHeader: string | null = null;
  let body: {
    contents?: Array<{ role: string; parts: Array<{ text: string }> }>;
  } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      apiKeyHeader = headers.get("x-goog-api-key");
      authHeader = headers.get("Authorization");
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ totalTokens: 7 }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const adapter = new GeminiAdapter(
    "g-key",
    "http://mock/v1beta/openai",
    client,
  );
  const counted = await adapter.countTokens({
    model: "gemini-2.0-flash",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "count me" },
      { role: "assistant", content: "ok" },
    ],
  });

  // Native base drops the OpenAI-compat "/openai" segment.
  assertEquals(url, "http://mock/v1beta/models/gemini-2.0-flash:countTokens");
  // Native generativelanguage auth is the API key header, never a Bearer token.
  assertEquals(apiKeyHeader, "g-key");
  assertEquals(authHeader, null);
  assertEquals(body.contents?.[0], {
    role: "user",
    parts: [{ text: "be brief" }],
  });
  assertEquals(body.contents?.[2], { role: "model", parts: [{ text: "ok" }] });
  assertEquals(counted, { input_tokens: 7, estimated: false });
});

// ---------------------------------------------------------------------------
// rawProxy /audio/speech (G1)

Deno.test("GeminiAdapter speech wraps PCM inlineData in a WAV container by default", async () => {
  let url = "";
  let apiKeyHeader: string | null = null;
  let body: {
    contents?: unknown;
    generationConfig?: {
      responseModalities?: string[];
      speechConfig?: unknown;
    };
  } = {};
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    apiKeyHeader = new Headers(init?.headers).get("x-goog-api-key");
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: "ignored non-audio part" },
              // Two audio parts: [1,2] + [3,4], concatenated in order.
              {
                inlineData: { mimeType: "audio/L16;rate=24000", data: "AQI=" },
              },
              {
                inlineData: { mimeType: "audio/L16;rate=24000", data: "AwQ=" },
              },
            ],
          },
        }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/audio/speech",
    jsonForward("/audio/speech", {
      model: "gemini-2.5-flash-preview-tts",
      input: "hello",
      voice: "Kore",
    }),
  );

  assertEquals(
    url,
    "http://mock/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
  );
  assertEquals(apiKeyHeader, "g-key");
  // camelCase generateContent wire throughout.
  assertEquals(body.contents, [{ parts: [{ text: "hello" }] }]);
  assertEquals(body.generationConfig?.responseModalities, ["AUDIO"]);
  assertEquals(body.generationConfig?.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
  });
  assertEquals(res.headers.get("Content-Type"), "audio/wav");
  const wav = new Uint8Array(await res.arrayBuffer());
  assertEquals(wav, pcmToWav(new Uint8Array([1, 2, 3, 4])));
});

Deno.test("GeminiAdapter speech response_format pcm returns raw bytes, no voice config", async () => {
  let body: { generationConfig?: Record<string, unknown> } = {};
  const adapter = mockedAdapter((_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              inlineData: { mimeType: "audio/pcm", data: "AQIDBA==" },
            }],
          },
        }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/audio/speech",
    jsonForward("/audio/speech", {
      model: "gemini-2.5-flash-preview-tts",
      input: "hello",
      response_format: "pcm",
    }),
  );

  // No voice -> speechConfig omitted entirely (Go injects no default voice).
  assertEquals("speechConfig" in (body.generationConfig ?? {}), false);
  assertEquals(res.headers.get("Content-Type"), "audio/pcm");
  assertEquals(
    new Uint8Array(await res.arrayBuffer()),
    new Uint8Array([1, 2, 3, 4]),
  );
});

Deno.test("GeminiAdapter speech rejects unsupported response_format with 400", async () => {
  const adapter = mockedAdapter(() => {
    throw new Error("upstream must not be called");
  });
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        jsonForward("/audio/speech", {
          model: "gemini-2.5-flash-preview-tts",
          input: "hello",
          response_format: "mp3",
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(err.body.includes("wav/pcm"), true);
});

Deno.test("GeminiAdapter speech preserves the upstream error body", async () => {
  const upstream = JSON.stringify({
    error: {
      code: 400,
      message: "voice not found",
      status: "INVALID_ARGUMENT",
    },
  });
  const adapter = mockedAdapter(() =>
    new Response(upstream, {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" },
    })
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        jsonForward("/audio/speech", { model: "m", input: "x" }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(err.body, upstream);
});

// ---------------------------------------------------------------------------
// rawProxy /audio/transcriptions (G1)

Deno.test("GeminiAdapter transcription inlines the sniffed file and maps usage", async () => {
  let url = "";
  let body: {
    contents?: Array<{
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    }>;
  } = {};
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "hello " }, { text: "world" }] },
        }],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          totalTokenCount: 12,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });

  // WAV magic bytes so the MIME sniff resolves to audio/wav.
  const audio = new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    0,
    0,
    0,
    0,
    0x57,
    0x41,
    0x56,
    0x45,
  ]);
  const form = new FormData();
  form.append("file", new Blob([audio]), "clip.wav");
  form.append("model", "gemini-2.0-flash");
  const res = await adapter.rawProxy(
    "/audio/transcriptions",
    new Request("http://internal/audio/transcriptions", {
      method: "POST",
      body: form,
    }),
  );

  assertEquals(
    url,
    "http://mock/v1beta/models/gemini-2.0-flash:generateContent",
  );
  const parts = body.contents?.[0]?.parts ?? [];
  // Default prompt part always comes first (Go-exact string).
  assertEquals(parts[0], { text: "Generate a transcript of the speech." });
  assertEquals(parts[1]?.inlineData?.mimeType, "audio/wav");
  assertEquals(parts[1]?.inlineData?.data, btoa(String.fromCharCode(...audio)));

  const json = await res.json();
  const parsed = TranscriptionResponseSchema.parse(json);
  assertEquals(parsed.text, "hello world");
  assertEquals(json.task, "transcribe");
  assertEquals(json.usage, {
    type: "tokens",
    input_tokens: 5,
    output_tokens: 7,
    total_tokens: 12,
  });
});

Deno.test("GeminiAdapter transcription forwards a caller prompt verbatim", async () => {
  let body: { contents?: Array<{ parts?: Array<{ text?: string }> }> } = {};
  const adapter = mockedAdapter((_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "clip.mp3");
  form.append("model", "gemini-2.0-flash");
  form.append("prompt", "Transcribe in French.");
  await adapter.rawProxy(
    "/audio/transcriptions",
    new Request("http://internal/audio/transcriptions", {
      method: "POST",
      body: form,
    }),
  );
  assertEquals(body.contents?.[0]?.parts?.[0], {
    text: "Transcribe in French.",
  });
});

// ---------------------------------------------------------------------------
// rawProxy /files* (G2)

Deno.test("GeminiAdapter file upload posts metadata + bytes to the upload base", async () => {
  let url = "";
  let apiKeyHeader: string | null = null;
  let sent: FormData | null = null;
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    apiKeyHeader = new Headers(init?.headers).get("x-goog-api-key");
    sent = init?.body as FormData;
    return new Response(
      JSON.stringify({
        file: {
          name: "files/abc123",
          displayName: "data.jsonl",
          mimeType: "application/octet-stream",
          sizeBytes: "2048",
          createTime: "2026-07-16T00:00:00Z",
          state: "ACTIVE",
          uri: "https://example/files/abc123",
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });

  const form = new FormData();
  form.append("file", new Blob(['{"k":1}\n']), "data.jsonl");
  form.append("purpose", "batch");
  const res = await adapter.rawProxy(
    "/files",
    new Request("http://internal/files", { method: "POST", body: form }),
  );

  assertEquals(url, "http://mock/upload/v1beta/files");
  assertEquals(apiKeyHeader, "g-key");
  // Two plain multipart parts: metadata JSON, then the file bytes.
  const metadata = sent!.get("metadata");
  assertEquals(
    metadata,
    JSON.stringify({ file: { displayName: "data.jsonl" } }),
  );
  const filePart = sent!.get("file") as File;
  assertEquals(filePart.name, "data.jsonl");
  assertEquals(await filePart.text(), '{"k":1}\n');

  const json = await res.json();
  assertEquals(json, {
    id: "abc123",
    object: "file",
    bytes: 2048,
    created_at: Date.UTC(2026, 6, 16) / 1000,
    filename: "data.jsonl",
    purpose: "batch",
    status: "processed",
    uri: "https://example/files/abc123",
  });
});

Deno.test("GeminiAdapter file list maps limit/after to pageSize/pageToken", async () => {
  let url = "";
  const adapter = mockedAdapter((input) => {
    url = String(input);
    return new Response(
      JSON.stringify({
        files: [{
          name: "files/abc",
          displayName: "a.jsonl",
          sizeBytes: "10",
          createTime: "2026-07-16T00:00:00Z",
          state: "PROCESSING",
        }],
        nextPageToken: "tok-2",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/files",
    new Request("http://gateway/v1/files?limit=2&after=tok-1&provider=g"),
  );

  assertEquals(url, "http://mock/v1beta/files?pageSize=2&pageToken=tok-1");
  const json = await res.json();
  assertEquals(json.object, "list");
  assertEquals(json.has_more, true);
  assertEquals(json.last_id, "tok-2");
  assertEquals(json.data[0].id, "abc");
  assertEquals(json.data[0].purpose, "vision");
  assertEquals(json.data[0].status, "processing");
});

Deno.test("GeminiAdapter file retrieve re-prefixes files/ and delete synthesizes the envelope", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const adapter = mockedAdapter((input, init) => {
    urls.push(String(input));
    methods.push(init?.method ?? "GET");
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify({
        name: "files/abc",
        displayName: "a.bin",
        sizeBytes: "1",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const got = await adapter.rawProxy(
    "/files/abc",
    new Request("http://internal/files/abc"),
  );
  assertEquals(urls[0], "http://mock/v1beta/files/abc");
  assertEquals((await got.json()).id, "abc");

  const deleted = await adapter.rawProxy(
    "/files/abc",
    new Request("http://internal/files/abc", { method: "DELETE" }),
  );
  assertEquals(urls[1], "http://mock/v1beta/files/abc");
  assertEquals(methods[1], "DELETE");
  assertEquals(await deleted.json(), {
    id: "abc",
    object: "file",
    deleted: true,
  });
});

Deno.test("GeminiAdapter file content download is a documented 400", async () => {
  const adapter = mockedAdapter(() => {
    throw new Error("upstream must not be called");
  });
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/files/abc/content",
        new Request("http://internal/files/abc/content"),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(
    err.body,
    "Gemini Files API doesn't support direct content download. " +
      "Use the file URI in your requests instead.",
  );
});

// ---------------------------------------------------------------------------
// rawProxy /batches* (G2)

Deno.test("GeminiAdapter batch create (file-based) prefixes files/ and defaults the model", async () => {
  let url = "";
  let body: {
    batch?: {
      display_name?: string;
      input_config?: { file_name?: string };
    };
  } = {};
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        metadata: {
          name: "batches/xyz",
          state: "BATCH_STATE_PENDING",
          createTime: "2026-07-16T00:00:00Z",
          batchStats: {
            requestCount: "2",
            pendingRequestCount: "2",
            successfulRequestCount: "0",
          },
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/batches",
    jsonForward("/batches", {
      input_file_id: "in-1",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    }),
  );

  assertEquals(
    url,
    "http://mock/v1beta/models/gemini-2.5-flash:batchGenerateContent",
  );
  // Batch create is the one snake_case Gemini wire.
  assertEquals(body.batch?.input_config, { file_name: "files/in-1" });
  assertEquals(body.batch?.display_name?.startsWith("frosty-batch-"), true);

  const json = await res.json();
  assertEquals(json.id, "xyz");
  assertEquals(json.status, "in_progress");
  assertEquals(json.input_file_id, "in-1");
  assertEquals(json.endpoint, "/v1/chat/completions");
  assertEquals(json.request_counts, { total: 2, completed: 0, failed: 0 });
});

Deno.test("GeminiAdapter batch create (inline) maps requests and metadata.model", async () => {
  let url = "";
  let body: {
    batch?: { input_config?: { requests?: { requests?: unknown[] } } };
  } = {};
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        metadata: { name: "batches/inline", state: "BATCH_STATE_PENDING" },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  await adapter.rawProxy(
    "/batches",
    jsonForward("/batches", {
      requests: [{
        custom_id: "a",
        body: { messages: [{ role: "user", content: "hi" }] },
      }],
      metadata: { model: "gemini-2.0-flash" },
    }),
  );
  assertEquals(
    url,
    "http://mock/v1beta/models/gemini-2.0-flash:batchGenerateContent",
  );
  assertEquals(body.batch?.input_config?.requests?.requests?.[0], {
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    metadata: { key: "a" },
  });
});

Deno.test("GeminiAdapter batch create rejects input_file_id + requests together", async () => {
  const adapter = mockedAdapter(() => {
    throw new Error("upstream must not be called");
  });
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/batches",
        jsonForward("/batches", {
          input_file_id: "in-1",
          requests: [{ custom_id: "a", body: { messages: [] } }],
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
});

Deno.test("GeminiAdapter batch retrieve maps state and string counts", async () => {
  let url = "";
  const adapter = mockedAdapter((input) => {
    url = String(input);
    return new Response(
      JSON.stringify({
        metadata: {
          name: "batches/xyz",
          state: "BATCH_STATE_SUCCEEDED",
          createTime: "2026-07-16T00:00:00Z",
          batchStats: {
            requestCount: "10",
            pendingRequestCount: "0",
            successfulRequestCount: "9",
          },
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/batches/xyz",
    new Request("http://internal/batches/xyz"),
  );
  assertEquals(url, "http://mock/v1beta/batches/xyz");
  const json = await res.json();
  assertEquals(json.status, "completed");
  assertEquals(json.request_counts, { total: 10, completed: 10, failed: 1 });
});

Deno.test("GeminiAdapter batch list 404 becomes an empty list", async () => {
  const adapter = mockedAdapter(() =>
    new Response("not found", { status: 404, statusText: "Not Found" })
  );
  const res = await adapter.rawProxy(
    "/batches",
    new Request("http://gateway/v1/batches"),
  );
  assertEquals(await res.json(), { object: "list", data: [] });
});

Deno.test("GeminiAdapter batch cancel posts :cancel and reports cancelling", async () => {
  let url = "";
  let method = "";
  const adapter = mockedAdapter((input, init) => {
    url = String(input);
    method = init?.method ?? "GET";
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  });
  const res = await adapter.rawProxy(
    "/batches/xyz/cancel",
    new Request("http://internal/batches/xyz/cancel", { method: "POST" }),
  );
  assertEquals(url, "http://mock/v1beta/batches/xyz:cancel");
  assertEquals(method, "POST");
  const json = await res.json();
  assertEquals(json.id, "xyz");
  assertEquals(json.object, "batch");
  assertEquals(json.status, "cancelling");
  assertEquals(typeof json.cancelling_at, "number");
});

Deno.test("GeminiAdapter batch results downloads and remaps the JSONL file", async () => {
  const urls: string[] = [];
  const adapter = mockedAdapter((input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes(":download")) {
      return new Response(
        JSON.stringify({
          key: "a",
          response: {
            candidates: [{
              content: { parts: [{ text: "hi" }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 2,
              totalTokenCount: 3,
            },
          },
        }) + "\n" +
          JSON.stringify({ error: { code: 400, message: "boom" } }) + "\n",
        { headers: { "Content-Type": "application/octet-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        metadata: { name: "batches/xyz", state: "BATCH_STATE_SUCCEEDED" },
        dest: { fileName: "files/out-1" },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const res = await adapter.rawProxy(
    "/batches/xyz/results",
    new Request("http://internal/batches/xyz/results"),
  );

  assertEquals(urls, [
    "http://mock/v1beta/batches/xyz",
    "http://mock/download/v1beta/files/out-1:download?alt=media",
  ]);
  assertEquals(res.headers.get("Content-Type"), "application/jsonl");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines, [
    {
      custom_id: "a",
      response: {
        status_code: 200,
        body: {
          text: "hi",
          finish_reason: "STOP",
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      },
    },
    { custom_id: "request-1", error: { code: "400", message: "boom" } },
  ]);
});

Deno.test("GeminiAdapter batch results while processing is a 400", async () => {
  const adapter = mockedAdapter(() =>
    new Response(
      JSON.stringify({
        metadata: { name: "batches/xyz", state: "BATCH_STATE_RUNNING" },
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/batches/xyz/results",
        new Request("http://internal/batches/xyz/results"),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(err.body.includes("still processing"), true);
});

Deno.test("GeminiAdapter rawProxy rejects unknown passthrough paths", async () => {
  const adapter = mockedAdapter(() => {
    throw new Error("upstream must not be called");
  });
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/images/generations",
        jsonForward("/images/generations", {}),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
});

// ---------------------------------------------------------------------------
// TTS token usage (WP8): the usageMetadata this path already parsed and dropped

Deno.test("GeminiAdapter speech reports usageMetadata through onUsage", async () => {
  const adapter = mockedAdapter(() =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "audio/pcm", data: "AQID" } }],
          },
        }],
        // Already parsed by this path before WP8, and dropped on the floor.
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 240,
          totalTokenCount: 249,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  );
  const seen: Array<{ prompt?: number; completion?: number; total?: number }> =
    [];
  const res = await adapter.rawProxy(
    "/audio/speech",
    jsonForward("/audio/speech", {
      model: "gemini-2.5-flash-preview-tts",
      input: "hello",
      response_format: "pcm",
    }),
    { onUsage: (usage) => seen.push(usage) },
  );
  await res.body?.cancel();
  // Gemini TTS is token-priced while OpenAI TTS is character-priced, so this is
  // the only route by which the token half of the bill can arrive: the reply is
  // audio bytes, with no JSON body for an accounting site to sniff.
  assertEquals(seen, [{ prompt: 9, completion: 240, total: 249 }]);
});

Deno.test("GeminiAdapter speech omits onUsage when the reply carries no usage block", async () => {
  const adapter = mockedAdapter(() =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "audio/pcm", data: "AQID" } }],
          },
        }],
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  );
  let calls = 0;
  const res = await adapter.rawProxy(
    "/audio/speech",
    jsonForward("/audio/speech", {
      model: "gemini-2.5-flash-preview-tts",
      input: "hello",
      response_format: "pcm",
    }),
    { onUsage: () => calls++ },
  );
  await res.body?.cancel();
  assertEquals(calls, 0);
});

// ---------------------------------------------------------------------------
// D1-T18 on the native Gemini media surfaces: one paid attempt, never four

Deno.test("D1-T18: gemini media surfaces make exactly one attempt on a 429", async () => {
  const surfaces: Array<[string, (a: GeminiAdapter) => Promise<unknown>]> = [
    ["speech", (a) =>
      a.rawProxy(
        "/audio/speech",
        jsonForward("/audio/speech", { model: "m", input: "hi" }),
      )],
    ["transcriptions", (a) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])]));
      form.append("model", "gemini-2.0-flash");
      return a.rawProxy(
        "/audio/transcriptions",
        new Request("http://internal/audio/transcriptions", {
          method: "POST",
          body: form,
        }),
      );
    }],
    [
      "generateImage",
      (a) =>
        a.generateImage({ model: "imagen-3.0-generate-002", prompt: "fjord" }),
    ],
  ];
  for (const [label, call] of surfaces) {
    let attempts = 0;
    // maxRetries: 3 is the shipped default, so this fixture would bill four
    // attempts through fetchWithRetry.
    const adapter = new GeminiAdapter(
      "g-key",
      "http://mock/v1beta/openai",
      new ProviderClient(
        { maxRetries: 3, initialDelayMs: 1 },
        mockFetch(() => {
          attempts++;
          return new Response(JSON.stringify({ error: "slow down" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }),
      ),
    );
    const err = await assertRejects(() => call(adapter));
    assert(err instanceof ProviderError, label);
    assertEquals((err as ProviderError).status, 429, label);
    assertEquals(attempts, 1, `${label}: exactly one paid attempt`);
  }
});
