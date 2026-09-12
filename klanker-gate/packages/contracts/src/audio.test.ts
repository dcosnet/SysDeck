import { assert, assertEquals } from "@std/assert";
import { SpeechRequestSchema, TranscriptionResponseSchema } from "./audio.ts";
import { MAX_TTS_INPUT_CHARS } from "./limits.ts";

// --- New typed shapes parse ---

Deno.test("SpeechRequestSchema - rich request (format/speed/instructions)", () => {
  const result = SpeechRequestSchema.safeParse({
    model: "gpt-4o-mini-tts",
    input: "hello there",
    voice: "alloy",
    response_format: "wav",
    speed: 1.25,
    instructions: "speak slowly",
    vendor_extra: "kept",
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.response_format, "wav");
    assertEquals(result.data.speed, 1.25);
    assertEquals(
      (result.data as Record<string, unknown>).vendor_extra,
      "kept",
    );
  }
});

Deno.test("TranscriptionResponseSchema - verbose response parses", () => {
  const result = TranscriptionResponseSchema.safeParse({
    text: "hello world",
    duration: 2.5,
    language: "english",
    segments: [{ start: 0, end: 1.2, text: "hello", seek: 0 }],
    words: [{ word: "hello", start: 0, end: 0.6 }],
    usage: { type: "duration", seconds: 2.5 },
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.segments?.[0].text, "hello");
    assertEquals(result.data.words?.[0].word, "hello");
    assertEquals(result.data.language, "english");
  }
});

Deno.test("SpeechRequestSchema - input is bounded by MAX_TTS_INPUT_CHARS", () => {
  // A TTS bill is the operator's per-character rate times a caller-supplied
  // character count. Without this bound the quantity is whatever
  // MAX_JSON_BODY_BYTES admits (~26.2M characters), so one POST buys an
  // unbounded bill.
  const over = SpeechRequestSchema.safeParse({
    model: "tts-1",
    input: "a".repeat(MAX_TTS_INPUT_CHARS + 1),
  });
  assert(!over.success);
  assertEquals(over.error.issues[0].path, ["input"]);
  assertEquals(over.error.issues[0].code, "too_big");

  const at = SpeechRequestSchema.safeParse({
    model: "tts-1",
    input: "a".repeat(MAX_TTS_INPUT_CHARS),
  });
  assert(at.success, `exactly ${MAX_TTS_INPUT_CHARS} characters is admitted`);

  // The bound is on `input`, not on `voice` - the field one line below it.
  const longVoice = SpeechRequestSchema.safeParse({
    model: "tts-1",
    input: "hello",
    voice: "v".repeat(MAX_TTS_INPUT_CHARS + 1),
  });
  assert(longVoice.success);
});

// --- BACKWARD-COMPAT: historical shapes still parse ---

Deno.test("BACKWARD-COMPAT: minimal speech request {model,input,voice}", () => {
  const result = SpeechRequestSchema.safeParse({
    model: "tts-1",
    input: "hello",
    voice: "alloy",
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: speech request without voice (widened) parses", () => {
  const result = SpeechRequestSchema.safeParse({
    model: "tts-1",
    input: "hello",
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: bare {text} transcription response parses", () => {
  const result = TranscriptionResponseSchema.safeParse({ text: "just text" });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.text, "just text");
    assertEquals(result.data.segments, undefined);
  }
});
