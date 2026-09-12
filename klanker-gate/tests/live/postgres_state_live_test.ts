// LIVE evidence against a real PostgreSQL. Not part of the default gate:
// `deno task test:live` starts the Compose `postgres` service first.
//
// This is where the Postgres consolidation is actually proved. The unit gate
// runs the StateStore contract against MemoryStateStore, which cannot catch a
// SQL-level mistake - a wrong collation, a prefix range that misses, an upsert
// that is not atomic under real concurrency. The SAME contract runs here
// against the real engine.
//
// Everything is namespaced per test run so the sandbox stays inspectable and
// concurrent runs cannot collide.

import { assert, assertEquals } from "@std/assert";
import { openPg, type PgHandle } from "../../packages/config/src/pg.ts";
import { PostgresStateStore } from "../../packages/config/src/store_postgres.ts";
import { STATE_STORE_CONTRACT } from "../../packages/config/src/store_contract.ts";
import { PgCacheStore } from "../../packages/cache/src/pg_cache.ts";
import { InvalidationBus } from "../../packages/cache/src/invalidation.ts";
import type { Sql } from "../../packages/config/src/pg_types.ts";
import type { StateKey } from "../../packages/config/src/store.ts";
import type { ChatCompletionResponse } from "../../packages/contracts/src/mod.ts";

const URL_ = "postgres://frosty:frosty@127.0.0.1:5432/frosty";

async function docker(...args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

let sandboxReady: Promise<string> | undefined;
function ensureSandbox(): Promise<string> {
  sandboxReady ??= docker("compose", "up", "-d", "--wait", "postgres");
  return sandboxReady;
}

async function connect(): Promise<PgHandle> {
  await ensureSandbox();
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const pg = await openPg({ url: URL_, max: 4 });
      await pg.unsafe("SELECT 1");
      return pg;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`postgres not ready: ${lastError}`);
}

/**
 * Wraps a store so every key is prefixed with a per-test namespace. The
 * contract cases use fixed key paths; without isolation they would collide
 * across cases and across concurrent runs against the shared sandbox.
 */
function namespaced(store: PostgresStateStore, ns: string): PostgresStateStore {
  const scope = (key: StateKey): StateKey => [ns, ...key];
  const unscope = (key: StateKey): StateKey => key.slice(1);
  return {
    set: (k, v) => store.set(scope(k), v),
    get: (k) => store.get(scope(k)),
    list: async (k, o) =>
      (await store.list(scope(k), o)).map((r) => ({
        key: unscope(r.key),
        value: r.value,
      })),
    keys: async (k) => (await store.keys(scope(k))).map(unscope),
    delete: (k) => store.delete(scope(k)),
    sum: (k, d) => store.sum(scope(k), d),
    getCount: (k) => store.getCount(scope(k)),
    listCounts: async (k) =>
      (await store.listCounts(scope(k))).map((r) => ({
        key: unscope(r.key),
        value: r.value,
      })),
    deleteCount: (k) => store.deleteCount(scope(k)),
    getOrSet: (k, v) => store.getOrSet(scope(k), v),
    reserveCounts: (limits) =>
      store.reserveCounts(limits.map((l) => ({ ...l, key: scope(l.key) }))),
    close: () => {},
  } as PostgresStateStore;
}

Deno.test("LIVE PostgresStateStore satisfies the StateStore contract", async (t) => {
  const pg = await connect();
  const store = new PostgresStateStore(pg);
  await store.init();
  try {
    for (const testCase of STATE_STORE_CONTRACT) {
      await t.step(testCase.name, async () => {
        const ns = `t${crypto.randomUUID().replaceAll("-", "")}`;
        await testCase.run(namespaced(store, ns));
      });
    }
  } finally {
    await pg.close();
  }
});

