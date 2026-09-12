// Two-tier cache behavior: in-process L1 in front of a shared L2.
//
// The properties under test are the ones that make N gateway processes share a
// cache correctly, and the ones that stop the L2 from ever failing a request.

import { assert, assertEquals } from "@std/assert";
import { SemanticCache } from "./semantic.ts";
import type { CachedEntry, CacheStore } from "./store.ts";
import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";

function reply(content: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-${content}`,
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hei" }],
};

/** Recording in-memory CacheStore standing in for PostgreSQL. */
class FakeCacheStore implements CacheStore {
  entries = new Map<string, CachedEntry>();
  calls: string[] = [];

  get(key: string): Promise<CachedEntry | null> {
    this.calls.push(`get:${key.slice(0, 8)}`);
    return Promise.resolve(this.entries.get(key) ?? null);
  }
  set(key: string, entry: CachedEntry): Promise<void> {
    this.calls.push(`set:${key.slice(0, 8)}`);
    this.entries.set(key, entry);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    this.calls.push("delete");
    return Promise.resolve(this.entries.delete(key));
  }
  deleteByRequestId(requestId: string): Promise<boolean> {
    this.calls.push("deleteByRequestId");
    let hit = false;
    for (const [k, v] of this.entries) {
      if (v.requestId === requestId) {
        this.entries.delete(k);
        hit = true;
      }
    }
    return Promise.resolve(hit);
  }
  clear(): Promise<number> {
    this.calls.push("clear");
    const n = this.entries.size;
    this.entries.clear();
    return Promise.resolve(n);
  }
  cleanupExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** Every method rejects: the fail-open contract must hold against a dead L2. */
class BrokenCacheStore implements CacheStore {
  get(): Promise<CachedEntry | null> {
    return Promise.reject(new Error("connection refused"));
  }
  set(): Promise<void> {
    return Promise.reject(new Error("connection refused"));
  }
  delete(): Promise<boolean> {
    return Promise.reject(new Error("connection refused"));
  }
  deleteByRequestId(): Promise<boolean> {
    return Promise.reject(new Error("connection refused"));
  }
  clear(): Promise<number> {
    return Promise.reject(new Error("connection refused"));
  }
  cleanupExpired(): Promise<number> {
    return Promise.reject(new Error("connection refused"));
  }
}

Deno.test("L1 hit never touches L2", async () => {
  const shared = new FakeCacheStore();
  const cache = new SemanticCache({ cacheStore: shared });

  await cache.set(REQUEST, reply("first"), "req-1");
  shared.calls.length = 0;

  const hit = await cache.getWithDebug(REQUEST);
  assertEquals(hit.response?.choices[0].message.content, "first");
  assertEquals(hit.debug.cache_type, "direct");
  assertEquals(hit.debug.tier, "l1");
  // The whole point of keeping L1: a hit costs a Map lookup, not a round trip.
  assertEquals(shared.calls, []);
});

Deno.test("a second process reads the first one's completion from L2", async () => {
  // Two caches over ONE shared store is exactly the replica topology.
  const shared = new FakeCacheStore();
  const processA = new SemanticCache({ cacheStore: shared });
  const processB = new SemanticCache({ cacheStore: shared });

  await processA.set(REQUEST, reply("computed-by-A"), "req-1");

  const onB = await processB.getWithDebug(REQUEST);
  assertEquals(onB.response?.choices[0].message.content, "computed-by-A");
  assertEquals(onB.debug.cache_type, "direct");
  assertEquals(onB.debug.tier, "l2");

  // ...and it is promoted into B's L1, so B's next hit is local.
  shared.calls.length = 0;
  const again = await processB.getWithDebug(REQUEST);
  assertEquals(again.debug.tier, "l1");
  assertEquals(shared.calls, []);
});

Deno.test("L2 entries past the configured TTL are a miss, not a stale hit", async () => {
  const shared = new FakeCacheStore();
  const writer = new SemanticCache({ cacheStore: shared, ttlMs: 60_000 });
  await writer.set(REQUEST, reply("old"), "req-1");

  // Backdate the shared row past the reader's TTL. The reader re-checks the TTL
  // itself rather than trusting the row's expires_at, so an operator who
  // SHORTENS the TTL at runtime sees it take effect immediately instead of
  // waiting for rows written under the old TTL to age out.
  for (const entry of shared.entries.values()) {
    entry.storedAt = Date.now() - 120_000;
  }

  const reader = new SemanticCache({ cacheStore: shared, ttlMs: 60_000 });
  const lookup = await reader.getWithDebug(REQUEST);
  assertEquals(lookup.response, null);
  assertEquals(lookup.debug.cache_type, "miss");
});

Deno.test("a dead L2 degrades to a miss and never fails the request", async () => {
  const cache = new SemanticCache({ cacheStore: new BrokenCacheStore() });

  // Writing must not throw: a completion that was successfully generated is
  // never discarded because the cache write failed.
  await cache.set(REQUEST, reply("value"), "req-1");

  // Reading must not throw either. L1 still answers, because the write reached
  // L1 even though L2 rejected.
  const hit = await cache.getWithDebug(REQUEST);
  assertEquals(hit.debug.tier, "l1");

  // With L1 cold, a broken L2 is a plain miss.
  const cold = new SemanticCache({ cacheStore: new BrokenCacheStore() });
  const miss = await cold.getWithDebug(REQUEST);
  assertEquals(miss.response, null);
  assertEquals(miss.debug.cache_type, "miss");
});

Deno.test("clear empties BOTH tiers", async () => {
  const shared = new FakeCacheStore();
  const cache = new SemanticCache({ cacheStore: shared });
  await cache.set(REQUEST, reply("value"), "req-1");
  assertEquals(shared.entries.size, 1);

  const cleared = await cache.clear();
  assert(cleared >= 1);
  // Clearing only L1 would be a lie: the next request on ANY replica would
  // still be served the entry the operator just deleted.
  assertEquals(shared.entries.size, 0);
  assertEquals((await cache.getWithDebug(REQUEST)).response, null);
});

Deno.test("clearLocal empties ONLY this process's tier", async () => {
  const shared = new FakeCacheStore();
  const cache = new SemanticCache({ cacheStore: shared });
  await cache.set(REQUEST, reply("value"), "req-1");

  // This is the remote-invalidation handler: the replica that published the
  // change already removed the shared row, so a receiver must drop its own L1
  // WITHOUT re-clearing the shared tier (which would race other replicas'
  // concurrent writes).
  cache.clearLocal();
  assertEquals(shared.entries.size, 1);
  assertEquals(cache.size(), 0);
});

Deno.test("deleteEntry and deleteByRequestId reach the shared tier", async () => {
  const shared = new FakeCacheStore();
  const cache = new SemanticCache({ cacheStore: shared });

  await cache.set(REQUEST, reply("value"), "req-1");
  assertEquals(await cache.deleteEntry(REQUEST), true);
  assertEquals(shared.entries.size, 0);

  await cache.set(REQUEST, reply("value"), "req-2");
  assertEquals(await cache.deleteByRequestId("req-2"), true);
  assertEquals(shared.entries.size, 0);
});

Deno.test("no L2 attached: behavior is byte-identical to the historical cache", async () => {
  // The single-process path must be unchanged by the two-tier work, including
  // the absence of the new `tier` field.
  const cache = new SemanticCache();
  assertEquals((await cache.getWithDebug(REQUEST)).debug, {
    cache_type: "miss",
    threshold: 0.95,
  });
  await cache.set(REQUEST, reply("value"), "req-1");
  const hit = await cache.getWithDebug(REQUEST);
  assertEquals(hit.debug.cache_type, "direct");
  assertEquals(hit.debug.tokens, 3);
  assertEquals(hit.debug.tier, undefined);
  assertEquals(await cache.clear(), 1);
});
