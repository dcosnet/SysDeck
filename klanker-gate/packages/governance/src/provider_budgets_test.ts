import { assertEquals } from "@std/assert";
import { ConfigService } from "../../config/src/service.ts";
import type { ProviderAccountConfig } from "../../contracts/src/config.ts";
import { ProviderBudgetTracker } from "./provider_budgets.ts";

const account: ProviderAccountConfig = {
  id: "provider-budgeted",
  type: "openai",
  apiKey: "sk-test",
  enabled: true,
  models: ["m"],
  priority: 0,
  governance: { maxRequests: 1 },
};

Deno.test("provider budget window anchor survives a restart (no reset drift)", () => {
  const acct: ProviderAccountConfig = {
    ...account,
    governance: { maxRequests: 1, requestsResetPeriod: "daily" },
  };
  const DAY = 86_400_000;
  const anchors: Record<string, number> = {};
  const counts: Record<string, number> = {};

  // t=1000: the first request opens the daily window and exhausts the budget.
  let clock = 1000;
  const t1 = new ProviderBudgetTracker({ now: () => clock });
  t1.onRecord((_d, id, amt) => (counts[id] = (counts[id] ?? 0) + amt));
  t1.onAnchor((_d, id, ws) => (anchors[id] = ws));
  t1.recordRequest(acct);
  assertEquals(t1.check(acct).ok, false);

  // "Restart" 23h later: rehydrated with the persisted anchor, the window is
  // still the ORIGINAL one, so the budget stays closed within its period.
  clock = 1000 + 23 * 3_600_000;
  const t2 = new ProviderBudgetTracker({ now: () => clock });
  t2.hydrate("requests", counts, anchors);
  assertEquals(t2.check(acct).ok, false);

  // At original-anchor + 1 day the window elapses and the budget resets — even
  // though barely an hour has passed since the restart (the drift bug would
  // have kept it locked out for a full extra day).
  clock = 1000 + DAY + 1;
  assertEquals(t2.check(acct).ok, true);
});

Deno.test("provider budget counters persist and hydrate across a restart", async () => {
  const dir = await Deno.makeTempDir();
  const kvPath = `${dir}/provider-budget.kv`;

  let config = await ConfigService.open(kvPath);
  let write = Promise.resolve();
  let tracker = new ProviderBudgetTracker();
  tracker.onRecord((dimension, id, amount) => {
    write = config.addCounter(`provider-${dimension}`, id, amount);
  });
  tracker.recordRequest(account);
  await write;
  assertEquals(await config.loadCounters("provider-requests"), {
    "provider-budgeted": 1,
  });
  config.close();

  config = await ConfigService.open(kvPath);
  tracker = new ProviderBudgetTracker();
  tracker.hydrate("requests", await config.loadCounters("provider-requests"));
  const decision = tracker.check(account);
  assertEquals(decision.ok, false);
  if (!decision.ok) {
    assertEquals(decision.code, "provider_request_limit");
  }
  config.close();
});
