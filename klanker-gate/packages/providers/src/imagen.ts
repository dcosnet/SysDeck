import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "../../contracts/src/mod.ts";

/** Default Imagen model when the request does not name one. */
export const DEFAULT_IMAGEN_MODEL = "imagen-3.0-generate-002";

/** A single Imagen `:predict` prediction (base64-encoded image bytes). */
export interface ImagenPrediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
}

/** The `:predict` request body Google Imagen expects. */
export interface ImagenPredictBody {
  instances: Array<{ prompt: string }>;
  parameters: Record<string, unknown>;
}

/** Maps an OpenAI `size` ("1024x1792") to the nearest Imagen aspect ratio.
 * Returns undefined when the size is absent or unparseable so the parameter
 * is simply omitted (Imagen then applies its own default). */
export function sizeToAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  const ratio = w / h;
  if (ratio === 1) return "1:1";
  if (ratio > 1) return ratio >= 1.7 ? "16:9" : "4:3";
  return ratio <= 0.6 ? "9:16" : "3:4";
}

/** Strips any `google/` prefix and defaults to the standard Imagen model. */
export function resolveImagenModel(model?: string): string {
  const bare = (model ?? "").replace(/^google\//, "").trim();
  return bare || DEFAULT_IMAGEN_MODEL;
}

/**
 * Translates an ImageGenerationRequest into a Google Imagen `:predict` body:
 * `{ instances: [{ prompt }], parameters: {...} }`. `sampleCount` defaults to
 * `sampleCount ?? n ?? 1`; `aspectRatio` is taken verbatim or derived from
 * `size`; `negativePrompt` and `seed` pass through only when present.
 */
export function buildImagenPredictBody(
  req: ImageGenerationRequest,
): ImagenPredictBody {
  const parameters: Record<string, unknown> = {
    sampleCount: req.sampleCount ?? req.n ?? 1,
  };
  const aspectRatio = req.aspectRatio ?? sizeToAspectRatio(req.size);
  if (aspectRatio) parameters.aspectRatio = aspectRatio;
  if (req.negativePrompt !== undefined) {
    parameters.negativePrompt = req.negativePrompt;
  }
  if (req.seed !== undefined) parameters.seed = req.seed;
  return { instances: [{ prompt: req.prompt }], parameters };
}

/** Maps Imagen `:predict` predictions to the OpenAI image-response shape,
 * exposing each image's base64 bytes as `b64_json` (Imagen returns bytes, not
 * hosted URLs). */
export function mapImagenResponse(
  predictions: ImagenPrediction[],
): ImageGenerationResponse {
  return {
    created: Math.floor(Date.now() / 1000),
    data: predictions.map((p) => ({ b64_json: p.bytesBase64Encoded ?? "" })),
  };
}
