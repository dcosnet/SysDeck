// RR-3 / OR-1: admin control-plane trust-boundary guard.
//
// Verifies the layered defense on state-changing /api/* requests:
//   1. Content-Type must be application/json (defeats HTML-form CSRF).
//   2. Provably cross-site requests (Sec-Fetch-Site / mismatched Origin) are
//      rejected, while non-browser clients (no Origin AND no Sec-Fetch-Site)
//      are allowed so tokenless local dev keeps working.
//   3. The Host header is pinned to a localhost allow-list (DNS-rebind), which
//      FROSTY_ALLOWED_HOSTS may extend.
// GET /api/* and the guard's interaction with the admin-token gate are covered.

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
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  assertAdminRequestOrigin,
  DEFAULT_ADMIN_HOSTS,
  parseAllowedHosts,
} from "../../apps/gateway/routes/origin-guard.ts";

const base = "http://gateway.test";
const DEFAULT_HOSTS = parseAllowedHosts(undefined);

/** In-memory context (no KV) — deterministic and resource-leak free. */
function makeContext(adminToken?: string): AppContext {
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
    adminToken,
  };
}

function providerBody(): string {
  return JSON.stringify({
    id: "openai",
    type: "openai",
    apiKey: "sk",
    enabled: true,
    models: ["gpt-4o"],
    priority: 0,
  });
}

/** Exercise the pure guard against a /api/providers mutation. */
function guard(
  method: string,
  headers: Record<string, string>,
  body?: string,
  hosts: Set<string> = DEFAULT_HOSTS,
): Response | null {
  return assertAdminRequestOrigin(
    new Request(`${base}/api/providers`, { method, headers, body }),
    hosts,
  );
}

// ---------------------------------------------------------------------------
// Layer 2 — cross-site rejection
// ---------------------------------------------------------------------------

Deno.test("RR-3 guard: cross-site Origin on a mutation is rejected", () => {
  const res = guard("POST", {
    Host: "localhost:8080",
    Origin: "http://evil.example",
    "Content-Type": "application/json",
  }, "{}");
  assertEquals(res?.status, 403);
});

Deno.test("RR-3 guard: same-origin Origin is allowed", () => {
  const res = guard("POST", {
    Host: "localhost:8080",
    Origin: "http://localhost:8080",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  }, "{}");
  assertEquals(res, null);
});

Deno.test("RR-3 guard: no Origin/Sec-Fetch (API client) is allowed", () => {
  // Host present and localhost.
  assertEquals(
    guard("POST", {
      Host: "localhost:8080",
      "Content-Type": "application/json",
    }, "{}"),
    null,
  );
  // Host also absent — the typical in-process / curl client.
  assertEquals(
    guard("POST", { "Content-Type": "application/json" }, "{}"),
    null,
  );
});

Deno.test("RR-3 guard: Sec-Fetch-Site governs cross-site", () => {
  const json = { Host: "localhost:8080", "Content-Type": "application/json" };
  assertEquals(
    guard("POST", { ...json, "Sec-Fetch-Site": "cross-site" }, "{}")?.status,
    403,
  );
  assertEquals(
    guard("POST", { ...json, "Sec-Fetch-Site": "cross-origin" }, "{}")?.status,
    403,
  );
  assertEquals(
    guard("POST", { ...json, "Sec-Fetch-Site": "same-origin" }, "{}"),
    null,
  );
  assertEquals(
    guard("POST", { ...json, "Sec-Fetch-Site": "none" }, "{}"),
    null,
  );
});

// ---------------------------------------------------------------------------
// Layer 1 — Content-Type enforcement
// ---------------------------------------------------------------------------

Deno.test("RR-3 guard: non-JSON Content-Type on a mutation is rejected", () => {
  const host = { Host: "localhost:8080" };
  assertEquals(
    guard("POST", { ...host, "Content-Type": "text/plain" }, "x")?.status,
    415,
  );
  assertEquals(
    guard("POST", {
      ...host,
      "Content-Type": "application/x-www-form-urlencoded",
    }, "a=1")?.status,
    415,
  );
  assertEquals(
    guard("POST", { ...host, "Content-Type": "multipart/form-data" }, "x")
      ?.status,
    415,
  );
  // application/json with a charset parameter is accepted.
  assertEquals(
    guard("POST", {
      ...host,
      "Content-Type": "application/json; charset=utf-8",
    }, "{}"),
    null,
  );
  // A bodyless mutation carries no Content-Type requirement.
  assertEquals(guard("DELETE", host), null);
});

