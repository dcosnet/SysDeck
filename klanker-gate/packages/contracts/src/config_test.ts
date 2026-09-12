import { assert, assertEquals } from "@std/assert";
import {
  GlobalProxyConfigSchema,
  GlobalProxyPublicSchema,
  ProviderAccountConfigSchema,
  ProviderAccountPublicSchema,
  redactGlobalProxy,
  redactProviderAccount,
} from "./config.ts";

Deno.test("legacy provider config (no 6-tab groups) still parses", () => {
  const parsed = ProviderAccountConfigSchema.parse({
    id: "openai",
    type: "openai",
    apiKey: "sk-legacy",
    models: ["gpt-4o"],
    proxyUrl: "http://proxy.local:8080",
    retry: { maxRetries: 5 },
  });
  assertEquals(parsed.id, "openai");
  assertEquals(parsed.network, undefined);
  assertEquals(parsed.proxy, undefined);
  assertEquals(parsed.governance, undefined);
  // Defaults still apply.
  assertEquals(parsed.enabled, true);
  assertEquals(parsed.priority, 0);
});

Deno.test("new optional 6-tab groups are accepted and typed", () => {
  const parsed = ProviderAccountConfigSchema.parse({
    id: "anthropic",
    type: "anthropic",
    apiKey: "sk-ant",
    models: ["claude-3-5-sonnet"],
    network: {
      timeoutSec: 30,
      streamIdleTimeoutSec: 60,
      maxRetries: 4,
      initialBackoffMs: 250,
      maxBackoffMs: 8000,
      maxConnectionsPerHost: 10,
      enforceHttp2: true,
      extraHeaders: [{ name: "X-Org", value: "acme" }],
      skipTlsVerify: false,
      caCertPem: "-----BEGIN CERTIFICATE-----",
    },
    proxy: {
      proxyType: "socks5",
      proxyUsername: "u",
      proxyPassword: "p",
      noProxy: [".internal"],
    },
    performance: { maxConcurrentRequests: 16 },
    governance: {
      budgetUsd: 100,
      budgetResetPeriod: "monthly",
      maxTokens: 1_000_000,
      tokensResetPeriod: "daily",
      maxRequests: 5000,
      requestsResetPeriod: "hourly",
    },
    betaHeaders: { overrides: { "prompt-caching-2024-07-31": "enabled" } },
    debugging: {
      sendBackRawRequest: true,
      sendBackRawResponse: false,
      storeRawReqResp: true,
    },
  });
  assertEquals(parsed.network?.maxRetries, 4);
  assertEquals(parsed.network?.extraHeaders?.[0], {
    name: "X-Org",
    value: "acme",
  });
  assertEquals(parsed.proxy?.proxyType, "socks5");
  assertEquals(parsed.proxy?.noProxy, [".internal"]);
  assertEquals(parsed.governance?.budgetResetPeriod, "monthly");
  assertEquals(
    parsed.betaHeaders?.overrides?.["prompt-caching-2024-07-31"],
    "enabled",
  );
  assertEquals(parsed.debugging?.storeRawReqResp, true);
});

Deno.test("invalid enum values in the new groups are rejected", () => {
  const bad = ProviderAccountConfigSchema.safeParse({
    id: "x",
    type: "openai",
    proxy: { proxyType: "ftp" },
  });
  assert(!bad.success);
});

Deno.test("redactProviderAccount drops every secret and sets presence flags", () => {
  const publicView = redactProviderAccount({
    id: "bedrock",
    type: "bedrock",
    enabled: true,
    models: [],
    priority: 0,
    apiKey: "sk-secret",
    awsAccessKeyId: "AKIA-visible",
    awsSecretAccessKey: "shhh",
    awsSessionToken: "temp",
    serviceAccountJson: "{json}",
    proxyUrl: "http://user:pass@proxy.local",
    network: {
      extraHeaders: [{ name: "X-Org", value: "acme" }],
      caCertPem: "-----BEGIN CERTIFICATE-----",
    },
    proxy: {
      proxyUsername: "u",
      proxyPassword: "topsecret",
      noProxy: [".private"],
    },
  });

  // Presence flags.
  assertEquals(publicView.hasApiKey, true);
  assertEquals(publicView.hasCloudCredentials, true);
  assertEquals(publicView.hasProxy, true);
  assertEquals(publicView.hasProxyPassword, true);
  assertEquals(publicView.hasCaCert, true);

  // The redacted view must validate against the public schema...
  const reparsed = ProviderAccountPublicSchema.parse(publicView);
  assertEquals(reparsed.id, "bedrock");

  // ...and must not echo any secret material.
  const serialized = JSON.stringify(publicView);
  for (
    const secret of [
      "sk-secret",
      "shhh",
      "temp",
      "{json}",
      "user:pass@proxy.local",
      "topsecret",
      "BEGIN CERTIFICATE",
    ]
  ) {
    assert(
      !serialized.includes(secret),
      `redacted view leaked secret: ${secret}`,
    );
  }
  // Non-secret fields survive.
  assertEquals(publicView.awsAccessKeyId, "AKIA-visible");
  assertEquals(publicView.network?.extraHeaders?.[0], {
    name: "X-Org",
    hasValue: true,
  });
  assertEquals(publicView.proxy?.proxyUsername, "u");
  assertEquals(publicView.proxy?.noProxyCount, 1);
});

Deno.test("redactProviderAccount omits groups that were never set", () => {
  const publicView = redactProviderAccount({
    id: "openai",
    type: "openai",
    enabled: true,
    models: ["gpt-4o"],
    priority: 0,
    apiKey: "k",
  });
  assertEquals(publicView.network, undefined);
  assertEquals(publicView.proxy, undefined);
  assertEquals(publicView.hasProxyPassword, false);
  assertEquals(publicView.hasCaCert, false);
});

Deno.test("global proxy accepts only explicit safe transport configuration", () => {
  const parsed = GlobalProxyConfigSchema.parse({
    proxyUrl: "socks5://proxy.internal:1080",
    proxyUsername: "operator",
    proxyPassword: "secret",
    noProxy: [".internal", "*.corp.example"],
  });
  assertEquals(parsed.noProxy.length, 2);

  for (
    const proxyUrl of [
      "ftp://proxy.internal",
      "http://user:pass@proxy.internal",
      "not a url",
    ]
  ) {
    assertEquals(
      GlobalProxyConfigSchema.safeParse({ proxyUrl }).success,
      false,
    );
  }
  assertEquals(
    GlobalProxyConfigSchema.safeParse({
      proxyUrl: "http://proxy.internal",
      proxyPassword: "secret",
    }).success,
    false,
  );
});

Deno.test("redactGlobalProxy never exposes routing or credential secrets", () => {
  const publicView = redactGlobalProxy({
    proxyUrl: "https://proxy.internal:8443",
    proxyUsername: "operator",
    proxyPassword: "secret",
    noProxy: [".private.example"],
  });
  assertEquals(GlobalProxyPublicSchema.parse(publicView).enabled, true);
  assertEquals(publicView.proxyType, "https");
  assertEquals(publicView.hasCredentials, true);
  assertEquals(publicView.noProxyCount, 1);
  const serialized = JSON.stringify(publicView);
  for (
    const secret of ["proxy.internal", "operator", "secret", "private.example"]
  ) {
    assert(
      !serialized.includes(secret),
      `redacted global proxy leaked ${secret}`,
    );
  }
});
