import { assert, assertEquals } from "@std/assert";
import { MemoryStateStore } from "../../config/src/store_memory.ts";
import { type UsageRecord, UsageTracker } from "./usagestore.ts";

function rec(partial: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: new Date().toISOString(),
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costMicroUsd: 100,
    durationMs: 5,
    status: 200,
    stream: false,
    cacheHit: false,
    ...partial,
  };
}

Deno.test("ring caps at the configured size, pruning oldest", () => {
  const t = new UsageTracker(undefined, 3);
  for (let i = 0; i < 5; i++) {
    t.record(rec({ requestId: String(i) }));
  }
  assertEquals(t.count(), 3);
});

Deno.test("rollup: empty tracker reports the full contract with tracked=false", async () => {
  const report = await new UsageTracker().rollup({ window: "24h" });
  assertEquals(report.tracked, false);
  assertEquals(report.window, "24h");
  assertEquals(report.series.length, 12);
  assertEquals(report.series[0].label, "1");
  assertEquals(report.series[11].label, "12");
  assertEquals(report.totals.requests, 0);
  assertEquals(report.byModel, []);
  assertEquals(report.byProvider, []);
  assertEquals(report.byVirtualKey, []);
  assert(typeof report.generatedAt === "string");
});

Deno.test("rollup: byVirtualKey aggregates only tenant-attributed records", async () => {
  const t = new UsageTracker();
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  t.record(rec({
    ts: new Date(now - 1000).toISOString(),
    virtualKeyId: "vk-1",
    virtualKeyName: "alpha",
    teamId: "team-1",
    customerId: "cust-1",
    totalTokens: 100,
    costMicroUsd: 200,
  }));
  t.record(rec({
    ts: new Date(now - 2000).toISOString(),
    virtualKeyId: "vk-1",
    virtualKeyName: "alpha",
    teamId: "team-1",
    customerId: "cust-1",
    totalTokens: 50,
    costMicroUsd: 100,
  }));
  // A zero-virtual-key (always-on) record is excluded from byVirtualKey.
  t.record(rec({ ts: new Date(now - 3000).toISOString(), totalTokens: 999 }));

  const r = await t.rollup({ window: "1h", now });
  assertEquals(r.byVirtualKey.length, 1);
  assertEquals(r.byVirtualKey[0].virtualKeyId, "vk-1");
  assertEquals(r.byVirtualKey[0].virtualKeyName, "alpha");
  assertEquals(r.byVirtualKey[0].teamId, "team-1");
  assertEquals(r.byVirtualKey[0].customerId, "cust-1");
  assertEquals(r.byVirtualKey[0].requests, 2);
  assertEquals(r.byVirtualKey[0].totalTokens, 150);
  assertEquals(r.byVirtualKey[0].costMicroUsd, 300);
  // The un-attributed record still counts in the global totals.
  assertEquals(r.totals.requests, 3);
});

Deno.test("rollup: totals, buckets, byModel/byProvider match the contract", async () => {
  const t = new UsageTracker();
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  t.record(rec({
    ts: new Date(now - 1000).toISOString(),
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMicroUsd: 500,
    status: 200,
  }));
  t.record(rec({
    ts: new Date(now - 2000).toISOString(),
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    promptTokens: 200,
    completionTokens: 20,
    totalTokens: 220,
    costMicroUsd: 700,
    status: 500, // an error
  }));
  t.record(rec({
    ts: new Date(now - 3000).toISOString(),
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 10,
    completionTokens: 0,
    totalTokens: 10,
    costMicroUsd: null,
    status: 200,
    cacheHit: true,
  }));

  const r = await t.rollup({ window: "1h", now });
  assertEquals(r.tracked, true);
  assertEquals(r.window, "1h");

  assertEquals(r.totals.requests, 3);
  assertEquals(r.totals.promptTokens, 310);
  assertEquals(r.totals.completionTokens, 70);
  assertEquals(r.totals.totalTokens, 380);
  assertEquals(r.totals.costMicroUsd, 1200);
  assertEquals(r.totals.costUsd, 0.0012);
  assertEquals(r.totals.cacheHits, 1);
  assertEquals(r.totals.cacheMisses, 2);
  assertEquals(r.totals.errorRatePct, 33.33); // 1 of 3

  // All three land in the final bucket (all within the last few seconds).
  assertEquals(r.series.length, 12);
  assertEquals(r.series[11].requests, 3);
  assertEquals(r.series[11].errors, 1);

  // byModel sorted desc by totalTokens; gpt-4o aggregated across two records.
  assertEquals(r.byModel[0].model, "claude-sonnet-4-5"); // 220 > 160
  assertEquals(r.byModel[0].provider, "anthropic");
  const gpt = r.byModel.find((m) => m.model === "gpt-4o")!;
  assertEquals(gpt.requests, 2);
  assertEquals(gpt.totalTokens, 160);
  assertEquals(gpt.costMicroUsd, 500); // null cost counts as 0

  // byProvider sorted desc by totalTokens.
  assertEquals(r.byProvider[0].provider, "anthropic");
  assertEquals(
    r.byProvider.find((p) => p.provider === "openai")!.totalTokens,
    160,
  );
});

Deno.test("rollup reads the durable store when one is attached", async () => {
  const dir = await Deno.makeTempDir();
  const store = MemoryStateStore.named(`${dir}/usage.kv`);
  try {
    const t = new UsageTracker(store);
    t.record(rec({ promptTokens: 5, completionTokens: 5, totalTokens: 10 }));
    // The durable write is fire-and-forget; give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const report = await t.rollup({ window: "24h" });
    assertEquals(report.tracked, true);
    assertEquals(report.totals.requests, 1);
    assertEquals(report.totals.totalTokens, 10);
  } finally {
    store.close();
  }
});