// ---------------------------------------------------------------------------
// Layer 3 — Host allow-list (DNS-rebind)
// ---------------------------------------------------------------------------

Deno.test("RR-3 guard: Host allow-list defends against DNS-rebind", () => {
  const json = { "Content-Type": "application/json" };
  assertEquals(
    guard("POST", { ...json, Host: "attacker.example" }, "{}")?.status,
    403,
  );
  for (
    const h of [
      "localhost",
      "localhost:8080",
      "127.0.0.1",
      "127.0.0.1:9999",
      "[::1]:8080",
    ]
  ) {
    assertEquals(
      guard("POST", { ...json, Host: h }, "{}"),
      null,
      `host ${h} should be allowed`,
    );
  }
});

Deno.test("RR-3 guard: FROSTY_ALLOWED_HOSTS extends the allow-list", () => {
  const json = { "Content-Type": "application/json" };
  const extended = parseAllowedHosts("gateway.test, corp.internal:9000");
  assertEquals(
    guard("POST", { ...json, Host: "gateway.test" }, "{}", extended),
    null,
  );
  assertEquals(
    guard("POST", { ...json, Host: "corp.internal:9000" }, "{}", extended),
    null,
  );
  // Hosts outside the extended list are still rejected.
  assertEquals(
    guard("POST", { ...json, Host: "other.host" }, "{}", extended)?.status,
    403,
  );
});

Deno.test("RR-3 parseAllowedHosts: defaults plus normalized env entries", () => {
  const defaults = parseAllowedHosts(undefined);
  for (const h of DEFAULT_ADMIN_HOSTS) {
    assert(defaults.has(h), `default host ${h} missing`);
  }
  const extended = parseAllowedHosts("Gateway.Test, FOO.local:9000 , ");
  assert(extended.has("gateway.test")); // lower-cased
  assert(extended.has("foo.local:9000")); // trimmed + lower-cased
  assert(extended.has("localhost")); // defaults retained
});

// ---------------------------------------------------------------------------
// Envelope + DELETE semantics
// ---------------------------------------------------------------------------

Deno.test("RR-3 guard: rejection uses the canonical error envelope", async () => {
  const res = guard("POST", {
    Host: "localhost:8080",
    "Content-Type": "text/plain",
  }, "x")!;
  assertEquals(res.status, 415);
  const body = await res.json();
  assertEquals(body.error.type, "unsupported_media_type");
  assert(typeof body.error.message === "string");
  assertEquals(body.error.param, null);
  assertEquals(body.error.code, null);
});

Deno.test("RR-3 guard: cross-site rules apply to bodyless DELETE", () => {
  const crossSite = new Request(`${base}/api/cache`, {
    method: "DELETE",
    headers: { Host: "localhost:8080", "Sec-Fetch-Site": "cross-site" },
  });
  assertEquals(assertAdminRequestOrigin(crossSite, DEFAULT_HOSTS)?.status, 403);

  const sameOrigin = new Request(`${base}/api/cache`, {
    method: "DELETE",
    headers: { Host: "localhost:8080" },
  });
  assertEquals(assertAdminRequestOrigin(sameOrigin, DEFAULT_HOSTS), null);
});

// ---------------------------------------------------------------------------
// End-to-end wiring through createHandler
// ---------------------------------------------------------------------------

Deno.test("RR-3 wiring: cross-site POST /api/* is blocked", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: {
        Host: "localhost:8080",
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: providerBody(),
    }),
  );
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("RR-3 wiring: same-origin POST /api/* is admitted", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: {
        Host: "localhost:8080",
        Origin: "http://localhost:8080",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: providerBody(),
    }),
  );
  assertEquals(res.status, 201);
  await res.body?.cancel();
});

