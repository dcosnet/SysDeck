import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  assertSafeAudioUrl,
  buildHfImageRequest,
  HuggingFaceAdapter,
  isBlockedIp,
  mapHfImageResponse,
  splitModelProvider,
} from "./huggingface.ts";

// DNS-rebind guard: isBlockedIp flags every internal range across v4/v6,
// including IPv4-mapped IPv6 in dotted and hex forms.
Deno.test("isBlockedIp flags internal addresses across encodings", () => {
  for (
    const blocked of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "100.100.100.200", // CGNAT
      "198.18.0.1", // benchmarking
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:169.254.169.254", // mapped, dotted
      "::ffff:a9fe:a9fe", // mapped, hex (= 169.254.169.254)
      "::ffff:127.0.0.1",
      "2002:a9fe:a9fe::1", // 6to4 embedding 169.254.169.254
      "64:ff9b::a9fe:a9fe", // NAT64 embedding 169.254.169.254
      "64:ff9b::169.254.169.254", // NAT64 dotted
    ]
  ) {
    if (!isBlockedIp(blocked)) throw new Error(`should block ${blocked}`);
  }
  for (const ok of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
    if (isBlockedIp(ok)) throw new Error(`should allow ${ok}`);
  }
});

Deno.test("speech rejects a host that resolves to an internal address", async () => {
  let secondGet = false;
  const adapter = new HuggingFaceAdapter(
    "hf-token",
    "https://router.huggingface.co/v1",
    new ProviderClient(
      { maxRetries: 0 },
      mockFetch((input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/pipeline/text-to-speech")) {
          return new Response(
            JSON.stringify({ audio: { url: "https://rebind.evil/a.mp3" } }),
            { status: 200 },
          );
        }
        secondGet = true;
        return new Response("SECRET", { status: 200 });
      }),
    ),
    // rebind.evil (a DNS name, passes the literal check) resolves internal.
    (_h, t) => Promise.resolve(t === "A" ? ["169.254.169.254"] : []),
  );
  await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        new Request("https://gw/v1/audio/speech", {
          method: "POST",
          body: JSON.stringify({ model: "hf-inference/x", input: "hi" }),
        }),
      ),
    ProviderError,
  );
  assert(!secondGet, "the rebound internal address must never be fetched");
});

// M1 regression: the TTS second-GET target comes from the (federated) upstream
// response, so an SSRF payload must be rejected before the unauthenticated GET.
Deno.test("assertSafeAudioUrl blocks SSRF targets and non-https", () => {
  for (
    const bad of [
      "http://cdn.hf.co/a.mp3", // non-https
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/a.mp3",
      "https://app.localhost/a.mp3",
      "https://127.0.0.1/a.mp3",
      "https://[::1]/a.mp3",
      "https://[::ffff:169.254.169.254]/", // IPv4-mapped IPv6 (r2 bypass)
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
      "https://[fe80::1]/a.mp3",
      "https://10.0.0.5/a.mp3",
      "https://192.168.1.9/a.mp3",
      "https://172.16.0.1/a.mp3",
      "https://100.100.100.200/", // CGNAT (Alibaba metadata)
      "https://2852039166/", // decimal-encoded 169.254.169.254
      "https://metadata.google.internal/x",
      "not a url",
    ]
  ) {
    assertThrows(
      () => assertSafeAudioUrl(bad),
      ProviderError,
      undefined,
      `expected reject: ${bad}`,
    );
  }
  // A normal https CDN URL passes.
  assertSafeAudioUrl("https://cdn-lfs.huggingface.co/audio/out.mp3");
});

Deno.test("speech rejects an SSRF audio URL without fetching it", async () => {
  let secondGet = false;
  const adapter = new HuggingFaceAdapter(
    "hf-token",
    "https://router.huggingface.co/v1",
    new ProviderClient(
      { maxRetries: 0 },
      mockFetch((input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/pipeline/text-to-speech")) {
          return new Response(
            JSON.stringify({
              audio: { url: "http://169.254.169.254/latest/meta-data/" },
            }),
            { status: 200 },
          );
        }
        secondGet = true;
        return new Response("SECRET", { status: 200 });
      }),
    ),
  );
  await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        new Request("https://gw/v1/audio/speech", {
          method: "POST",
          body: JSON.stringify({ model: "hf-inference/x", input: "hi" }),
        }),
      ),
    ProviderError,
  );
  assert(!secondGet, "the SSRF target must never be fetched");
});

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

