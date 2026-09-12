import { compareKeys, hasPrefix, keyId, type StateKey } from "./store.ts";

/**
 * State key-path microbenchmarks.
 *
 * `keyId` encodes a key path on every durable read, write, and counter
 * operation; `hasPrefix` and `compareKeys` run per candidate entry inside a
 * prefix listing, so their cost multiplies by result-set size rather than by
 * request count.
 */

/** Consumes a result so the call cannot be optimized away. */
const sink: unknown[] = [];
function keep(value: unknown): void {
  sink[0] = value;
}

const shortKey: StateKey = ["config", "providers", "openai"];
const longKey: StateKey = [
  "governance",
  "counters",
  "vk_9f2c1ba4",
  "cost",
  "2026-07",
];
const listPrefix: StateKey = ["governance", "counters", "vk_9f2c1ba4"];
const otherKey: StateKey = [
  "governance",
  "counters",
  "vk_9f2c1bb0",
  "cost",
  "2026-07",
];

Deno.bench({
  name: "keyId, 3-part path",
  group: "state-key",
  baseline: true,
}, () => {
  keep(keyId(shortKey));
});

Deno.bench({ name: "keyId, 5-part path", group: "state-key" }, () => {
  keep(keyId(longKey));
});

Deno.bench({ name: "hasPrefix, 5-part vs 3-part", group: "state-key" }, () => {
  keep(hasPrefix(longKey, listPrefix));
});

Deno.bench(
  { name: "compareKeys, two 5-part paths", group: "state-key" },
  () => {
    keep(compareKeys(longKey, otherKey));
  },
);
