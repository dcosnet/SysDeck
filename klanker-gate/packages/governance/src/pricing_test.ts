// Unit coverage for the deepened cost model: cache-read / cache-creation token
// pricing, long-context (>128k / >200k) tiers, batch rates, and per-mode keys.
// The overriding contract is backward compatibility: a model carrying only the
// two base rates must return the exact flat number it always did, regardless of
// which optional breakdown fields a caller supplies.

import { assertEquals } from "@std/assert";
import { PricingCatalog } from "./pricing.ts";

Deno.test("cost: flat price is unchanged AND immune to breakdown fields", () => {
  const c = new PricingCatalog(); // bundled DEFAULT_PRICES (flat only)
  // Baseline: exactly the historical result.
  assertEquals(
    c.costMicroUsd("gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 }),
    7500,
  );
  // A flat-priced model has no optional rates, so every optional usage field is
  // inert: cached folds back into the input rate, creation adds nothing, the
  // tier stays base, and batch is ignored -> the identical 7500.
  assertEquals(
    c.costMicroUsd("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cached_tokens: 400,
      cache_creation_tokens: 900,
      prompt_tokens_total: 300_000,
      batch: true,
    }),
    7500,
  );
  // Prefix + provider-prefix + unknown resolution is preserved.
  assertEquals(
    c.costMicroUsd("gpt-4o-2026-01-01", { prompt_tokens: 1000 }),
    2500,
  );
  assertEquals(c.costMicroUsd("openai/gpt-4o", { prompt_tokens: 1000 }), 2500);
  assertEquals(c.costMicroUsd("unknown-model", { prompt_tokens: 5 }), null);
});

Deno.test("resolveKey: prefix must end at a token boundary", () => {
  const c = new PricingCatalog({
    "gpt-4": { inputPerMTokUsd: 30, outputPerMTokUsd: 60 },
    "embedding": { inputPerMTokUsd: 1, outputPerMTokUsd: 0 },
  });
  // Exact and dated-variant (trailing '-') still resolve to the family key.
  assertEquals(c.resolveKey("gpt-4"), "gpt-4");
  assertEquals(c.resolveKey("gpt-4-0613"), "gpt-4");
  // A different adjacent-alphanumeric model must NOT capture gpt-4's price.
  assertEquals(c.resolveKey("gpt-4o"), undefined);
  // A mode lookup must not resolve to a plain model key named like the mode.
  assertEquals(c.resolveKey("text-3", "embedding"), undefined);
});

Deno.test("cost: cached tokens bill at the cache-read rate when set", () => {
  const c = new PricingCatalog({
    m: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 },
  });
  // 200 uncached @3 + 800 cached @0.3 + 200 completion @15 = 600 + 240 + 3000.
  assertEquals(
    c.costMicroUsd("m", {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 800,
    }),
    3840,
  );
  // Same usage against a model WITHOUT a cache-read price -> the flat number
  // (cached tokens fall back to the input rate: 1000*3 + 200*15).
  const flat = new PricingCatalog({
    m: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  });
  assertEquals(
    flat.costMicroUsd("m", {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 800,
    }),
    6000,
  );
});

Deno.test("cost: cache-creation is an additive bucket, billed only when priced", () => {
  const priced = new PricingCatalog({
    m: {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cacheCreationPerMTokUsd: 3.75,
    },
  });
  // 1000 input @3 + 400 creation @3.75 + 200 completion @15 = 3000 + 1500 + 3000.
  assertEquals(
    priced.costMicroUsd("m", {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cache_creation_tokens: 400,
    }),
    7500,
  );
  // No creation price -> the extra bucket contributes nothing (flat 6000).
  const flat = new PricingCatalog({
    m: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  });
  assertEquals(
    flat.costMicroUsd("m", {
      prompt_tokens: 1000,
      completion_tokens: 200,
      cache_creation_tokens: 400,
    }),
    6000,
  );
});

Deno.test("cost: cached_tokens is clamped to the prompt (never negative input)", () => {
  const c = new PricingCatalog({
    m: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 },
  });
  // cached 5000 > prompt 1000 -> clamped to 1000: 0 uncached + 1000*0.3 = 300.
  assertEquals(
    c.costMicroUsd("m", { prompt_tokens: 1000, cached_tokens: 5000 }),
    300,
  );
});

