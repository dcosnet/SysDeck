import {
  hashVirtualKeyToken,
  type VirtualKey,
  VirtualKeyManager,
} from "./virtual_keys.ts";

/**
 * Governance admission microbenchmarks.
 *
 * `check` is the synchronous half of the admission path and runs once per
 * governed request: token hash, hash-indexed lookup, budget checks, then the
 * in-process rate and token windows. The `token-estimate` group sizes the two
 * things the middleware does to the request body before calling it.
 */

/** Consumes a result so the call cannot be optimized away. */
const sink: unknown[] = [];
function keep(value: unknown): void {
  sink[0] = value;
}

const TOKEN = "sk-frosty-bench-0123456789abcdef0123456789abcdef";

// Limits are set far above any achievable iteration count so every iteration
// takes the admit path; a window that exhausted mid-run would silently switch
// the benchmark to the (cheaper) denial path.
const KEY: VirtualKey = {
  id: "vk_bench",
  name: "bench key",
  token: TOKEN,
  enabled: true,
  rateLimit: { maxRequests: 1_000_000_000_000, windowMs: 3_600_000 },
  tokenLimit: { maxTokens: 1_000_000_000_000, windowMs: 3_600_000 },
  budget: { maxRequests: 1_000_000_000_000, maxCostUsd: 1_000_000 },
  usedRequests: 0,
  usedCostMicroUsd: 0,
};

const manager = new VirtualKeyManager([KEY]);

/** ~8 KB chat request: the body size the middleware sees from a real client. */
const body = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a concise engineering assistant." },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}: ${
        "the router rerouted on 429 only and the fallback chain held. ".repeat(
          8,
        )
      }`,
    })),
  ],
  temperature: 0.2,
  max_tokens: 1024,
  stream: true,
});

const estimatedTokens = Math.ceil(body.length / 4);

Deno.bench({
  name: "check, admit (hash, lookup, budgets, rate + token windows)",
  group: "governance-admission",
  baseline: true,
}, () => {
  keep(manager.check(TOKEN, estimatedTokens));
});

Deno.bench({
  name: "check, reject unknown token",
  group: "governance-admission",
}, () => {
  keep(manager.check("sk-frosty-not-a-real-key-000000000000", estimatedTokens));
});

Deno.bench({
  name: "hashVirtualKeyToken alone",
  group: "governance-admission",
}, () => {
  keep(hashVirtualKeyToken(TOKEN));
});

// Both mirror what the governance middleware does with the body text before
// admission (apps/gateway/routes/governance.ts): the chars/4 estimate, and the
// parse that recovers the requested model when the path does not carry it.
Deno.bench({
  name: `chars/4 token estimate, ${Math.round(body.length / 1024)} KB body`,
  group: "token-estimate",
  baseline: true,
}, () => {
  keep(Math.ceil(body.length / 4));
});

Deno.bench({
  name: `JSON.parse model extraction, ${
    Math.round(body.length / 1024)
  } KB body`,
  group: "token-estimate",
}, () => {
  keep((JSON.parse(body) as { model?: unknown }).model);
});