/** One recorded upstream call made through the adapter's rawProxy fetch. */
interface RecordedCall {
  url: string;
  method?: string;
  headers: Headers;
  body?: BodyInit | null;
}

/** rawProxy fetch stub that records every call and replays queued responses. */
function recordingFetch(
  responses: Response[],
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const next = responses.shift();
    if (!next) throw new Error("recordingFetch: no queued response");
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------------------
// splitModelProvider
// ---------------------------------------------------------------------------

Deno.test("splitModelProvider rejects a model with no slash", () => {
  const err = assertThrows(() => splitModelProvider("gpt-4o"), ProviderError);
  assertEquals(err.status, 400);
  assert(err.body.includes("invalid model name format"));
});

Deno.test("splitModelProvider routes single-slash ids to the auto policy", () => {
  assertEquals(splitModelProvider("openai/whisper-large-v3"), {
    provider: "auto",
    model: "openai/whisper-large-v3",
  });
});

Deno.test("splitModelProvider splits multi-slash ids on the first slash", () => {
  assertEquals(splitModelProvider("fal-ai/black-forest-labs/FLUX.1-dev"), {
    provider: "fal-ai",
    model: "black-forest-labs/FLUX.1-dev",
  });
  assertEquals(splitModelProvider("hf-inference/facebook/mms-tts-eng"), {
    provider: "hf-inference",
    model: "facebook/mms-tts-eng",
  });
});

// ---------------------------------------------------------------------------
// buildHfImageRequest / mapHfImageResponse (pure helpers)
// ---------------------------------------------------------------------------

Deno.test("buildHfImageRequest maps every provider branch", () => {
  assertEquals(
    buildHfImageRequest({
      model: "hf-inference/black-forest-labs/FLUX.1-schnell",
      prompt: "a cat",
    }),
    {
      provider: "hf-inference",
      path: "/hf-inference/models/black-forest-labs/FLUX.1-schnell",
      body: { inputs: "a cat" },
    },
  );

  assertEquals(
    buildHfImageRequest({
      model: "fal-ai/black-forest-labs/FLUX.1-dev",
      prompt: "a dog",
      n: 2,
      size: "512x512",
      negativePrompt: "blurry",
      seed: 42,
      response_format: "b64_json",
    }),
    {
      provider: "fal-ai",
      path: "/fal-ai/black-forest-labs/FLUX.1-dev",
      body: {
        prompt: "a dog",
        num_images: 2,
        image_size: { width: 512, height: 512 },
        negative_prompt: "blurry",
        seed: 42,
        sync_mode: true,
      },
    },
  );

  assertEquals(
    buildHfImageRequest({
      model: "nebius/stability-ai/sdxl",
      prompt: "a fox",
      size: "1024x768",
      response_format: "url",
      seed: 7,
      negativePrompt: "low-res",
    }),
    {
      provider: "nebius",
      path: "/nebius/v1/images/generations",
      body: {
        model: "stability-ai/sdxl",
        prompt: "a fox",
        width: 1024,
        height: 768,
        response_format: "url",
        seed: 7,
        negative_prompt: "low-res",
      },
    },
  );

  assertEquals(
    buildHfImageRequest({
      model: "together/black-forest-labs/FLUX.1-schnell",
      prompt: "an owl",
      size: "768x768",
      n: 1,
      response_format: "b64_json",
    }),
    {
      provider: "together",
      path: "/together/v1/images/generations",
      body: {
        prompt: "an owl",
        model: "black-forest-labs/FLUX.1-schnell",
        size: "768x768",
        n: 1,
        // together spells inline delivery "base64".
        response_format: "base64",
      },
    },
  );
});

Deno.test("buildHfImageRequest skips fal-ai image_size for auto or bad sizes", () => {
  const auto = buildHfImageRequest({
    model: "fal-ai/x/y",
    prompt: "p",
    size: "auto",
  });
  assertEquals("image_size" in auto.body, false);
  const bad = buildHfImageRequest({
    model: "fal-ai/x/y",
    prompt: "p",
    size: "square",
  });
  assertEquals("image_size" in bad.body, false);
});

Deno.test("buildHfImageRequest rejects a malformed nebius size", () => {
  const err = assertThrows(
    () =>
      buildHfImageRequest({
        model: "nebius/x/y",
        prompt: "p",
        size: "square",
      }),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("invalid size format"));
});

Deno.test("buildHfImageRequest rejects unsupported media providers with 400", () => {
  const err = assertThrows(
    () => buildHfImageRequest({ model: "groq/meta/llama", prompt: "p" }),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(
    err.body.includes("unsupported inference provider for image generation"),
  );
  // Single-slash ids resolve to `auto`, which has no media surface either.
  const auto = assertThrows(
    () => buildHfImageRequest({ model: "stabilityai/sdxl", prompt: "p" }),
    ProviderError,
  );
  assertEquals(auto.status, 400);
});

Deno.test("mapHfImageResponse handles bytes, fal-ai and OpenAI-shaped payloads", () => {
  const raw = mapHfImageResponse(
    "hf-inference",
    new Uint8Array([1, 2, 3, 255]),
  );
  assertEquals(raw.data, [{ b64_json: btoa("\x01\x02\x03\xff") }]);

  const fal = mapHfImageResponse("fal-ai", {
    images: [{ url: "https://img/1.png" }, { b64_json: "aW1n" }],
  });
  assertEquals(fal.data, [{ url: "https://img/1.png" }, { b64_json: "aW1n" }]);

  const together = mapHfImageResponse("together", {
    data: [{ b64_json: "dG9n", url: "https://img/2.png", index: 0 }],
  });
  assertEquals(together.data, [{ b64_json: "dG9n", url: "https://img/2.png" }]);
});

// ---------------------------------------------------------------------------
// generateImage (adapter, mocked ProviderClient fetch)
// ---------------------------------------------------------------------------

Deno.test("HuggingFaceAdapter.generateImage encodes hf-inference raw bytes as b64_json", async () => {
  let url = "";
  let auth: string | null = null;
  let body: Record<string, unknown> = {};
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization");
      body = JSON.parse(String(init?.body));
      return new Response(pngBytes, {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
  const adapter = new HuggingFaceAdapter("hf-key", "http://mock/v1", client);
  const result = await adapter.generateImage({
    model: "hf-inference/black-forest-labs/FLUX.1-schnell",
    prompt: "a cat",
  });

  assertEquals(
    url,
    "http://mock/hf-inference/models/black-forest-labs/FLUX.1-schnell",
  );
  assertEquals(auth, "Bearer hf-key");
  assertEquals(body, { inputs: "a cat" });
  assertEquals(result.data, [{ b64_json: btoa("\x89PNG") }]);
});

Deno.test("HuggingFaceAdapter.generateImage posts the fal-ai body and maps images[]", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          images: [{ url: "https://fal/1.png" }, { b64_json: "aW1n" }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new HuggingFaceAdapter("hf-key", "http://mock/v1", client);
  const result = await adapter.generateImage({
    model: "fal-ai/black-forest-labs/FLUX.1-dev",
    prompt: "a dog",
    n: 2,
    size: "512x512",
    response_format: "b64_json",
  });

  assertEquals(url, "http://mock/fal-ai/black-forest-labs/FLUX.1-dev");
  assertEquals(body, {
    prompt: "a dog",
    num_images: 2,
    image_size: { width: 512, height: 512 },
    sync_mode: true,
  });
  assertEquals(result.data, [
    { url: "https://fal/1.png" },
    { b64_json: "aW1n" },
  ]);
});

Deno.test("HuggingFaceAdapter.generateImage preserves upstream error bodies", async () => {
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() =>
      new Response(JSON.stringify({ error: "model is overloaded" }), {
        status: 503,
        statusText: "Service Unavailable",
      })
    ),
  );
  const adapter = new HuggingFaceAdapter("hf-key", "http://mock/v1", client);
  const err = await assertRejects(
    () =>
      adapter.generateImage({
        model: "hf-inference/x/y",
        prompt: "p",
      }),
    ProviderError,
  );
  assertEquals(err.status, 503);
  assert(err.body.includes("model is overloaded"));
});

// ---------------------------------------------------------------------------
// rawProxy /audio/speech
// ---------------------------------------------------------------------------

Deno.test("HuggingFaceAdapter speech runs the pipeline POST then an unauthenticated GET", async () => {
  const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const { calls, fetchImpl } = recordingFetch([
    new Response(
      JSON.stringify({
        audio: {
          url: "https://cdn.mock/speech.flac",
          content_type: "audio/flac",
          file_name: "speech.flac",
          file_size: 4,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
    new Response(audioBytes),
  ]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
    // Safe resolver: cdn.mock resolves to a public IP for the SSRF guard.
    (_h, t) => Promise.resolve(t === "A" ? ["93.184.216.34"] : []),
  );
  const res = await adapter.rawProxy(
    "/audio/speech",
    new Request("http://internal/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hf-inference/facebook/mms-tts-eng",
        input: "hello world",
      }),
    }),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());

  assertEquals(calls.length, 2);
  assertEquals(
    calls[0].url,
    "http://mock/hf-inference/models/facebook/mms-tts-eng/pipeline/text-to-speech",
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("Authorization"), "Bearer hf-key");
  assertEquals(JSON.parse(String(calls[0].body)), {
    text: "hello world",
    provider: "hf-inference",
    model: "facebook/mms-tts-eng",
  });
  // Second fetch: the hosted audio URL, WITHOUT the HF token.
  assertEquals(calls[1].url, "https://cdn.mock/speech.flac");
  assertEquals(calls[1].headers.get("Authorization"), null);
  assertEquals(res.headers.get("Content-Type"), "audio/flac");
  assertEquals(bytes, audioBytes);
});

Deno.test("HuggingFaceAdapter speech falls back to audio/mpeg without a content_type", async () => {
  const { fetchImpl } = recordingFetch([
    new Response(JSON.stringify({ audio: { url: "https://cdn.mock/a" } }), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(new Uint8Array([1])),
  ]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
    // Safe resolver: cdn.mock resolves to a public IP for the SSRF guard.
    (_h, t) => Promise.resolve(t === "A" ? ["93.184.216.34"] : []),
  );
  const res = await adapter.rawProxy(
    "/audio/speech",
    new Request("http://internal/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "hf-inference/x/y", input: "hi" }),
    }),
  );
  await res.body?.cancel();
  assertEquals(res.headers.get("Content-Type"), "audio/mpeg");
});

Deno.test("HuggingFaceAdapter speech rejects non-hf-inference providers", async () => {
  const { calls, fetchImpl } = recordingFetch([]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        new Request("http://internal/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "fal-ai/x/y", input: "hi" }),
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("unsupported inference provider for speech"));
  assertEquals(calls.length, 0);
});

Deno.test("HuggingFaceAdapter speech preserves upstream error bodies", async () => {
  const { fetchImpl } = recordingFetch([
    new Response("model too busy", {
      status: 503,
      statusText: "Service Unavailable",
    }),
  ]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        new Request("http://internal/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "hf-inference/x/y", input: "hi" }),
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 503);
  assertEquals(err.body, "model too busy");
});

// ---------------------------------------------------------------------------
// rawProxy /audio/transcriptions
// ---------------------------------------------------------------------------

function multipartRequest(fileBytes: Uint8Array, model: string): Request {
  const form = new FormData();
  form.append("file", new File([fileBytes.slice()], "clip.bin"));
  form.append("model", model);
  return new Request("http://internal/v1/audio/transcriptions", {
    method: "POST",
    body: form,
  });
}

Deno.test("HuggingFaceAdapter transcription posts raw bytes with a sniffed content type", async () => {
  // ID3 magic -> detectAudioMimeType audio/mp3 -> normalized audio/mpeg.
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const { calls, fetchImpl } = recordingFetch([
    new Response(
      JSON.stringify({
        text: "hello",
        chunks: [
          { text: "hel", timestamp: [0, 1.5] },
          { text: "lo", timestamp: [] },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  ]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const res = await adapter.rawProxy(
    "/audio/transcriptions",
    multipartRequest(mp3, "hf-inference/openai/whisper-large-v3"),
  );
  const json = await res.json() as {
    text: string;
    segments?: Array<{ id: number; start: number; end: number; text: string }>;
  };

  assertEquals(
    calls[0].url,
    "http://mock/hf-inference/models/openai/whisper-large-v3",
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("Content-Type"), "audio/mpeg");
  assertEquals(calls[0].headers.get("Authorization"), "Bearer hf-key");
  assertEquals(new Uint8Array(calls[0].body as Uint8Array), mp3);
  assertEquals(json.text, "hello");
  // Only chunks carrying a [start, end] pair become segments.
  assertEquals(json.segments, [{ id: 0, start: 0, end: 1.5, text: "hel" }]);
});

Deno.test("HuggingFaceAdapter transcription sends fal-ai audio as a base64 data URI", async () => {
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  const { calls, fetchImpl } = recordingFetch([
    new Response(JSON.stringify({ text: "bonjour" }), {
      headers: { "Content-Type": "application/json" },
    }),
  ]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const res = await adapter.rawProxy(
    "/audio/transcriptions",
    multipartRequest(ogg, "fal-ai/openai/whisper"),
  );
  const json = await res.json() as { text: string; segments?: unknown };

  assertEquals(calls[0].url, "http://mock/fal-ai/openai/whisper");
  assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  const body = JSON.parse(String(calls[0].body)) as { audio_url: string };
  assertEquals(body.audio_url, `data:audio/ogg;base64,${btoa("OggS\x00\x02")}`);
  assertEquals(json.text, "bonjour");
  assertEquals(json.segments, undefined);
});

Deno.test("HuggingFaceAdapter transcription rejects WAV audio for fal-ai", async () => {
  const wav = new Uint8Array(16);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  const { calls, fetchImpl } = recordingFetch([]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/transcriptions",
        multipartRequest(wav, "fal-ai/openai/whisper"),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(
    err.body,
    "fal-ai provider does not support audio/wav format; please use a " +
      "different format like mp3 or ogg",
  );
  assertEquals(calls.length, 0);
});

Deno.test("HuggingFaceAdapter transcription rejects an empty audio file", async () => {
  const { fetchImpl } = recordingFetch([]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/transcriptions",
        multipartRequest(new Uint8Array(0), "hf-inference/x/y"),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("audio file cannot be empty"));
});

Deno.test("HuggingFaceAdapter transcription rejects unsupported providers", async () => {
  const { fetchImpl } = recordingFetch([]);
  const adapter = new HuggingFaceAdapter(
    "hf-key",
    "http://mock/v1",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/transcriptions",
        multipartRequest(new Uint8Array([1, 2, 3, 4]), "nebius/x/y"),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(
    err.body.includes("unsupported inference provider for transcription"),
  );
});

// ---------------------------------------------------------------------------
// Delegation regressions (today's OpenAI-router behavior must not move)
// ---------------------------------------------------------------------------

Deno.test("HuggingFaceAdapter still delegates chat to the /v1 router unchanged", async () => {
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
          id: "cmpl-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new HuggingFaceAdapter("hf-key", "http://mock/v1", client);
  const res = await adapter.chatCompletions({
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [{ role: "user", content: "hello" }],
  });
  await res.body?.cancel();

  assertEquals(url, "http://mock/v1/chat/completions");
  assertEquals(auth, "Bearer hf-key");
  assertEquals(body.model, "meta-llama/Llama-3.3-70B-Instruct");
});

Deno.test("HuggingFaceAdapter still delegates embeddings to the /v1 router", async () => {
  let url = "";
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input) => {
      url = String(input);
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const adapter = new HuggingFaceAdapter("hf-key", "http://mock/v1", client);
  const res = await adapter.embeddings({ model: "bge", input: "x" });
  await res.body?.cancel();
  assertEquals(url, "http://mock/v1/embeddings");
});

// ---------------------------------------------------------------------------
// D1-T18 on the HuggingFace media surfaces: one paid attempt, never four.
// generateImage used fetchWithRetry (measured 4); the audio paths used a bare
// fetch with no establishment timeout at all.

Deno.test("D1-T18: huggingface media surfaces make exactly one attempt on a 429", async () => {
  const surfaces: Array<[string, (a: HuggingFaceAdapter) => Promise<unknown>]> =
    [
      [
        "generateImage",
        (a) => a.generateImage({ model: "hf-inference/x/y", prompt: "fjord" }),
      ],
      ["speech", (a) =>
        a.rawProxy(
          "/audio/speech",
          new Request("http://internal/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "hf-inference/x/y", input: "hi" }),
          }),
        )],
      ["transcriptions", (a) => {
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x00])]),
        );
        form.append("model", "hf-inference/openai/whisper-large-v3");
        return a.rawProxy(
          "/audio/transcriptions",
          new Request("http://internal/v1/audio/transcriptions", {
            method: "POST",
            body: form,
          }),
        );
      }],
    ];
  for (const [label, call] of surfaces) {
    let attempts = 0;
    // maxRetries: 3 is the shipped default, so this fixture would bill four
    // attempts through fetchWithRetry - the assertion cannot be vacuous.
    const adapter = new HuggingFaceAdapter(
      "hf-key",
      "http://mock/v1",
      new ProviderClient(
        { maxRetries: 3, initialDelayMs: 1 },
        mockFetch(() => {
          attempts++;
          return new Response(JSON.stringify({ error: "slow down" }), {
            status: 429,
            statusText: "Too Many Requests",
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
