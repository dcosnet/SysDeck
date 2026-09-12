// Wave-3 governance: pricing catalog + $-cost budgets, token-window limits,
// and the teams/customers hierarchy (fail-closed admission up the chain).

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import { PricingCatalog } from "../../packages/governance/src/pricing.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

function makeContext(mockUrl: string): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: mockUrl,
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    pricing: new PricingCatalog(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

function chatRequest(token: string, content = "hei"): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content }],
    }),
  });
}

const usageBody = openAIChatBody("ok", {
  model: "gpt-4o",
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
});

Deno.test("pricing: integer micro-USD math and prefix matching", () => {
  const pricing = new PricingCatalog();
  // 1000 prompt @ $2.5/M + 500 completion @ $10/M = 2500 + 5000 micro-USD.
  assertEquals(
    pricing.costMicroUsd("gpt-4o", {
      prompt_tokens: 1000,
      completion_tokens: 500,
    }),
    7500,
  );
  // Dated variants resolve through the longest configured prefix.
  assertEquals(
    pricing.costMicroUsd("gpt-4o-2026-01-01", { prompt_tokens: 1000 }),
    2500,
  );
  // Provider-prefixed ids resolve too; unknown models are unpriced.
  assertEquals(
    pricing.costMicroUsd("openai/gpt-4o", { prompt_tokens: 1000 }),
    2500,
  );
  assertEquals(
    pricing.costMicroUsd("unknown-model", { prompt_tokens: 5 }),
    null,
  );
});

Deno.test("cost budget: exhausted keys get 402 and metrics count cost", async () => {
  const mock = new MockProvider(() => jsonResponse(usageBody));
  const ctx = makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk-cost",
    name: "cost-capped",
    token: "vk-cost-budget-token",
    enabled: true,
    budget: { maxCostUsd: 0.005 }, // 5000 micro; one gpt-4o call costs 7500
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  try {
    const first = await handler(chatRequest("vk-cost-budget-token"));
    assertEquals(first.status, 200);
    await first.body?.cancel();
    assertEquals(ctx.virtualKeys.get("vk-cost")!.usedCostMicroUsd, 7500);
    assert(
      ctx.metrics.renderPrometheus().includes(
        "frosty_cost_usd_total 0.007500",
      ),
    );

    const second = await handler(chatRequest("vk-cost-budget-token"));
    assertEquals(second.status, 402);
    const body = await second.json() as { error: { code: string } };
    assertEquals(body.error.code, "cost_budget_exhausted");
  } finally {
    await mock.close();
  }
});

Deno.test("token limit: request estimates meter the window", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk-tok",
    name: "token-capped",
    token: "vk-token-limit-token",
    enabled: true,
    tokenLimit: { maxTokens: 100, windowMs: 60_000 },
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  try {
    // ~380-char body -> est ~95 tokens: first passes, second exceeds 100.
    const first = await handler(
      chatRequest("vk-token-limit-token", "x".repeat(300)),
    );
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const second = await handler(
      chatRequest("vk-token-limit-token", "x".repeat(300)),
    );
    assertEquals(second.status, 429);
    const body = await second.json() as { error: { code: string } };
    assertEquals(body.error.code, "token_limited");
    assert(second.headers.get("Retry-After"));
  } finally {
    await mock.close();
  }
});

Deno.test("hierarchy: disabled/exhausted parents lock descendants out", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = makeContext(mock.url);
  ctx.hierarchy!.upsertCustomer({
    id: "cust-1",
    name: "acme",
    enabled: true,
    budget: { maxRequests: 1 },
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  ctx.hierarchy!.upsertTeam({
    id: "team-1",
    name: "core",
    enabled: true,
    customerId: "cust-1",
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  ctx.virtualKeys.upsert({
    id: "vk-h",
    name: "hier-key",
    token: "vk-hierarchy-token1",
    enabled: true,
    teamId: "team-1",
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  try {
    // Customer allows exactly one request across all descendants.
    const first = await handler(chatRequest("vk-hierarchy-token1"));
    assertEquals(first.status, 200);
    await first.body?.cancel();

    const second = await handler(chatRequest("vk-hierarchy-token1"));
    assertEquals(second.status, 402);
    assertEquals(
      ((await second.json()) as { error: { code: string } }).error.code,
      "customer_budget_exhausted",
    );

    // Disabling the team denies immediately (fail closed).
    const team = ctx.hierarchy!.getTeam("team-1")!;
    ctx.hierarchy!.upsertTeam({ ...team, enabled: false });
    const third = await handler(chatRequest("vk-hierarchy-token1"));
    assertEquals(third.status, 401);
    assertEquals(
      ((await third.json()) as { error: { code: string } }).error.code,
      "team_disabled",
    );

    // A dangling team reference is a lockout, not an open door.
    ctx.virtualKeys.upsert({
      ...ctx.virtualKeys.get("vk-h")!,
      teamId: "no-such-team",
    });
    const fourth = await handler(chatRequest("vk-hierarchy-token1"));
    assertEquals(fourth.status, 401);
    assertEquals(
      ((await fourth.json()) as { error: { code: string } }).error.code,
      "invalid_team",
    );
  } finally {
    await mock.close();
  }
});

Deno.test("teams/customers/pricing admin APIs round-trip", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const customer = await (await handler(
      new Request("http://gateway.test/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "acme", budget: { maxCostUsd: 10 } }),
      }),
    )).json() as { id: string };

    const team = await (await handler(
      new Request("http://gateway.test/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "core", customerId: customer.id }),
      }),
    )).json() as { id: string; customerId: string };
    assertEquals(team.customerId, customer.id);

    const teams = await (await handler(
      new Request("http://gateway.test/api/teams"),
    )).json() as { teams: Array<{ id: string }> };
    assertEquals(teams.teams.length, 1);

    const del = await handler(
      new Request(`http://gateway.test/api/teams/${team.id}`, {
        method: "DELETE",
      }),
    );
    assertEquals(del.status, 204);

    // Pricing: PUT replaces the catalog and GET reads it back.
    const put = await handler(
      new Request("http://gateway.test/api/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "my-model": { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
        }),
      }),
    );
    assertEquals(put.status, 200);
    const pricing = await (await handler(
      new Request("http://gateway.test/api/pricing"),
    )).json() as { prices: Record<string, unknown> };
    assertEquals(Object.keys(pricing.prices), ["my-model"]);
    assertEquals(
      ctx.pricing!.costMicroUsd("my-model", {
        prompt_tokens: 1000,
        completion_tokens: 1000,
      }),
      3000,
    );
  } finally {
    await mock.close();
  }
});
