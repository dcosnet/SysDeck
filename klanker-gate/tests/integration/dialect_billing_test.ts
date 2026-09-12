// Billing correctness on every ingress dialect. Two defects lived here and
// neither surface had a cache or cost-accounting test:
//
//   1. The dialect routes rebuilt the response with jsonResponse(...), dropping
//      `x-frosty-cache`. Governance reads that header to EXEMPT a cache hit
//      from cost accounting, so every hit on /v1/messages, /genai/* and
//      /cohere/v2/chat was billed a second time.
//   2. Cost accounting read only `body.usage` / `body.model`. GenAI reports
//      `usageMetadata` / `modelVersion` at the top level and Cohere carried no
//      model at all, so those two surfaces were counted-but-uncosted and their
//      maxCostUsd budgets never fired.
//
// The canonical /v1/chat/completions path was correct throughout, which is
// exactly why it rides along below as the control: every assertion has to hold
// identically for all six surfaces, or the surface is a governance bypass
// reachable by URL selection alone.

import { assertEquals } from "@std/assert";
import {
  CohereStreamTranslator,
  translateSSEBody,
} from "../../packages/core/src/mod.ts";
import { extractStreamUsage } from "../../packages/telemetry/src/usage.ts";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { UsageTracker } from "../../packages/telemetry/src/usagestore.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { PricingCatalog } from "../../packages/governance/src/pricing.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import { SemanticCache } from "../../packages/cache/src/semantic.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";
const KEY_ID = "vk-dialect";
const TOKEN = "vk-dialect-billing-token";
const MODEL = "m1";

// Usage the mock upstream reports on every call, and the catalog that prices
// it. Cost is integer micro-USD: 1000 * $3/Mtok + 500 * $15/Mtok.
const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 500;
const COST_MICRO_USD = 10_500;

// Smaller than one request's cost, so request 1 is admitted on an empty
// counter and everything after it is refused. 0.001 USD = 1000 micro-USD.
const MAX_COST_USD = 0.001;

interface Surface {
  name: string;
  /** One request in this dialect's own wire shape. */
  request: (prompt: string) => Request;
  /**
   * Machine-readable governance code as THIS dialect's error envelope carries
   * it. Anthropic's envelope has no code slot, so the reshaped type is the
   * only machine-readable field left (decision-log 86 covers the GenAI case,
   * where the gateway code rides `details[].reason`).
   */
  denialCode: string;
}

function post(path: string, body: unknown): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

