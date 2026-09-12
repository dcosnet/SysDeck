import { assert, assertEquals, assertThrows } from "@std/assert";
import { buildAdapter, clientOptionsFor, ProviderManager } from "./manager.ts";
import { OpenAIAdapter } from "./openai.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { CohereAdapter } from "./cohere.ts";
import { BedrockAdapter } from "./bedrock.ts";
import { VertexAdapter } from "./vertex.ts";
import { OPENAI_COMPAT_BASE_URLS } from "./openai_compat.ts";
import { ProviderClient } from "./client.ts";
import { GatewayError } from "../../core/src/mod.ts";
import { ProviderRegistry } from "../../contracts/src/mod.ts";
import type {
  ProviderAccountConfig,
  ProviderName,
} from "../../contracts/src/mod.ts";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

function hasMethod(adapter: unknown, name: string): boolean {
  return typeof (adapter as Record<string, unknown>)[name] === "function";
}

function account(
  overrides: Partial<ProviderAccountConfig> & { id: string },
): ProviderAccountConfig {
  return {
    type: "openai",
    enabled: true,
    models: ["gpt-4o"],
    priority: 0,
    apiKey: "k",
    ...overrides,
  };
}

Deno.test("resolve routes provider-prefixed models and strips the prefix", () => {
  const manager = new ProviderManager([
    account({ id: "openai" }),
    account({ id: "anthropic", type: "anthropic", models: ["claude-x"] }),
  ]);
  const target = manager.resolve("anthropic/claude-x");
  assertEquals(target.providerId, "anthropic");
  assertEquals(target.model, "claude-x");
});

Deno.test("global proxy is rejected when native HTTP clients are unavailable", () => {
  const manager = new ProviderManager(
    [],
    undefined,
    undefined,
    undefined,
    () => false,
  );
  const error = assertThrows(
    () =>
      manager.configureGlobalProxy({
        proxyUrl: "http://proxy.internal",
        noProxy: [],
      }),
    GatewayError,
  );
  assertEquals(error.status, 409);
  assertEquals(manager.getGlobalProxy(), undefined);
});

Deno.test("provider noProxy overrides the selected global proxy policy", () => {
  const globalProxy = {
    proxyUrl: "http://proxy.internal",
    noProxy: [".global"],
  };
  assertEquals(
    clientOptionsFor(
      account({ id: "scoped", proxy: { noProxy: [".provider"] } }),
      globalProxy,
    ).noProxy,
    [".provider"],
  );
  assertEquals(
    clientOptionsFor(account({ id: "fallback" }), globalProxy).noProxy,
    [".global"],
  );
});

Deno.test("resolve uses the default provider for unprefixed models", () => {
  const manager = new ProviderManager(
    [account({ id: "openai" }), account({ id: "backup" })],
    "backup",
  );
  const target = manager.resolve("gpt-4o");
  assertEquals(target.providerId, "backup");
  assertEquals(target.model, "gpt-4o");
});

Deno.test("resolve uses the single enabled account when unambiguous", () => {
  const manager = new ProviderManager([
    account({ id: "solo" }),
    account({ id: "off", enabled: false }),
  ]);
  assertEquals(manager.resolve("gpt-4o").providerId, "solo");
});

Deno.test("resolve fails loud when unroutable or empty", () => {
  // Two accounts, neither advertises the requested model: ambiguous.
  const ambiguous = new ProviderManager([
    account({ id: "a" }),
    account({ id: "b" }),
  ]);
  assertThrows(() => ambiguous.resolve("mystery-model"), GatewayError);

  const empty = new ProviderManager([]);
  const err = assertThrows(() => empty.resolve("gpt-4o"), GatewayError);
  assertEquals(err.status, 503);
});

