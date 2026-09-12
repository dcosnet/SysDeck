export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;

  // ---- Optional deepenings (all additive). When EVERY field below is absent a
  // model prices exactly as the flat inputPerMTokUsd / outputPerMTokUsd it
  // always did, so any existing single-tier catalog is byte-for-byte unchanged.

  /**
   * Price for prompt tokens SERVED FROM the provider cache (Anthropic
   * cache-read / OpenAI cached input). Applied to the `cached_tokens` subset of
   * the prompt; the remainder bills at the input rate. Absent => cached tokens
   * bill at the ordinary input rate (no discount), so the total is unchanged.
   */
  cacheReadPerMTokUsd?: number;
  /**
   * Price for prompt tokens WRITTEN INTO the cache this request (Anthropic
   * cache-creation). Applied to the additional `cache_creation_tokens` bucket.
   * Absent => cache-creation tokens are not billed separately.
   */
  cacheCreationPerMTokUsd?: number;

  /**
   * Long-context tier rates, applied once the prompt exceeds the threshold
   * (Gemini-style >128k, Claude-style >200k). Selected on prompt size; absent
   * => the base rate applies at every prompt size.
   */
  inputPerMTokAbove128kUsd?: number;
  outputPerMTokAbove128kUsd?: number;
  inputPerMTokAbove200kUsd?: number;
  outputPerMTokAbove200kUsd?: number;

  /**
   * Discounted async batch-API rates, applied only when the usage record is
   * flagged `batch`. Absent => batch requests bill at the normal rate.
   */
  batchInputPerMTokUsd?: number;
  batchOutputPerMTokUsd?: number;
}

/** Optional model capabilities, populated by the LiteLLM pricing sync. */
export interface ModelMeta {
  contextWindow?: number;
  maxOutputTokens?: number;
  modality?: string;
}

export interface UsageTokens {
  prompt_tokens?: number;
  completion_tokens?: number;

  // ---- Optional richer breakdown (all additive). When these are absent (or a
  // model has no matching optional price) costMicroUsd returns the exact number
  // it returned before these fields existed. ----

  /**
   * Prompt tokens served from cache (a SUBSET of prompt_tokens). Billed at the
   * model's cache-read rate when set, else at the input rate. Clamped to
   * prompt_tokens, so an over-large value can never bill negative input.
   */
  cached_tokens?: number;
  /**
   * Prompt tokens written to the cache this request (an ADDITIONAL bucket, not
   * part of prompt_tokens). Billed at the model's cache-creation rate when set;
   * with no such rate it adds nothing.
   */
  cache_creation_tokens?: number;
  /**
   * Total prompt size used to select the >128k / >200k tier. Defaults to
   * prompt_tokens; pass it when prompt_tokens has been narrowed (e.g. to the
   * uncached portion) but tiering should still key on the full context length.
   */
  prompt_tokens_total?: number;
  /** Bills at the model's batch rates when it defines them. */
  batch?: boolean;
}

/** Long-context tier thresholds (prompt tokens; strictly greater-than). */
const TIER_128K = 128_000;
const TIER_200K = 200_000;

/**
 * The effective per-Mtok rate for a prompt of `promptSize` tokens: the >200k
 * rate above 200k, else the >128k rate above 128k, else the base rate. A
 * missing higher tier falls through to the next configured rate (ultimately
 * the base), so a catalog may define either, both, or neither tier.
 */
function tierRate(
  base: number,
  above128k: number | undefined,
  above200k: number | undefined,
  promptSize: number,
): number {
  if (promptSize > TIER_200K && above200k !== undefined) {
    return above200k;
  }
  if (promptSize > TIER_128K && above128k !== undefined) {
    return above128k;
  }
  return base;
}