Deno.test("RR-3 wiring: non-JSON body and disallowed Host are blocked", async () => {
  const handler = createHandler(makeContext());

  const nonJson = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: { Host: "localhost:8080", "Content-Type": "text/plain" },
      body: "id=openai",
    }),
  );
  assertEquals(nonJson.status, 415);
  await nonJson.body?.cancel();

  const rebind = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: { Host: "rebind.attacker", "Content-Type": "application/json" },
      body: providerBody(),
    }),
  );
  assertEquals(rebind.status, 403);
  await rebind.body?.cancel();
});

Deno.test("RR-3 wiring: GET /api/* is guarded against rebind + cross-site", async () => {
  const handler = createHandler(makeContext());

  // DNS-rebind on a sensitive read is now blocked (GET /api/config/export
  // ?include_secrets=true returns provider keys). Previously a GET passed through.
  const rebind = await handler(
    new Request(`${base}/api/providers`, {
      headers: { Host: "rebind.attacker" },
    }),
  );
  assertEquals(rebind.status, 403);
  assertEquals((await rebind.json()).error.type, "forbidden_host");

  // A cross-site read is rejected.
  const crossSite = await handler(
    new Request(`${base}/api/providers`, {
      headers: {
        Host: "localhost:8080",
        Origin: "http://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    }),
  );
  assertEquals(crossSite.status, 403);
  await crossSite.body?.cancel();

  // Legitimate reads still pass: a non-browser client (no Origin) on an allowed
  // host, and a same-origin browser read.
  const cli = await handler(
    new Request(`${base}/api/providers`, {
      headers: { Host: "localhost:8080" },
    }),
  );
  assertEquals(cli.status, 200);
  await cli.body?.cancel();

  const sameOrigin = await handler(
    new Request(`${base}/api/providers`, {
      headers: {
        Host: "localhost:8080",
        Origin: "http://localhost:8080",
        "Sec-Fetch-Site": "same-origin",
      },
    }),
  );
  assertEquals(sameOrigin.status, 200);
  await sameOrigin.body?.cancel();
});

Deno.test("RR-3 wiring: guard runs before the admin-token check", async () => {
  const handler = createHandler(makeContext("s3cret"));

  // Cross-site AND no token: the guard (403) fires before the token gate (401).
  const blocked = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: {
        Host: "localhost:8080",
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: providerBody(),
    }),
  );
  assertEquals(blocked.status, 403);
  await blocked.body?.cancel();

  // Same-origin but wrong token: guard passes, token gate rejects (401 intact).
  const wrongToken = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: {
        Host: "localhost:8080",
        Origin: "http://localhost:8080",
        "Content-Type": "application/json",
        Authorization: "Bearer nope",
      },
      body: providerBody(),
    }),
  );
  assertEquals(wrongToken.status, 401);
  await wrongToken.body?.cancel();

  // Same-origin with the right token: admitted (existing behavior preserved).
  const ok = await handler(
    new Request(`${base}/api/providers`, {
      method: "POST",
      headers: {
        Host: "localhost:8080",
        Origin: "http://localhost:8080",
        "Content-Type": "application/json",
        Authorization: "Bearer s3cret",
      },
      body: providerBody(),
    }),
  );
  assertEquals(ok.status, 201);
  await ok.body?.cancel();
});

Deno.test("RR-3 wiring: FROSTY_ALLOWED_HOSTS extension applies through the handler", async () => {
  const prev = Deno.env.get("FROSTY_ALLOWED_HOSTS");
  Deno.env.set("FROSTY_ALLOWED_HOSTS", "gateway.test");
  try {
    const handler = createHandler(makeContext());
    const res = await handler(
      new Request(`${base}/api/providers`, {
        method: "POST",
        headers: { Host: "gateway.test", "Content-Type": "application/json" },
        body: providerBody(),
      }),
    );
    assertEquals(res.status, 201);
    await res.body?.cancel();
  } finally {
    if (prev === undefined) {
      Deno.env.delete("FROSTY_ALLOWED_HOSTS");
    } else {
      Deno.env.set("FROSTY_ALLOWED_HOSTS", prev);
    }
  }
});