Deno.test("cost: long-context 128k tier applies past the threshold when priced", () => {
  const gem = new PricingCatalog({
    gem: {
      inputPerMTokUsd: 1.25,
      outputPerMTokUsd: 10,
      inputPerMTokAbove128kUsd: 2.5,
      outputPerMTokAbove128kUsd: 15,
    },
  });
  // Below threshold -> base rates: 1000*1.25 + 1000*10 = 11250.
  assertEquals(
    gem.costMicroUsd("gem", { prompt_tokens: 1000, completion_tokens: 1000 }),
    11_250,
  );
  // Above 128k -> tier rates on BOTH sides, keyed on prompt size:
  // 130000*2.5 + 1000*15 = 325000 + 15000.
  assertEquals(
    gem.costMicroUsd("gem", {
      prompt_tokens: 130_000,
      completion_tokens: 1000,
    }),
    340_000,
  );
});

Deno.test("cost: 200k tier applies, and prompt_tokens_total selects the tier", () => {
  const claude = new PricingCatalog({
    c: {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      inputPerMTokAbove200kUsd: 6,
      outputPerMTokAbove200kUsd: 22.5,
    },
  });
  // 210k prompt -> 200k tier: 210000*6 + 1000*22.5 = 1260000 + 22500.
  assertEquals(
    claude.costMicroUsd("c", {
      prompt_tokens: 210_000,
      completion_tokens: 1000,
    }),
    1_282_500,
  );
  // prompt_tokens narrowed (e.g. to the uncached remainder) but tiering keys on
  // the full context via prompt_tokens_total: 1000*6 + 500*22.5 = 6000 + 11250.
  assertEquals(
    claude.costMicroUsd("c", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_tokens_total: 210_000,
    }),
    17_250,
  );
});

Deno.test("cost: batch swaps in the batch rates only when flagged and priced", () => {
  const c = new PricingCatalog({
    b: {
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 6,
      batchInputPerMTokUsd: 1,
      batchOutputPerMTokUsd: 3,
    },
  });
  // Unflagged -> normal rates: 1000*2 + 1000*6 = 8000.
  assertEquals(
    c.costMicroUsd("b", { prompt_tokens: 1000, completion_tokens: 1000 }),
    8000,
  );
  // Flagged -> batch rates: 1000*1 + 1000*3 = 4000.
  assertEquals(
    c.costMicroUsd("b", {
      prompt_tokens: 1000,
      completion_tokens: 1000,
      batch: true,
    }),
    4000,
  );
  // Flagged against a model without batch rates -> stays on the normal rate.
  const noBatch = new PricingCatalog({
    b: { inputPerMTokUsd: 2, outputPerMTokUsd: 6 },
  });
  assertEquals(
    noBatch.costMicroUsd("b", {
      prompt_tokens: 1000,
      completion_tokens: 1000,
      batch: true,
    }),
    8000,
  );
});

Deno.test("cost: per-mode key prices distinctly, with model-only fallback", () => {
  const c = new PricingCatalog({
    "text-embedding-3-large": { inputPerMTokUsd: 0.13, outputPerMTokUsd: 0 },
    "embedding::text-embedding-3-large": {
      inputPerMTokUsd: 0.065,
      outputPerMTokUsd: 0,
    },
  });
  // Model-only lookup ignores the mode-keyed entry: 1e6 * 0.13.
  assertEquals(
    c.costMicroUsd("text-embedding-3-large", { prompt_tokens: 1_000_000 }),
    130_000,
  );
  // With the mode, the "<mode>::<model>" price wins: 1e6 * 0.065.
  assertEquals(
    c.costMicroUsd(
      "text-embedding-3-large",
      { prompt_tokens: 1_000_000 },
      "embedding",
    ),
    65_000,
  );
  // A mode with no mode-keyed entry falls back to the model price.
  assertEquals(
    c.costMicroUsd(
      "text-embedding-3-large",
      { prompt_tokens: 1_000_000 },
      "image",
    ),
    130_000,
  );
  // resolveKey mirrors the resolution (drives cardinality-bounded metric labels)
  // and still strips a provider prefix.
  assertEquals(
    c.resolveKey("openai/text-embedding-3-large", "embedding"),
    "embedding::text-embedding-3-large",
  );
  assertEquals(
    c.resolveKey("openai/text-embedding-3-large"),
    "text-embedding-3-large",
  );
});
