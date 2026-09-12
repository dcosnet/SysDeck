import { assert, assertEquals } from "@std/assert";
import { ConcurrencyGauge, trackResponseLifetime } from "./concurrency.ts";

Deno.test("gauge counts open connections and peak", () => {
  const gauge = new ConcurrencyGauge();
  assertEquals(gauge.active(), 0);
  const a = gauge.open();
  const b = gauge.open();
  assertEquals(gauge.active(), 2);
  assertEquals(gauge.peak(), 2);
  a.close();
  assertEquals(gauge.active(), 1);
  assertEquals(gauge.peak(), 2, "peak is monotonic");
  b.close();
  assertEquals(gauge.active(), 0);
  assertEquals(gauge.total(), 2);
  assertEquals(gauge.snapshot().completed, 2);
});

Deno.test("close is idempotent", () => {
  // A response stream can flush AND cancel; double counting would drive
  // `active` negative and corrupt every later reading.
  const gauge = new ConcurrencyGauge();
  const handle = gauge.open();
  handle.close();
  handle.close();
  handle.close();
  assertEquals(gauge.active(), 0);
  assertEquals(gauge.snapshot().completed, 1);
});

Deno.test("dispatch is tracked independently of connection lifetime", () => {
  const gauge = new ConcurrencyGauge();
  const conn = gauge.open();
  gauge.enterDispatch();
  assertEquals(gauge.dispatching(), 1);
  assertEquals(gauge.active(), 1);
  gauge.exitDispatch();
  assertEquals(gauge.dispatching(), 0);
  assertEquals(gauge.active(), 1, "connection outlives its handler");
  conn.close();
  assertEquals(gauge.active(), 0);
});

Deno.test("dispatch clamps at zero on double exit", () => {
  const gauge = new ConcurrencyGauge();
  gauge.exitDispatch();
  assertEquals(gauge.dispatching(), 0);
});

Deno.test("trackDispatch decrements when the handler throws", async () => {
  const gauge = new ConcurrencyGauge();
  await gauge.trackDispatch(() => Promise.reject(new Error("boom")))
    .then(() => assert(false, "should have thrown"))
    .catch(() => {});
  assertEquals(gauge.dispatching(), 0);
});

Deno.test("longestOpenMs reports the oldest live connection", async () => {
  const gauge = new ConcurrencyGauge();
  assertEquals(gauge.longestOpenMs(), 0, "nothing open");
  const first = gauge.open();
  await new Promise((r) => setTimeout(r, 25));
  const second = gauge.open();
  const longest = gauge.longestOpenMs();
  assert(longest >= 20, `expected >= 20ms, got ${longest}`);
  first.close();
  // With the older connection gone the reading must drop to the younger one.
  assert(gauge.longestOpenMs() < longest);
  second.close();
  assertEquals(gauge.longestOpenMs(), 0);
});

Deno.test("lifetime stats accumulate over completed connections", async () => {
  const gauge = new ConcurrencyGauge();
  for (let i = 0; i < 3; i++) {
    const handle = gauge.open();
    await new Promise((r) => setTimeout(r, 15));
    handle.close();
  }
  const snap = gauge.snapshot();
  assertEquals(snap.completed, 3);
  assert(snap.avgLifetimeMs >= 10, `avg was ${snap.avgLifetimeMs}`);
  assert(
    snap.maxLifetimeMs >= snap.avgLifetimeMs,
    "max cannot be under the mean",
  );
});

Deno.test("bodyless response closes the connection immediately", () => {
  const gauge = new ConcurrencyGauge();
  const handle = gauge.open();
  const out = trackResponseLifetime(
    new Response(null, { status: 204 }),
    handle,
  );
  assertEquals(out.status, 204);
  assertEquals(gauge.active(), 0);
});

Deno.test("undefined handle passes the response through untouched", async () => {
  const original = new Response("body", { status: 200 });
  const out = trackResponseLifetime(original, undefined);
  assertEquals(out, original);
  await out.body?.cancel();
});

