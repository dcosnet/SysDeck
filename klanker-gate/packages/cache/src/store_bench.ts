import { digestKey } from "./store.ts";

/**
 * L2 cache-key digest microbenchmark.
 *
 * `digestKey` is the only hashing on the cache path and it runs once per L2
 * read and once per L2 write. The measurement includes the `await` on
 * `crypto.subtle.digest`, so read it as the per-request cost of deriving the
 * shared-tier key, not as raw SHA-256 throughput. The L1 tier never calls it.
 */

const smallKey = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What is the CAP theorem?" }],
  temperature: 0.2,
});

/** ~40 KB: a long agent thread, which is where real keys land. */
const largeKey = JSON.stringify({
  model: "gpt-4o-mini",
  messages: Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Turn ${i}: ${
      "the gateway streamed the response unchanged. ".repeat(20)
    }`,
  })),
});

Deno.bench({
  name: "digestKey, 120-byte key",
  group: "cache-digest",
  baseline: true,
}, async () => {
  await digestKey(smallKey);
});

Deno.bench({
  name: `digestKey, ${Math.round(largeKey.length / 1024)} KB key`,
  group: "cache-digest",
}, async () => {
  await digestKey(largeKey);
});
