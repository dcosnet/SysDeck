import { assert, assertEquals } from "@std/assert";
import type { StateStore } from "./store.ts";

export interface ContractCase {
  name: string;
  run: (store: StateStore) => Promise<void>;
}

export const STATE_STORE_CONTRACT: ContractCase[] = [
  {
    name: "set/get round-trips JSON-shaped values",
    async run(store) {
      await store.set(["config", "providers", "openai"], {
        id: "openai",
        nested: { list: [1, 2, 3], flag: true },
      });
      assertEquals(
        await store.get(["config", "providers", "openai"]),
        { id: "openai", nested: { list: [1, 2, 3], flag: true } },
      );
    },
  },
  {
    name: "get returns null for an absent key",
    async run(store) {
      assertEquals(await store.get(["config", "providers", "nope"]), null);
    },
  },
  {
    name: "set overwrites wholesale rather than merging",
    async run(store) {
      await store.set(["config", "x"], { a: 1, b: 2 });
      await store.set(["config", "x"], { a: 9 });
      assertEquals(await store.get(["config", "x"]), { a: 9 });
    },
  },
  {
    name: "list returns descendants in lexicographic key order",
    async run(store) {
      await store.set(["config", "providers", "c"], 3);
      await store.set(["config", "providers", "a"], 1);
      await store.set(["config", "providers", "b"], 2);
      const rows = await store.list<number>(["config", "providers"]);
      assertEquals(rows.map((r) => r.value), [1, 2, 3]);
      assertEquals(rows.map((r) => r.key[2]), ["a", "b", "c"]);
    },
  },
  {
    name: "list EXCLUDES the entry stored at the prefix itself",
    async run(store) {
      // Deno KV's prefix semantics, preserved: list(["a"]) yields the
      // descendants of ["a"], not the value at ["a"].
      await store.set(["ns"], "self");
      await store.set(["ns", "child"], "child");
      const rows = await store.list<string>(["ns"]);
      assertEquals(rows.map((r) => r.value), ["child"]);
    },
  },
  {
    name: "list honors reverse and limit",
    async run(store) {
      for (const id of ["a", "b", "c", "d"]) {
        await store.set(["logs", id], id);
      }
      assertEquals(
        (await store.list<string>(["logs"], { reverse: true })).map((r) =>
          r.value
        ),
        ["d", "c", "b", "a"],
      );
      assertEquals(
        (await store.list<string>(["logs"], { limit: 2 })).map((r) => r.value),
        ["a", "b"],
      );
      assertEquals(
        (await store.list<string>(["logs"], { reverse: true, limit: 2 }))
          .map((r) => r.value),
        ["d", "c"],
      );
    },
  },
  {
    name: "list does not leak across sibling prefixes",
    async run(store) {
      await store.set(["governance", "usage", "k1"], 1);
      await store.set(["governance", "usage-anchor", "k1"], 2);
      const rows = await store.list<number>(["governance", "usage"]);
      // "usage-anchor" starts with "usage" as a STRING but is a different key
      // path element. A naive LIKE 'usage%' prefix match would wrongly match it.
      assertEquals(rows.length, 1);
      assertEquals(rows[0].value, 1);
    },
  },
  {
    name: "keys returns paths only",
    async run(store) {
      await store.set(["logs", "a"], { big: "payload" });
      await store.set(["logs", "b"], { big: "payload" });
      const keys = await store.keys(["logs"]);
      assertEquals(keys.map((k) => k[1]), ["a", "b"]);
    },
  },
  {
    name: "delete removes one key and is idempotent",
    async run(store) {
      await store.set(["config", "gone"], 1);
      await store.delete(["config", "gone"]);
      assertEquals(await store.get(["config", "gone"]), null);
      await store.delete(["config", "gone"]);
    },
  },
  {
    name: "sum accumulates atomically and getCount reads it back",
    async run(store) {
      await store.sum(["governance", "cost", "k1"], 100n);
      await store.sum(["governance", "cost", "k1"], 250n);
      assertEquals(await store.getCount(["governance", "cost", "k1"]), 350);
    },
  },
  {
    name: "getCount is 0 for an absent counter",
    async run(store) {
      assertEquals(await store.getCount(["governance", "cost", "absent"]), 0);
    },
  },
  {
    name: "counters and values are SEPARATE namespaces",
    async run(store) {
      // Same key path, one of each. Neither may shadow the other - conflating
      // them is what forced the old Deno.KvU64 casts through ConfigService.
      await store.set(["governance", "dual"], { kind: "value" });
      await store.sum(["governance", "dual"], 7n);
      assertEquals(await store.get(["governance", "dual"]), { kind: "value" });
      assertEquals(await store.getCount(["governance", "dual"]), 7);
    },
  },
  {
    name: "listCounts prefix-lists the counter namespace in key order",
    async run(store) {
      await store.sum(["governance", "team-usage", "b"], 2n);
      await store.sum(["governance", "team-usage", "a"], 1n);
      const rows = await store.listCounts(["governance", "team-usage"]);
      assertEquals(rows.map((r) => [r.key[2], r.value]), [["a", 1], ["b", 2]]);
    },
  },
  {
    name: "deleteCount removes a counter; delete() does NOT touch counters",
    async run(store) {
      await store.sum(["governance", "usage", "k1"], 5n);
      await store.delete(["governance", "usage", "k1"]);
      assertEquals(await store.getCount(["governance", "usage", "k1"]), 5);

      await store.deleteCount(["governance", "usage", "k1"]);
      assertEquals(await store.getCount(["governance", "usage", "k1"]), 0);
      assertEquals(
        (await store.listCounts(["governance", "usage"])).length,
        0,
      );
    },
  },
  {
    name: "deleteCount is idempotent",
    async run(store) {
      await store.deleteCount(["governance", "usage", "never-existed"]);
    },
  },
  {
    name: "getOrSet returns the FIRST value and never overwrites",
    async run(store) {
      assertEquals(await store.getOrSet(["governance", "anchor"], 111), 111);
      assertEquals(await store.getOrSet(["governance", "anchor"], 222), 111);
      assertEquals(await store.get(["governance", "anchor"]), 111);
    },
  },
  {
    name: "reserveCounts admits up to max, then reports exhausted",
    async run(store) {
      const limits = [{ key: ["governance", "res", "k"] as const, max: 3 }];
      assertEquals(await store.reserveCounts(limits), "reserved");
      assertEquals(await store.reserveCounts(limits), "reserved");
      assertEquals(await store.reserveCounts(limits), "reserved");
      assertEquals(await store.reserveCounts(limits), "exhausted");
      assertEquals(await store.getCount(["governance", "res", "k"]), 3);
    },
  },
  {
    name: "reserveCounts is all-or-nothing across every supplied counter",
    async run(store) {
      const key = ["governance", "multi", "key"] as const;
      const team = ["governance", "multi", "team"] as const;
      // Team is already at its limit; the key is not. The reservation must be
      // refused AND must not leave the key's counter incremented, or a denied
      // request would still consume budget.
      await store.sum(team, 5n);
      const result = await store.reserveCounts([
        { key, max: 100 },
        { key: team, max: 5 },
      ]);
      assertEquals(result, "exhausted");
      assertEquals(await store.getCount(key), 0);
      assertEquals(await store.getCount(team), 5);
    },
  },
  {
    name: "reserveCounts admits EXACTLY max under concurrency",
    async run(store) {
      // The lifetime-budget race decision-log 42 closed per-process, now
      // enforced across processes by the store itself. 25 concurrent admits
      // against a budget of 5 must admit 5.
      const limits = [{ key: ["governance", "race", "k"] as const, max: 5 }];
      const results = await Promise.all(
        Array.from({ length: 25 }, () => store.reserveCounts(limits)),
      );
      const reserved = results.filter((r) => r === "reserved").length;
      assertEquals(reserved, 5);
      assertEquals(await store.getCount(["governance", "race", "k"]), 5);
      // Nothing may be silently dropped: every attempt is accounted for.
      assert(
        results.every((r) =>
          r === "reserved" || r === "exhausted" || r === "conflict"
        ),
      );
    },
  },
  {
    name: "reserveCounts with no limits admits",
    async run(store) {
      assertEquals(await store.reserveCounts([]), "reserved");
    },
  },
  {
    name: "reserveCounts consumes `amount`, not always one",
    async run(store) {
      // Token metering reserves the estimated token count. Both stores must
      // agree, or a fleet-wide token window means something different
      // depending on which implementation is behind it.
      const key = ["governance", "amount", "k"] as const;
      assertEquals(
        await store.reserveCounts([{ key, max: 100, amount: 40 }]),
        "reserved",
      );
      assertEquals(await store.getCount(key), 40);
      assertEquals(
        await store.reserveCounts([{ key, max: 100, amount: 40 }]),
        "reserved",
      );
      assertEquals(await store.getCount(key), 80);
      assertEquals(
        await store.reserveCounts([{ key, max: 100, amount: 40 }]),
        "exhausted",
      );
      // The denied reservation consumed nothing.
      assertEquals(await store.getCount(key), 80);
    },
  },
  {
    name: "reserveCounts: an amount larger than max never poisons the window",
    async run(store) {
      // A single oversized request must be denied WITHOUT recording anything,
      // or it locks out every later request in the same window.
      const key = ["governance", "oversize", "k"] as const;
      assertEquals(
        await store.reserveCounts([{ key, max: 10, amount: 999 }]),
        "exhausted",
      );
      assertEquals(await store.getCount(key), 0);
      assertEquals(
        await store.reserveCounts([{ key, max: 10, amount: 5 }]),
        "reserved",
      );
      assertEquals(await store.getCount(key), 5);
    },
  },
  {
    name: "reserveCounts: an omitted amount still means one",
    async run(store) {
      const key = ["governance", "default-amount", "k"] as const;
      await store.reserveCounts([{ key, max: 3 }]);
      await store.reserveCounts([{ key, max: 3, amount: 1 }]);
      assertEquals(await store.getCount(key), 2);
    },
  },
  {
    name: "values survive a large payload round-trip",
    async run(store) {
      const big = { blob: "x".repeat(64_000) };
      await store.set(["config", "big"], big);
      assertEquals(await store.get(["config", "big"]), big);
    },
  },
  {
    name: "keys containing regex/LIKE metacharacters are handled literally",
    async run(store) {
      // A prefix range must not treat these as patterns.
      await store.set(["logs", "a%_b"], "meta");
      await store.set(["logs", "plain"], "plain");
      assertEquals(await store.get(["logs", "a%_b"]), "meta");
      assertEquals((await store.list(["logs"])).length, 2);
    },
  },
];
