// Composition-root behavior that unit tests can reach without a database.
// `createDefaultContext()` itself is covered by actually booting the gateway
// (the live and browser stages); what is testable in isolation is the env
// parsing and the reload semantics it wires up.

import { assert, assertEquals } from "@std/assert";
import {
  createContext,
  NullToolExecutor,
  reconcileIntervalFromEnv,
  sharedRateLimitEnabled,
  VERSION,
} from "./context.ts";

Deno.test("reconcileIntervalFromEnv: default when unset or blank", () => {
  assertEquals(reconcileIntervalFromEnv(undefined), 30_000);
  assertEquals(reconcileIntervalFromEnv(""), 30_000);
  assertEquals(reconcileIntervalFromEnv("   "), 30_000);
});

Deno.test("reconcileIntervalFromEnv: accepts a sane explicit interval", () => {
  assertEquals(reconcileIntervalFromEnv("5000"), 5_000);
  assertEquals(reconcileIntervalFromEnv("3600000"), 3_600_000);
});

Deno.test("reconcileIntervalFromEnv: zero disables the poll", () => {
  // Explicitly supported: an operator who trusts LISTEN/NOTIFY and does not
  // want a background query can turn the backstop off.
  assertEquals(reconcileIntervalFromEnv("0"), 0);
});

Deno.test("reconcileIntervalFromEnv: every bad input falls back, none throw", () => {
  for (
    const bad of ["-1", "1.5", "abc", "3600001", "Infinity", "NaN", "1 000"]
  ) {
    assertEquals(
      reconcileIntervalFromEnv(bad),
      30_000,
      `input ${JSON.stringify(bad)} should fall back`,
    );
  }
});

Deno.test("reconcileIntervalFromEnv: exponent notation is a valid number", () => {
  // `Number()` accepts it and the result is a sane integer interval, so it is
  // taken rather than rejected. Recorded because it looks like a typo.
  assertEquals(reconcileIntervalFromEnv("1e3"), 1_000);
});

Deno.test("createContext: builds a usable env-only context", () => {
  const ctx = createContext();
  assertEquals(ctx.version, VERSION);
  assert(ctx.providers, "provider manager is present");
  assert(ctx.virtualKeys, "virtual key manager is present");
  assert(ctx.metrics, "metrics are present");
  assert(ctx.concurrency, "the connection gauge is present");
});

Deno.test("createContext: attaches NO shared authorities", () => {
  // The env-only context is the zero-infrastructure path: no database, so no
  // invalidation bus, no fleet-wide rate limiter, and no durable config. Tests
  // that assume single-process semantics depend on this staying true.
  const ctx = createContext();
  assertEquals(ctx.invalidation, undefined);
  assertEquals(ctx.sharedRateLimit, undefined);
  assertEquals(ctx.config, undefined);
  // Without a shared limiter the in-process windows must stay active.
  assertEquals(ctx.virtualKeys.hasExternalRateLimit(), false);
});

Deno.test("NullToolExecutor: owns nothing and refuses to execute", async () => {
  const executor = new NullToolExecutor();
  assertEquals(executor.has("anything"), false);
  assertEquals(executor.isSideEffect("anything"), false);
  await executor.execute("anything", {})
    .then(() => assert(false, "should have rejected"))
    .catch((error: Error) =>
      assert(error.message.includes("no gateway tools"))
    );
});

Deno.test("sharedRateLimitEnabled: auto follows the worker count", () => {
  // The whole point: pay for a shared reservation only when a second process
  // could otherwise admit a second copy of the same limit.
  assertEquals(sharedRateLimitEnabled(undefined, undefined), false);
  assertEquals(sharedRateLimitEnabled(undefined, "1"), false);
  assertEquals(sharedRateLimitEnabled(undefined, "4"), true);
  assertEquals(sharedRateLimitEnabled("auto", "2"), true);
});

Deno.test("sharedRateLimitEnabled: explicit on/off overrides the worker count", () => {
  // `on` is for separate replicas behind a load balancer, which the worker
  // count cannot see.
  assertEquals(sharedRateLimitEnabled("on", "1"), true);
  assertEquals(sharedRateLimitEnabled("true", undefined), true);
  assertEquals(sharedRateLimitEnabled("off", "8"), false);
  assertEquals(sharedRateLimitEnabled("false", "8"), false);
});

Deno.test("sharedRateLimitEnabled: garbage falls back to auto", () => {
  assertEquals(sharedRateLimitEnabled("banana", "4"), true);
  assertEquals(sharedRateLimitEnabled("banana", "1"), false);
  assertEquals(sharedRateLimitEnabled("  ON  ", "1"), true);
  // A malformed worker count is not a fleet.
  assertEquals(sharedRateLimitEnabled(undefined, "abc"), false);
  assertEquals(sharedRateLimitEnabled(undefined, "2.5"), false);
});
