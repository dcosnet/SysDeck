import { assertEquals } from "@std/assert";
import { MemoryStateStore } from "../../config/src/store_memory.ts";
import {
  pruneRateWindows,
  RATE_PREFIX,
  SharedRateLimiter,
  windowStart,
} from "./shared_rate_limit.ts";

function store() {
  return MemoryStateStore.named(`rate-${crypto.randomUUID()}`);
}

Deno.test("windowStart snaps to the containing fixed window", () => {
  assertEquals(windowStart(0, 60_000), 0);
  assertEquals(windowStart(59_999, 60_000), 0);
  assertEquals(windowStart(60_000, 60_000), 60_000);
  assertEquals(windowStart(60_001, 60_000), 60_000);
});

Deno.test("admits exactly max, then limits", async () => {
  const limiter = new SharedRateLimiter(store());
  const w = { scope: "requests", id: "k", max: 3, windowMs: 60_000 };
  const now = 1_000_000;
  assertEquals(await limiter.admit(w, now), "admitted");
  assertEquals(await limiter.admit(w, now), "admitted");
  assertEquals(await limiter.admit(w, now), "admitted");
  assertEquals(await limiter.admit(w, now), "limited");
});

Deno.test("REGRESSION: two processes share one window", async () => {
  // This is R1. With the in-process RateLimiter each worker kept its own Map,
  // so a limit of 3 admitted 3 PER WORKER - 6 across two. One shared store
  // means one budget no matter which process serves the request.
  const shared = store();
  const workerA = new SharedRateLimiter(shared);
  const workerB = new SharedRateLimiter(shared);
  const w = { scope: "requests", id: "k", max: 3, windowMs: 60_000 };
  const now = 2_000_000;

  assertEquals(await workerA.admit(w, now), "admitted");
  assertEquals(await workerB.admit(w, now), "admitted");
  assertEquals(await workerA.admit(w, now), "admitted");
  assertEquals(
    await workerB.admit(w, now),
    "limited",
    "the fourth request is denied regardless of which worker sees it",
  );
});

Deno.test("a new window resets the allowance", async () => {
  const limiter = new SharedRateLimiter(store());
  const w = { scope: "requests", id: "k", max: 2, windowMs: 60_000 };
  const first = 3_000_000;
  assertEquals(await limiter.admit(w, first), "admitted");
  assertEquals(await limiter.admit(w, first), "admitted");
  assertEquals(await limiter.admit(w, first), "limited");
  // Next window start.
  const next = windowStart(first, 60_000) + 60_000;
  assertEquals(await limiter.admit(w, next), "admitted");
});

Deno.test("scopes do not share a window", async () => {
  const limiter = new SharedRateLimiter(store());
  const now = 4_000_000;
  const requests = { scope: "requests", id: "k", max: 1, windowMs: 60_000 };
  const tokens = {
    scope: "tokens",
    id: "k",
    max: 100,
    windowMs: 60_000,
    amount: 10,
  };
  assertEquals(await limiter.admit(requests, now), "admitted");
  assertEquals(await limiter.admit(requests, now), "limited");
  // Token metering is a separate budget and must be unaffected.
  assertEquals(await limiter.admit(tokens, now), "admitted");
});

Deno.test("keys do not share a window", async () => {
  const limiter = new SharedRateLimiter(store());
  const now = 5_000_000;
  const a = { scope: "requests", id: "key-a", max: 1, windowMs: 60_000 };
  const b = { scope: "requests", id: "key-b", max: 1, windowMs: 60_000 };
  assertEquals(await limiter.admit(a, now), "admitted");
  assertEquals(await limiter.admit(a, now), "limited");
  assertEquals(await limiter.admit(b, now), "admitted");
});

Deno.test("token metering consumes the estimated amount", async () => {
  const limiter = new SharedRateLimiter(store());
  const now = 6_000_000;
  const w = {
    scope: "tokens",
    id: "k",
    max: 100,
    windowMs: 60_000,
    amount: 60,
  };
  assertEquals(await limiter.admit(w, now), "admitted");
  assertEquals(await limiter.admit(w, now), "limited", "60 + 60 exceeds 100");
});

Deno.test("an oversized request does not poison a fresh window", async () => {
  // The reservation is all-or-nothing, so a request larger than the whole
  // window is denied WITHOUT consuming anything - the next normal-sized
  // request still gets through.
  const limiter = new SharedRateLimiter(store());
  const now = 7_000_000;
  const huge = {
    scope: "tokens",
    id: "k",
    max: 100,
    windowMs: 60_000,
    amount: 500,
  };
  assertEquals(await limiter.admit(huge, now), "limited");
  const normal = { ...huge, amount: 50 };
  assertEquals(await limiter.admit(normal, now), "admitted");
});

Deno.test("retryAfterMs counts down to the window boundary", () => {
  const limiter = new SharedRateLimiter(store());
  const windowMs = 60_000;
  const start = windowStart(8_000_000, windowMs);
  assertEquals(limiter.retryAfterMs(windowMs, start), windowMs);
  assertEquals(limiter.retryAfterMs(windowMs, start + 15_000), 45_000);
  assertEquals(limiter.retryAfterMs(windowMs, start + windowMs - 1), 1);
});

Deno.test("a store that cannot answer reports unavailable, never admitted", async () => {
  // Governance fails closed: a limit nobody can evaluate has not been passed.
  const broken = {
    ...MemoryStateStore.named(`rate-broken-${crypto.randomUUID()}`),
    reserveCounts: () => Promise.resolve("conflict" as const),
  } as unknown as MemoryStateStore;
  const limiter = new SharedRateLimiter(broken);
  assertEquals(
    await limiter.admit({
      scope: "requests",
      id: "k",
      max: 5,
      windowMs: 60_000,
    }),
    "unavailable",
  );
});

Deno.test("keyFor addresses a window by its start time", () => {
  const key = SharedRateLimiter.keyFor(
    { scope: "requests", id: "k", max: 1, windowMs: 60_000 },
    125_000,
  );
  assertEquals(key, [RATE_PREFIX, "requests", "k", "120000"]);
});

Deno.test("the janitor removes only windows that can no longer be used", async () => {
  const shared = store();
  const limiter = new SharedRateLimiter(shared);
  const now = 100_000_000;
  const w = { scope: "requests", id: "k", max: 5, windowMs: 60_000 };
  // One ancient window and one current.
  await limiter.admit(w, now - 7_200_000);
  await limiter.admit(w, now);
  assertEquals((await shared.listCounts([RATE_PREFIX])).length, 2);

  const removed = await pruneRateWindows(shared, now, 3_600_000);
  assertEquals(removed, 1, "only the ancient window is collectable");
  const left = await shared.listCounts([RATE_PREFIX]);
  assertEquals(left.length, 1);
  assertEquals(left[0].key[3], String(windowStart(now, 60_000)));
});

Deno.test("the janitor is a no-op with nothing to collect", async () => {
  const shared = store();
  assertEquals(await pruneRateWindows(shared, Date.now()), 0);
});