Deno.test("resolve load-balances round-robin across advertising accounts", () => {
  const manager = new ProviderManager([
    account({ id: "a" }),
    account({ id: "b" }),
  ]);
  const picks = [
    manager.resolve("gpt-4o").providerId,
    manager.resolve("gpt-4o").providerId,
    manager.resolve("gpt-4o").providerId,
    manager.resolve("gpt-4o").providerId,
  ];
  // alternates between the two equal-priority accounts
  assertEquals(new Set(picks).size, 2);
  assertEquals(picks[0] !== picks[1], true);
  assertEquals(picks[0], picks[2]);
});

Deno.test("resolve prefers lower priority tiers in the pool", () => {
  const manager = new ProviderManager([
    account({ id: "backup", priority: 10 }),
    account({ id: "main", priority: 0 }),
  ]);
  assertEquals(manager.resolve("gpt-4o").providerId, "main");
  assertEquals(manager.resolve("gpt-4o").providerId, "main");
});

Deno.test("resolveChain alternates equal-priority primaries across calls", () => {
  const manager = new ProviderManager([
    account({ id: "a" }),
    account({ id: "b" }),
  ]);
  const first = manager.resolveChain("gpt-4o");
  const second = manager.resolveChain("gpt-4o");
  const third = manager.resolveChain("gpt-4o");
  // One request advances the rotation exactly once, so consecutive
  // resolveChain calls alternate the primary between the two accounts.
  assert(first[0].providerId !== second[0].providerId);
  assertEquals(first[0].providerId, third[0].providerId);
  // Failover still covers the other account.
  assertEquals(
    new Set(first.map((t) => t.providerId)),
    new Set(["a", "b"]),
  );
});

Deno.test("resolveChain appends automatic failover targets from the pool", () => {
  const manager = new ProviderManager([
    account({ id: "a" }),
    account({ id: "b" }),
    account({ id: "c", models: ["other-model"] }),
  ], "a");
  const chain = manager.resolveChain("gpt-4o");
  assertEquals(chain[0].providerId, "a");
  // b advertises the same model -> auto failover; c does not -> excluded
  assertEquals(chain.map((t) => t.providerId).includes("b"), true);
  assertEquals(chain.map((t) => t.providerId).includes("c"), false);
});

Deno.test("resolve rejects disabled providers", () => {
  const manager = new ProviderManager([account({ id: "x", enabled: false })]);
  const err = assertThrows(() => manager.resolve("x/gpt-4o"), GatewayError);
  assertEquals(err.status, 400);
});

Deno.test("resolveChain appends valid fallbacks and skips unknown ones", () => {
  const manager = new ProviderManager([
    account({ id: "a" }),
    account({ id: "b", models: ["other"] }),
  ]);
  const chain = manager.resolveChain("a/gpt-4o", [
    { provider: "b" },
    { provider: "missing" },
    { provider: "b", model: "override" },
  ]);
  assertEquals(chain.map((t) => `${t.providerId}:${t.model}`), [
    "a:gpt-4o",
    "b:gpt-4o",
    "b:override",
  ]);
});

Deno.test("models aggregates enabled catalogs with prefixed ids", () => {
  const manager = new ProviderManager([
    account({ id: "openai", models: ["gpt-4o", "gpt-4o-mini"] }),
    account({ id: "off", enabled: false, models: ["hidden"] }),
  ]);
  assertEquals(manager.models().map((m) => m.id), [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
  ]);
});

Deno.test("listPublic never exposes API keys", () => {
  const manager = new ProviderManager([
    account({ id: "openai", apiKey: "sk-secret" }),
  ]);
  const pub = manager.listPublic()[0] as unknown as Record<string, unknown>;
  assertEquals(pub.hasApiKey, true);
  assertEquals("apiKey" in pub, false);
});

Deno.test("buildAdapter maps openai-compatible to the OpenAI adapter", () => {
  const adapter = buildAdapter(account({
    id: "openai-compatible",
    type: "openai-compatible",
    baseUrl: "https://compat.example/v1",
  }));
  assert(adapter instanceof OpenAIAdapter);
});