/** Static seed (representative 2026 list prices); operators override via API. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "gpt-4o": { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 },
  "gpt-4o-mini": { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
  "gpt-4-turbo": { inputPerMTokUsd: 10, outputPerMTokUsd: 30 },
  "claude-sonnet-4-5": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-opus-4-5": { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  "claude-haiku-4-5": { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 },
  "gemini-2.5-pro": { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 },
  "gemini-2.5-flash": { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
  "mistral-large-latest": { inputPerMTokUsd: 2, outputPerMTokUsd: 6 },
  "command-r-plus": { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 },
};

export class PricingCatalog {
  private prices: Map<string, ModelPrice>;
  /** Parallel capability map, keyed like `prices`. Independent of ModelPrice. */
  private meta = new Map<string, ModelMeta>();

  constructor(seed: Record<string, ModelPrice> = DEFAULT_PRICES) {
    this.prices = new Map(Object.entries(seed));
  }

  set(model: string, price: ModelPrice): void {
    this.prices.set(model, price);
  }

  /**
   * The catalog KEY a model resolves to (exact match, else longest configured
   * prefix), or undefined. Used both for pricing and to bound metric-label
   * cardinality to the known catalog rather than arbitrary caller strings.
   */
  resolveKey(model: string, mode?: string): string | undefined {
    const bare = model.includes("/")
      ? model.slice(model.indexOf("/") + 1)
      : model;
    if (mode) {
      const modeHit = this.longestKeyFor(`${mode}::${bare}`);
      if (modeHit !== undefined) {
        return modeHit;
      }
    }
    if (this.prices.has(bare)) {
      return bare;
    }
    if (this.prices.has(model)) {
      return model;
    }
    return this.longestKeyFor(bare);
  }

  /** Exact match on `query`, else the longest configured key that prefixes it. */
  private longestKeyFor(query: string): string | undefined {
    if (this.prices.has(query)) {
      return query;
    }
    let best: string | undefined;
    for (const key of this.prices.keys()) {
      if (!query.startsWith(key)) {
        continue;
      }
      const next = query[key.length];
      const atBoundary = next === undefined || next === "-" || next === "/" ||
        next === "@";
      if (atBoundary && (best === undefined || key.length > best.length)) {
        best = key;
      }
    }
    return best;
  }

  /**
   * Exact match, else longest configured prefix (dated model variants). Pass
   * `mode` to prefer a per-mode price (see resolveKey); omitting it keeps the
   * historical model-only lookup.
   */
  get(model: string, mode?: string): ModelPrice | undefined {
    const key = this.resolveKey(model, mode);
    return key === undefined ? undefined : this.prices.get(key);
  }

  list(): Record<string, ModelPrice> {
    return Object.fromEntries(this.prices);
  }

  /** Every configured catalog key; the allowlist for bounded metric labels. */
  modelKeys(): string[] {
    return [...this.prices.keys()];
  }

  replace(prices: Record<string, ModelPrice>): void {
    this.prices = new Map(Object.entries(prices));
  }

  /** Records optional capabilities for a model (LiteLLM sync). */
  setMeta(model: string, meta: ModelMeta): void {
    this.meta.set(model, meta);
  }

  getMeta(model: string): ModelMeta | undefined {
    const bare = model.includes("/")
      ? model.slice(model.indexOf("/") + 1)
      : model;
    return this.meta.get(bare) ?? this.meta.get(model);
  }

  listMeta(): Record<string, ModelMeta> {
    return Object.fromEntries(this.meta);
  }

  /**
   * Integer micro-USD for a usage record, or null when the model is unpriced.
   * tokens/1e6 * $perM * 1e6 micro = tokens * $perM.
   *
   * With only `prompt_tokens` / `completion_tokens` (and a model carrying only
   * the two base rates) this is the flat `prompt*input + completion*output` it
   * always was. The optional breakdown layers on strictly when BOTH the usage
   * field and the matching optional price are present:
   *   - `cached_tokens` (a subset of the prompt) bill at cacheReadPerMTokUsd;
   *   - `cache_creation_tokens` (an extra bucket) bill at cacheCreationPerMTokUsd;
   *   - a prompt past 128k / 200k bills at the corresponding tier rate;
   *   - `batch` swaps in the batch rates.
   * Every optional price a model omits leaves those tokens on the base rate, so
   * a flat-priced model returns the identical number no matter what breakdown a
   * caller supplies. Pass `mode` to price a per-mode ("<mode>::<model>") entry.
   */
  costMicroUsd(
    model: string,
    usage: UsageTokens,
    mode?: string,
  ): number | null {
    const price = this.get(model, mode);
    if (!price) {
      return null;
    }

    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;

    // Tier is chosen on the full context length; default it to prompt_tokens.
    const promptSize = usage.prompt_tokens_total ?? prompt;
    let inputRate = tierRate(
      price.inputPerMTokUsd,
      price.inputPerMTokAbove128kUsd,
      price.inputPerMTokAbove200kUsd,
      promptSize,
    );
    let outputRate = tierRate(
      price.outputPerMTokUsd,
      price.outputPerMTokAbove128kUsd,
      price.outputPerMTokAbove200kUsd,
      promptSize,
    );

    // Batch API: a distinct discounted flat rate, used only when requested AND
    // the model prices it. Replaces the (tiered) base rate on that side.
    if (usage.batch) {
      if (price.batchInputPerMTokUsd !== undefined) {
        inputRate = price.batchInputPerMTokUsd;
      }
      if (price.batchOutputPerMTokUsd !== undefined) {
        outputRate = price.batchOutputPerMTokUsd;
      }
    }

    // Cache-read tokens are a subset of the prompt: bill them at the cache-read
    // rate (else the input rate) and the uncached remainder at the input rate.
    // Clamp so an over-large value can never drive the remainder negative.
    const cached = Math.min(Math.max(usage.cached_tokens ?? 0, 0), prompt);
    const cacheReadRate = price.cacheReadPerMTokUsd ?? inputRate;

    // Cache-creation tokens are an additional bucket, billed only when priced.
    const created = Math.max(usage.cache_creation_tokens ?? 0, 0);
    const cacheCreateCost = price.cacheCreationPerMTokUsd !== undefined
      ? created * price.cacheCreationPerMTokUsd
      : 0;

    return Math.round(
      (prompt - cached) * inputRate +
        cached * cacheReadRate +
        cacheCreateCost +
        completion * outputRate,
    );
  }
}
