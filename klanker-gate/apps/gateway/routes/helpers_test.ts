import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  GatewayError,
  REBUILT_BODY_HEADERS,
} from "../../../packages/core/src/mod.ts";
import {
  dispatchThenDetach,
  MAX_JSON_BODY_BYTES,
  parseJsonBody,
  readCappedBytes,
  readCappedText,
  rebuild,
} from "./helpers.ts";

function jsonRequest(body: string): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

Deno.test("parseJsonBody parses a normal JSON body", async () => {
  const parsed = await parseJsonBody(jsonRequest('{"model":"m","n":1}'));
  assertEquals(parsed, { model: "m", n: 1 });
});

Deno.test("parseJsonBody rejects a body over the size cap with 413", async () => {
  const big = JSON.stringify({ blob: "x".repeat(64) });
  let thrown: unknown;
  try {
    await parseJsonBody(jsonRequest(big), 16); // cap below the body size
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof GatewayError, "expected a GatewayError");
  assertEquals((thrown as GatewayError).status, 413);
});

Deno.test("parseJsonBody still rejects invalid JSON with 400", async () => {
  let thrown: unknown;
  try {
    await parseJsonBody(jsonRequest("{not json"));
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof GatewayError);
  assertEquals((thrown as GatewayError).status, 400);
});

Deno.test("MAX_JSON_BODY_BYTES is a sane positive bound", () => {
  assert(MAX_JSON_BODY_BYTES > 0);
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Races `work` against a deadline without leaking the timer into the sanitizer. */
async function withinMs<T>(ms: number, work: Promise<T>): Promise<T | "HUNG"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"HUNG">((resolve) => {
    timer = setTimeout(() => resolve("HUNG"), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("readCappedBytes returns the exact bytes across chunk boundaries", async () => {
  const bytes = await readCappedBytes(
    streamOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])),
    64,
  );
  assertEquals([...bytes], [1, 2, 3, 4, 5]);
});

Deno.test("readCappedBytes treats a null body as zero bytes", async () => {
  assertEquals((await readCappedBytes(null, 64)).byteLength, 0);
});

Deno.test("readCappedBytes 413 boundary: total === maxBytes passes, one more throws", async () => {
  assertEquals(
    (await readCappedBytes(streamOf(new Uint8Array(64)), 64)).byteLength,
    64,
  );
  const err = await assertRejects(
    () => readCappedBytes(streamOf(new Uint8Array(64)), 63),
    GatewayError,
  );
  assertEquals(err.status, 413);
});

Deno.test("readCappedBytes 413 fires on the chunk that crosses the cap", async () => {
  // First chunk is under the cap, second crosses it: the check must be
  // cumulative, not per-chunk.
  const err = await assertRejects(
    () => readCappedBytes(streamOf(new Uint8Array(40), new Uint8Array(40)), 64),
    GatewayError,
  );
  assertEquals(err.status, 413);
});

Deno.test("readCappedBytes does not await cancel: a tee'd branch still yields its 413", async () => {
  // A tee branch's cancel() promise settles only once BOTH branches cancel
  // (measured: awaiting it here never resolves), so an awaited cancel would
  // hang instead of producing the 413. This is the guard on helpers.ts:43-46.
  const [a, b] = streamOf(new Uint8Array(32), new Uint8Array(32)).tee();
  const outcome = await withinMs(
    1500,
    readCappedBytes(a, 8).then((): unknown => "resolved").catch((e) => e),
  );
  assert(
    outcome instanceof GatewayError,
    `expected a GatewayError, got ${String(outcome)}`,
  );
  assertEquals(outcome.status, 413);
  await b.cancel();
});

Deno.test("readCappedText does not await cancel: a req.clone() of a STREAM body still yields its 413", async () => {
  // The shape that actually occurs in the tree, and the one the tee arm above
  // does not cover: governance.ts pre-auth-reads `req.clone()`. A clone of a
  // stream-sourced body is a tee underneath, so its cancel promise settles only
  // once the original is cancelled too - an awaited cancel hangs here exactly
  // as it does on an explicit .tee(). A clone of a BUFFERED body resolves
  // promptly, which is why measuring only that shape makes awaiting look safe.
  const req = new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    body: streamOf(new Uint8Array(32), new Uint8Array(32)),
  });
  const outcome = await withinMs(
    1500,
    readCappedText(req.clone(), 8).then((): unknown => "resolved").catch((e) =>
      e
    ),
  );
  assert(
    outcome instanceof GatewayError,
    `expected a GatewayError, got ${String(outcome)}`,
  );
  assertEquals(outcome.status, 413);
  await req.body?.cancel();
});

Deno.test("readCappedText rejects an over-cap declared content-length before reading", async () => {
  const req = new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-length": "9999" },
    body: "x".repeat(9999),
  });
  const err = await assertRejects(() => readCappedText(req, 16), GatewayError);
  assertEquals(err.status, 413);
  // The body was never consumed: the declared length alone refused it.
  assertEquals(req.bodyUsed, false);
});

Deno.test("readCappedText returns an empty string for a body-less request", async () => {
  assertEquals(
    await readCappedText(new Request("http://gateway.test/x"), 64),
    "",
  );
});

Deno.test("readCappedText decodes multibyte UTF-8 split across chunks", async () => {
  // EUR is E2 82 AC; the split lands mid-character. The read must merge before
  // decoding, or the caller gets replacement characters.
  const req = new Request("http://gateway.test/x", {
    method: "POST",
    body: streamOf(new Uint8Array([0xE2, 0x82]), new Uint8Array([0xAC])),
  });
  assertEquals(await readCappedText(req, 64), "€");
});