const SURFACES: Surface[] = [
  {
    name: "/v1/chat/completions (control)",
    request: (prompt) =>
      post("/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    denialCode: "cost_budget_exhausted",
  },
  {
    name: "/v1/messages",
    request: (prompt) =>
      post("/v1/messages", {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: prompt }],
      }),
    denialCode: "invalid_request_error",
  },
  {
    name: "/genai/v1beta/models/{model}:generateContent",
    request: (prompt) =>
      post(`/genai/v1beta/models/${MODEL}:generateContent`, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    denialCode: "cost_budget_exhausted",
  },
  {
    name: "/cohere/v2/chat",
    request: (prompt) =>
      post("/cohere/v2/chat", {
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    denialCode: "cost_budget_exhausted",
  },
  {
    name: "/openai/deployments/{model}/chat/completions",
    request: (prompt) =>
      // Azure routes on the URL deployment; the body carries no model.
      post(`/openai/deployments/${MODEL}/chat/completions`, {
        messages: [{ role: "user", content: prompt }],
      }),
    denialCode: "cost_budget_exhausted",
  },
  {
    name: "/openrouter/v1/chat/completions",
    request: (prompt) =>
      post("/openrouter/v1/chat/completions", {
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    denialCode: "cost_budget_exhausted",
  },
];

interface Harness {
  ctx: AppContext;
  mock: MockProvider;
  handler: (req: Request) => Promise<Response>;
  /** Cost billed to the virtual key so far, in integer micro-USD. */
  billed: () => number;
  close: () => Promise<void>;
}

function harness(
  options: { cache: boolean; maxCostUsd?: number },
): Harness {
  const mock = new MockProvider(() =>
    jsonResponse(openAIChatBody("dialect answer", {
      // The catalog prices this id; the stock mock body says "mock-model",
      // which would price at null and hide every cost assertion below.
      model: MODEL,
      usage: {
        prompt_tokens: PROMPT_TOKENS,
        completion_tokens: COMPLETION_TOKENS,
        total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
      },
    }))
  );
  const virtualKeys = new VirtualKeyManager();
  virtualKeys.upsert({
    id: KEY_ID,
    name: "dialect-billing",
    token: TOKEN,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    ...(options.maxCostUsd !== undefined
      ? { budget: { maxCostUsd: options.maxCostUsd } }
      : {}),
  });
  const ctx: AppContext = {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: mock.url,
      enabled: true,
      models: [MODEL],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    usage: new UsageTracker(),
    virtualKeys,
    pricing: new PricingCatalog({
      [MODEL]: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
    }),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    ...(options.cache ? { cache: new SemanticCache() } : {}),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
  return {
    ctx,
    mock,
    handler: createHandler(ctx),
    billed: () => ctx.virtualKeys.get(KEY_ID)!.usedCostMicroUsd,
    close: () => mock.close(),
  };
}

/** Governance code out of whichever dialect envelope answered the denial. */
function denialCode(body: unknown): string | undefined {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) {
    return undefined;
  }
  if (typeof error.code === "string") {
    return error.code; // canonical {error:{message,type,param,code}}
  }
  const details = error.details as Array<{ reason?: string }> | undefined;
  if (typeof details?.[0]?.reason === "string") {
    return details[0].reason; // GenAI: code is the HTTP status
  }
  return typeof error.type === "string" ? error.type : undefined;
}

Deno.test("dialect billing: a cache hit is exempt from cost accounting on every surface", async (t) => {
  for (const surface of SURFACES) {
    await t.step(surface.name, async () => {
      const h = harness({ cache: true });
      try {
        const first = await h.handler(surface.request("cache me"));
        assertEquals(first.status, 200);
        assertEquals(first.headers.get("x-frosty-cache"), "miss");
        await first.body?.cancel();
        assertEquals(h.mock.calls.length, 1);
        assertEquals(h.billed(), COST_MICRO_USD);

        const second = await h.handler(surface.request("cache me"));
        assertEquals(second.status, 200);
        // Defect 1: a rebuilt dialect body dropped this header, and it is not
        // cosmetic - governance reads it to skip post-response accounting.
        assertEquals(second.headers.get("x-frosty-cache"), "hit");
        assertEquals(second.headers.get("x-frosty-cache-type"), "direct");
        await second.body?.cancel();
        // The second request never reached a provider...
        assertEquals(h.mock.calls.length, 1);
        // ...so it must not have been billed a second time either.
        assertEquals(h.billed(), COST_MICRO_USD);
        assertEquals(h.ctx.metrics.get("cache.hit"), 1);
      } finally {
        await h.close();
      }
    });
  }
});

Deno.test("dialect billing: a maxCostUsd budget is enforced on every surface", async (t) => {
  for (const surface of SURFACES) {
    await t.step(surface.name, async () => {
      // Deliberately no cache: with one attached, a repeat request would be
      // served from cache and skip the provider even when the budget is not
      // enforced at all, which is the exact failure this test must be able to
      // see. Each attempt also carries a distinct prompt for the same reason.
      const h = harness({ cache: false, maxCostUsd: MAX_COST_USD });
      try {
        const first = await h.handler(surface.request("bill me 1"));
        assertEquals(first.status, 200);
        await first.body?.cancel();
        assertEquals(h.mock.calls.length, 1);
        // Defect 2: GenAI reports usageMetadata/modelVersion and Cohere
        // reported no model, so both stayed at 0 here forever and their
        // budgets never fired.
        assertEquals(h.billed(), COST_MICRO_USD);

        for (const attempt of [2, 3]) {
          const denied = await h.handler(surface.request(`bill me ${attempt}`));
          assertEquals(
            denied.status,
            402,
            `${surface.name} attempt ${attempt} was admitted`,
          );
          assertEquals(denialCode(await denied.json()), surface.denialCode);
        }

        // Refused before dispatch, so the upstream saw exactly one call.
        assertEquals(h.mock.calls.length, 1);
        assertEquals(h.billed(), COST_MICRO_USD);
        assertEquals(
          h.ctx.metrics.get("governance.denied.cost_budget_exhausted"),
          2,
        );
      } finally {
        await h.close();
      }
    });
  }
});

Deno.test("dialect billing: usage records carry the upstream's real tokens and model", async (t) => {
  for (const surface of SURFACES) {
    await t.step(surface.name, async () => {
      const h = harness({ cache: false });
      try {
        const res = await h.handler(surface.request("attribute me"));
        assertEquals(res.status, 200);
        await res.body?.cancel();

        // GenAI and Cohere are the two surfaces this could not see before:
        // GenAI's usageMetadata was skipped, and Cohere's missing model made
        // every record counted-but-uncosted (costMicroUsd null -> 0).
        const report = await h.ctx.usage!.rollup();
        assertEquals(report.totals.requests, 1);
        assertEquals(report.totals.promptTokens, PROMPT_TOKENS);
        assertEquals(report.totals.completionTokens, COMPLETION_TOKENS);
        assertEquals(
          report.totals.totalTokens,
          PROMPT_TOKENS + COMPLETION_TOKENS,
        );
        assertEquals(report.totals.costMicroUsd, COST_MICRO_USD);
        assertEquals(report.byModel.length, 1);
        assertEquals(report.byModel[0].model, MODEL);
        assertEquals(report.byModel[0].provider, "openai");
        assertEquals(report.byModel[0].costMicroUsd, COST_MICRO_USD);
        // The record is attributed to the key that paid for it.
        assertEquals(report.byVirtualKey.length, 1);
        assertEquals(report.byVirtualKey[0].virtualKeyId, KEY_ID);
        assertEquals(report.byVirtualKey[0].costMicroUsd, COST_MICRO_USD);
      } finally {
        await h.close();
      }
    });
  }
});

// Streamed dialect responses go out through createSSEResponse, which mints a
// fresh Response carrying only the SSE headers. Without carrying the gateway
// markers across that boundary the cache-event counter silently under-counts
// streamed dialect traffic, while the byte-identical request on
// /v1/chat/completions IS counted - the same root cause as the double-billing
// defect, on the streaming branch.
Deno.test("dialect billing: a streamed dialect response keeps the cache marker", async () => {
  const streamSurfaces: Array<{ name: string; request: Request }> = [
    {
      name: "/v1/messages",
      request: post("/v1/messages", {
        model: MODEL,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "stream me" }],
      }),
    },
    {
      name: "/genai :streamGenerateContent",
      request: post(`/genai/v1beta/models/${MODEL}:streamGenerateContent`, {
        contents: [{ role: "user", parts: [{ text: "stream me" }] }],
      }),
    },
    {
      name: "/cohere/v2/chat (stream)",
      request: post("/cohere/v2/chat", {
        model: MODEL,
        stream: true,
        messages: [{ role: "user", content: "stream me" }],
      }),
    },
  ];
  for (const surface of streamSurfaces) {
    const h = harness({ cache: true });
    try {
      const res = await h.handler(surface.request);
      assertEquals(res.status, 200, surface.name);
      assertEquals(res.headers.get("x-frosty-cache"), "miss", surface.name);
      await res.body?.cancel();
    } finally {
      await h.close();
    }
  }
});

/** SSE frame terminator: a blank line. */
const SSE_END = "\n\n";

// A streamed response is metered from the TRANSLATED bytes, so a dialect whose
// stream carries no model prices to null and enforces no cost budget at all -
// a client only had to set stream:true to reopen the bypass that the
// non-streaming fix closed. Asserted at the translator boundary because that is
// where the model is either carried or lost; the mock upstream in this file
// answers JSON, so it cannot produce a real SSE stream to drive end to end.
Deno.test("dialect billing: a streamed Cohere response carries a priceable model", async () => {
  const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}` + SSE_END;
  const frames = [
    frame({
      id: "chatcmpl-1",
      model: MODEL,
      choices: [{ index: 0, delta: { content: "hi" } }],
    }),
    frame({
      id: "chatcmpl-1",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    frame({
      id: "chatcmpl-1",
      model: MODEL,
      choices: [],
      usage: {
        prompt_tokens: PROMPT_TOKENS,
        completion_tokens: COMPLETION_TOKENS,
        total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
      },
    }),
    "data: [DONE]" + SSE_END,
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
      controller.close();
    },
  });
  const translated = await new Response(
    translateSSEBody(body, new CohereStreamTranslator(MODEL)),
  ).text();
  const usage = extractStreamUsage(translated);
  // Without the model the usage is still recovered but prices to null, so
  // recordCost never runs and the budget is never charged.
  assertEquals(usage?.model, MODEL);
  assertEquals(usage?.prompt, PROMPT_TOKENS);
  assertEquals(usage?.completion, COMPLETION_TOKENS);
});
