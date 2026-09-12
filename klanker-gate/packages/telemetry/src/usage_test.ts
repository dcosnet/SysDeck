import { assert, assertEquals } from "@std/assert";
import {
  GenAIStreamTranslator,
  translateSSEBody,
} from "../../core/src/translate.ts";
import {
  clampCount,
  clampSeconds,
  extractStreamModel,
  extractStreamUsage,
  getRequestDispatch,
  markSettled,
  mergeRequestStatus,
  mergeRequestTokens,
  mergeRequestUnits,
  normalizeUsage,
  setRequestDispatch,
  tapSseTail,
  type UsageShape,
} from "./usage.ts";

Deno.test("normalizeUsage maps OpenAI and Anthropic field names", () => {
  assertEquals(
    normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }),
    { prompt: 10, completion: 5, cached: 0, cacheCreation: 0, total: 15 },
  );
  assertEquals(
    normalizeUsage({ input_tokens: 7, output_tokens: 3 }),
    { prompt: 7, completion: 3, cached: 0, cacheCreation: 0, total: 10 },
  );
  assertEquals(normalizeUsage({}), {
    prompt: 0,
    completion: 0,
    cached: 0,
    cacheCreation: 0,
    total: 0,
  });
});

Deno.test("normalizeUsage preserves OpenAI and Anthropic cache-cost buckets", () => {
  assertEquals(
    normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
    }),
    { prompt: 100, completion: 20, cached: 60, cacheCreation: 0, total: 120 },
  );
  assertEquals(
    normalizeUsage({
      input_tokens: 40,
      output_tokens: 8,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    }),
    { prompt: 70, completion: 8, cached: 30, cacheCreation: 10, total: 88 },
  );
});

Deno.test("extractStreamUsage reads the OpenAI include_usage final chunk", () => {
  const text = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}',
    'data: {"model":"gpt-4o","choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
    "data: [DONE]",
  ].join("\n");
  assertEquals(extractStreamUsage(text), {
    model: "gpt-4o",
    prompt: 11,
    completion: 4,
    cached: 0,
    cacheCreation: 0,
    total: 15,
  });
});

Deno.test("extractStreamUsage reads the Anthropic message_start shape", () => {
  const text = [
    'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":20,"output_tokens":0}}}',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
  ].join("\n");
  const found = extractStreamUsage(text);
  assertEquals(found?.model, "claude-sonnet-4-5");
  assertEquals(found?.prompt, 20);
  assertEquals(found?.completion, 9); // max() across chunks
});

Deno.test("extractStreamUsage reads GenAI and Cohere translated usage tails", () => {
  const genAi = extractStreamUsage(
    'data: {"modelVersion":"gemini-2.5-pro","usageMetadata":{"promptTokenCount":13,"candidatesTokenCount":7}}',
  );
  assertEquals(genAi, {
    model: "gemini-2.5-pro",
    prompt: 13,
    completion: 7,
    cached: 0,
    cacheCreation: 0,
    total: 20,
  });

  const cohere = extractStreamUsage(
    'data: {"model":"command-a","delta":{"usage":{"billed_units":{"input_tokens":5,"output_tokens":3}}}}',
  );
  assertEquals(cohere, {
    model: "command-a",
    prompt: 5,
    completion: 3,
    cached: 0,
    cacheCreation: 0,
    total: 8,
  });
});

Deno.test("extractStreamUsage returns undefined without a usage block", () => {
  assertEquals(
    extractStreamUsage('data: {"model":"m","choices":[]}\ndata: [DONE]'),
    undefined,
  );
});

// Regression: the streamed span was attributed to "unknown" because the model
// was only reachable through extractStreamUsage, which yields nothing without a
// usage block - and most providers omit usage from stream chunks unless asked.
Deno.test("extractStreamModel finds the model when the stream carries NO usage", () => {
  const text =
    'data: {"model":"gemma-4","choices":[{"delta":{"content":"a"}}]}\n' +
    'data: {"model":"gemma-4","choices":[{"delta":{"content":"b"}}]}\n' +
    "data: [DONE]";
  assertEquals(extractStreamUsage(text), undefined);
  assertEquals(extractStreamModel(text), "gemma-4");
});

