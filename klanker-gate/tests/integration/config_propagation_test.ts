// Cross-process config propagation (decision-log 69 / open-risks R0).
//
// Measured before the fix, on four workers: a newly created virtual key was
// visible to 1 request in 12, and its DELETE returned 404 after landing on a
// worker that had never seen it. These cases model two processes sharing one
// durable store and assert the property that failure violated.

import { assert, assertEquals } from "@std/assert";
import { ConfigService } from "../../packages/config/src/service.ts";
import { ConfigCrypto } from "../../packages/config/src/crypto.ts";
import { MemoryStateStore } from "../../packages/config/src/store_memory.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { reloadConfigInto } from "../../apps/gateway/context.ts";
import type { VirtualKey } from "../../packages/governance/src/virtual_keys.ts";

/** One gateway process: its own in-memory state over a SHARED durable store. */
function worker(store: MemoryStateStore) {
  const config = new ConfigService(store);
  return {
    config,
    providers: new ProviderManager(),
    virtualKeys: new VirtualKeyManager([]),
    hierarchy: new GovernanceHierarchy([], []),
  };
}

async function hydrate(w: ReturnType<typeof worker>) {
  await reloadConfigInto(w);
}

function key(id: string, name = id): VirtualKey {
  return {
    id,
    name,
    token: `vk-${id}-secret`,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  };
}

Deno.test("R0: a key created on one worker becomes visible on another", async () => {
  const store = MemoryStateStore.named(`prop-create-${crypto.randomUUID()}`);
  const a = worker(store);
  const b = worker(store);
  await hydrate(a);
  await hydrate(b);
  assertEquals(b.virtualKeys.list().length, 0);

  // Worker A serves the admin write.
  const stored = a.virtualKeys.upsert(key("k1"));
  await a.config.upsertVirtualKey(stored);

  // Worker B has not been told yet - this is the bug's starting state.
  assertEquals(b.virtualKeys.get("k1"), undefined);

  await reloadConfigInto(b);
  assert(b.virtualKeys.get("k1"), "peer must see the new key after a reload");
  assertEquals(b.virtualKeys.get("k1")?.name, "k1");
});

Deno.test("R0: REVOCATION propagates - the security case", async () => {
  const store = MemoryStateStore.named(`prop-revoke-${crypto.randomUUID()}`);
  const a = worker(store);
  const b = worker(store);
  const stored = a.virtualKeys.upsert(key("k-revoke"));
  await a.config.upsertVirtualKey(stored);
  await hydrate(b);
  assert(b.virtualKeys.get("k-revoke"), "peer starts holding the key");

  a.virtualKeys.remove("k-revoke");
  await a.config.deleteVirtualKey("k-revoke");
  await reloadConfigInto(b);

  // An upsert-only reload leaves the key in place and it keeps authenticating.
  // This is exactly the failure that made R0 Critical.
  assertEquals(
    b.virtualKeys.get("k-revoke"),
    undefined,
    "a revoked key must not survive on a peer",
  );
});

Deno.test("R0: a deleted provider is removed from a peer, not just added", async () => {
  const store = MemoryStateStore.named(`prop-prov-${crypto.randomUUID()}`);
  const a = worker(store);
  const b = worker(store);
  await a.config.upsertProvider({
    id: "p1",
    type: "openai",
    apiKey: "sk-x",
    enabled: true,
    models: [],
    priority: 0,
  });
  await reloadConfigInto(b);
  assert(b.providers.get("p1"), "peer picked up the provider");

  await a.config.deleteProvider("p1");
  await reloadConfigInto(b);
  assertEquals(b.providers.get("p1"), undefined, "removal must propagate");
});