Deno.test("buildAdapter maps anthropic-compatible to the Anthropic adapter", () => {
  const adapter = buildAdapter(account({
    id: "anthropic-compatible",
    type: "anthropic-compatible",
    baseUrl: "https://anthropic.example",
  }));
  assert(adapter instanceof AnthropicAdapter);
});

Deno.test("buildAdapter maps lmstudio to the OpenAI adapter with a local default base URL", () => {
  const adapter = buildAdapter(account({ id: "lmstudio", type: "lmstudio" }));
  assert(adapter instanceof OpenAIAdapter);
  // lmstudio needs no explicit case: the default branch supplies its base URL.
  assertEquals(OPENAI_COMPAT_BASE_URLS.lmstudio, "http://localhost:1234/v1");
});

Deno.test("ProviderRegistry advertises the three generic providers", () => {
  for (
    const name of [
      "openai-compatible",
      "anthropic-compatible",
      "lmstudio",
    ] as const
  ) {
    const cap = ProviderRegistry[name];
    assert(cap, `missing registry entry: ${name}`);
    assertEquals(cap.supportsStreaming, true);
    assertEquals(cap.supportsTools, true);
  }
  assertEquals(ProviderRegistry["openai-compatible"].authRequirements, [
    "OPENAI_COMPAT_BASE_URL",
  ]);
  assertEquals(ProviderRegistry["anthropic-compatible"].authRequirements, [
    "ANTHROPIC_COMPAT_BASE_URL",
  ]);
  assertEquals(ProviderRegistry.lmstudio.authRequirements, []);
});

Deno.test("registry capability flags match the resolved adapter surface (no lying flags)", () => {
  const build = (type: ProviderName) =>
    buildAdapter(account({ id: type, type }));

  // Gemini: embeddings + countTokens + native Imagen image generation. The
  // supportsImages flag is truthful via generateImage (not rawProxy).
  const gemini = build("gemini");
  assert(gemini instanceof GeminiAdapter);
  assertEquals(ProviderRegistry.gemini.supportsEmbeddings, true);
  assert(hasMethod(gemini, "embeddings"));
  assert(hasMethod(gemini, "countTokens"));
  assertEquals(ProviderRegistry.gemini.supportsImages, true);
  assert(hasMethod(gemini, "generateImage"));
  // Gemini audio (TTS/STT) and files/batches ride a translating rawProxy.
  assertEquals(ProviderRegistry.gemini.supportsAudio, true);
  assertEquals(ProviderRegistry.gemini.supportsFiles, true);
  assert(hasMethod(gemini, "rawProxy"));

  // Anthropic files/batches ride a translating rawProxy.
  const anthropic = build("anthropic");
  assertEquals(ProviderRegistry.anthropic.supportsFiles, true);
  assert(hasMethod(anthropic, "rawProxy"));

  // Bedrock files (S3 emulation) + batches (Model Invocation Jobs).
  const bedrockAdapter = build("bedrock");
  assertEquals(ProviderRegistry.bedrock.supportsFiles, true);
  assert(hasMethod(bedrockAdapter, "rawProxy"));

  // HuggingFace images are a typed generateImage; audio rides rawProxy.
  const huggingface = build("huggingface");
  assertEquals(ProviderRegistry.huggingface.supportsImages, true);
  assert(hasMethod(huggingface, "generateImage"));
  assertEquals(ProviderRegistry.huggingface.supportsAudio, true);
  assert(hasMethod(huggingface, "rawProxy"));

  // Mistral transcription is an OpenAI-wire passthrough (groq precedent).
  const mistral = build("mistral");
  assert(mistral instanceof OpenAIAdapter);
  assertEquals(ProviderRegistry.mistral.supportsAudio, true);
  assert(hasMethod(mistral, "rawProxy"));

  // Vertex embeddings + countTokens + native Imagen image generation.
  const vertex = build("vertex");
  assert(vertex instanceof VertexAdapter);
  assertEquals(ProviderRegistry.vertex.supportsEmbeddings, true);
  assert(hasMethod(vertex, "embeddings"));
  assert(hasMethod(vertex, "countTokens"));
  assertEquals(ProviderRegistry.vertex.supportsImages, true);
  assert(hasMethod(vertex, "generateImage"));

  // sgl embeddings ride the OpenAI adapter's /embeddings surface.
  const sgl = build("sgl");
  assert(sgl instanceof OpenAIAdapter);
  assertEquals(ProviderRegistry.sgl.supportsEmbeddings, true);
  assert(hasMethod(sgl, "embeddings"));

  // nebius images ride the OpenAI adapter's rawProxy image-generation path.
  const nebius = build("nebius");
  assert(nebius instanceof OpenAIAdapter);
  assertEquals(ProviderRegistry.nebius.supportsImages, true);
  assert(hasMethod(nebius, "rawProxy"));

  // Tool-forwarding OpenAI-wire vendors resolve to the OpenAI adapter, which
  // forwards `tools` verbatim.
  for (const type of ["perplexity", "sgl", "parasail"] as const) {
    assertEquals(ProviderRegistry[type].supportsTools, true);
    assert(build(type) instanceof OpenAIAdapter);
  }

  // Cohere + Bedrock translate tools inside their own adapters.
  assertEquals(ProviderRegistry.cohere.supportsTools, true);
  assert(build("cohere") instanceof CohereAdapter);
  assertEquals(ProviderRegistry.bedrock.supportsTools, true);
  const bedrock = build("bedrock");
  assert(bedrock instanceof BedrockAdapter);
  // Bedrock streaming is live via the converse-stream eventstream decoder.
  assertEquals(ProviderRegistry.bedrock.supportsStreaming, true);
  // Bedrock embeddings ride the native InvokeModel (:invoke) surface.
  assertEquals(ProviderRegistry.bedrock.supportsEmbeddings, true);
  assert(hasMethod(bedrock, "embeddings"));
});