Deno.test("extractStreamModel covers the translated vendor shapes", () => {
  assertEquals(
    extractStreamModel(
      'data: {"message":{"model":"claude-x"},"type":"message_start"}',
    ),
    "claude-x",
  );
  assertEquals(
    extractStreamModel('data: {"modelVersion":"gemini-y","candidates":[]}'),
    "gemini-y",
  );
});

Deno.test("extractStreamModel returns the FIRST model and tolerates junk lines", () => {
  const text = ": comment line\n" +
    "data: {not json\n" +
    'data: {"choices":[]}\n' +
    'data: {"model":"first"}\n' +
    'data: {"model":"second"}\n' +
    "data: [DONE]";
  assertEquals(extractStreamModel(text), "first");
});

Deno.test("extractStreamModel returns empty when no chunk names a model", () => {
  assertEquals(extractStreamModel('data: {"choices":[]}\ndata: [DONE]'), "");
  assertEquals(extractStreamModel(""), "");
});

Deno.test("tapSseTail passes bytes through, captures tail usage + first chunk", async () => {
  const frames = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"model":"gpt-4o","usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });

  let captured: ReturnType<typeof extractStreamUsage>;
  let firstChunks = 0;
  let chunks = 0;
  const tapped = tapSseTail(
    source,
    (text) => {
      captured = extractStreamUsage(text);
    },
    () => {
      firstChunks++;
    },
    () => {
      chunks++;
    },
  );

  // Bytes are forwarded untouched.
  assertEquals(await new Response(tapped).text(), frames.join(""));
  assertEquals(captured, {
    model: "gpt-4o",
    prompt: 3,
    completion: 2,
    cached: 0,
    cacheCreation: 0,
    total: 5,
  });
  assertEquals(firstChunks, 1); // fires exactly once
  assertEquals(chunks, frames.length);
});

// --- Oversized terminal frames ---------------------------------------------
//
// The tap's head/tail windows are 16384 chars each. Translators that buffer
// tool-call arguments and emit them WHOLE in the same frame as usage (GenAI)
// can push that frame past the tail window, at which point the windowed text
// holds no complete `data:` line and the request billed NOTHING. The retained
// last-complete-frame slot is what closes that hole; these tests pin it.

const TAP_CAP = 16_384; // mirrors SSE_TAP_CAP (module-private)
const FRAME_CAP = 131_072; // mirrors SSE_FRAME_CAP (module-private)

const enc = new TextEncoder();

/** One stream chunk per string, encoded as UTF-8. */
function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(enc.encode(piece));
      }
      controller.close();
    },
  });
}

