import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { PricingCatalog } from "./pricing.ts";
import { DEFAULT_LITELLM_URL, syncPricingFromLiteLLM } from "./pricing_sync.ts";
import { Metrics } from "../../telemetry/src/metrics.ts";

function jsonFetch(payload: unknown, capturedUrls?: string[]): typeof fetch {
  return ((input: RequestInfo | URL) => {
    capturedUrls?.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

Deno.test("sync maps prices + metadata; skips sample_spec and malformed", async () => {
  const catalog = new PricingCatalog({});
  const urls: string[] = [];
  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({
      sample_spec: { input_cost_per_token: 0.1 }, // pseudo-entry, skipped
      "gpt-4o": {
        input_cost_per_token: 0.0000025, // -> 2.5 per Mtok
        output_cost_per_token: 0.00001, // -> 10 per Mtok
        max_input_tokens: 128000,
        max_tokens: 16384,
        litellm_provider: "openai",
        mode: "chat",
      },
      "no-input-cost": { output_cost_per_token: 0.5 }, // malformed, skipped
    }, urls),
    env: () => undefined, // force the default URL
  });

  assertEquals(result.synced, 1);
  assertEquals(result.error, undefined);
  // SECURITY: the URL is the env/default, never a caller value.
  assertEquals(urls[0], DEFAULT_LITELLM_URL);

  const price = catalog.get("gpt-4o")!;
  assertAlmostEquals(price.inputPerMTokUsd, 2.5, 1e-9);
  assertAlmostEquals(price.outputPerMTokUsd, 10, 1e-9);
  const meta = catalog.getMeta("gpt-4o")!;
  assertEquals(meta.contextWindow, 128000);
  assertEquals(meta.maxOutputTokens, 16384);
  assertEquals(meta.modality, "chat");

  assertEquals(catalog.get("sample_spec"), undefined);
  assertEquals(catalog.get("no-input-cost"), undefined);
});

Deno.test("sync reads the URL from the environment only", async () => {
  const catalog = new PricingCatalog({});
  const urls: string[] = [];
  await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({ m: { input_cost_per_token: 0.000001 } }, urls),
    env: (key) =>
      key === "FROSTY_PRICING_URL"
        ? "https://prices.example/list.json"
        : undefined,
  });
  assertEquals(urls[0], "https://prices.example/list.json");
});

Deno.test("network failure keeps the catalog unchanged and counts a failure", async () => {
  const catalog = new PricingCatalog(); // bundled DEFAULT_PRICES
  const before = catalog.list();
  const metrics = new Metrics();
  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: (() =>
      Promise.reject(new Error("network down"))) as typeof fetch,
    metrics,
  });
  assertEquals(result.synced, 0);
  assert(result.error !== undefined);
  assertEquals(catalog.list(), before); // fallback intact
  assertEquals(metrics.get("pricing.sync_failures"), 1);
});

Deno.test("oversize response is rejected under the byte cap", async () => {
  const catalog = new PricingCatalog({});
  const metrics = new Metrics();
  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({
      pad: "x".repeat(50_000),
      m: { input_cost_per_token: 0.000001 },
    }),
    maxBytes: 1024, // payload is far larger than 1 KB
    metrics,
  });
  assertEquals(result.synced, 0);
  assert(result.error?.includes("cap"));
  assertEquals(metrics.get("pricing.sync_failures"), 1);
  assertEquals(catalog.get("m"), undefined);
});

Deno.test("a stalled fetch is aborted by the timeout", async () => {
  const catalog = new PricingCatalog({});
  const metrics = new Metrics();
  const stalled =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
        );
      })) as typeof fetch;

  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: stalled,
    timeoutMs: 30,
    metrics,
  });
  assertEquals(result.synced, 0);
  assert(result.error !== undefined);
  assertEquals(metrics.get("pricing.sync_failures"), 1);
});

