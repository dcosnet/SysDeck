// Cross-process invalidation semantics, driven through fakes.
//
// The wire behavior against a real PostgreSQL LISTEN/NOTIFY channel is proved
// in tests/live/postgres_state_live_test.ts; this file pins the LOGIC that
// decides what happens to each event.

import { assert, assertEquals } from "@std/assert";
import type { PgExecutor } from "../../config/src/pg.ts";
import type { PgSubscription, Sql } from "../../config/src/pg_types.ts";
import { INVALIDATION_CHANNEL, InvalidationBus } from "./invalidation.ts";

/** Captures pg_notify calls instead of issuing them. */
function recordingPublisher(): PgExecutor & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    sent,
    unsafe(_query: string, params: unknown[] = []) {
      sent.push(params);
      return Promise.resolve([]);
    },
  };
}

/** A listener handle whose notifications the test drives by hand. */
function fakeListener(): Sql & {
  fire: (payload: string) => void;
  reconnect: () => void;
  unlistened: () => boolean;
} {
  let onNotify: ((payload: string) => void) | undefined;
  let onListen: (() => void) | undefined;
  let unlistened = false;
  return {
    unsafe: () => Promise.resolve([]),
    begin: () => Promise.resolve(undefined),
    end: () => Promise.resolve(),
    listen(channel, notify, listen) {
      assertEquals(channel, INVALIDATION_CHANNEL);
      onNotify = notify;
      onListen = listen;
      listen?.();
      const subscription: PgSubscription = {
        unlisten: () => {
          unlistened = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(subscription);
    },
    fire: (payload: string) => onNotify?.(payload),
    reconnect: () => onListen?.(),
    unlistened: () => unlistened,
  };
}

Deno.test("publish emits a pg_notify on the shared channel", async () => {
  const publisher = recordingPublisher();
  const bus = new InvalidationBus({ publisher, processId: "p1" });

  await bus.publishCacheClear();

  assertEquals(publisher.sent.length, 1);
  assertEquals(publisher.sent[0][0], INVALIDATION_CHANNEL);
  const payload = JSON.parse(String(publisher.sent[0][1]));
  assertEquals(payload, { origin: "p1", kind: "cache-clear" });
});

Deno.test("a process ignores its OWN events", async () => {
  const listener = fakeListener();
  let invalidations = 0;
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
    handlers: { onCacheInvalidated: () => invalidations++ },
  });
  await bus.start();
  invalidations = 0; // the initial onListen drop is asserted separately

  listener.fire(JSON.stringify({ origin: "p1", kind: "cache-clear" }));
  // The publisher already applied the change locally; re-applying would be
  // harmless but would make the applied-count meaningless.
  assertEquals(invalidations, 0);
  assertEquals(bus.appliedCount(), 0);

  listener.fire(JSON.stringify({ origin: "p2", kind: "cache-clear" }));
  assertEquals(invalidations, 1);
  assertEquals(bus.appliedCount(), 1);
});

Deno.test("every cache event kind drops the local tier", async () => {
  const listener = fakeListener();
  let invalidations = 0;
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
    handlers: { onCacheInvalidated: () => invalidations++ },
  });
  await bus.start();
  invalidations = 0;

  for (const kind of ["cache-clear", "cache-key", "cache-request-id"]) {
    listener.fire(JSON.stringify({ origin: "other", kind }));
  }
  assertEquals(invalidations, 3);
});

Deno.test("a config event reloads config instead of dropping the cache", async () => {
  const listener = fakeListener();
  let invalidations = 0;
  let reloads = 0;
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
    handlers: {
      onCacheInvalidated: () => invalidations++,
      onConfigChanged: () => {
        reloads++;
      },
    },
  });
  await bus.start();
  invalidations = 0;

  listener.fire(JSON.stringify({ origin: "other", kind: "config" }));
  assertEquals(reloads, 1);
  assertEquals(invalidations, 0);
});

Deno.test("connecting AND reconnecting both drop the local tier", async () => {
  const listener = fakeListener();
  let invalidations = 0;
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
    handlers: { onCacheInvalidated: () => invalidations++ },
  });

  await bus.start();
  // Notifications are ephemeral: anything published while this process was not
  // listening is gone for good. Assuming the worst on every (re)connection is
  // what stops a missed event from leaving a replica permanently stale.
  assertEquals(invalidations, 1);

  listener.reconnect();
  assertEquals(invalidations, 2);
});

Deno.test("a malformed payload invalidates rather than being ignored", async () => {
  const listener = fakeListener();
  let invalidations = 0;
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
    handlers: { onCacheInvalidated: () => invalidations++ },
  });
  await bus.start();
  invalidations = 0;

  listener.fire("not json at all");
  // Someone else is writing to this channel. Failing safe means invalidating.
  assertEquals(invalidations, 1);
});

Deno.test("a publish failure never propagates to the caller", async () => {
  const bus = new InvalidationBus({
    publisher: {
      unsafe: () => Promise.reject(new Error("connection refused")),
    },
    processId: "p1",
  });
  // The admin clear already succeeded locally and in the shared store; a failed
  // fanout must degrade to "other replicas expire on TTL", not to a 5xx.
  await bus.publishCacheClear();
});

Deno.test("stop unlistens", async () => {
  const listener = fakeListener();
  const bus = new InvalidationBus({
    publisher: recordingPublisher(),
    listener,
    processId: "p1",
  });
  await bus.start();
  await bus.stop();
  assert(listener.unlistened());
});

Deno.test("without a listener the bus is publish-only and start is a no-op", async () => {
  const publisher = recordingPublisher();
  const bus = new InvalidationBus({ publisher, processId: "solo" });
  // Single-process deployments get a working publish path and no subscription,
  // so call sites need no branch.
  await bus.start();
  await bus.publishRequestId("req-9");
  assertEquals(publisher.sent.length, 1);
  assertEquals(
    JSON.parse(String(publisher.sent[0][1])).detail,
    "req-9",
  );
});