Deno.test("LIVE ordering is byte order, not locale collation", async () => {
  // The state tables declare key_text COLLATE "C". Under a locale collation
  // PostgreSQL orders text by dictionary rules - ignoring case and punctuation -
  // so the newest-first log trail would come back mis-ordered relative to the
  // same data read from the in-memory store. These inputs differ between the
  // two orderings.
  const pg = await connect();
  const store = new PostgresStateStore(pg);
  await store.init();
  const ns = `collate${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    for (const id of ["B", "a", "_x", "Z", "1"]) {
      await store.set([ns, id], id);
    }
    const got = (await store.list<string>([ns])).map((r) => r.value);
    const expected = ["1", "B", "Z", "_x", "a"].sort(); // JS byte order
    assertEquals(got, expected);
  } finally {
    for (const id of ["B", "a", "_x", "Z", "1"]) {
      await store.delete([ns, id]);
    }
    await pg.close();
  }
});

Deno.test("LIVE reserveCounts admits exactly max under REAL concurrency", async () => {
  // The unit contract runs this against a single-threaded Map, where the
  // guarantee is trivial. Here the increments race across separate pooled
  // connections, so only the row lock held to COMMIT makes it hold - this is
  // the multi-replica version of the lifetime-budget race decision-log 42
  // closed per-process.
  const pg = await connect();
  const store = new PostgresStateStore(pg);
  await store.init();
  const key = [`race${crypto.randomUUID().replaceAll("-", "")}`, "k"];
  try {
    const limits = [{ key, max: 5 }];
    const results = await Promise.all(
      Array.from({ length: 40 }, () => store.reserveCounts(limits)),
    );
    const reserved = results.filter((r) => r === "reserved").length;
    assertEquals(reserved, 5, "exactly 5 of 40 concurrent admits may pass");
    assertEquals(await store.getCount(key), 5);
    // No attempt may be lost; a "conflict" is a deny, never a silent admit.
    assertEquals(results.length, 40);
    assert(results.every((r) => r !== undefined));
  } finally {
    await store.deleteCount(key);
    await pg.close();
  }
});

Deno.test("LIVE L2 cache: round-trip, TTL expiry, and janitor cleanup", async () => {
  const pg = await connect();
  const cache = new PgCacheStore({ executor: pg });
  await cache.init();
  const key = `live-${crypto.randomUUID()}`;
  const expiring = `live-${crypto.randomUUID()}`;
  const response = {
    id: "chatcmpl-live",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "hei" },
      finish_reason: "stop",
    }],
  } as ChatCompletionResponse;

  try {
    await cache.set(
      key,
      { response, storedAt: Date.now(), requestId: "r1" },
      60_000,
    );
    const hit = await cache.get(key);
    assertEquals(hit?.response.choices[0].message.content, "hei");
    assertEquals(hit?.requestId, "r1");
    // stored_at survives the timestamptz round-trip as epoch millis.
    assert(Math.abs((hit?.storedAt ?? 0) - Date.now()) < 60_000);

    // TTL floors at 1 second; wait it out and confirm the read filter - not a
    // sweeper - is what makes it a miss.
    await cache.set(expiring, { response, storedAt: Date.now() }, 1);
    await new Promise((r) => setTimeout(r, 1500));
    assertEquals(await cache.get(expiring), null);

    // ...and that the expired ROW is still physically present until deleted,
    // which is exactly why the janitor exists.
    //
    // A gateway may be running against this same database with its own janitor
    // loop, so asserting `swept >= 1` unconditionally is a race: the other
    // sweeper can reclaim the row first and this call legitimately returns 0.
    // Check whether the row is still there immediately before sweeping, and
    // only then require this call to be the one that collects it. The invariant
    // that always holds - and the one that matters - is that it is gone after.
    const stillPresent = async () => {
      const rows = await pg.unsafe(
        `SELECT 1 FROM frosty.response_cache WHERE cache_key = $1`,
        [expiring],
      ) as unknown[];
      return rows.length > 0;
    };
    const ourRowToCollect = await stillPresent();
    const swept = await cache.cleanupExpired(1000);
    if (ourRowToCollect) {
      assert(swept >= 1, "the janitor must reclaim the expired row");
    }
    assertEquals(
      await stillPresent(),
      false,
      "the expired row must be gone once a janitor has run",
    );

    assertEquals(await cache.deleteByRequestId("r1"), true);
    assertEquals(await cache.get(key), null);
  } finally {
    await cache.delete(key);
    await cache.delete(expiring);
    await pg.close();
  }
});

Deno.test("LIVE invalidation crosses process boundaries over LISTEN/NOTIFY", async () => {
  // Two buses on two independent connections stand in for two gateway
  // processes. This is the whole reason a shared L1 invalidation works at all,
  // and it cannot be proved with fakes.
  const publisherPg = await connect();
  const postgres = (await import("postgres")).default;
  const listenerSql = postgres(URL_, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
  }) as unknown as Sql;

  let received = 0;
  const processB = new InvalidationBus({
    publisher: publisherPg,
    listener: listenerSql,
    processId: "process-B",
    handlers: { onCacheInvalidated: () => received++ },
  });
  const processA = new InvalidationBus({
    publisher: publisherPg,
    processId: "process-A",
  });

  try {
    await processB.start();
    // start() drops L1 unconditionally (missed-notification recovery).
    assertEquals(received, 1);

    await processA.publishCacheClear();
    await waitFor(() => received >= 2, 10_000);
    assertEquals(processB.appliedCount(), 1);

    // B must ignore its own publish.
    const before = processB.appliedCount();
    await processB.publishCacheClear();
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(processB.appliedCount(), before);
  } finally {
    await processB.stop();
    await listenerSql.end({ timeout: 5 });
    await publisherPg.close();
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
