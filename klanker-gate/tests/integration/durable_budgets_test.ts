// Decision-log item 9 closure: request budgets survive a gateway restart.
// Usage is an atomic KV counter hydrated into the VirtualKeyManager at boot.

import { assertEquals } from "@std/assert";
import { ConfigService } from "../../packages/config/src/service.ts";
import {
  type VirtualKey,
  VirtualKeyManager,
} from "../../packages/governance/src/virtual_keys.ts";

function budgetKey(): VirtualKey {
  return {
    id: "k-budget",
    name: "budgeted",
    token: "vk-durable-budget-token",
    enabled: true,
    budget: { maxRequests: 2 },
    usedRequests: 0,
    usedCostMicroUsd: 0,
  };
}

/** Mirrors the createDefaultContext wiring, with awaitable persistence. */
function wire(config: ConfigService, keys: VirtualKey[]) {
  const manager = new VirtualKeyManager(keys);
  let lastWrite: Promise<void> = Promise.resolve();
  manager.onUsage((id) => {
    lastWrite = config.addUsage(id);
  });
  return { manager, flush: () => lastWrite };
}

Deno.test("budget usage persists across a service restart", async () => {
  const dir = await Deno.makeTempDir();
  const kvPath = `${dir}/frosty-test.kv`;

  // --- first process lifetime -------------------------------------------
  let config = await ConfigService.open(kvPath);
  await config.upsertVirtualKey(budgetKey());
  let { manager, flush } = wire(config, await config.listVirtualKeys());
  manager.hydrateUsage(await config.loadUsage());

  const first = manager.check("vk-durable-budget-token");
  assertEquals(first.ok, true);
  manager.recordUsage("k-budget");
  await flush();
  const second = manager.check("vk-durable-budget-token");
  assertEquals(second.ok, true);
  manager.recordUsage("k-budget");
  await flush();
  config.close();

  // --- restart ------------------------------------------------------------
  config = await ConfigService.open(kvPath);
  assertEquals(await config.loadUsage(), { "k-budget": 2 });
  ({ manager, flush } = wire(config, await config.listVirtualKeys()));
  manager.hydrateUsage(await config.loadUsage());

  // The 2-request budget is exhausted even though the process restarted.
  const third = manager.check("vk-durable-budget-token");
  assertEquals(third.ok, false);
  if (!third.ok) {
    assertEquals(third.status, 402);
    assertEquals(third.code, "budget_exhausted");
  }

  // Deleting the key clears its usage counter too.
  await config.deleteVirtualKey("k-budget");
  assertEquals(await config.loadUsage(), {});
  config.close();
});