Deno.test("dispatchThenDetach: an already-aborted request never reaches the provider (D1-T30)", async () => {
  let upstreamHits = 0;
  const server = Deno.serve({ port: 0, onListen: () => {} }, () => {
    upstreamHits++;
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const url = `http://127.0.0.1:${server.addr.port}/images/generations`;
    const controller = new AbortController();
    const req = new Request(url, { method: "POST", signal: controller.signal });
    const reason = new Error("client vanished before the route body ran");
    controller.abort(reason);

    let seen: AbortSignal | undefined;
    let thrown: unknown;
    try {
      await dispatchThenDetach(req, (signal) => {
        seen = signal;
        return fetch(url, { method: "POST", signal });
      });
    } catch (error) {
      thrown = error;
    }

    assert(seen, "dispatch was never invoked");
    // Without the pre-listener guard the provider signal is live, the fetch
    // succeeds, and a fully abandoned request costs full provider spend.
    assertEquals(seen.aborted, true);
    assertStrictEquals(seen.reason, reason);
    assertStrictEquals(thrown, reason);
    await withinMs(200, new Promise<void>(() => {})); // let a stray connection land
    assertEquals(upstreamHits, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test("dispatchThenDetach: an abort during the dispatch reaches the provider signal", async () => {
  const controller = new AbortController();
  const req = new Request("http://gateway.test/p", {
    signal: controller.signal,
  });
  const reason = new Error("mid-flight");
  let seenReason: unknown;
  const res = await dispatchThenDetach(
    req,
    (signal) =>
      new Promise<Response>((resolve) => {
        signal.addEventListener("abort", () => {
          seenReason = signal.reason;
          resolve(new Response("abort-observed"));
        }, { once: true });
        controller.abort(reason);
      }),
  );
  assertEquals(await res.text(), "abort-observed");
  assertStrictEquals(seenReason, reason);
});

Deno.test("dispatchThenDetach: a client abort after the dispatch settles does not reach the provider signal", async () => {
  const controller = new AbortController();
  const req = new Request("http://gateway.test/q", {
    signal: controller.signal,
  });
  let seen: AbortSignal | undefined;
  const res = await dispatchThenDetach(req, (signal) => {
    seen = signal;
    return Promise.resolve(new Response("ok"));
  });
  assertEquals(seen!.aborted, false);
  // From the return onward the body read is the gateway's obligation, not the
  // client's option: the listener is gone, so this abort is not forwarded.
  controller.abort(new Error("too late"));
  assertEquals(seen!.aborted, false);
  assertEquals(req.signal.aborted, true);
  assertEquals(await res.text(), "ok");
});

/** ~15 arbitrary provider headers, none of which describes the body's framing. */
const PROVIDER_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "openai-organization": "org-abc",
  "openai-processing-ms": "4821",
  "openai-version": "2020-10-01",
  "x-request-id": "req_upstream_7",
  "x-ratelimit-limit-images": "50",
  "x-ratelimit-remaining-images": "42",
  "x-ratelimit-reset-images": "1s",
  "x-ratelimit-limit-requests": "5000",
  "x-ratelimit-remaining-requests": "4999",
  "cf-ray": "8f2b1c-DFW",
  "cf-cache-status": "DYNAMIC",
  "x-envoy-upstream-service-time": "913",
  "vary": "Accept-Encoding",
  "etag": 'W/"9a1f"',
  "x-vendor-quota-remaining": "17",
};

Deno.test("rebuild drops the framing headers and keeps every provider header (D1-T22(c))", async () => {
  // Route level, no middleware in the chain: this pins rebuild()'s OWN
  // invariant - a buffered body must not carry another body's framing headers.
  const payload = JSON.stringify({
    data: [{ b64_json: "AAAA" }, { b64_json: "BBBB" }],
  });
  const bytes = new TextEncoder().encode(payload);
  const upstream = new Response("not the body we rebuild around", {
    status: 200,
    statusText: "OK",
    headers: {
      ...PROVIDER_HEADERS,
      "content-encoding": "gzip",
      "content-length": "166",
      "transfer-encoding": "chunked",
    },
  });

  const out = rebuild(upstream, bytes);

  assertEquals(out.status, 200);
  for (const name of REBUILT_BODY_HEADERS) {
    assertEquals(out.headers.get(name), null, `${name} must not survive`);
  }
  // Behavioural floor, independent of the shared set's contents.
  assertEquals(out.headers.get("content-encoding"), null);
  assertEquals(out.headers.get("content-length"), null);
  assertEquals(out.headers.get("transfer-encoding"), null);
  // Every provider header arrives with its exact value - the denylist adds
  // nothing and drops nothing else. This is the set-membership residual,
  // closed behaviourally.
  for (const [name, value] of Object.entries(PROVIDER_HEADERS)) {
    assertEquals(out.headers.get(name), value, `${name} must survive`);
  }
  assertEquals(
    [...out.headers.keys()].length,
    Object.keys(PROVIDER_HEADERS).length,
  );
  assertEquals(await out.text(), payload);
});

Deno.test("rebuild carries the gateway's own cache markers across the buffered body", async () => {
  const bytes = new TextEncoder().encode("{}");
  const upstream = new Response("stale", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": "166",
      "x-frosty-cache": "HIT",
      "x-frosty-cache-type": "semantic",
    },
  });
  const out = rebuild(upstream, bytes);
  assertEquals(out.headers.get("x-frosty-cache"), "HIT");
  assertEquals(out.headers.get("x-frosty-cache-type"), "semantic");
  assertEquals(out.headers.get("content-length"), null);
  assertEquals(await out.text(), "{}");
});
