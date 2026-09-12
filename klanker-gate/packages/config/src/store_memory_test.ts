// The shared StateStore contract, run against the in-process implementation.
// tests/live/postgres_state_live_test.ts runs the SAME cases against real
// PostgreSQL, which is what keeps the two from drifting.

import { assertEquals } from "@std/assert";
import { STATE_STORE_CONTRACT } from "./store_contract.ts";
import { MemoryStateStore } from "./store_memory.ts";

for (const testCase of STATE_STORE_CONTRACT) {
  Deno.test(`MemoryStateStore contract: ${testCase.name}`, async () => {
    // A fresh store per case: the contract asserts absolute counts, so leakage
    // between cases would make failures depend on execution order.
    const store = new MemoryStateStore();
    try {
      await testCase.run(store);
    } finally {
      store.close();
    }
  });
}

Deno.test("MemoryStateStore: named instances survive close, anonymous do not", async () => {
  MemoryStateStore.resetAll();

  const named = MemoryStateStore.named("data/frosty");
  await named.set(["config", "a"], 1);
  named.close();
  // A named store models a database at an address: closing the HANDLE must not
  // delete the data, or every reopen-and-assert durability test in the suite
  // would pass against an empty store and prove nothing.
  assertEquals(
    await MemoryStateStore.named("data/frosty").get(["config", "a"]),
    1,
  );

  const anon = MemoryStateStore.named(":memory:");
  await anon.set(["config", "a"], 1);
  anon.close();
  assertEquals(await anon.get(["config", "a"]), null);

  // Two `:memory:` opens are independent stores, matching Deno KV.
  const a = MemoryStateStore.named(":memory:");
  await a.set(["config", "shared"], "a");
  assertEquals(
    await MemoryStateStore.named(":memory:").get(["config", "shared"]),
    null,
  );

  MemoryStateStore.resetAll();
});

Deno.test("MemoryStateStore: stored values are cloned, not aliased", async () => {
  const store = new MemoryStateStore();
  const mutable = { list: [1, 2] };
  await store.set(["config", "clone"], mutable);
  // Mutating the caller's object after the write must not retroactively change
  // what was persisted - a real store serializes, and the in-memory one has to
  // behave the same or it hides aliasing bugs that only appear in production.
  mutable.list.push(3);
  assertEquals(await store.get(["config", "clone"]), { list: [1, 2] });

  const read = await store.get<{ list: number[] }>(["config", "clone"]);
  read!.list.push(99);
  assertEquals(await store.get(["config", "clone"]), { list: [1, 2] });
  store.close();
});
