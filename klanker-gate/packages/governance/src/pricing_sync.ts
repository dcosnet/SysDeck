import type { ModelMeta, ModelPrice, PricingCatalog } from "./pricing.ts";
import type { Metrics } from "../../telemetry/src/metrics.ts";

export const DEFAULT_LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

/** The subset of LiteLLM's per-model record we consume. */
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  // Cache, long-context tier, and batch costs. Per-TOKEN USD like the base
  // costs; scaled to per-Mtok on ingest. LiteLLM omits these for models that do
  // not offer the feature, so each maps to an OPTIONAL ModelPrice field.
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_128k_tokens?: number;
  output_cost_per_token_above_128k_tokens?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
  max_input_tokens?: number;
  max_tokens?: number;
  litellm_provider?: string;
  mode?: string;
}

/**
 * A LiteLLM per-token cost expressed as per-Mtok USD, or undefined when the key
 * is absent or not a valid non-negative finite number.
 */
function perMTokCost(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw * 1e6
    : undefined;
}

export interface SyncPricingOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Failure counter sink (pricing.sync_failures). */
  metrics?: Metrics;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Persisted operator overrides (/api/pricing), re-applied AFTER the sync so an
   * operator's explicit price always wins over the upstream list.
   */
  overrides?: Record<string, ModelPrice> | null;
  /** Injectable env reader (defaults to Deno.env.get). Never a request value. */
  env?: (key: string) => string | undefined;
}

export interface SyncPricingResult {
  synced: number;
  updatedAt: string;
  error?: string;
}

function readEnv(
  env: ((key: string) => string | undefined) | undefined,
  key: string,
): string | undefined {
  try {
    return env ? env(key) : (Deno.env.get(key) ?? undefined);
  } catch {
    return undefined; // missing --allow-env: fall through to the default URL
  }
}

/**
 * Rejects non-https URLs. The URL is already env-only, but this blocks a
 * misconfigured `file://` / link-local / plaintext endpoint. `http:` is allowed
 * only for localhost so tests and self-hosted mirrors keep working.
 */
function assertHttpsUrl(url: string): void {
  const parsed = new URL(url);
  const localhostHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localhostHttp) {
    throw new Error(`pricing URL must use https (got "${parsed.protocol}")`);
  }
}

/** Fetches the URL with a timeout AND a hard byte cap, decoding to text. */
async function fetchCapped(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`pricing source responded ${res.status}`);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("pricing source returned no body");
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          controller.abort();
          throw new Error(`pricing source exceeded ${maxBytes}-byte cap`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refreshes `catalog` from the LiteLLM price list. Resolves with the number of
 * models applied (and an `error` string on failure); never rejects.
 */
export async function syncPricingFromLiteLLM(
  catalog: PricingCatalog,
  opts: SyncPricingOptions = {},
): Promise<SyncPricingResult> {
  const updatedAt = new Date().toISOString();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes && opts.maxBytes > 0
    ? opts.maxBytes
    : DEFAULT_MAX_BYTES;
  // SECURITY: the source URL is environment-derived ONLY. It is never taken
  // from an API caller or request body.
  const url = readEnv(opts.env, "FROSTY_PRICING_URL") ?? DEFAULT_LITELLM_URL;

  try {
    assertHttpsUrl(url);
    const text = await fetchCapped(url, fetchImpl, timeoutMs, maxBytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("pricing source was not a JSON object");
    }

    // Stage first; apply only after a fully successful parse so a mid-parse
    // failure can never leave the live catalog half-updated.
    const stagedPrices: Array<[string, ModelPrice]> = [];
    const stagedMeta: Array<[string, ModelMeta]> = [];
    for (const [model, raw] of Object.entries(parsed)) {
      // The pseudo-entry documents the schema; it is not a real model.
      if (model === "sample_spec" || !raw || typeof raw !== "object") {
        continue;
      }
      const entry = raw as LiteLLMEntry;
      const input = entry.input_cost_per_token;
      if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
        continue; // malformed or non-priced entry
      }
      const rawOutput = entry.output_cost_per_token;
      const output =
        typeof rawOutput === "number" && Number.isFinite(rawOutput) &&
          rawOutput >= 0
          ? rawOutput
          : 0;
      const price: ModelPrice = {
        inputPerMTokUsd: input * 1e6,
        outputPerMTokUsd: output * 1e6,
      };
      // Optional deepenings: attach each only when the upstream provides it, so
      // a model lacking these keys yields the same flat price it always did.
      const cacheRead = perMTokCost(entry.cache_read_input_token_cost);
      if (cacheRead !== undefined) {
        price.cacheReadPerMTokUsd = cacheRead;
      }
      const cacheCreation = perMTokCost(entry.cache_creation_input_token_cost);
      if (cacheCreation !== undefined) {
        price.cacheCreationPerMTokUsd = cacheCreation;
      }
      const in128 = perMTokCost(entry.input_cost_per_token_above_128k_tokens);
      if (in128 !== undefined) {
        price.inputPerMTokAbove128kUsd = in128;
      }
      const out128 = perMTokCost(entry.output_cost_per_token_above_128k_tokens);
      if (out128 !== undefined) {
        price.outputPerMTokAbove128kUsd = out128;
      }
      const in200 = perMTokCost(entry.input_cost_per_token_above_200k_tokens);
      if (in200 !== undefined) {
        price.inputPerMTokAbove200kUsd = in200;
      }
      const out200 = perMTokCost(entry.output_cost_per_token_above_200k_tokens);
      if (out200 !== undefined) {
        price.outputPerMTokAbove200kUsd = out200;
      }
      const batchIn = perMTokCost(entry.input_cost_per_token_batches);
      if (batchIn !== undefined) {
        price.batchInputPerMTokUsd = batchIn;
      }
      const batchOut = perMTokCost(entry.output_cost_per_token_batches);
      if (batchOut !== undefined) {
        price.batchOutputPerMTokUsd = batchOut;
      }
      stagedPrices.push([model, price]);
      const meta: ModelMeta = {};
      if (typeof entry.max_input_tokens === "number") {
        meta.contextWindow = entry.max_input_tokens;
      }
      if (typeof entry.max_tokens === "number") {
        meta.maxOutputTokens = entry.max_tokens;
      }
      if (typeof entry.mode === "string") {
        meta.modality = entry.mode;
      }
      if (Object.keys(meta).length > 0) {
        stagedMeta.push([model, meta]);
      }
    }

    for (const [model, price] of stagedPrices) {
      catalog.set(model, price);
    }
    for (const [model, meta] of stagedMeta) {
      catalog.setMeta(model, meta);
    }
    // Operator overrides win: re-apply persisted /api/pricing entries last.
    if (opts.overrides) {
      for (const [model, price] of Object.entries(opts.overrides)) {
        catalog.set(model, price);
      }
    }

    return { synced: stagedPrices.length, updatedAt };
  } catch (error) {
    // Keep the bundled DEFAULT_PRICES fallback intact; count and swallow.
    opts.metrics?.increment("pricing.sync_failures");
    return {
      synced: 0,
      updatedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
