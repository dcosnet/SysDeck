// The two pure quantity readers behind the media accounting channel. The route
// halves of these cases (and the in-flight budget, which needs a real provider
// to hold a reservation open) live in tests/integration/media_billing_test.ts.

import { assertEquals } from "@std/assert";
import { countUnits, tokensFrom } from "./advanced.ts";

// -- countUnits: the pathname gate -----------------------------------------

// D1-T2, unit half. `data: [...]` is not an image marker: /v1/embeddings answers
// with exactly that shape, so a shape-driven count bills embeddings as images.
// This assertion CANNOT fail on unmodified code by accident - it is the direct
// probe of the gate, and it is what the M-PATH mutant (gate on `Array.isArray`
// instead of the pathname) kills.
Deno.test("D1-T2: countUnits is gated on the pathname, never the shape", () => {
  const embeddingShaped = {
    object: "list",
    data: [{ embedding: [0.1] }, { embedding: [0.2] }, { embedding: [0.3] }],
  };
  assertEquals(countUnits("/v1/embeddings", embeddingShaped), {});
  assertEquals(countUnits("/v1/chat/completions", embeddingShaped), {});
  assertEquals(countUnits("/v1/files", embeddingShaped), {});
  // The same body on the image pathname does count.
  assertEquals(countUnits("/v1/images/generations", embeddingShaped), {
    imageCount: 3,
  });
});

Deno.test("countUnits: imageCount comes from data.length, clamped", () => {
  assertEquals(
    countUnits("/v1/images/generations", { data: [{ url: "a" }] }),
    { imageCount: 1 },
  );
  assertEquals(countUnits("/v1/images/generations", { data: [] }), {
    imageCount: 0,
  });
  // Absence of `data`, a non-array `data`, and a non-object body are all
  // "not counted" rather than zero.
  assertEquals(countUnits("/v1/images/generations", { created: 1 }), {});
  assertEquals(countUnits("/v1/images/generations", { data: "nope" }), {});
  assertEquals(countUnits("/v1/images/generations", undefined), {});
  assertEquals(countUnits("/v1/images/generations", "not json at all"), {});
});

// D1-T4, unit half: usage.seconds wins, duration is the fallback, and neither
// records nothing at all rather than a billable zero.
Deno.test("D1-T4: audioSeconds prefers usage.seconds, falls back to duration", () => {
  const p = "/v1/audio/transcriptions";
  assertEquals(countUnits(p, { usage: { seconds: 3.5 }, duration: 9 }), {
    audioSeconds: 3.5,
  });
  assertEquals(countUnits(p, { duration: 9 }), { audioSeconds: 9 });
  assertEquals(countUnits(p, { usage: { seconds: 0 } }), { audioSeconds: 0 });
  assertEquals(countUnits(p, { text: "words" }), {});
  // A token-shaped transcription usage carries no `seconds`; that must not be
  // read as zero seconds.
  assertEquals(
    countUnits(p, { usage: { type: "tokens", input_tokens: 5 } }),
    {},
  );
  // Hostile / broken values are dropped, never billed.
  assertEquals(countUnits(p, { duration: -1 }), {});
  assertEquals(countUnits(p, { duration: Infinity }), {});
  assertEquals(countUnits(p, { duration: NaN }), {});
  assertEquals(countUnits(p, { duration: "12" }), {});
  assertEquals(countUnits(p, { usage: "duration" }), {});
});

// -- tokensFrom ------------------------------------------------------------

Deno.test("tokensFrom: reads usage and usageMetadata through normalizeUsage", () => {
  assertEquals(
    tokensFrom({ usage: { input_tokens: 12, output_tokens: 3 } }),
    { prompt: 12, completion: 3, cached: 0, cacheCreation: 0 },
  );
  assertEquals(
    tokensFrom({ usage: { prompt_tokens: 7, completion_tokens: 2 } }),
    { prompt: 7, completion: 2, cached: 0, cacheCreation: 0 },
  );
  // Gemini's native block, under its own key.
  assertEquals(
    tokensFrom({
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
    }),
    { prompt: 4, completion: 6, cached: 0, cacheCreation: 0 },
  );
  // `usage` wins when both are present.
  assertEquals(
    tokensFrom({
      usage: { prompt_tokens: 1 },
      usageMetadata: { promptTokenCount: 99 },
    }),
    { prompt: 1, completion: 0, cached: 0, cacheCreation: 0 },
  );
});

// Absence must not become a billed zero (decision-log 56). A duration-shaped
// transcription usage carries no token fields at all, and it is the shape that
// makes this rule load-bearing rather than theoretical.
Deno.test("tokensFrom: a body with no token fields reports ABSENT, not zeros", () => {
  assertEquals(tokensFrom({ text: "words" }), undefined);
  assertEquals(tokensFrom({}), undefined);
  assertEquals(tokensFrom(undefined), undefined);
  assertEquals(tokensFrom({ usage: null }), undefined);
  assertEquals(tokensFrom({ usage: "tokens" }), undefined);
  assertEquals(
    tokensFrom({ usage: { type: "duration", seconds: 12 } }),
    undefined,
  );
  // An explicitly zero usage block is also reported absent: it prices to the
  // same figure either way, so nothing is lost by not inventing a row.
  assertEquals(
    tokensFrom({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    undefined,
  );
});

Deno.test("tokensFrom: hostile numbers are clamped, not propagated", () => {
  assertEquals(
    tokensFrom({ usage: { prompt_tokens: -5, completion_tokens: 2.7 } }),
    { prompt: 0, completion: 2, cached: 0, cacheCreation: 0 },
  );
  assertEquals(
    tokensFrom({ usage: { prompt_tokens: Infinity, completion_tokens: 1 } }),
    { prompt: 0, completion: 1, cached: 0, cacheCreation: 0 },
  );
  assertEquals(
    tokensFrom({ usage: { prompt_tokens: 1e308, completion_tokens: 1 } }),
    {
      prompt: Number.MAX_SAFE_INTEGER,
      completion: 1,
      cached: 0,
      cacheCreation: 0,
    },
  );
  // NaN in every bucket collapses to "no tokens at all", not to NaN rows.
  assertEquals(tokensFrom({ usage: { prompt_tokens: NaN } }), undefined);
});
