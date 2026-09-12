import { assertEquals } from "@std/assert";
import { ProviderClient } from "./client.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { clientOptionsFor } from "./manager.ts";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

Deno.test("clientOptionsFor maps network group + proxy creds, network wins over retry", () => {
  const opts = clientOptionsFor({
    id: "p",
    type: "openai",
    enabled: true,
    models: [],
    priority: 0,
    retry: { maxRetries: 2, initialDelayMs: 100, maxDelayMs: 1000 },
    proxyUrl: "http://proxy.local",
    network: {
      maxRetries: 7,
      initialBackoffMs: 250,
      maxBackoffMs: 9000,
      extraHeaders: [{ name: "X-Org", value: "acme" }],
    },
    proxy: { proxyUsername: "u", proxyPassword: "p" },
  });
  assertEquals(opts.maxRetries, 7); // network wins
  assertEquals(opts.initialDelayMs, 250);
  assertEquals(opts.maxDelayMs, 9000);
  assertEquals(opts.proxyUrl, "http://proxy.local");
  assertEquals(opts.proxyUsername, "u");
  assertEquals(opts.proxyPassword, "p");
  assertEquals(opts.extraHeaders?.[0], { name: "X-Org", value: "acme" });
});

Deno.test("clientOptionsFor falls back to the legacy retry object", () => {
  const opts = clientOptionsFor({
    id: "p",
    type: "openai",
    enabled: true,
    models: [],
    priority: 0,
    retry: { maxRetries: 3, initialDelayMs: 500 },
  });
  assertEquals(opts.maxRetries, 3);
  assertEquals(opts.initialDelayMs, 500);
  assertEquals(opts.extraHeaders, undefined);
});

Deno.test("global proxy is a default while provider proxy remains a full override", () => {
  const global = {
    proxyUrl: "https://global.proxy:8443",
    proxyUsername: "global-user",
    proxyPassword: "global-secret",
    noProxy: [".internal"],
  };
  const inherited = clientOptionsFor({
    id: "inherited",
    type: "openai",
    enabled: true,
    models: [],
    priority: 0,
  }, global);
  assertEquals(inherited.proxyUrl, global.proxyUrl);
  assertEquals(inherited.proxyUsername, global.proxyUsername);
  assertEquals(inherited.noProxy, [".internal"]);

  const overridden = clientOptionsFor({
    id: "isolated",
    type: "openai",
    enabled: true,
    models: [],
    priority: 0,
    proxyUrl: "http://account.proxy:8080",
    proxy: { proxyUsername: "account-user", proxyPassword: "account-secret" },
  }, global);
  assertEquals(overridden.proxyUrl, "http://account.proxy:8080");
  assertEquals(overridden.proxyUsername, "account-user");
  assertEquals(overridden.proxyPassword, "account-secret");
  assertEquals(overridden.noProxy, undefined);
});

Deno.test("extraHeaders reach the upstream request", async () => {
  let captured = new Headers();
  const client = new ProviderClient(
    {
      maxRetries: 0,
      extraHeaders: [
        { name: "X-Org", value: "acme" },
        { name: "X-Trace", value: "abc" },
      ],
    },
    mockFetch((_input, init) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    }),
  );
  const res = await client.fetchWithRetry("http://mock/", {
    headers: { "Content-Type": "application/json" },
  });
  await res.body?.cancel();
  assertEquals(captured.get("X-Org"), "acme");
  assertEquals(captured.get("X-Trace"), "abc");
  // Request-owned headers are preserved alongside the extras.
  assertEquals(captured.get("Content-Type"), "application/json");
});

Deno.test("adapter-set headers win over operator extraHeaders", async () => {
  let captured = new Headers();
  const client = new ProviderClient(
    {
      maxRetries: 0,
      // Operator tries to override auth: the adapter's header must still win.
      extraHeaders: [{ name: "Authorization", value: "Bearer operator" }],
    },
    mockFetch((_input, init) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    }),
  );
  const res = await client.fetchWithRetry("http://mock/", {
    headers: { Authorization: "Bearer adapter" },
  });
  await res.body?.cancel();
  assertEquals(captured.get("Authorization"), "Bearer adapter");
});

Deno.test("proxy basic-auth credentials reach the http client factory", () => {
  let seen: unknown;
  new ProviderClient(
    {
      proxyUrl: "http://proxy.local:8080",
      proxyUsername: "user",
      proxyPassword: "pass",
    },
    globalThis.fetch.bind(globalThis),
    (options) => {
      seen = options;
      return { close() {} };
    },
  );
  assertEquals(seen, {
    proxy: {
      url: "http://proxy.local:8080",
      basicAuth: { username: "user", password: "pass" },
    },
  });
});

Deno.test("AnthropicAdapter joins enabled beta overrides into anthropic-beta", async () => {
  let captured = new Headers();
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((_input, init) => {
      captured = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ id: "m", content: [], usage: {} }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new AnthropicAdapter(
    "sk-ant",
    undefined,
    "http://mock/v1",
    client,
    {
      "prompt-caching-2024-07-31": "enabled",
      "message-batches-2024-09-24": "enabled",
      "some-other": "disabled",
      "yet-another": "default",
    },
  );
  const res = await adapter.chatCompletions({
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
  });
  await res.body?.cancel();
  assertEquals(
    captured.get("anthropic-beta"),
    "prompt-caching-2024-07-31,message-batches-2024-09-24",
  );
});

Deno.test("AnthropicAdapter sends no anthropic-beta header without overrides", async () => {
  let captured = new Headers();
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((_input, init) => {
      captured = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ id: "m", content: [], usage: {} }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const adapter = new AnthropicAdapter(
    "sk-ant",
    undefined,
    "http://mock/v1",
    client,
  );
  const res = await adapter.chatCompletions({
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
  });
  await res.body?.cancel();
  assertEquals(captured.get("anthropic-beta"), null);
});
