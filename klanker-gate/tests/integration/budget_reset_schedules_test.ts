import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ConfigService } from "../../packages/config/src/service.ts";
import {
  BudgetEpochStore,
  type BudgetSubject,
} from "../../packages/governance/src/budget_epochs.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import {
  BudgetSchema,
  VirtualKeyManager,
} from "../../packages/governance/src/virtual_keys.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

const intervalMs = 60_000;

Deno.test("scheduled budget policy rejects private reset metadata", () => {
  assertEquals(
    BudgetSchema.safeParse({
      maxRequests: 1,
      resetIntervalMs: intervalMs,
      anchorMs: 0,
    }).success,
    false,
  );
  assertEquals(
    BudgetSchema.safeParse({
      maxRequests: 1,
      resetIntervalMs: intervalMs - 1,
    }).success,
    false,
  );
});

function scheduledSubjects(): BudgetSubject[] {
  return [
    {
      kind: "virtual-key",
      id: "key",
      name: "key",
      budget: { maxRequests: 2, maxCostUsd: 10, resetIntervalMs: intervalMs },
    },
    {
      kind: "team",
      id: "team",
      name: "team",
      budget: { maxRequests: 2, resetIntervalMs: intervalMs },
    },
    {
      kind: "customer",
      id: "customer",
      name: "customer",
      budget: { maxRequests: 2, resetIntervalMs: intervalMs },
    },
  ];
}

Deno.test("scheduled budgets reset by server time and retain cost in its admission period", async () => {
  let now = 1_000_000;
  const budgets = new BudgetEpochStore(undefined, () => now);
  const subjects = scheduledSubjects();
  await budgets.configure("virtual-key", "key", undefined, subjects[0].budget);
  await budgets.configure("team", "team", undefined, subjects[1].budget);
  await budgets.configure(
    "customer",
    "customer",
    undefined,
    subjects[2].budget,
  );

  const first = await budgets.admit(subjects);
  assert(first.ok);
  if (first.ok) {
    await budgets.recordCost(first.schedules[0], 1_000_000);
  }
  const second = await budgets.admit(subjects);
  assert(second.ok);
  const exhausted = await budgets.admit(subjects);
  assertEquals(exhausted.ok, false);
  if (!exhausted.ok) {
    assertEquals(exhausted.status, 402);
  }

  now += intervalMs;
  const nextPeriod = await budgets.admit(subjects);
  assert(nextPeriod.ok);
  if (nextPeriod.ok) {
    assertEquals(
      await budgets.count(nextPeriod.schedules[0], "cost-micro-usd"),
      0,
    );
  }
});

Deno.test("scheduled request reservations remain durable and atomic across the hierarchy", async () => {
  const dir = await Deno.makeTempDir();
  const config = await ConfigService.open(`${dir}/frosty.kv`);
  const now = 2_000_000;
  const firstProcess = new BudgetEpochStore(config.raw(), () => now);
  const subjects = scheduledSubjects();
  for (const subject of subjects) {
    await firstProcess.configure(
      subject.kind,
      subject.id,
      undefined,
      subject.budget,
    );
  }

  // A restart reads the anchor/counter from KV rather than reopening a budget.
  const restarted = new BudgetEpochStore(config.raw(), () => now);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => restarted.admit(subjects)),
  );
  assertEquals(attempts.filter((result) => result.ok).length, 2);
  for (const result of attempts.filter((result) => !result.ok)) {
    assertEquals(result.status, 402);
  }
  config.close();
});

function request(token: string): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

Deno.test("gateway skips lifetime counters for a scheduled key and denies at its period cap", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  let now = 3_000_000;
  const budgets = new BudgetEpochStore(undefined, () => now);
  const ctx: AppContext = {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: mock.url,
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    budgetEpochs: budgets,
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
  const key = {
    id: "scheduled-key",
    name: "scheduled key",
    token: "vk-scheduled-key-token",
    enabled: true,
    budget: { maxRequests: 1, resetIntervalMs: intervalMs },
    usedRequests: 0,
    usedCostMicroUsd: 0,
  };
  await budgets.configure("virtual-key", key.id, undefined, key.budget);
  ctx.virtualKeys.upsert(key);
  const handler = createHandler(ctx);
  try {
    const first = await handler(request(key.token));
    assertEquals(first.status, 200);
    await first.body?.cancel();
    // Projection updates, but it is not a legacy durable counter authority.
    assertEquals(ctx.virtualKeys.get(key.id)?.usedRequests, 1);

    const second = await handler(request(key.token));
    assertEquals(second.status, 402);
    assertEquals(
      ((await second.json()) as { error: { code: string } }).error.code,
      "budget_exhausted",
    );
    now += intervalMs;
    const third = await handler(request(key.token));
    assertEquals(third.status, 200);
    await third.body?.cancel();
  } finally {
    await mock.close();
  }
});
