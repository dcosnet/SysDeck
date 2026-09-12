import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProviderClient, shouldBypassProxy } from "./client.ts";
import { readSSE } from "../../testing/src/mod.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Synchronous mock fetch (ignores signal/client). */
function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

/** A fetch that never resolves until its signal aborts, then rejects with the
 * abort reason — models a hung upstream that honors cancellation. */
const mockHang: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
    } else {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }
  });

/** Event-stream body that emits `chunks` one every `gapMs`, then closes. */
function timedStream(
  chunks: string[],
  gapMs: number,
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

// ---------------------------------------------------------------------------
// Timeout: establishment
// ---------------------------------------------------------------------------

Deno.test("request-timeout aborts a hung upstream with a TimeoutError", async () => {
  const client = new ProviderClient(
    { maxRetries: 0, requestTimeoutMs: 30 },
    mockHang,
  );
  const err = await assertRejects(() => client.fetchWithRetry("http://mock/"));
  assert(err instanceof DOMException);
  assertEquals((err as DOMException).name, "TimeoutError");
});

Deno.test("a timeout is terminal and is not retried", async () => {
  let calls = 0;
  const mock: typeof fetch = (_i, init) =>
    new Promise<Response>((_r, reject) => {
      calls++;
      const s = init?.signal!;
      s.addEventListener("abort", () => reject(s.reason), { once: true });
    });
  const client = new ProviderClient(
    { maxRetries: 3, initialDelayMs: 1, requestTimeoutMs: 20 },
    mock,
  );
  const err = await assertRejects(() => client.fetchWithRetry("http://mock/"));
  assertEquals((err as DOMException).name, "TimeoutError");
  assertEquals(calls, 1); // no retry burns another full timeout budget
});

Deno.test("a call that responds within budget succeeds", async () => {
  const client = new ProviderClient(
    { maxRetries: 0, requestTimeoutMs: 1000 },
    mockFetch(() =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      })
    ),
  );
  const res = await client.fetchWithRetry("http://mock/");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// Timeout: non-streaming body reads ARE bounded
// ---------------------------------------------------------------------------

Deno.test("a stalled non-streaming body read is bounded by the timeout", async () => {
  const mockStall: typeof fetch = (_i, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("partial"));
        // never closes; only an abort ends it
        signal?.addEventListener("abort", () => {
          controller.error(signal.reason);
        }, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
  };
  const client = new ProviderClient(
    { maxRetries: 0, requestTimeoutMs: 40 },
    mockStall,
  );
  const res = await client.fetchWithRetry("http://mock/");
  // Headers arrived fine; the body read stalls and must abort at the budget.
  const err = await assertRejects(() => res.text());
  assertEquals((err as DOMException).name, "TimeoutError");
});

// ---------------------------------------------------------------------------
// Streaming: NEVER truncated by the total timeout
// ---------------------------------------------------------------------------

Deno.test("an SSE stream slower than the request-timeout is NOT truncated", async () => {
  // 4 frames, one every 25ms => ~100ms total, well past the 30ms request cap.
  const frames = [
    `data: {"n":1}\n\n`,
    `data: {"n":2}\n\n`,
    `data: {"n":3}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const client = new ProviderClient(
    { maxRetries: 0, requestTimeoutMs: 30 }, // shorter than the stream lifetime
    () =>
      Promise.resolve(
        new Response(timedStream(frames, 25), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  );
  const res = await client.fetchWithRetry("http://mock/");
  const events = await readSSE(res);
  // All four frames survive despite the elapsed time exceeding requestTimeoutMs.
  assertEquals(events.length, 4);
  assertEquals(events.at(-1), "[DONE]");
});

Deno.test("streamIdleTimeout aborts a stalled stream (idle semantics)", async () => {
  // One quick frame, then the stream stalls forever.
  const mockStallingSSE: typeof fetch = () => {
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          await new Promise((r) => setTimeout(r, 10));
          controller.enqueue(enc.encode('data: {"n":1}\n\n'));
          return;
        }
        // stall on a long timer that cancel() clears (no leaked op)
        await new Promise<void>((resolve) => {
          stallTimer = setTimeout(resolve, 60_000);
        });
      },
      cancel() {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
  };
  const client = new ProviderClient(
    { maxRetries: 0, requestTimeoutMs: 1000, streamIdleTimeoutMs: 50 },
    mockStallingSSE,
  );
  const res = await client.fetchWithRetry("http://mock/");
  const reader = res.body!.getReader();
  const got: string[] = [];
  const err = await assertRejects(async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(dec.decode(value));
    }
  });
  assertEquals((err as DOMException).name, "TimeoutError");
  assert(got.length >= 1, "the pre-stall frame should have been delivered");
});

// ---------------------------------------------------------------------------
// NoProxy matcher
// ---------------------------------------------------------------------------

Deno.test("shouldBypassProxy: wildcard, suffix forms, exact, and misses", () => {
  assertEquals(shouldBypassProxy("api.openai.com", ["*"]), true);
  assertEquals(shouldBypassProxy("api.openai.com", ["api.openai.com"]), true); // exact
  assertEquals(shouldBypassProxy("api.openai.com", ["openai.com"]), false); // not a suffix pattern
  // ".example.com" matches the base host AND subdomains
  assertEquals(shouldBypassProxy("example.com", [".example.com"]), true);
  assertEquals(shouldBypassProxy("a.b.example.com", [".example.com"]), true);
  // "*.example.com" matches subdomains only
  assertEquals(shouldBypassProxy("a.example.com", ["*.example.com"]), true);
  assertEquals(shouldBypassProxy("example.com", ["*.example.com"]), false);
  // case-insensitive + surrounding whitespace tolerated
  assertEquals(shouldBypassProxy("API.OpenAI.Com", [" api.openai.com "]), true);
  // multi-pattern: any-match, and clean misses
  assertEquals(
    shouldBypassProxy("api.anthropic.com", [".openai.com", "x.com"]),
    false,
  );
  assertEquals(shouldBypassProxy("", ["*"]), false);
  assertEquals(shouldBypassProxy("host", []), false);
});

Deno.test("NoProxy bypass selects the proxy client only for non-bypassed hosts", async () => {
  const proxyMarker = { close() {} };
  let sawClient: unknown = "unset";
  const client = new ProviderClient(
    {
      maxRetries: 0,
      requestTimeoutMs: 0, // disable wrapping/timers for a clean client-selection probe
      proxyUrl: "http://proxy.local",
      noProxy: ["api.internal.test", "*.corp.example"],
    },
    ((_input, init) => {
      sawClient = (init as { client?: unknown }).client;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch,
    () => proxyMarker, // factory result stands in for the proxy client
  );

  const r1 = await client.fetchWithRetry("http://api.openai.com/v1/x");
  await r1.body?.cancel();
  assertEquals(sawClient, proxyMarker); // not bypassed -> proxied

  const r2 = await client.fetchWithRetry("http://api.internal.test/v1/x");
  await r2.body?.cancel();
  assertEquals(sawClient, undefined); // exact bypass -> direct (no client)

  const r3 = await client.fetchWithRetry("http://node.corp.example:8443/x");
  await r3.body?.cancel();
  assertEquals(sawClient, undefined); // suffix bypass, port ignored -> direct

  client.close();
});

Deno.test("FROSTY_NO_PROXY env patterns drive proxy bypass", async () => {
  const prev = Deno.env.get("FROSTY_NO_PROXY");
  Deno.env.set("FROSTY_NO_PROXY", ".internal.test, *.corp.example");
  try {
    const proxyMarker = { close() {} };
    let sawClient: unknown = "unset";
    const client = new ProviderClient(
      { maxRetries: 0, requestTimeoutMs: 0, proxyUrl: "http://proxy.local" },
      ((_i, init) => {
        sawClient = (init as { client?: unknown }).client;
        return Promise.resolve(new Response("ok"));
      }) as typeof fetch,
      () => proxyMarker,
    );
    const r = await client.fetchWithRetry("http://db.internal.test/x");
    await r.body?.cancel();
    assertEquals(sawClient, undefined); // bypassed via env pattern

    const r2 = await client.fetchWithRetry("http://api.openai.com/x");
    await r2.body?.cancel();
    assertEquals(sawClient, proxyMarker); // not bypassed
    client.close();
  } finally {
    if (prev === undefined) Deno.env.delete("FROSTY_NO_PROXY");
    else Deno.env.set("FROSTY_NO_PROXY", prev);
  }
});

Deno.test("FROSTY_HTTP_TIMEOUT_MS provides the default per-request timeout", async () => {
  const prev = Deno.env.get("FROSTY_HTTP_TIMEOUT_MS");
  Deno.env.set("FROSTY_HTTP_TIMEOUT_MS", "25");
  try {
    const client = new ProviderClient({ maxRetries: 0 }, mockHang);
    const err = await assertRejects(() =>
      client.fetchWithRetry("http://mock/")
    );
    assertEquals((err as DOMException).name, "TimeoutError");
  } finally {
    if (prev === undefined) Deno.env.delete("FROSTY_HTTP_TIMEOUT_MS");
    else Deno.env.set("FROSTY_HTTP_TIMEOUT_MS", prev);
  }
});

// ---------------------------------------------------------------------------
// TLS wiring
// ---------------------------------------------------------------------------

Deno.test("caCertPem is wired into createHttpClient caCerts (no proxy)", () => {
  let seen: unknown;
  const client = new ProviderClient(
    { caCertPem: "PEM-DATA" },
    globalThis.fetch.bind(globalThis),
    (opts) => {
      seen = opts;
      return { close() {} };
    },
  );
  assertEquals(seen, { caCerts: ["PEM-DATA"] });
  client.close();
});

Deno.test("caCertPem + proxy: proxy client carries the CA, plus a CA-only direct client", () => {
  const calls: unknown[] = [];
  const client = new ProviderClient(
    {
      proxyUrl: "http://proxy.local:8080",
      proxyUsername: "u",
      proxyPassword: "p",
      caCertPem: "PEM",
    },
    globalThis.fetch.bind(globalThis),
    (opts) => {
      calls.push(opts);
      return { close() {} };
    },
  );
  assertEquals(calls, [
    {
      proxy: {
        url: "http://proxy.local:8080",
        basicAuth: { username: "u", password: "p" },
      },
      caCerts: ["PEM"],
    },
    { caCerts: ["PEM"] },
  ]);
  client.close();
});

Deno.test("skipTlsVerify warns and is never sent to createHttpClient (Deno API limit)", () => {
  const calls: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    // skipTlsVerify alone: nothing enforceable => no client is even built.
    new ProviderClient(
      { skipTlsVerify: true },
      globalThis.fetch.bind(globalThis),
      (opts) => {
        calls.push(opts as Record<string, unknown>);
        return { close() {} };
      },
    );
    // With a CA present the factory IS called, but only with caCerts — never a
    // fabricated insecure/skip-verify key.
    new ProviderClient(
      { skipTlsVerify: true, caCertPem: "PEM" },
      globalThis.fetch.bind(globalThis),
      (opts) => {
        calls.push(opts as Record<string, unknown>);
        return { close() {} };
      },
    );
  } finally {
    console.warn = origWarn;
  }
  assertEquals(calls, [{ caCerts: ["PEM"] }]); // only the CA-only client
  assertEquals("insecure" in calls[0], false);
  assertEquals("skipTlsVerify" in calls[0], false);
  assertEquals(warnings.length, 2); // one warning per client that set the flag
  assert(warnings[0].includes("skipTlsVerify"));
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

Deno.test("backward-compat: default timeout leaves a normal JSON call intact", async () => {
  const prevT = Deno.env.get("FROSTY_HTTP_TIMEOUT_MS");
  const prevP = Deno.env.get("FROSTY_NO_PROXY");
  Deno.env.delete("FROSTY_HTTP_TIMEOUT_MS");
  Deno.env.delete("FROSTY_NO_PROXY");
  try {
    const client = new ProviderClient(
      { maxRetries: 0 }, // no timeout override, no proxy, no CA
      mockFetch(() =>
        new Response(JSON.stringify({ hi: 1 }), {
          headers: { "Content-Type": "application/json" },
        })
      ),
    );
    const res = await client.fetchWithRetry("http://mock/");
    assertEquals(await res.json(), { hi: 1 });
  } finally {
    if (prevT !== undefined) Deno.env.set("FROSTY_HTTP_TIMEOUT_MS", prevT);
    if (prevP !== undefined) Deno.env.set("FROSTY_NO_PROXY", prevP);
  }
});

// ---------------------------------------------------------------------------
// fetchGuarded: one attempt, and a !ok response returned rather than thrown
// ---------------------------------------------------------------------------

/** A client whose retry loop is fully armed at the shipped default, so any
 * "one attempt" assertion below is about fetchGuarded and not about a test
 * fixture that had retries disabled. */
function retryingClient(
  status: number,
  onCall: () => void,
): ProviderClient {
  return new ProviderClient(
    { maxRetries: 3, initialDelayMs: 1 },
    mockFetch(() => {
      onCall();
      return new Response(JSON.stringify({ error: "slow down" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

Deno.test("D1-T18: fetchGuarded makes exactly ONE attempt where fetchWithRetry makes four", async () => {
  for (const status of [429, 500, 503]) {
    let guarded = 0;
    const res = await retryingClient(status, () => guarded++).fetchGuarded(
      "http://mock/images/generations",
    );
    assertEquals(guarded, 1, `fetchGuarded, ${status}`);
    // Returned, not thrown: the calling adapter stays the single !ok authority.
    assertEquals(res.status, status);
    assertEquals(res.ok, false);
    await res.body?.cancel();

    // The same client, same status, through the retrying path: four attempts of
    // real provider spend. This is what pinning the retry count buys.
    let retried = 0;
    await assertRejects(() =>
      retryingClient(status, () => retried++).fetchWithRetry(
        "http://mock/images/generations",
      )
    );
    assertEquals(retried, 4, `fetchWithRetry, ${status}`);
  }
});

Deno.test("fetchGuarded still carries extra headers and the establishment timeout", async () => {
  let seen: string | null = null;
  const client = new ProviderClient(
    {
      maxRetries: 3,
      extraHeaders: [{ name: "x-operator", value: "frosty" }],
    },
    mockFetch((_i, init) => {
      seen = new Headers(init?.headers).get("x-operator");
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const res = await client.fetchGuarded("http://mock/audio/speech");
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(seen, "frosty");

  const hung = new ProviderClient(
    { maxRetries: 3, initialDelayMs: 1, requestTimeoutMs: 30 },
    mockHang,
  );
  const err = await assertRejects(() => hung.fetchGuarded("http://mock/"));
  assertEquals((err as DOMException).name, "TimeoutError");
});