Deno.test("buildAdapter enables native count_tokens only for the openai account", async () => {
  // Real OpenAI: native /responses/input_tokens counter.
  let openaiHit = false;
  const openaiClient = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() => {
      openaiHit = true;
      return new Response(JSON.stringify({ input_tokens: 3 }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const openai = buildAdapter(
    account({ id: "openai", type: "openai", baseUrl: "http://mock/v1" }),
    openaiClient,
  ) as OpenAIAdapter;
  const native = await openai.countTokens!({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert(openaiHit);
  assertEquals(native.estimated, false);

  // groq reuses the OpenAI adapter but must NOT call a native endpoint.
  let groqHit = false;
  const groqClient = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() => {
      groqHit = true;
      return new Response("nope", { status: 500 });
    }),
  );
  const groq = buildAdapter(
    account({ id: "groq", type: "groq", baseUrl: "http://mock/v1" }),
    groqClient,
  ) as OpenAIAdapter;
  const estimate = await groq.countTokens!({
    model: "mixtral",
    messages: [{ role: "user", content: "12345678" }],
  });
  assertEquals(groqHit, false);
  assertEquals(estimate, { input_tokens: 2, estimated: true });
});

Deno.test("listPublic replaces proxyUrl with a hasProxy flag", () => {
  const manager = new ProviderManager([
    account({ id: "proxied", proxyUrl: "http://user:pass@proxy.local:8888" }),
    account({ id: "direct" }),
  ]);
  try {
    const pub = Object.fromEntries(
      manager.listPublic().map((
        p,
      ) => [p.id, p as unknown as Record<string, unknown>]),
    );
    assertEquals("proxyUrl" in pub.proxied, false);
    assertEquals(pub.proxied.hasProxy, true);
    assertEquals(pub.direct.hasProxy, false);
  } finally {
    // remove() closes the proxied account's native HTTP client.
    manager.remove("proxied");
  }
});
