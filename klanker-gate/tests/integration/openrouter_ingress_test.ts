// OpenRouter-shaped ingress: POST /openrouter/v1/{chat/completions,embeddings},
// GET /openrouter/v1/models, and documented 501 stubs for /generation and /key.
// The canonical wire IS the OpenRouter wire, so the interesting surface area is
// the dialect's own extras: the /openrouter/api/v1 prefix rewrite, `models[]`
// folded onto the gateway fallback chain, and attribution headers that must be
// accepted but never forwarded.

import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { modelsToFallbacks } from "../../apps/gateway/routes/openrouter_ingress.ts";
import type { ProviderAccountConfig } from "../../packages/contracts/src/mod.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  openAIStreamFrames,
  readSSE,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

function account(
  id: string,
  baseUrl: string,
  models: string[],
  priority = 0,
): ProviderAccountConfig {
  return {
    id,
    type: "openai",
    apiKey: "sk-test",
    baseUrl,
    enabled: true,
    models,
    priority,
    // No client-level retry, so a 429 is one upstream call and one fallback hop.
    retry: { maxRetries: 0 },
  };
}

function makeContext(
  accounts: ProviderAccountConfig[],
  defaultProvider?: string,
): AppContext {
  return {
    providers: new ProviderManager(accounts, defaultProvider),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

/** Single-account context matching the other compat ingress suites. */
function singleContext(mockUrl: string): AppContext {
  return makeContext([account("openai", mockUrl, ["gpt-4o"])], "openai");
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`http://gateway.test${path}`);
}

const messages = [{ role: "user", content: "hei" }];

interface EgressBody {
  model?: string;
  stream?: boolean;
  fallbacks?: unknown;
  [key: string]: unknown;
}

interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// ------------------------------------------------------------ prefix rewrite

Deno.test("openrouter ingress: /openrouter/api/v1 and /openrouter/v1 reach the same handler", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const ctx = singleContext(mock.url);
  const handler = createHandler(ctx);
  const body = { model: "openai/gpt-4o", messages };
  try {
    // The base URL a stock OpenRouter SDK is pointed at.
    const sdkShape = await handler(
      post("/openrouter/api/v1/chat/completions", body),
    );
    assertEquals(sdkShape.status, 200);
    const sdkText = await sdkShape.text();

    const registered = await handler(
      post("/openrouter/v1/chat/completions", body),
    );
    assertEquals(registered.status, 200);
    assertEquals(await registered.text(), sdkText);

    assertEquals(mock.calls.length, 2);
    assertEquals(mock.calls.every((c) => c.path === "/chat/completions"), true);
    assertEquals(ctx.metrics.get("requests.compat.openrouter"), 2);
  } finally {
    await mock.close();
  }
});

// --------------------------------------------------------- models[] failover

