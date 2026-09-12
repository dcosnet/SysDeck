import { z } from "zod";

/**
 * Longest model key a pricing catalog may carry. Keys are operator-supplied and
 * become metric label values, so they need a length as well as a count bound.
 */
export const MAX_PRICING_KEY_LENGTH = 256;

/** Most models a pricing catalog may carry. ~14x the post-sync catalog. */
export const MAX_PRICING_KEYS = 20_000;

/**
 * Body cap for a pricing write, in place of the 25 MiB default that every other
 * JSON route uses. A pricing catalog is small, and this body is persisted and
 * reloaded at every boot.
 */
export const MAX_PRICING_BODY_BYTES = 4 * 1024 * 1024;

// Rate ceilings. Their job is REPRESENTABILITY, not business policy: cost is
// integer micro-USD, and `z.number().nonnegative()` rejects Infinity and NaN but
// ACCEPTS 1e308, which multiplied by any quantity leaves the safe-integer range.
// So `.max()` is the load-bearing constraint and `.finite()` would be redundant.
// Magnitude is bounded separately, by the gateway-set quantity ceilings in
// `limits.ts`, so the worst-case single-request bill is an operator-set rate
// times a gateway-set ceiling, never a caller-set quantity.

/** $1 per token, at the x1e6 scale these fields use. */
export const MAX_PER_MTOK_USD = 1_000_000;
/** Verbatim USD per generated image. */
export const MAX_PER_IMAGE_USD = 1_000;
/** Verbatim USD per second of audio. */
export const MAX_PER_SECOND_USD = 1_000;
/** $1 per character, at the x1e6 scale this field uses. */
export const MAX_PER_MCHAR_USD = 1_000_000;

const perMTok = () => z.number().nonnegative().max(MAX_PER_MTOK_USD);

/**
 * The one field set, shared by both schemas below so that the strict ingress
 * form and the tolerant load form cannot drift apart.
 */
const modelPriceShape = {
  inputPerMTokUsd: perMTok(),
  outputPerMTokUsd: perMTok(),

  // ---- Optional deepenings (all additive). When every field below is absent a
  // model prices exactly as the flat input/output rates it always did, so any
  // existing single-tier catalog is byte-for-byte unchanged.

  /** Prompt tokens SERVED FROM the provider cache. Absent => cached tokens bill
   * at the ordinary input rate, so the total is unchanged. */
  cacheReadPerMTokUsd: perMTok().optional(),
  /** Prompt tokens WRITTEN INTO the cache this request. Absent => not billed
   * separately. */
  cacheCreationPerMTokUsd: perMTok().optional(),

  /** Long-context tier rates, selected on prompt size. Absent => the base rate
   * applies at every prompt size. */
  inputPerMTokAbove128kUsd: perMTok().optional(),
  outputPerMTokAbove128kUsd: perMTok().optional(),
  inputPerMTokAbove200kUsd: perMTok().optional(),
  outputPerMTokAbove200kUsd: perMTok().optional(),

  /** Discounted async batch-API rates. Absent => batch bills at the normal
   * rate. */
  batchInputPerMTokUsd: perMTok().optional(),
  batchOutputPerMTokUsd: perMTok().optional(),

  // ---- Media rates. Only what the gateway maps is declared: per-pixel,
  // input-image and per-video rates are deliberately absent. All three optional,
  // so an existing catalog prices byte-identically.

  /** Verbatim USD per generated image (0.04 reads as-is). */
  outputPerImageUsd: z.number().nonnegative().max(MAX_PER_IMAGE_USD).optional(),
  /** USD per million input characters. Scaled x1e6 because a per-character rate
   * like 0.000015 is one dropped zero from a 10x bill. */
  inputPerMCharUsd: z.number().nonnegative().max(MAX_PER_MCHAR_USD).optional(),
  /** Verbatim USD per second of input audio (0.006 reads as-is). */
  inputPerAudioSecondUsd: z.number().nonnegative().max(MAX_PER_SECOND_USD)
    .optional(),
};

/**
 * A model's prices, for INGRESS. `.strict()`, because ingress is where operator
 * intent is expressed and must be exact: a mistyped rate name is a silent
 * mispricing that persists, not a no-op. The second `.strict()` in this package,
 * for the same reason as the first (`GatewayConfigSchema`).
 *
 * `.strict()` rejects an unknown key but ACCEPTS a missing optional, so it does
 * not stop a client that knows only two fields from wiping the other eleven.
 * That gap is closed by a per-model `PATCH`, not by this schema.
 */
export const ModelPriceSchema = z.object(modelPriceShape).strict();

/**
 * The same field set, for the PERSISTED LOAD path. Non-strict, so it strips
 * rather than rejects: a rate field a newer gateway added must be a downgrade on
 * rollback, not a refusal to boot. Value bounds are unchanged - tolerance is
 * about unknown keys, never about an unrepresentable number, which would reach
 * the coster from a persisted blob exactly as it would from ingress.
 */
export const PersistedModelPriceSchema = z.object(modelPriceShape);

export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/**
 * A whole pricing catalog at ingress: bounded key length, bounded key count,
 * strict per entry.
 */
export const PricingCatalogSchema = z.record(
  z.string().min(1).max(MAX_PRICING_KEY_LENGTH),
  ModelPriceSchema,
).refine((catalog) => Object.keys(catalog).length <= MAX_PRICING_KEYS, {
  message: `A pricing catalog cannot exceed ${MAX_PRICING_KEYS} models.`,
});

/** Named to avoid colliding with the `PricingCatalog` class in `governance`. */
export type ModelPriceCatalog = z.infer<typeof PricingCatalogSchema>;