Deno.test("R0: teams and customers propagate in both directions", async () => {
  const store = MemoryStateStore.named(`prop-hier-${crypto.randomUUID()}`);
  const a = worker(store);
  const b = worker(store);
  await a.config.upsertTeam({
    id: "t1",
    name: "Team One",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  await a.config.upsertCustomer({
    id: "c1",
    name: "Cust One",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  await reloadConfigInto(b);
  assert(b.hierarchy.getTeam("t1"));
  assert(b.hierarchy.getCustomer("c1"));

  await a.config.deleteTeam("t1");
  await a.config.deleteCustomer("c1");
  await reloadConfigInto(b);
  assertEquals(b.hierarchy.getTeam("t1"), undefined);
  assertEquals(b.hierarchy.getCustomer("c1"), undefined);
});

Deno.test("R0: a policy edit propagates, not only existence", async () => {
  const store = MemoryStateStore.named(`prop-policy-${crypto.randomUUID()}`);
  const a = worker(store);
  const b = worker(store);
  const stored = a.virtualKeys.upsert(key("k-pol"));
  await a.config.upsertVirtualKey(stored);
  await reloadConfigInto(b);
  assertEquals(b.virtualKeys.get("k-pol")?.enabled, true);

  await a.config.upsertVirtualKey({ ...stored, enabled: false });
  await reloadConfigInto(b);
  assertEquals(
    b.virtualKeys.get("k-pol")?.enabled,
    false,
    "disabling a key must reach peers",
  );
});

Deno.test("R0: a reload never LOWERS a usage counter", async () => {
  // A reconcile races in-flight reservations. Taking the durable value verbatim
  // would roll a counter backwards and re-open an exhausted budget, so the
  // reload takes the higher of the two - fail closed.
  const store = MemoryStateStore.named(`prop-usage-${crypto.randomUUID()}`);
  const a = worker(store);
  const stored = a.virtualKeys.upsert(key("k-usage"));
  await a.config.upsertVirtualKey({ ...stored, usedRequests: 2 });

  await reloadConfigInto(a);
  assertEquals(a.virtualKeys.get("k-usage")?.usedRequests, 2);

  // Simulate in-flight reservations beyond what durable has recorded.
  a.virtualKeys.recordUsage("k-usage", false);
  a.virtualKeys.recordUsage("k-usage", false);
  const inMemory = a.virtualKeys.get("k-usage")!.usedRequests;
  assert(inMemory > 2, `expected reservations to raise it, got ${inMemory}`);

  await reloadConfigInto(a);
  assertEquals(
    a.virtualKeys.get("k-usage")?.usedRequests,
    inMemory,
    "a reload must not roll usage backwards",
  );
});

Deno.test("R0: every config mutator announces; counter writers do not", async () => {
  // The publish is what makes propagation immediate. A mutator added later that
  // forgets to announce would silently reintroduce R0 for that entity, so this
  // asserts the whole surface rather than a sample.
  const store = MemoryStateStore.named(`prop-announce-${crypto.randomUUID()}`);
  const config = new ConfigService(store);
  // Encryption is attached so the global-proxy pair can be covered here rather
  // than in a separate test: `setGlobalProxy` fails closed without a key, which
  // is why those two were the surface this enumeration originally missed
  // (decision-log 72). Crypto is transparent to announcement behavior.
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of keyBytes) bin += String.fromCharCode(b);
  config.setCrypto(await ConfigCrypto.fromEnv(store, { key: btoa(bin) }));
  let announcements = 0;
  config.setMutationListener(() => {
    announcements++;
  });

  const before = () => announcements;
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["upsertProvider", () =>
      config.upsertProvider({
        id: "px",
        type: "openai",
        apiKey: "k",
        enabled: true,
        models: [],
        priority: 0,
      })],
    ["deleteProvider", () => config.deleteProvider("px")],
    ["setDefaultProvider", () => config.setDefaultProvider("px")],
    ["upsertVirtualKey", () =>
      config.upsertVirtualKey({
        ...key("kx"),
        tokenHash: "a".repeat(64),
      } as VirtualKey)],
    ["deleteVirtualKey", () => config.deleteVirtualKey("kx")],
    ["upsertTeam", () =>
      config.upsertTeam({
        id: "tx",
        name: "T",
        enabled: true,
        usedRequests: 0,
        usedCostMicroUsd: 0,
      })],
    ["deleteTeam", () => config.deleteTeam("tx")],
    ["upsertCustomer", () =>
      config.upsertCustomer({
        id: "cx",
        name: "C",
        enabled: true,
        usedRequests: 0,
        usedCostMicroUsd: 0,
      })],
    ["deleteCustomer", () => config.deleteCustomer("cx")],
    ["savePricing", () =>
      config.savePricing({
        "m": { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
      })],
    ["upsertMCPClient", () =>
      config.upsertMCPClient({
        id: "mx",
        url: "http://127.0.0.1:1/rpc",
        enabled: true,
        transport: "auto",
        requestTimeoutMs: 30_000,
      })],
    ["deleteMCPClient", () => config.deleteMCPClient("mx")],
    // The proxy pair was missing until decision-log 72. It is the one entity
    // here that carries credentials, so a stale peer means a worker still
    // egressing through a proxy the operator has already removed.
    ["setGlobalProxy", () =>
      config.setGlobalProxy({
        proxyUrl: "http://proxy.internal:8080",
        noProxy: [],
      })],
    ["deleteGlobalProxy", () => config.deleteGlobalProxy()],
  ];

  for (const [name, run] of cases) {
    const start = before();
    await run();
    assertEquals(
      announcements,
      start + 1,
      `${name} must announce exactly once`,
    );
  }

  // Counter writes run on the REQUEST path. Announcing them would fan out a
  // config reload per request, which is why they are deliberately excluded.
  const quiet = announcements;
  await config.addUsage("kx");
  await config.addCost("kx", 100);
  assertEquals(announcements, quiet, "counter writes must stay silent");
});

Deno.test("R0: an announcement failure never fails the admin write", async () => {
  // The durable write has already committed. Reporting the call as failed
  // because the fanout leg did would be wrong, and a retry would double-apply.
  const store = MemoryStateStore.named(`prop-fail-${crypto.randomUUID()}`);
  const config = new ConfigService(store);
  config.setMutationListener(() => {
    throw new Error("notify channel down");
  });

  await config.upsertProvider({
    id: "p-resilient",
    type: "openai",
    apiKey: "k",
    enabled: true,
    models: [],
    priority: 0,
  });
  const stored = await config.getProvider("p-resilient");
  assert(stored, "the write must still have landed durably");
});
