import { z } from "zod";
import { MAX_IMAGE_N } from "./limits.ts";

// Passthrough so vendor fields the gateway does not model (quality, style,
// background, output_format, moderation) survive to provider egress.
export const ImageGenerationRequestSchema = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  /** Images to generate. Bounded: it sizes the gateway's buffering
   * reservation, so an unbounded value is a caller-chosen memory cost. */
  n: z.number().int().positive().max(MAX_IMAGE_N).optional(),
  size: z.string().optional(),
  /** Imagen aspect ratio, e.g. "1:1", "16:9", "9:16", "4:3", "3:4". */
  aspectRatio: z.string().optional(),
  /** Number of images to sample; takes precedence over `n` when both are set,
   * so it carries the identical bound. */
  sampleCount: z.number().int().positive().max(MAX_IMAGE_N).optional(),
  /** Prompt describing what to avoid in the generated image. */
  negativePrompt: z.string().optional(),
  /** Preferred delivery of generated images ("url" or "b64_json"). Adapters
   * that always inline (Imagen, hf-inference) ignore it. */
  response_format: z.enum(["url", "b64_json"]).optional(),
  /** Deterministic sampling seed. */
  seed: z.number().optional(),
}).passthrough();
export type ImageGenerationRequest = z.infer<
  typeof ImageGenerationRequestSchema
>;

/**
 * Deliberately NOT passthrough: this schema is `.parse()`d nowhere and exists
 * only as the source of the inferred type below, where an index signature would
 * widen every adapter return for no benefit.
 */
export const ImageGenerationResponseSchema = z.object({
  created: z.number(),
  data: z.array(z.object({
    url: z.string().optional(),
    b64_json: z.string().optional(),
  })),
  /** Token usage a gpt-image-1-class response reports alongside the images. An
   * image request can bill on two dimensions at once, so the token half has to
   * be visible on the adapter return type. `normalizeUsage` maps
   * `input_tokens` and `output_tokens`; `total_tokens` is declared for wire
   * fidelity and is deliberately NOT consumed, because that function derives
   * the total itself (`usage.ts`: prompt + completion + cacheCreation) rather
   * than trusting a vendor's arithmetic. */
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
});
export type ImageGenerationResponse = z.infer<
  typeof ImageGenerationResponseSchema
>;
