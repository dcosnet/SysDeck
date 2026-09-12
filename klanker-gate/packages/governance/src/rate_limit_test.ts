import { assert, assertEquals } from "@std/assert";
import { RateLimiter } from "./rate_limit.ts";

Deno.test("RateLimiter enforces the fixed window", () => {
  const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
  assertEquals(limiter.check("k"), true);
  assertEquals(limiter.check("k"), true);
  assertEquals(limiter.check("k"), false);
  assert(limiter.retryAfterMs("k") > 0);
  // independent keys have independent windows
  assertEquals(limiter.check("other"), true);
});

Deno.test("RateLimiter resets after the window elapses", () => {
  const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1 });
  assertEquals(limiter.check("k"), true);
  // force expiry
  const later = Date.now() + 5;
  while (Date.now() < later) {
    // spin briefly; window is 1ms
  }
  assertEquals(limiter.check("k"), true);
});

Deno.test("RateLimiter accepts per-call policy overrides", () => {
  const limiter = new RateLimiter({ maxRequests: 100, windowMs: 60_000 });
  const strict = { maxRequests: 1, windowMs: 60_000 };
  assertEquals(limiter.check("k", strict), true);
  assertEquals(limiter.check("k", strict), false);
});
