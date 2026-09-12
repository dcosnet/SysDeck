import { assert, assertEquals } from "@std/assert";
import {
  hashVirtualKeyToken,
  publicVirtualKey,
  type VirtualKey,
  VirtualKeyManager,
} from "./virtual_keys.ts";

function key(overrides: Partial<VirtualKey> & { id: string }): VirtualKey {
  return {
    name: overrides.id,
    token: `vk-${overrides.id}-01234567`,
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    ...overrides,
  };
}

Deno.test("check denies missing, unknown, and disabled keys", () => {
  const manager = new VirtualKeyManager([
    key({ id: "off", enabled: false }),
  ]);

  const missing = manager.check(null);
  assert(!missing.ok);
  assertEquals(missing.status, 401);
  assertEquals(missing.code, "missing_virtual_key");

  const unknown = manager.check("vk-nope");
  assert(!unknown.ok);
  assertEquals(unknown.code, "invalid_virtual_key");

  const disabled = manager.check("vk-off-01234567");
  assert(!disabled.ok);
  assertEquals(disabled.code, "invalid_virtual_key");
});

Deno.test("check enforces request budgets", () => {
  const manager = new VirtualKeyManager([
    key({ id: "b", budget: { maxRequests: 2 } }),
  ]);
  const token = "vk-b-01234567";

  for (let i = 0; i < 2; i++) {
    const decision = manager.check(token);
    assert(decision.ok);
    manager.recordUsage(decision.key.id);
  }

  const exhausted = manager.check(token);
  assert(!exhausted.ok);
  assertEquals(exhausted.status, 402);
  assertEquals(exhausted.code, "budget_exhausted");
});

Deno.test("check enforces per-key rate limits", () => {
  const manager = new VirtualKeyManager([
    key({ id: "r", rateLimit: { maxRequests: 2, windowMs: 60_000 } }),
  ]);
  const token = "vk-r-01234567";

  assert(manager.check(token).ok);
  assert(manager.check(token).ok);
  const limited = manager.check(token);
  assert(!limited.ok);
  assertEquals(limited.status, 429);
  assertEquals(limited.code, "rate_limited");
});

Deno.test("active once any key exists, even a disabled one", () => {
  assertEquals(new VirtualKeyManager().active(), false);
  // disabled-only still enforces: fail closed, not open
  assertEquals(
    new VirtualKeyManager([key({ id: "off", enabled: false })]).active(),
    true,
  );
  assertEquals(new VirtualKeyManager([key({ id: "on" })]).active(), true);
});

Deno.test("tokens are stored hashed, never retained in raw form", () => {
  const manager = new VirtualKeyManager();
  const stored = manager.upsert(key({ id: "k1" })); // token: vk-k1-01234567
  // The stored/persisted record carries no raw token, only its SHA-256 hash.
  assertEquals(stored.token, undefined);
  assertEquals(stored.tokenHash, hashVirtualKeyToken("vk-k1-01234567"));
  assertEquals(manager.get("k1")!.token, undefined);
  // The raw token still authenticates via constant-time hash lookup.
  assert(manager.check("vk-k1-01234567").ok);
  // A wrong token of the same shape is rejected.
  const bad = manager.check("vk-k1-89abcdef");
  assert(!bad.ok);
  assertEquals(bad.code, "invalid_virtual_key");
});

Deno.test("legacy raw-token records are migrated to hashes at load", () => {
  // A persisted record predating hashing: raw token, no tokenHash.
  const manager = new VirtualKeyManager([key({ id: "legacy" })]);
  const stored = manager.get("legacy")!;
  assertEquals(stored.token, undefined);
  assertEquals(stored.tokenHash, hashVirtualKeyToken("vk-legacy-01234567"));
  assert(manager.check("vk-legacy-01234567").ok);
});

Deno.test("a key can be admitted by a pre-hashed record with no raw token", () => {
  const manager = new VirtualKeyManager([
    key({
      id: "h",
      token: undefined,
      tokenHash: hashVirtualKeyToken("vk-live"),
    }),
  ]);
  assert(manager.check("vk-live").ok);
});

Deno.test("removing a key clears its hash index entry", () => {
  const manager = new VirtualKeyManager([key({ id: "gone" })]);
  assert(manager.check("vk-gone-01234567").ok);
  manager.remove("gone");
  assert(!manager.check("vk-gone-01234567").ok);
});

Deno.test("publicVirtualKey exposes neither token nor hash, only a short hint", () => {
  const pub = publicVirtualKey(key({ id: "secret" }));
  assertEquals("token" in pub, false);
  assertEquals("tokenHash" in pub, false);
  // Hint reveals at most the last 4 chars (was first 6 — leaked 75% of a key).
  assert(pub.tokenHint.startsWith("…"));
  assert(pub.tokenHint.length <= 5);
  assert(!pub.tokenHint.includes("secret"));
});
