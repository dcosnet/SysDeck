import { z } from "zod";
import { MAX_TTS_INPUT_CHARS } from "./limits.ts";

// Speech (text-to-speech). `voice` is now optional (some providers carry the
// voice out-of-band) and format/speed/instructions are additive optionals.
// Passthrough so vendor fields on the wire survive to the provider.
export const SpeechRequestSchema = z.object({
  model: z.string(),
  /** Bounded: the billed quantity is this field's length, so without a ceiling
   * one POST buys a bill limited only by MAX_JSON_BODY_BYTES. */
  input: z.string().max(MAX_TTS_INPUT_CHARS),
  voice: z.string().optional(),
  response_format: z.union([
    z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]),
    z.string(),
  ]).optional(),
  speed: z.number().optional(),
  instructions: z.string().optional(),
}).passthrough();
export type SpeechRequest = z.infer<typeof SpeechRequestSchema>;

export const TranscriptionRequestSchema = z.object({
  file: z.instanceof(File).or(z.custom<Blob>((val) => val instanceof Blob)),
  model: z.string(),
});
export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

// Verbose transcription sub-objects. Each is passthrough so the fuller wire
// shape (id/seek/tokens/logprobs/...) survives on top of the named fields.
export const TranscriptionSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
}).passthrough();
export type TranscriptionSegment = z.infer<typeof TranscriptionSegmentSchema>;

export const TranscriptionWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
}).passthrough();
export type TranscriptionWord = z.infer<typeof TranscriptionWordSchema>;

// Usage covers both the token-based and duration-based wire variants.
export const TranscriptionUsageSchema = z.object({
  type: z.string().optional(),
  seconds: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
}).passthrough();
export type TranscriptionUsage = z.infer<typeof TranscriptionUsageSchema>;

// `text` stays required (as today); everything else is additive optional so
// the plain `{ text }` verbose=false response still parses unchanged.
export const TranscriptionResponseSchema = z.object({
  text: z.string(),
  duration: z.number().optional(),
  language: z.string().optional(),
  segments: z.array(TranscriptionSegmentSchema).optional(),
  words: z.array(TranscriptionWordSchema).optional(),
  usage: TranscriptionUsageSchema.optional(),
}).passthrough();
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;