Deno.test(
  "REGRESSION: a streamed body holds the gauge until the last chunk",
  async () => {
    // The old gauge decremented when the handler returned, so an SSE response
    // that stays open for seconds registered as ~0. This asserts the opposite:
    // the connection stays counted while chunks are still being produced.
    const gauge = new ConcurrencyGauge();
    const handle = gauge.open();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        await gate;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const tracked = trackResponseLifetime(new Response(source), handle);
    const reader = tracked.body!.getReader();
    const first = await reader.read();
    assertEquals(
      new TextDecoder().decode(first.value),
      "data: one\n\n",
      "bytes pass through unchanged",
    );
    assertEquals(gauge.active(), 1, "still open mid-stream");

    release();
    const second = await reader.read();
    assertEquals(new TextDecoder().decode(second.value), "data: [DONE]\n\n");
    assertEquals(gauge.active(), 1, "open until the reader sees done");

    const end = await reader.read();
    assert(end.done);
    assertEquals(gauge.active(), 0, "closed once the stream ended");
    assertEquals(gauge.snapshot().completed, 1);
  },
);

Deno.test("client disconnect closes the connection", async () => {
  const gauge = new ConcurrencyGauge();
  const handle = gauge.open();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      cancelled = true;
    },
  });

  const tracked = trackResponseLifetime(new Response(source), handle);
  const reader = tracked.body!.getReader();
  await reader.read();
  assertEquals(gauge.active(), 1);
  await reader.cancel("client went away");
  assertEquals(gauge.active(), 0, "an abandoned connection must not leak");
  assert(cancelled, "cancellation propagates to the source stream");
});

Deno.test("a stream error closes the connection", async () => {
  const gauge = new ConcurrencyGauge();
  const handle = gauge.open();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("upstream died"));
    },
  });

  const tracked = trackResponseLifetime(new Response(source), handle);
  const reader = tracked.body!.getReader();
  await reader.read().catch(() => {});
  assertEquals(gauge.active(), 0, "a failed stream must not leak the gauge");
});

Deno.test("tracked response preserves status, statusText and headers", async () => {
  const gauge = new ConcurrencyGauge();
  const handle = gauge.open();
  const original = new Response("payload", {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "text/plain", "x-frosty-cache": "miss" },
  });
  const out = trackResponseLifetime(original, handle);
  assertEquals(out.status, 201);
  assertEquals(out.statusText, "Created");
  assertEquals(out.headers.get("content-type"), "text/plain");
  assertEquals(out.headers.get("x-frosty-cache"), "miss");
  assertEquals(await out.text(), "payload");
  assertEquals(gauge.active(), 0);
});

Deno.test("lifetime window bounds memory and stays accurate on wrap", () => {
  // The ring subtracts the evicted sample rather than resumming every insert;
  // this drives it well past one wrap to catch drift or an off-by-one.
  const gauge = new ConcurrencyGauge();
  for (let i = 0; i < 2500; i++) {
    gauge.open().close();
  }
  const snap = gauge.snapshot();
  assertEquals(snap.completed, 2500);
  assertEquals(snap.active, 0);
  assert(
    snap.avgLifetimeMs >= 0 && Number.isFinite(snap.avgLifetimeMs),
    `avg drifted to ${snap.avgLifetimeMs}`,
  );
  assert(snap.avgLifetimeMs <= snap.maxLifetimeMs);
});

Deno.test("snapshot exposes the full connection contract", () => {
  const gauge = new ConcurrencyGauge();
  const snap = gauge.snapshot();
  assertEquals(Object.keys(snap).sort(), [
    "active",
    "avgLifetimeMs",
    "completed",
    "dispatching",
    "longestOpenMs",
    "maxLifetimeMs",
    "peak",
    "peakDispatching",
    "since",
    "total",
  ]);
  assert(!Number.isNaN(Date.parse(snap.since)));
});