Deno.test("openrouter ingress: models[] really drives failover to a second account", async () => {
  const primary = new MockProvider(() =>
    jsonResponse({
      error: { message: "rate limited", type: "rate_limit_error" },
    }, 429)
  );
  const secondary = new MockProvider(() =>
    jsonResponse(openAIChatBody("hei fra konto to"))
  );
  const ctx = makeContext([
    account("primary", primary.url, ["gpt-4o"]),
    account("secondary", secondary.url, ["llama-3"], 1),
  ]);
  const handler = createHandler(ctx);
  try {
    // No `model`: models[0] is the primary and the rest become fallbacks.
    const res = await handler(post("/openrouter/v1/chat/completions", {
      models: ["primary/gpt-4o", "secondary/llama-3"],
      messages,
    }));
    assertEquals(res.status, 200);
    const body = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    assertEquals(body.choices[0].message.content, "hei fra konto to");

    // The 429 account was tried exactly once, then the chain advanced.
    assertEquals(primary.calls.length, 1);
    assertEquals((primary.calls[0].body as EgressBody).model, "gpt-4o");
    assertEquals(secondary.calls.length, 1);
    assertEquals((secondary.calls[0].body as EgressBody).model, "llama-3");

    // `fallbacks` is a gateway extension and must never reach a provider.
    assertEquals((secondary.calls[0].body as EgressBody).fallbacks, undefined);

    assertEquals(ctx.metrics.get("provider.primary.fallback"), 1);
    assertEquals(ctx.metrics.get("provider.secondary.success"), 1);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

Deno.test("openrouter ingress: an explicit model plus models[] keeps every entry as a fallback", async () => {
  const primary = new MockProvider(() =>
    jsonResponse({ error: { message: "upstream down" } }, 503)
  );
  const secondary = new MockProvider(() =>
    jsonResponse(openAIChatBody("hei fra konto to"))
  );
  const ctx = makeContext([
    account("primary", primary.url, ["gpt-4o"]),
    account("secondary", secondary.url, ["llama-3"], 1),
  ]);
  const handler = createHandler(ctx);
  try {
    const res = await handler(post("/openrouter/v1/chat/completions", {
      model: "primary/gpt-4o",
      models: ["secondary/llama-3"],
      messages,
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(primary.calls.length, 1);
    assertEquals(secondary.calls.length, 1);
    assertEquals((secondary.calls[0].body as EgressBody).model, "llama-3");
  } finally {
    await primary.close();
    await secondary.close();
  }
});

// -------------------------------------------------- modelsToFallbacks (unit)

Deno.test("openrouter: modelsToFallbacks splits entries on the first slash", () => {
  const out = modelsToFallbacks(["a/b/c"], undefined, "keep-me");
  assertEquals(out.fallbacks, [{ provider: "a", model: "b/c" }]);
});

Deno.test("openrouter: modelsToFallbacks keeps a :tag suffix untouched", () => {
  const out = modelsToFallbacks(
    ["openai/gpt-4o:free", "openai/gpt-4o:nitro"],
    undefined,
    "keep-me",
  );
  assertEquals(out.fallbacks, [
    { provider: "openai", model: "gpt-4o:free" },
    { provider: "openai", model: "gpt-4o:nitro" },
  ]);
});

Deno.test("openrouter: modelsToFallbacks skips an entry with no provider slash", () => {
  // A fallback needs an account id; a bare model cannot name one.
  const out = modelsToFallbacks(
    ["gpt-4o", "/leading-slash", "openai/gpt-4o"],
    undefined,
    "keep-me",
  );
  assertEquals(out.fallbacks, [{ provider: "openai", model: "gpt-4o" }]);

  // Every entry skippable -> no fallbacks at all.
  assertEquals(
    modelsToFallbacks(["gpt-4o"], undefined, "keep-me").fallbacks,
    undefined,
  );

  // A trailing slash names a provider with no model: the primary's model rides.
  assertEquals(
    modelsToFallbacks(["openai/"], undefined, "keep-me").fallbacks,
    [{ provider: "openai" }],
  );
});

Deno.test("openrouter: modelsToFallbacks puts client fallbacks first and appends the mapped ones", () => {
  const out = modelsToFallbacks(
    ["mapped/m2"],
    [{ provider: "client-a", model: "cm" }, { provider: "client-b" }],
    "keep-me",
  );
  assertEquals(out.fallbacks, [
    { provider: "client-a", model: "cm" },
    { provider: "client-b" },
    { provider: "mapped", model: "m2" },
  ]);

  // Malformed client entries are dropped, not fatal.
  const dirty = modelsToFallbacks(
    ["mapped/m2"],
    [null, 42, {}, { provider: "" }, { provider: "ok", model: 7 }],
    "keep-me",
  );
  assertEquals(dirty.fallbacks, [
    { provider: "ok" },
    { provider: "mapped", model: "m2" },
  ]);
});

Deno.test("openrouter: modelsToFallbacks maps every entry when the request names its own model", () => {
  const out = modelsToFallbacks(
    ["first/m1", "second/m2"],
    undefined,
    "openai/gpt-4o",
  );
  // The caller's own model is untouched; nothing is promoted out of models[].
  assertEquals(out.model, undefined);
  assertEquals(out.fallbacks, [
    { provider: "first", model: "m1" },
    { provider: "second", model: "m2" },
  ]);
});

Deno.test("openrouter: modelsToFallbacks promotes models[0] when the request has no model", () => {
  const out = modelsToFallbacks(["first/m1", "second/m2"], undefined);
  assertEquals(out.model, "first/m1");
  assertEquals(out.fallbacks, [{ provider: "second", model: "m2" }]);

  // An empty-string model counts as absent (same promotion).
  assertEquals(
    modelsToFallbacks(["first/m1"], undefined, "").model,
    "first/m1",
  );
});

Deno.test("openrouter: modelsToFallbacks returns {} for input it cannot use", () => {
  assertEquals(modelsToFallbacks(undefined, undefined), {});
  assertEquals(modelsToFallbacks(null, undefined), {});
  assertEquals(modelsToFallbacks("openai/gpt-4o", undefined), {});
  assertEquals(modelsToFallbacks({}, undefined), {});
  assertEquals(modelsToFallbacks([], undefined), {});
  // A non-string entry is dropped, not treated as poison: silently voiding a
  // whole valid failover list because of one bad element is worse than
  // ignoring the element (review finding A9).
  assertEquals(modelsToFallbacks(["openai/gpt-4o", 7], undefined), {
    model: "openai/gpt-4o",
    fallbacks: undefined,
  });
  assertEquals(modelsToFallbacks([7, true], undefined), {});
});

Deno.test("openrouter: modelsToFallbacks caps the failover chain", () => {
  // Every entry becomes a dispatch attempt, so an unbounded models[] is an
  // amplification vector: one client request fanning out to thousands of
  // upstream calls. Proven before the cap: 2000 entries -> 2001 calls.
  const huge = Array.from({ length: 2000 }, (_, i) => `openai/m${i}`);
  const mapped = modelsToFallbacks(huge, undefined);
  assertEquals(mapped.model, "openai/m0");
  assert((mapped.fallbacks?.length ?? 0) <= 12);
});

// --------------------------------------------------- extensions and headers

Deno.test("openrouter ingress: extension fields reach the egress body untouched", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(singleContext(mock.url));
  try {
    const res = await handler(post("/openrouter/v1/chat/completions", {
      model: "openai/gpt-4o",
      messages,
      provider: { order: ["Anthropic", "OpenAI"], allow_fallbacks: false },
      transforms: ["middle-out"],
      route: "fallback",
      reasoning: { effort: "high", exclude: false },
    }));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const sent = mock.calls[0].body as EgressBody;
    assertEquals(sent.provider, {
      order: ["Anthropic", "OpenAI"],
      allow_fallbacks: false,
    });
    assertEquals(sent.transforms, ["middle-out"]);
    assertEquals(sent.route, "fallback");
    assertEquals(sent.reasoning, { effort: "high", exclude: false });
  } finally {
    await mock.close();
  }
});

Deno.test("openrouter ingress: HTTP-Referer and X-Title are accepted but not forwarded", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(singleContext(mock.url));
  try {
    const res = await handler(post(
      "/openrouter/v1/chat/completions",
      { model: "openai/gpt-4o", messages },
      { "HTTP-Referer": "https://example.test", "X-Title": "Frosty Test" },
    ));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    // Egress attribution is the per-account network.extraHeaders setting, never
    // a client-set header, so neither may leak onto the upstream request.
    const sent = mock.calls[0].headers;
    assertEquals(sent.get("HTTP-Referer"), null);
    assertEquals(sent.get("X-Title"), null);
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------- discovery and stubs

Deno.test("openrouter ingress: GET /openrouter/v1/models matches GET /v1/models", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const ctx = singleContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const canonical = await handler(get("/v1/models"));
    assertEquals(canonical.status, 200);
    const canonicalBody = await canonical.json();

    const openrouter = await handler(get("/openrouter/v1/models"));
    assertEquals(openrouter.status, 200);
    const openrouterBody = await openrouter.json();

    assertEquals(openrouterBody, canonicalBody);
    assertEquals(openrouterBody, {
      object: "list",
      data: [{ id: "openai/gpt-4o", object: "model", owned_by: "openai" }],
    });
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

Deno.test("openrouter ingress: /generation and /key answer 501 with the canonical envelope", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(singleContext(mock.url));
  try {
    for (const path of ["/openrouter/v1/generation", "/openrouter/v1/key"]) {
      const res = await handler(get(path));
      assertEquals(res.status, 501, path);
      assertEquals(res.headers.get("Content-Type"), "application/json");
      const body = await res.json() as ErrorEnvelope;
      assertEquals(body.error.type, "not_implemented");
      assertEquals(body.error.param, null);
      assertEquals(body.error.code, null);
      // Self-documenting, not a bare 404: it names the surface and the way out.
      assert(body.error.message.includes("OpenRouter"), body.error.message);
    }
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ streaming

Deno.test("openrouter ingress: streaming ends with data: [DONE]", async () => {
  const mock = new MockProvider((call) =>
    (call.body as EgressBody).stream
      ? sseResponse(openAIStreamFrames(["Hei", " fra", " OpenRouter"]))
      : jsonResponse(openAIChatBody("unused"))
  );
  const handler = createHandler(singleContext(mock.url));
  try {
    const res = await handler(post("/openrouter/v1/chat/completions", {
      model: "openai/gpt-4o",
      messages,
      stream: true,
    }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    assertEquals((mock.calls[0].body as EgressBody).stream, true);

    const events = await readSSE(res);
    assertEquals(events.at(-1), "[DONE]");
    const text = events
      .filter((e): e is Record<string, unknown> => e !== "[DONE]")
      .map((e) => {
        const choices = e.choices as
          | Array<{ delta?: { content?: string } }>
          | undefined;
        return choices?.[0]?.delta?.content ?? "";
      })
      .join("");
    assertEquals(text, "Hei fra OpenRouter");
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------- governance

Deno.test("openrouter ingress is governed exactly like /v1", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const ctx = singleContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk",
    name: "openrouter-gate",
    token: "vk-openrouter-gate-token",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  const body = { model: "openai/gpt-4o", messages };
  try {
    const denied = await handler(post("/openrouter/v1/chat/completions", body));
    assertEquals(denied.status, 401);
    await denied.body?.cancel();

    const allowed = await handler(post(
      "/openrouter/v1/chat/completions",
      body,
      { "Authorization": "Bearer vk-openrouter-gate-token" },
    ));
    assertEquals(allowed.status, 200);
    await allowed.body?.cancel();

    // The rewritten SDK shape is admitted through the identical check.
    const rewritten = await handler(post(
      "/openrouter/api/v1/chat/completions",
      body,
      { "Authorization": "Bearer vk-openrouter-gate-token" },
    ));
    assertEquals(rewritten.status, 200);
    await rewritten.body?.cancel();

    assertEquals(mock.calls.length, 2);
  } finally {
    await mock.close();
  }
});