Deno.test("sync ingests cache, tiered, and batch costs into the optional fields", async () => {
  const catalog = new PricingCatalog({});
  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({
      "claude-x": {
        input_cost_per_token: 0.000003, // 3 /Mtok
        output_cost_per_token: 0.000015, // 15 /Mtok
        cache_read_input_token_cost: 0.0000003, // 0.3 /Mtok
        cache_creation_input_token_cost: 0.00000375, // 3.75 /Mtok
        input_cost_per_token_above_200k_tokens: 0.000006, // 6 /Mtok
        output_cost_per_token_above_200k_tokens: 0.0000225, // 22.5 /Mtok
        input_cost_per_token_batches: 0.0000015, // 1.5 /Mtok
        output_cost_per_token_batches: 0.0000075, // 7.5 /Mtok
      },
      "gem-x": {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        input_cost_per_token_above_128k_tokens: 0.0000025, // 2.5 /Mtok
        output_cost_per_token_above_128k_tokens: 0.000015, // 15 /Mtok
      },
    }),
    env: () => undefined,
  });
  assertEquals(result.synced, 2);

  const c = catalog.get("claude-x")!;
  assertAlmostEquals(c.inputPerMTokUsd, 3, 1e-9);
  assertAlmostEquals(c.cacheReadPerMTokUsd!, 0.3, 1e-9);
  assertAlmostEquals(c.cacheCreationPerMTokUsd!, 3.75, 1e-9);
  assertAlmostEquals(c.inputPerMTokAbove200kUsd!, 6, 1e-9);
  assertAlmostEquals(c.outputPerMTokAbove200kUsd!, 22.5, 1e-9);
  assertAlmostEquals(c.batchInputPerMTokUsd!, 1.5, 1e-9);
  assertAlmostEquals(c.batchOutputPerMTokUsd!, 7.5, 1e-9);
  // Tiers the upstream did not provide stay undefined.
  assertEquals(c.inputPerMTokAbove128kUsd, undefined);

  const g = catalog.get("gem-x")!;
  assertAlmostEquals(g.inputPerMTokAbove128kUsd!, 2.5, 1e-9);
  assertAlmostEquals(g.outputPerMTokAbove128kUsd!, 15, 1e-9);
  assertEquals(g.cacheReadPerMTokUsd, undefined);

  // End-to-end: the ingested deep price actually deepens the cost. A 210k prompt
  // (>200k) bills the tier: 210000*6 + 1000*22.5 = 1260000 + 22500.
  assertEquals(
    catalog.costMicroUsd("claude-x", {
      prompt_tokens: 210_000,
      completion_tokens: 1000,
    }),
    1_282_500,
  );
});

Deno.test("sync leaves optional deep-pricing fields undefined when upstream omits them", async () => {
  const catalog = new PricingCatalog({});
  await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({
      flat: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000006 },
    }),
    env: () => undefined,
  });
  const p = catalog.get("flat")!;
  assertEquals(p.cacheReadPerMTokUsd, undefined);
  assertEquals(p.cacheCreationPerMTokUsd, undefined);
  assertEquals(p.inputPerMTokAbove128kUsd, undefined);
  assertEquals(p.inputPerMTokAbove200kUsd, undefined);
  assertEquals(p.batchInputPerMTokUsd, undefined);
  // Flat cost is exactly input/output: 1000*2 + 1000*6.
  assertEquals(
    catalog.costMicroUsd("flat", {
      prompt_tokens: 1000,
      completion_tokens: 1000,
    }),
    8000,
  );
});

Deno.test("operator overrides are re-applied after sync and win", async () => {
  const catalog = new PricingCatalog({});
  const result = await syncPricingFromLiteLLM(catalog, {
    fetchImpl: jsonFetch({
      "gpt-4o": {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
      },
    }),
    overrides: { "gpt-4o": { inputPerMTokUsd: 99, outputPerMTokUsd: 88 } },
  });
  assertEquals(result.synced, 1);
  const price = catalog.get("gpt-4o")!;
  assertEquals(price.inputPerMTokUsd, 99); // override beats the synced 2.5
  assertEquals(price.outputPerMTokUsd, 88);
});