/** One stream chunk per byte array, so chunk seams can be placed exactly. */
function byteStreamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Every byte a stream produced, concatenated. */
async function drainBytes(
  body: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * A canonical tool-call stream: name first, then argument FRAGMENTS, then the
 * finish + include_usage frames. `args` must be valid JSON or the translator
 * collapses it to `{}` - which is plausibly why this defect went unnoticed.
 */
function canonicalToolCallFrames(args: string, model: string): string[] {
  const frame = (choices: unknown[], usage?: unknown): string =>
    `data: ${
      JSON.stringify({
        id: "chatcmpl-tap",
        object: "chat.completion.chunk",
        model,
        choices,
        ...(usage ? { usage } : {}),
      })
    }\n\n`;
  const frames = [frame([{
    index: 0,
    delta: {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "write_file", arguments: "" },
      }],
    },
  }])];
  for (let i = 0; i < args.length; i += 4096) {
    frames.push(frame([{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: args.slice(i, i + 4096) },
        }],
      },
    }]));
  }
  frames.push(frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
  frames.push(frame([], { prompt_tokens: 1000, completion_tokens: 500 }));
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** The GenAI-translated bytes for a write_file call carrying `contentChars`. */
function genAiToolCallBody(contentChars: number): ReadableStream<Uint8Array> {
  const args = JSON.stringify({
    path: "src/generated.ts",
    content: "x".repeat(contentChars),
  });
  return translateSSEBody(
    streamOf(canonicalToolCallFrames(args, "gemini-2.5-pro")),
    new GenAIStreamTranslator("gemini-2.5-pro"),
  );
}

// Regression: a GenAI terminal frame larger than the tail window left the tap
// holding two truncated halves of one line, so extractStreamUsage returned
// undefined and the request billed nothing (telemetry logged prompt=0 too).
Deno.test("tapSseTail bills a GenAI terminal frame larger than the tail window", async () => {
  let captured: ReturnType<typeof extractStreamUsage>;
  const tapped = tapSseTail(genAiToolCallBody(60_000), (text) => {
    captured = extractStreamUsage(text);
  });
  const body = await new Response(tapped).text();

  // The frame really must exceed the window, or this test proves nothing.
  const terminal = body.split("\n").filter((l) => l.startsWith("data:")).at(
    -1,
  )!;
  assert(
    terminal.length > TAP_CAP,
    `terminal frame ${terminal.length} chars, needs > ${TAP_CAP}`,
  );
  assertEquals(captured, {
    model: "gemini-2.5-pro",
    prompt: 1000,
    completion: 500,
    cached: 0,
    cacheCreation: 0,
    total: 1500,
  });
});

Deno.test("tapSseTail forwards an oversized frame byte-identically", async () => {
  const expected = await drainBytes(genAiToolCallBody(60_000));
  const tapped = tapSseTail(genAiToolCallBody(60_000), () => {});
  assertEquals(await drainBytes(tapped), expected);
});

Deno.test("tapSseTail assembles a frame split across many tiny chunks", async () => {
  const whole = await new Response(genAiToolCallBody(30_000)).text();
  const pieces: string[] = [];
  for (let i = 0; i < whole.length; i += 13) {
    pieces.push(whole.slice(i, i + 13));
  }

  let captured: ReturnType<typeof extractStreamUsage>;
  const tapped = tapSseTail(streamOf(pieces), (text) => {
    captured = extractStreamUsage(text);
  });
  assertEquals(await new Response(tapped).text(), whole);
  assertEquals(captured?.prompt, 1000);
  assertEquals(captured?.completion, 500);
  assertEquals(captured?.model, "gemini-2.5-pro");
});

Deno.test("tapSseTail keeps a multi-byte character split across a chunk seam intact", async () => {
  // One oversized frame, so recovery runs through the retained-frame path, with
  // an emoji whose 4 UTF-8 bytes straddle the seam between the two chunks.
  const frame = `data: ${
    JSON.stringify({
      modelVersion: "gemini-2.5-pro",
      candidates: [{
        content: {
          role: "model",
          parts: [{ text: "\u{1F600}" + "y".repeat(20_000) }],
        },
        finishReason: "STOP",
        index: 0,
      }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
    })
  }\n\n`;
  const bytes = enc.encode(frame);
  const seam = enc.encode(frame.slice(0, frame.indexOf("\u{1F600}"))).length +
    2;
  const chunks = [bytes.slice(0, seam), bytes.slice(seam)];

  let text = "";
  const tapped = tapSseTail(byteStreamOf(chunks), (captured) => {
    text = captured;
  });
  assertEquals(await drainBytes(tapped), bytes); // client bytes untouched
  assert(!text.includes("�"), "decoder emitted a replacement character");
  assert(text.includes("\u{1F600}"), "emoji lost at the chunk seam");
  assertEquals(extractStreamUsage(text), {
    model: "gemini-2.5-pro",
    prompt: 11,
    completion: 4,
    cached: 0,
    cacheCreation: 0,
    total: 15,
  });
});

Deno.test("tapSseTail drops a frame past the frame cap without unbounded retention", async () => {
  // A frame beyond the cap is not retained; the head/tail windows still apply,
  // and a later in-cap usage frame is still billed (overflow state resets).
  const huge = `data: ${
    JSON.stringify({ model: "m", junk: "z".repeat(FRAME_CAP * 2) })
  }\n\n`;
  const usage =
    'data: {"model":"m","usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n';

  let text = "";
  const tapped = tapSseTail(streamOf([huge, usage]), (captured) => {
    text = captured;
  });
  assertEquals(await new Response(tapped).text(), huge + usage);
  assert(
    text.length <= TAP_CAP * 2 + FRAME_CAP + 2,
    `capture grew to ${text.length} chars, cap is ${
      TAP_CAP * 2 + FRAME_CAP + 2
    }`,
  );
  assert(text.length < huge.length, "oversized frame was retained whole");
  assertEquals(extractStreamUsage(text)?.prompt, 7);
  assertEquals(extractStreamUsage(text)?.completion, 2);
});

Deno.test("tapSseTail retained frame cannot double-count a small stream", async () => {
  // On a small stream the usage frame lands in the tail window AND the retained
  // slot. extractStreamUsage takes max() per field, so the result must equal an
  // untapped scan of the same text exactly - duplication is a no-op, not a
  // second charge.
  const frames = [
    'data: {"model":"gpt-4o","choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"model":"gpt-4o","usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
  let text = "";
  const tapped = tapSseTail(streamOf(frames), (captured) => {
    text = captured;
  });
  await new Response(tapped).text();

  const usageLine = frames[1].trimEnd();
  assert(text.split(usageLine).length - 1 >= 2, "frame must appear repeatedly");
  assertEquals(extractStreamUsage(text), extractStreamUsage(frames.join("")));
  assertEquals(extractStreamModel(text), "gpt-4o");
});

/**
 * Every usage shape the repository's own fixtures carry, with the expected
 * output captured from normalizeUsage BEFORE the J.1 clamps landed. One change
 * touches every surface's token accounting, so this is the no-op proof: the
 * clamp must not move a single existing number. Compared as JSON text, which
 * also pins key order.
 */
const USAGE_FIXTURES: Array<[string, Record<string, unknown>, string]> = [
  ["openai chat (two_tier_test:22)", {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  }, '{"prompt":1,"completion":2,"cached":0,"cacheCreation":0,"total":3}'],
  ["openai chat (accumulate_test:92)", {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
  }, '{"prompt":11,"completion":22,"cached":0,"cacheCreation":0,"total":33}'],
  ["openai chat, no total (accumulate_test:236)", {
    prompt_tokens: 4,
    completion_tokens: 6,
  }, '{"prompt":4,"completion":6,"cached":0,"cacheCreation":0,"total":10}'],
  ["openai stream final (stream_test:105)", {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8,
  }, '{"prompt":3,"completion":5,"cached":0,"cacheCreation":0,"total":8}'],
  [
    "openai cached subset (pricing_test:22-26)",
    {
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 400 },
    },
    '{"prompt":1000,"completion":500,"cached":400,"cacheCreation":0,"total":1500}',
  ],
  ["openai embeddings (mock_provider:72)", {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  }, '{"prompt":1,"completion":1,"cached":0,"cacheCreation":0,"total":2}'],
  ["anthropic message_start (anthropic_test:96)", {
    input_tokens: 9,
  }, '{"prompt":9,"completion":0,"cached":0,"cacheCreation":0,"total":9}'],
  ["anthropic non-stream (anthropic_test:178)", {
    input_tokens: 10,
    output_tokens: 5,
  }, '{"prompt":10,"completion":5,"cached":0,"cacheCreation":0,"total":15}'],
  ["anthropic cache buckets", {
    input_tokens: 40,
    output_tokens: 8,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
  }, '{"prompt":70,"completion":8,"cached":30,"cacheCreation":10,"total":88}'],
  ["anthropic message_delta, output only", {
    output_tokens: 9,
  }, '{"prompt":0,"completion":9,"cached":0,"cacheCreation":0,"total":9}'],
  ["gemini usageMetadata (gemini_test:345)", {
    promptTokenCount: 5,
    candidatesTokenCount: 7,
    totalTokenCount: 12,
  }, '{"prompt":5,"completion":7,"cached":0,"cacheCreation":0,"total":12}'],
  ["gemini usageMetadata (gemini_test:767)", {
    promptTokenCount: 1,
    candidatesTokenCount: 2,
    totalTokenCount: 3,
  }, '{"prompt":1,"completion":2,"cached":0,"cacheCreation":0,"total":3}'],
  [
    "gemini cached content",
    {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 60,
    },
    '{"prompt":100,"completion":20,"cached":60,"cacheCreation":0,"total":120}',
  ],
  ["cohere billed_units (cohere_test:38)", {
    billed_units: { input_tokens: 5, output_tokens: 2 },
  }, '{"prompt":5,"completion":2,"cached":0,"cacheCreation":0,"total":7}'],
  ["cohere billed_units (cohere_test:123)", {
    billed_units: { input_tokens: 10, output_tokens: 5 },
  }, '{"prompt":10,"completion":5,"cached":0,"cacheCreation":0,"total":15}'],
  ["cohere embed meta (cohere.ts:383)", {
    billed_units: { input_tokens: 7 },
  }, '{"prompt":7,"completion":0,"cached":0,"cacheCreation":0,"total":7}'],
  [
    "empty",
    {},
    '{"prompt":0,"completion":0,"cached":0,"cacheCreation":0,"total":0}',
  ],
];

Deno.test("normalizeUsage clamps byte-identically over the existing usage fixtures (D1-T20)", () => {
  for (const [name, usage, expected] of USAGE_FIXTURES) {
    assertEquals(
      JSON.stringify(normalizeUsage(usage as UsageShape)),
      expected,
      name,
    );
  }
  assertEquals(USAGE_FIXTURES.length, 17);
});

Deno.test("normalizeUsage clamps negative token counts to 0 (D1-T20)", () => {
  // costMicroUsd multiplies these, and governance.ts:782 increments a Prometheus
  // counter with the product inside `if (cost)`: -2 500 000 is truthy, so an
  // unclamped negative renders a DECREASING counter.
  assertEquals(normalizeUsage({ prompt_tokens: -1_000_000 }), {
    prompt: 0,
    completion: 0,
    cached: 0,
    cacheCreation: 0,
    total: 0,
  });
  assertEquals(
    normalizeUsage({
      prompt_tokens: -5,
      completion_tokens: -6,
      prompt_tokens_details: { cached_tokens: -7 },
      cache_creation_input_tokens: -8,
    }),
    { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, total: 0 },
  );
  // The derived total follows the clamped components, never the raw ones.
  assertEquals(normalizeUsage({ prompt_tokens: -100, completion_tokens: 7 }), {
    prompt: 0,
    completion: 7,
    cached: 0,
    cacheCreation: 0,
    total: 7,
  });
});

Deno.test("normalizeUsage truncates non-integer token counts (D1-T20)", () => {
  assertEquals(
    normalizeUsage({
      prompt_tokens: 10.9,
      completion_tokens: 4.1,
      prompt_tokens_details: { cached_tokens: 2.7 },
      cache_creation_input_tokens: 1.999,
    }),
    { prompt: 10, completion: 4, cached: 2, cacheCreation: 1, total: 15 },
  );
  // A sub-1 fraction is not a token.
  assertEquals(normalizeUsage({ prompt_tokens: 0.6 }).prompt, 0);
});

Deno.test("normalizeUsage clamps non-finite and non-numeric usage to 0 (D1-T20)", () => {
  assertEquals(
    normalizeUsage({ prompt_tokens: Infinity, completion_tokens: NaN }),
    { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, total: 0 },
  );
  // 1e308 + 1e308 overflows to Infinity inside the Anthropic prompt sum, so the
  // clamp has to reject non-finite AFTER the arithmetic, not only before it.
  assertEquals(
    normalizeUsage({ input_tokens: 1e308, cache_read_input_tokens: 1e308 })
      .prompt,
    0,
  );
  // A vendor sending a string must not become NaN downstream.
  assertEquals(
    normalizeUsage({ prompt_tokens: "12" } as unknown as UsageShape).prompt,
    0,
  );
  assertEquals(
    normalizeUsage({ prompt_tokens: 1e308 }).prompt,
    Number.MAX_SAFE_INTEGER,
  );
});

Deno.test("clampCount and clampSeconds are exported for the route-side clamps (J.1)", () => {
  // clampCount: token and image counts. Non-negative safe integer, or 0.
  assertEquals(clampCount(7), 7);
  assertEquals(clampCount(0), 0);
  assertEquals(clampCount(-0), 0);
  assertEquals(clampCount(-1), 0);
  assertEquals(clampCount(2.9), 2);
  assertEquals(clampCount(Infinity), 0);
  assertEquals(clampCount(-Infinity), 0);
  assertEquals(clampCount(NaN), 0);
  assertEquals(clampCount(1e308), Number.MAX_SAFE_INTEGER);
  assertEquals(clampCount("5"), 0);
  assertEquals(clampCount(undefined), 0);
  assertEquals(clampCount(null), 0);

  // clampSeconds: audio duration. Fractional is legitimate; absence is not 0.
  assertEquals(clampSeconds(12.5), 12.5);
  assertEquals(clampSeconds(0), 0);
  assertEquals(clampSeconds(-0.5), undefined);
  assertEquals(clampSeconds(Infinity), undefined);
  assertEquals(clampSeconds(NaN), undefined);
  assertEquals(clampSeconds(undefined), undefined);
  assertEquals(clampSeconds("3"), undefined);
  // 1e308 is representable and finite: seconds carry no integer contract, so
  // magnitude is bounded by the rate ceiling, not here.
  assertEquals(clampSeconds(1e308), 1e308);
});

function mediaRequest(path = "/v1/images/generations"): Request {
  return new Request(`http://gateway.test${path}`, { method: "POST" });
}

function fakeCounters(): {
  counts: Map<string, number>;
  increment(name: string, value?: number): void;
} {
  const counts = new Map<string, number>();
  return {
    counts,
    increment(name: string, value = 1) {
      counts.set(name, (counts.get(name) ?? 0) + value);
    },
  };
}

Deno.test("channel: setRequestDispatch round-trips, and an unwritten request reads undefined", () => {
  const req = mediaRequest();
  assertEquals(getRequestDispatch(req), undefined);
  assertEquals(
    setRequestDispatch(req, { providerId: "openai", model: "gpt-image-1" }),
    true,
  );
  assertEquals(getRequestDispatch(req), {
    providerId: "openai",
    model: "gpt-image-1",
  });
});

Deno.test("channel: setRequestDispatch is first-write-wins and counts the rewrite (D1 condition 10)", () => {
  const req = mediaRequest();
  const metrics = fakeCounters();
  assertEquals(
    setRequestDispatch(
      req,
      { providerId: "openai", model: "gpt-image-1" },
      metrics,
    ),
    true,
  );
  // The first write is not a rewrite.
  assertEquals(metrics.counts.get("accounting.dispatch_rewritten"), undefined);
  assertEquals(
    setRequestDispatch(
      req,
      { providerId: "gemini", model: "imagen-4.0-generate-001" },
      metrics,
    ),
    false,
  );
  // The channel is authoritative at both accounting sites, so a last-write-wins
  // setter would bill a provider that was never dispatched to.
  assertEquals(getRequestDispatch(req), {
    providerId: "openai",
    model: "gpt-image-1",
  });
  assertEquals(metrics.counts.get("accounting.dispatch_rewritten"), 1);
});

Deno.test("channel: mergeRequestUnits/mergeRequestTokens are not rewrites (D1 condition 10)", () => {
  const req = mediaRequest();
  const metrics = fakeCounters();
  setRequestDispatch(
    req,
    { providerId: "openai", model: "gpt-image-1", providerStatus: 200 },
    metrics,
  );
  mergeRequestUnits(req, { imageCount: 2 });
  mergeRequestUnits(req, { characterCount: 11 });
  mergeRequestTokens(req, {
    prompt: 5,
    completion: 0,
    cached: 0,
    cacheCreation: 0,
  });
  assertEquals(getRequestDispatch(req), {
    providerId: "openai",
    model: "gpt-image-1",
    providerStatus: 200,
    units: { imageCount: 2, characterCount: 11 },
    tokens: { prompt: 5, completion: 0, cached: 0, cacheCreation: 0 },
  });
  // The normal two-phase flow (dispatch, then quantities) is not a rewrite.
  assertEquals(metrics.counts.get("accounting.dispatch_rewritten"), undefined);
});

Deno.test("channel: a merge with no dispatch record is dropped, never attributed to an empty target", () => {
  // Fail closed against MISATTRIBUTION, which E.2 names as the worse outcome: a
  // quantity with no recorded target is dropped rather than billed to "".
  const req = mediaRequest();
  mergeRequestUnits(req, { imageCount: 3 });
  mergeRequestTokens(req, {
    prompt: 1,
    completion: 1,
    cached: 0,
    cacheCreation: 0,
  });
  assertEquals(getRequestDispatch(req), undefined);
});

Deno.test("channel: markSettled is per-site, once each, and one site never suppresses the other (B.7)", () => {
  const req = mediaRequest();
  setRequestDispatch(req, { providerId: "openai", model: "gpt-image-1" });
  assertEquals(markSettled(req, "governance"), true);
  assertEquals(markSettled(req, "governance"), false);
  // governance owns recordCost, telemetry owns emit: each must run exactly once,
  // so settling one must NOT short-circuit the other.
  assertEquals(markSettled(req, "telemetry"), true);
  assertEquals(markSettled(req, "telemetry"), false);
  assertEquals(getRequestDispatch(req)!.settledBy, {
    governance: true,
    telemetry: true,
  });
});

Deno.test("channel: markSettled on a request with no dispatch record settles nothing", () => {
  assertEquals(markSettled(mediaRequest(), "governance"), false);
  assertEquals(markSettled(mediaRequest(), "telemetry"), false);
});

Deno.test("channel: entries are keyed on request identity, not on the URL", () => {
  const a = mediaRequest();
  const b = mediaRequest();
  setRequestDispatch(a, { providerId: "openai", model: "gpt-image-1" });
  assertEquals(getRequestDispatch(b), undefined);
});

Deno.test("channel: two concurrent requests stay isolated", async () => {
  const images = mediaRequest("/v1/images/generations");
  const speech = mediaRequest("/v1/audio/speech");
  await Promise.all([
    (async () => {
      setRequestDispatch(images, {
        providerId: "openai",
        model: "gpt-image-1",
      });
      await Promise.resolve();
      mergeRequestUnits(images, { imageCount: 4 });
      markSettled(images, "governance");
    })(),
    (async () => {
      setRequestDispatch(speech, { providerId: "gemini", model: "tts-1" });
      await Promise.resolve();
      mergeRequestUnits(speech, { characterCount: 99 });
      markSettled(speech, "telemetry");
    })(),
  ]);
  assertEquals(getRequestDispatch(images), {
    providerId: "openai",
    model: "gpt-image-1",
    units: { imageCount: 4 },
    settledBy: { governance: true },
  });
  assertEquals(getRequestDispatch(speech), {
    providerId: "gemini",
    model: "tts-1",
    units: { characterCount: 99 },
    settledBy: { telemetry: true },
  });
});

Deno.test("channel: mergeRequestStatus records the provider's own status, once", () => {
  const req = mediaRequest();
  const metrics = fakeCounters();
  // No record yet: a status with no dispatch to attach to is dropped, like the
  // quantity merges.
  assertEquals(mergeRequestStatus(req, 200), false);
  assertEquals(getRequestDispatch(req), undefined);

  setRequestDispatch(
    req,
    { providerId: "openai", model: "gpt-image-1" },
    metrics,
  );
  assertEquals(mergeRequestStatus(req, 429), true);
  assertEquals(getRequestDispatch(req)!.providerStatus, 429);
  // Media routes dispatch exactly once, so a second provider status means a
  // second dispatch this channel never recorded: keep the first.
  assertEquals(mergeRequestStatus(req, 200), false);
  assertEquals(getRequestDispatch(req)!.providerStatus, 429);
  // Recording a status is not a target rewrite.
  assertEquals(metrics.counts.get("accounting.dispatch_rewritten"), undefined);
});

Deno.test("channel: a provider !ok records the status and no quantities (B.4 write gate)", () => {
  // The shape of the !ok path: providerStatus is the evidence a provider was
  // reached, and it must be recordable with units/tokens both absent - absence
  // means "not counted", never "zero".
  const req = mediaRequest();
  setRequestDispatch(req, { providerId: "openai", model: "gpt-image-1" });
  mergeRequestStatus(req, 400);
  assertEquals(getRequestDispatch(req), {
    providerId: "openai",
    model: "gpt-image-1",
    providerStatus: 400,
  });
});
