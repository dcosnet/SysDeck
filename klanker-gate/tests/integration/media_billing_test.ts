// D1 Stage 3: the media accounting channel written from the three media routes,
// the per-process in-flight byte budget, and the C1 write gate.
//
// These drive the REAL route handlers registered on a bare Router rather than
// through createHandler, because the channel is a WeakMap keyed on Request
// identity and makeRequestLogger hands the router a CLONE of the request the
// caller made (middleware.ts: `new Request(req, {headers})`). A test asserting
// on its own Request object would read an empty channel and pass vacuously. The
// full chain is exercised separately at the end, for the client-visible half.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { Router } from "../../packages/core/src/mod.ts";
import { registerAdvancedRoutes } from "../../apps/gateway/routes/advanced.ts";
import { mediaInflightReserved } from "../../apps/gateway/routes/advanced.ts";
import {
  ProviderError,
  ProviderManager,
} from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { GovernanceHierarchy } from "../../packages/governance/src/hierarchy.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  getRequestDispatch,
  mergeRequestStatus,
  setRequestDispatch,
} from "../../packages/telemetry/src/usage.ts";
import {
  MAX_MEDIA_INFLIGHT_BYTES,
  MAX_MEDIA_JSON_BYTES,
  MAX_TRANSCRIPTION_JSON_BYTES,
  MAX_TTS_INPUT_CHARS,
  MEDIA_BYTES_PER_IMAGE,
} from "../../packages/contracts/src/mod.ts";
import { jsonResponse, MockProvider } from "../../packages/testing/src/mod.ts";

const base = "http://gateway.test";

function makeContext(
  mockUrl: string,
  retry: { maxRetries: number; initialDelayMs?: number } = { maxRetries: 0 },
): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-media",
      baseUrl: mockUrl,
      enabled: true,
      models: ["gpt-image-1", "tts-1", "whisper-1"],
      priority: 0,
      retry,
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    hierarchy: new GovernanceHierarchy(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

function mediaRouter(ctx: AppContext): Router {
  const router = new Router();
  registerAdvancedRoutes(router, ctx);
  return router;
}

function imageRequest(
  body: Record<string, unknown>,
  init?: RequestInit,
): Request {
  return new Request(`${base}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-image-1",
      prompt: "fjord",
      ...body,
    }),
    ...init,
  });
}

function speechRequest(input: string, init?: RequestInit): Request {
  return new Request(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/tts-1", input, voice: "alloy" }),
    ...init,
  });
}

function transcriptionRequest(init?: RequestInit): Request {
  const boundary = "----frosty";
  const payload = `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n' +
    `--${boundary}--\r\n`;
  return new Request(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: payload,
    ...init,
  });
}

/** Polls until `pred` holds. Used to observe a reservation that only exists
 * while a provider request is parked. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A promise the test resolves to let a parked provider respond. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// ---------------------------------------------------------------------------
// D1-T1 / D1-T2 / D1-T3 / D1-T4 - the quantity written per surface
// ---------------------------------------------------------------------------

Deno.test("D1-T1..T4: each media surface writes its own quantity", async (t) => {
  const mock = new MockProvider((call) => {
    switch (call.path) {
      case "/images/generations":
        // Two images returned against n: 7, plus a token block, so imageCount
        // and tokens both come from the SAME parse.
        return jsonResponse({
          created: 1,
          data: [{ b64_json: "aa" }, { b64_json: "bb" }],
          usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
        });
      case "/audio/speech":
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      case "/embeddings":
        return jsonResponse({
          object: "list",
          data: [{ embedding: [0.1] }, { embedding: [0.2] }],
          model: "text-embedding-3-small",
        });
      case "/audio/transcriptions":
        return jsonResponse({ text: "words", duration: 12.5 });
      default:
        return jsonResponse({ error: call.path }, 500);
    }
  });
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);

  try {
    // D1-T1: `n: 7` requested, 2 delivered. The billed count is what arrived.
    await t.step("D1-T1: imageCount is data.length, never n", async () => {
      const req = imageRequest({ n: 7 });
      const res = await router.handle(req);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).data.length, 2);
      const channel = getRequestDispatch(req)!;
      assertEquals(channel.units, { imageCount: 2 });
      assertEquals(channel.providerStatus, 200);
      assertEquals(channel.providerId, "openai");
      assertEquals(channel.model, "gpt-image-1");
      // M1: the token half comes from the same parse, not a second body sniff.
      assertEquals(channel.tokens, {
        prompt: 11,
        completion: 22,
        cached: 0,
        cacheCreation: 0,
      });
    });

    // D1-T2, route half: /v1/embeddings is not a media surface at all, so it
    // opens no channel - the strongest form of "records no imageCount".
    await t.step("D1-T2: an embeddings response records nothing", async () => {
      const req = new Request(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/text-embedding-3-small",
          input: "hei",
        }),
      });
      const res = await router.handle(req);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).data.length, 2);
      assertEquals(getRequestDispatch(req), undefined);
    });

    // D1-T3: code points, not UTF-16 units. "a😀b🎉c" is 5 code points and 7
    // UTF-16 units, so `.length` would over-bill by 2 on a 5-character input.
    await t.step("D1-T3: characterCount counts code points", async () => {
      const input = "a\u{1F600}b\u{1F389}c";
      assertEquals(input.length, 7);
      assertEquals([...input].length, 5);
      const req = speechRequest(input);
      const res = await router.handle(req);
      assertEquals(res.status, 200);
      await res.body?.cancel();
      assertEquals(getRequestDispatch(req)!.units, { characterCount: 5 });
      assertEquals(getRequestDispatch(req)!.providerStatus, 200);
      // Audio carries no token block and OpenAI reports none, so tokens stay
      // absent rather than becoming a billed zero.
      assertEquals(getRequestDispatch(req)!.tokens, undefined);
    });

    // D1-T4, route half: duration-bearing transcription.
    await t.step(
      "D1-T4: audioSeconds from a duration-bearing body",
      async () => {
        const req = transcriptionRequest();
        const res = await router.handle(req);
        assertEquals(res.status, 200);
        assertEquals((await res.json()).text, "words");
        assertEquals(getRequestDispatch(req)!.units, { audioSeconds: 12.5 });
        assertEquals(getRequestDispatch(req)!.tokens, undefined);
      },
    );
  } finally {
    await mock.close();
  }
});

Deno.test("D1-T4: usage.seconds wins over duration on the wire", async () => {
  const mock = new MockProvider(() =>
    jsonResponse({ text: "words", duration: 99, usage: { seconds: 4.25 } })
  );
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    const req = transcriptionRequest();
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(getRequestDispatch(req)!.units, { audioSeconds: 4.25 });
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T27 - the C1 regression. A client must not be billed for a provider that
// was never reached, and must not buy media by making the gateway fail.
// ---------------------------------------------------------------------------

/**
 * Stands in for BOTH halves that are not built yet: Stage 4's channel read at
 * the accounting sites, and P3's per-Mchar rate field on `UsageTokens` (which
 * `PricingService.costMicroUsd` does not yet accept - it has no media unit
 * fields at all). Everything else is real: the route, the OpenAI adapter,
 * mapDispatchError, VirtualKeyManager and GovernanceHierarchy including their
 * fail-closed admission chain.
 *
 * $15 per million characters is the design's own tts-1 figure. The design
 * measured the pre-fix over-bill at 30 000 000 micro-USD from a 2 000 000
 * character input - but `MAX_TTS_INPUT_CHARS` (100 000), which B.4 introduced in
 * the same document and Stage 1 shipped, now refuses that request with a gateway
 * 400 before any dispatch. The largest admissible input is 100 000 characters,
 * so the largest reachable over-bill is 1 500 000 micro-USD per POST, repeatable
 * and still walking to team and customer.
 */
const TTS_MICRO_USD_PER_MCHAR = 15_000_000;
/** The largest TTS input the gateway admits, i.e. the biggest single C1 loss. */
const MAX_INPUT = "x".repeat(MAX_TTS_INPUT_CHARS);
const MAX_INPUT_MICRO_USD = 1_500_000;

function settleFromChannelStandIn(
  req: Request,
  ctx: AppContext,
  keyId: string,
): void {
  const channel = getRequestDispatch(req);
  if (!channel) return;
  const characters = channel.units?.characterCount;
  if (characters === undefined) return;
  const cost = Math.round(
    (characters * TTS_MICRO_USD_PER_MCHAR) / 1_000_000,
  );
  ctx.virtualKeys.recordCost(keyId, cost, false);
  const key = ctx.virtualKeys.get(keyId)!;
  ctx.hierarchy!.recordCost(key.teamId, cost, false);
}

Deno.test("D1-T27: a provider 400 and a refused connection each bill zero", async (t) => {
  // Arm A: the provider answers 400. mapDispatchError returns a Response
  // carrying the PROVIDER's 400, so a read-site `ok` gate cannot tell this
  // apart from a gateway 400 - which is exactly why the WRITE is gated.
  const mock = new MockProvider(() =>
    jsonResponse({ error: { message: "voice not found" } }, 400)
  );

  const arm = (mockUrl: string) => {
    const ctx = makeContext(mockUrl);
    ctx.hierarchy!.upsertCustomer({
      id: "cust-1",
      name: "acme",
      enabled: true,
      budget: { maxCostUsd: 1 },
      usedRequests: 0,
      usedCostMicroUsd: 0,
    });
    ctx.hierarchy!.upsertTeam({
      id: "team-1",
      name: "core",
      enabled: true,
      customerId: "cust-1",
      budget: { maxCostUsd: 1 },
      usedRequests: 0,
      usedCostMicroUsd: 0,
    });
    ctx.virtualKeys.upsert({
      id: "vk-1",
      name: "media",
      token: "vk-media-c1-token",
      enabled: true,
      teamId: "team-1",
      budget: { maxCostUsd: 1 }, // 1 000 000 micro-USD
      usedRequests: 0,
      usedCostMicroUsd: 0,
    });
    return { ctx, router: mediaRouter(ctx) };
  };

  const billed = (ctx: AppContext) => ({
    key: ctx.virtualKeys.get("vk-1")!.usedCostMicroUsd,
    team: ctx.hierarchy!.getTeam("team-1")!.usedCostMicroUsd,
    customer: ctx.hierarchy!.getCustomer("cust-1")!.usedCostMicroUsd,
  });

  try {
    await t.step(
      "provider 400: zero billed, providerStatus recorded",
      async () => {
        const { ctx, router } = arm(mock.url);
        const req = speechRequest(MAX_INPUT);
        const res = await router.handle(req);
        settleFromChannelStandIn(req, ctx, "vk-1");

        // The client sees the provider's own status, which is the whole reason a
        // read-site gate cannot work.
        assertEquals(res.status, 400);
        await res.body?.cancel();

        const channel = getRequestDispatch(req)!;
        // The evidence a provider was reached IS recorded ...
        assertEquals(channel.providerStatus, 400);
        // ... and no quantity was ever written, on any of the three surfaces.
        assertEquals(channel.units, undefined);
        assertEquals(channel.tokens, undefined);
        assertEquals(billed(ctx), { key: 0, team: 0, customer: 0 });

        // The next admission is admitted, not 402: the key's own budget, the
        // team's and the customer's are all intact.
        assertEquals(ctx.virtualKeys.check("vk-media-c1-token", 0).ok, true);
        assertEquals(ctx.hierarchy!.checkChain("team-1").ok, true);
      },
    );

    await t.step(
      "refused connection: zero billed, no providerStatus",
      async () => {
        // Port 1 on loopback: nothing listens, so fetch rejects with a TypeError
        // and NO Response is ever produced - there is no status for a read-site
        // gate to inspect at all.
        const { ctx, router } = arm("http://127.0.0.1:1/v1");
        const req = speechRequest(MAX_INPUT);
        await assertRejects(() => router.handle(req));
        settleFromChannelStandIn(req, ctx, "vk-1");

        const channel = getRequestDispatch(req)!;
        assertEquals(channel.providerStatus, undefined);
        assertEquals(channel.units, undefined);
        assertEquals(channel.tokens, undefined);
        assertEquals(billed(ctx), { key: 0, team: 0, customer: 0 });
        assertEquals(ctx.virtualKeys.check("vk-media-c1-token", 0).ok, true);
        assertEquals(ctx.hierarchy!.checkChain("team-1").ok, true);
      },
    );

    // The positive control: the same composition DOES bill when the provider
    // returns 2xx. Without this the two assertions above would also pass on a
    // channel that never writes anything at all.
    await t.step("control: a 2xx provider bills all three tiers", async () => {
      const ok = new MockProvider(() =>
        new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "audio/mpeg" },
        })
      );
      try {
        const { ctx, router } = arm(ok.url);
        const req = speechRequest(MAX_INPUT);
        const res = await router.handle(req);
        assertEquals(res.status, 200);
        await res.body?.cancel();
        settleFromChannelStandIn(req, ctx, "vk-1");
        assertEquals(getRequestDispatch(req)!.units, {
          characterCount: MAX_TTS_INPUT_CHARS,
        });
        assertEquals(billed(ctx), {
          key: MAX_INPUT_MICRO_USD,
          team: MAX_INPUT_MICRO_USD,
          customer: MAX_INPUT_MICRO_USD,
        });
        // And now the budget IS exhausted - the cross-tenant denial the pre-fix
        // shape produced from a provider 400.
        assertEquals(ctx.virtualKeys.check("vk-media-c1-token", 0).ok, false);
        assertEquals(ctx.hierarchy!.checkChain("team-1").ok, false);
      } finally {
        await ok.close();
      }
    });
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T6 - the pre-headers abort, on all three surfaces
// ---------------------------------------------------------------------------

Deno.test("D1-T6: an abort before provider headers bills nothing on any surface", async () => {
  const mock = new MockProvider(() => jsonResponse({ unreachable: true }));
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    const aborted = (): RequestInit => {
      const ac = new AbortController();
      ac.abort();
      return { signal: ac.signal };
    };
    const cases: Array<[string, Request]> = [
      ["speech", speechRequest("hei", aborted())],
      ["images", imageRequest({ n: 1 }, aborted())],
      ["transcriptions", transcriptionRequest(aborted())],
    ];
    let expected = 0;
    for (const [label, req] of cases) {
      const before = mock.calls.length;
      // mapDispatchError rethrows an AbortError, so the route throws out to the
      // errorHandler. The channel is what matters here, not the envelope.
      await assertRejects(() => router.handle(req), Error, "", label);
      assertEquals(mock.calls.length, before, `${label}: no provider call`);
      const channel = getRequestDispatch(req)!;
      assertEquals(channel.providerStatus, undefined, label);
      assertEquals(channel.units, undefined, label);
      assertEquals(channel.tokens, undefined, label);
      expected += 1;
      assertEquals(
        ctx.metrics.get("media.abort_pre_headers"),
        expected,
        `${label}: media.abort_pre_headers increments`,
      );
    }
    // Every reservation taken pre-dispatch was released on the throw path.
    assertEquals(mediaInflightReserved(), 0);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T14 / D1-T15 - the write contract, at every route call site
// ---------------------------------------------------------------------------

Deno.test("D1-T14: a forced double write is refused and counted, per call site", async () => {
  const mock = new MockProvider((call) =>
    call.path === "/audio/speech"
      ? new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mpeg" },
      })
      : jsonResponse({ created: 1, data: [{ b64_json: "aa" }], text: "w" })
  );
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    // Every media route must pass ctx.metrics to setRequestDispatch. A site
    // that omitted it would leave accounting.dispatch_rewritten silent and
    // D1-T15 vacuous, so each site is driven independently here.
    const sites: Array<[string, () => Request]> = [
      ["speech", () => speechRequest("hei")],
      ["images", () => imageRequest({ n: 1 })],
      ["transcriptions", () => transcriptionRequest()],
    ];
    let expected = 0;
    for (const [label, make] of sites) {
      const req = make();
      // Claim the channel first, so the ROUTE's write is the second one.
      assertEquals(
        setRequestDispatch(req, { providerId: "squatter", model: "planted" }),
        true,
      );
      const res = await router.handle(req);
      assertEquals(res.status, 200, label);
      await res.body?.cancel();
      expected += 1;
      assertEquals(
        ctx.metrics.get("accounting.dispatch_rewritten"),
        expected,
        `${label}: the refused rewrite is counted with the real ctx.metrics`,
      );
      const channel = getRequestDispatch(req)!;
      assertEquals(channel.providerId, "squatter", `${label}: target intact`);
      assertEquals(channel.model, "planted", `${label}: model intact`);
      // The quantity still lands: a refused rewrite is not a refused merge.
      assert(channel.units !== undefined, `${label}: units still written`);
    }
    assertEquals(expected, 3);
  } finally {
    await mock.close();
  }
});

Deno.test("D1-T15: accounting.dispatch_rewritten stays 0 on normal traffic", async () => {
  const mock = new MockProvider((call) =>
    call.path === "/audio/speech"
      ? new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mpeg" },
      })
      : jsonResponse({
        created: 1,
        data: [{ b64_json: "aa" }],
        text: "w",
        duration: 1,
        object: "list",
      })
  );
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    const requests = [
      speechRequest("hei"),
      imageRequest({ n: 2 }),
      transcriptionRequest(),
      imageRequest({ sampleCount: 3 }),
      speechRequest("moro"),
      new Request(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-image-1", input: "x" }),
      }),
    ];
    for (const req of requests) {
      const res = await router.handle(req);
      await res.body?.cancel();
    }
    assertEquals(ctx.metrics.get("accounting.dispatch_rewritten"), 0);
    assertEquals(ctx.metrics.get("accounting.status_dropped"), 0);
    assertEquals(mediaInflightReserved(), 0);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T17 (over-cap half) - the 413 -> 502 remap
// ---------------------------------------------------------------------------

Deno.test("D1-T17: an over-cap provider body is 502, unbilled and counted", async () => {
  // A transcription reserves MAX_TRANSCRIPTION_JSON_BYTES (4 MiB); this body is
  // deliberately past it. readCappedBytes throws its REQUEST-shaped 413 and the
  // route must not let that reach the client.
  const oversized = "z".repeat(MAX_TRANSCRIPTION_JSON_BYTES + 1024);
  const mock = new MockProvider(() =>
    jsonResponse({ text: oversized, duration: 5 })
  );
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    const before = mediaInflightReserved();
    const req = transcriptionRequest();
    const res = await router.handle(req);
    assertEquals(res.status, 502);
    const body = await res.text();
    const parsed = JSON.parse(body) as {
      error: { type: string; code: string; message: string };
    };
    assertEquals(parsed.error.type, "provider_error");
    assertEquals(parsed.error.code, "media_body_cap_exceeded");
    assert(parsed.error.message.includes(String(MAX_TRANSCRIPTION_JSON_BYTES)));
    // The 413's own wording describes a REQUEST body and must never surface on
    // a provider read.
    assert(
      !body.includes("Request body exceeds the maximum allowed size."),
      "the request-shaped 413 message must not reach a client",
    );
    assertEquals(ctx.metrics.get("media.body_cap_exceeded"), 1);

    // The observable unbilled row: the provider WAS reached (200 recorded), and
    // no quantity was written, so nothing can be billed for it.
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.providerStatus, 200);
    assertEquals(channel.units, undefined);
    assertEquals(channel.tokens, undefined);
    // D1-T23's cap path: the reservation came back.
    assertEquals(mediaInflightReserved(), before);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T18 - fetchGuarded pins the attempt count to one
// ---------------------------------------------------------------------------

Deno.test("D1-T18: a provider 429 on an image request is ONE upstream attempt", async () => {
  const mock = new MockProvider(() =>
    jsonResponse({ error: { message: "slow down" } }, 429)
  );
  // maxRetries: 3 is the shipped default, and it is what makes this assertion
  // non-vacuous: through fetchWithRetry this single request would cost four
  // paid attempts.
  const ctx = makeContext(mock.url, { maxRetries: 3, initialDelayMs: 1 });
  const router = mediaRouter(ctx);
  try {
    const before = mock.calls.length;
    const imageReq = imageRequest({ n: 1 });
    const res = await router.handle(imageReq);
    assertEquals(res.status, 429);
    await res.body?.cancel();
    assertEquals(
      mock.calls.length - before,
      1,
      "exactly one upstream attempt on a provider 429",
    );
    // rawProxy signals a provider error by THROWING, so the provider's own
    // status only reaches the channel from dispatchBufferedMedia's catch. Pin
    // it: without this, a 4xx/5xx from a reached provider is indistinguishable
    // from a refused connection, which is the discrimination the C1 write gate
    // and the settle path both read.
    assertEquals(getRequestDispatch(imageReq)!.providerStatus, 429);
    assertEquals(getRequestDispatch(imageReq)!.units, undefined);

    // The same pin on the other two paid media surfaces.
    const speech = await router.handle(speechRequest("hei"));
    assertEquals(speech.status, 429);
    await speech.body?.cancel();
    const transcriptionReq = transcriptionRequest();
    const transcription = await router.handle(transcriptionReq);
    assertEquals(transcription.status, 429);
    await transcription.body?.cancel();
    assertEquals(mock.calls.length - before, 3);
    // The second dispatchBufferedMedia route, same catch.
    assertEquals(getRequestDispatch(transcriptionReq)!.providerStatus, 429);
    assertEquals(getRequestDispatch(transcriptionReq)!.units, undefined);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// D1-T23 / D1-T28 - the in-flight byte budget and the reservation it takes
// ---------------------------------------------------------------------------

Deno.test("D1-T23/T28: the in-flight budget refuses pre-dispatch and always releases", async (t) => {
  const parked = gate();
  const mock = new MockProvider(async (call) => {
    if (call.path === "/images/generations") {
      await parked.wait;
      return jsonResponse({ created: 1, data: [{ b64_json: "aa" }] });
    }
    return jsonResponse({ text: "w", duration: 1 });
  });
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    assertEquals(mediaInflightReserved(), 0);

    // D1-T28's reservation clause: `n: 10` reserves exactly the derived
    // per-response ceiling, so the reservation IS the read cap for it.
    const held = router.handle(imageRequest({ n: 10 }));
    await until(() => mediaInflightReserved() > 0, "the n=10 reservation");

    await t.step("D1-T28: n = 10 reserves exactly MAX_MEDIA_JSON_BYTES", () => {
      assertEquals(mediaInflightReserved(), MAX_MEDIA_JSON_BYTES);
      assertEquals(MAX_MEDIA_JSON_BYTES, 10 * MEDIA_BYTES_PER_IMAGE);
    });

    await t.step(
      "D1-T23: over budget is 429 + Retry-After, pre-dispatch",
      async () => {
        // 90 MiB held + 90 MiB requested is over the 128 MiB budget.
        const before = mock.calls.length;
        const res = await router.handle(imageRequest({ n: 10 }));
        assertEquals(res.status, 429);
        assertEquals(res.headers.get("Retry-After"), "1");
        const body = await res.json() as {
          error: { type: string; code: string };
        };
        // The house pattern: governance_error, never rate_limit_error.
        assertEquals(body.error.type, "governance_error");
        assertEquals(body.error.code, "media_inflight");
        assertEquals(
          mock.calls.length,
          before,
          "refused BEFORE the provider is reached",
        );
        assertEquals(ctx.metrics.get("media.inflight_rejected"), 1);
        // Nothing was spent, so there is nothing to bill and no channel row.
        assertEquals(mediaInflightReserved(), MAX_MEDIA_JSON_BYTES);
      },
    );

    await t.step(
      "D1-T23: a fitting request is still admitted alongside",
      async () => {
        // 38 MiB of budget remain; a 4 MiB transcription fits.
        const req = transcriptionRequest();
        const res = await router.handle(req);
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(getRequestDispatch(req)!.units, { audioSeconds: 1 });
        assertEquals(mediaInflightReserved(), MAX_MEDIA_JSON_BYTES);
      },
    );

    await t.step(
      "D1-T23: the reservation returns on the success path",
      async () => {
        parked.open();
        const res = await held;
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(mediaInflightReserved(), 0);
      },
    );
  } finally {
    parked.open();
    await mock.close();
  }
});

Deno.test("D1-T23: the reservation returns on the throw path too", async () => {
  // Nothing listens on port 1, so the dispatch throws before any headers.
  const ctx = makeContext("http://127.0.0.1:1/v1");
  const router = mediaRouter(ctx);
  const before = mediaInflightReserved();
  await assertRejects(() => router.handle(imageRequest({ n: 10 })));
  assertEquals(mediaInflightReserved(), before);
  await assertRejects(() => router.handle(transcriptionRequest()));
  assertEquals(mediaInflightReserved(), before);
});

// ---------------------------------------------------------------------------
// The in-flight budget's other half: a provider that never answers must not be
// able to hold the budget against OTHER callers indefinitely. The budget is a
// per-process resource, so a media path with no establishment timeout turns one
// caller's hung provider into everybody's 429 - which is what Stage 3 made
// reachable by adding the budget in the first place.
// ---------------------------------------------------------------------------

Deno.test("a never-answering provider releases the in-flight budget on the establishment timeout", async () => {
  // Raw TCP: the connection is accepted and not one byte of response is ever
  // sent, so not even headers arrive. A MockProvider cannot express this.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accepted: Deno.Conn[] = [];
  const accepting = (async () => {
    for await (const conn of listener) accepted.push(conn);
  })().catch(() => {});
  const upstream = `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`;
  const ctx: AppContext = {
    ...makeContext(upstream),
    providers: new ProviderManager([{
      id: "azure",
      type: "azure",
      apiKey: "az",
      endpoint: upstream,
      apiVersion: "2024-06-01",
      enabled: true,
      models: ["dall-e-3"],
      priority: 0,
      // A short establishment budget so the release is observable in a test;
      // production takes FROSTY_HTTP_TIMEOUT_MS, else 120 s.
      network: { maxRetries: 3, timeoutSec: 0.3 },
    }], "azure"),
    metrics: new Metrics(),
  };
  const router = mediaRouter(ctx);
  const azureImage = () =>
    new Request(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "azure/dall-e-3", prompt: "fjord", n: 1 }),
    });
  // 14 x 9 MiB = 126 MiB of the 128 MiB budget: a 15th n=1 cannot fit.
  const n = Math.floor(MAX_MEDIA_INFLIGHT_BYTES / MEDIA_BYTES_PER_IMAGE);
  const stalled = Array.from(
    { length: n },
    () => router.handle(azureImage()).catch((e: unknown) => e),
  );
  try {
    await until(
      () => mediaInflightReserved() === n * MEDIA_BYTES_PER_IMAGE,
      "every stalled reservation",
    );

    // A DIFFERENT caller, refused for a provider it never touched.
    const before = ctx.metrics.get("requests.images");
    const refused = await router.handle(azureImage());
    assertEquals(refused.status, 429);
    assertEquals(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "media_inflight",
    );
    assertEquals(ctx.metrics.get("media.inflight_rejected"), 1);
    assertEquals(ctx.metrics.get("requests.images"), before + 1);

    // And it is reclaimed: the establishment timeout ends every stalled
    // dispatch, and the `finally` gives every reservation back. Polled with a
    // bound rather than awaited: without a timeout on this path the dispatches
    // never settle at all, and an `await` on them would hang the suite instead
    // of failing it.
    await until(
      () => mediaInflightReserved() === 0,
      "the in-flight budget to be reclaimed",
    );
    await Promise.allSettled(stalled);

    // The proof that the refusal was transient rather than terminal: the same
    // shape is admitted now, and no second refusal is counted.
    const admitted = await router.handle(azureImage()).catch((e: unknown) => e);
    assert(
      admitted instanceof DOMException && admitted.name === "TimeoutError",
      "admitted through to the provider, then timed out on its own budget",
    );
    assertEquals(ctx.metrics.get("media.inflight_rejected"), 1);
    assertEquals(mediaInflightReserved(), 0);
  } finally {
    listener.close();
    for (const conn of accepted) {
      try {
        conn.close();
      } catch { /* already closed by the timeout */ }
    }
    await Promise.allSettled(stalled);
    await accepting;
  }
});

// ---------------------------------------------------------------------------
// onUsage - the surface whose reply cannot carry its own usage
// ---------------------------------------------------------------------------

Deno.test("onUsage: TTS token usage is reported and bounded route-side", async (t) => {
  // A fake rawProxy standing in for GeminiAdapter.speech: it reports the usage
  // block through the callback, exactly as the real one now does.
  let reportNext: { prompt?: number; completion?: number; total?: number } = {};
  const ctx = makeContext("http://127.0.0.1:1/v1");
  const target = ctx.providers.resolve("openai/tts-1");
  target.adapter.rawProxy = (_path, _req, context) => {
    context?.onUsage?.(reportNext);
    return Promise.resolve(
      new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/wav" },
      }),
    );
  };
  const router = mediaRouter(ctx);

  await t.step("a reported block reaches the channel", async () => {
    reportNext = { prompt: 31, completion: 7, total: 38 };
    const req = speechRequest("hei");
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.tokens, {
      prompt: 31,
      completion: 7,
      cached: 0,
      cacheCreation: 0,
    });
    // The character quantity is unaffected: a token-priced TTS vendor still
    // gets its characters counted.
    assertEquals(channel.units, { characterCount: 3 });
  });

  await t.step(
    "negative, fractional, Infinity and 1e308 are clamped",
    async () => {
      for (
        const [reported, want] of [
          [{ prompt: -5, completion: 3.9 }, { prompt: 0, completion: 3 }],
          [{ prompt: Infinity, completion: 1 }, { prompt: 0, completion: 1 }],
          [{ prompt: 1e308, completion: NaN }, {
            prompt: Number.MAX_SAFE_INTEGER,
            completion: 0,
          }],
        ] as const
      ) {
        reportNext = reported;
        const req = speechRequest("hei");
        const res = await router.handle(req);
        await res.body?.cancel();
        assertEquals(getRequestDispatch(req)!.tokens, {
          ...want,
          cached: 0,
          cacheCreation: 0,
        });
      }
    },
  );

  await t.step("no reported block leaves tokens absent", async () => {
    let called = false;
    target.adapter.rawProxy = (_path, _req, _context) => {
      called = true;
      return Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "audio/wav" },
        }),
      );
    };
    const req = speechRequest("hei");
    const res = await router.handle(req);
    await res.body?.cancel();
    assert(called);
    assertEquals(getRequestDispatch(req)!.tokens, undefined);
  });
});

// ---------------------------------------------------------------------------
// The client-visible half, through the real middleware chain
// ---------------------------------------------------------------------------

Deno.test("the 429 and the 502 survive the real middleware chain", async () => {
  const parked = gate();
  const mock = new MockProvider(async (call) => {
    if (call.path === "/images/generations") {
      await parked.wait;
      return jsonResponse({ created: 1, data: [{ b64_json: "aa" }] });
    }
    return jsonResponse({ text: "z".repeat(MAX_TRANSCRIPTION_JSON_BYTES + 8) });
  });
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const held = handler(imageRequest({ n: 10 }));
    await until(() => mediaInflightReserved() > 0, "the held reservation");

    const refused = await handler(imageRequest({ n: 10 }));
    assertEquals(refused.status, 429);
    assertEquals(refused.headers.get("Retry-After"), "1");
    assertEquals(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "media_inflight",
    );

    const overCap = await handler(transcriptionRequest());
    assertEquals(overCap.status, 502);
    const text = await overCap.text();
    assert(!text.includes("Request body exceeds the maximum allowed size."));
    assertEquals(
      (JSON.parse(text) as { error: { code: string } }).error.code,
      "media_body_cap_exceeded",
    );

    parked.open();
    const ok = await held;
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    assertEquals(mediaInflightReserved(), 0);
  } finally {
    parked.open();
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// B.4's second clause: `upstream.ok`, not merely "after the headers"
// ---------------------------------------------------------------------------

Deno.test("B.4: a !ok provider Response records the status and no quantity", async (t) => {
  // Every rawProxy and generateImage in this repo THROWS a ProviderError on a
  // non-2xx (condition 15 requires it), so `upstream.ok` is defence in depth
  // against an adapter that returns one instead. Without an arm like this,
  // deleting the guard is unkillable by any test - which is exactly how a write
  // gate quietly stops gating.
  const ctx = makeContext("http://127.0.0.1:1/v1");
  const target = ctx.providers.resolve("openai/tts-1");
  target.adapter.rawProxy = (path) =>
    Promise.resolve(
      path === "/audio/speech"
        ? new Response(new Uint8Array([9]), {
          status: 500,
          headers: { "Content-Type": "audio/mpeg" },
        })
        // A body that WOULD count if the gate were absent: two images and a
        // duration, under a 503.
        : jsonResponse(
          {
            created: 1,
            data: [{ b64_json: "a" }, { b64_json: "b" }],
            duration: 3,
          },
          503,
        ),
    );
  const router = mediaRouter(ctx);

  await t.step("speech", async () => {
    const req = speechRequest("hei");
    const res = await router.handle(req);
    assertEquals(res.status, 500);
    await res.body?.cancel();
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.providerStatus, 500);
    assertEquals(channel.units, undefined);
    assertEquals(channel.tokens, undefined);
  });

  await t.step("images", async () => {
    const req = imageRequest({ n: 1 });
    const res = await router.handle(req);
    assertEquals(res.status, 503);
    await res.body?.cancel();
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.providerStatus, 503);
    assertEquals(channel.units, undefined);
    assertEquals(channel.tokens, undefined);
    assertEquals(mediaInflightReserved(), 0);
  });

  await t.step("transcriptions", async () => {
    const req = transcriptionRequest();
    const res = await router.handle(req);
    assertEquals(res.status, 503);
    await res.body?.cancel();
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.providerStatus, 503);
    assertEquals(channel.units, undefined);
    assertEquals(mediaInflightReserved(), 0);
  });
});

// ---------------------------------------------------------------------------
// The native generateImage branch - the fourth channel call site
// ---------------------------------------------------------------------------

Deno.test("native generateImage writes the channel from the adapter's return", async (t) => {
  const ctx = makeContext("http://127.0.0.1:1/v1");
  const target = ctx.providers.resolve("openai/gpt-image-1");
  let thrown: unknown;
  target.adapter.generateImage = () => {
    if (thrown) return Promise.reject(thrown);
    return Promise.resolve({
      created: 1,
      data: [{ b64_json: "a" }, { b64_json: "b" }, { b64_json: "c" }],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    });
  };
  const router = mediaRouter(ctx);

  await t.step("units and tokens come from the resolved result", async () => {
    const req = imageRequest({ n: 7 });
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).data.length, 3);
    const channel = getRequestDispatch(req)!;
    // Three delivered against n: 7, exactly as on the rawProxy branch.
    assertEquals(channel.units, { imageCount: 3 });
    assertEquals(channel.tokens, {
      prompt: 4,
      completion: 5,
      cached: 0,
      cacheCreation: 0,
    });
    // Every generateImage adapter throws on a non-2xx, so a resolved call is
    // the evidence a provider was reached. The typed return cannot carry the
    // exact code, so 200 stands in for it.
    assertEquals(channel.providerStatus, 200);
    // This branch buffers inside the adapter, so it takes no reservation.
    assertEquals(mediaInflightReserved(), 0);
  });

  // The native branch's own setRequestDispatch site - one of the three in
  // advanced.ts, reached from four route paths - driven with the real
  // ctx.metrics.
  await t.step("a forced double write here is counted too", async () => {
    const before = ctx.metrics.get("accounting.dispatch_rewritten");
    const req = imageRequest({ n: 1 });
    setRequestDispatch(req, { providerId: "squatter", model: "planted" });
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(
      ctx.metrics.get("accounting.dispatch_rewritten"),
      before + 1,
    );
    assertEquals(getRequestDispatch(req)!.providerId, "squatter");
  });

  await t.step("a throwing adapter writes no quantity", async () => {
    thrown = new ProviderError(429, "Too Many Requests", '{"error":"slow"}');
    const req = imageRequest({ n: 1 });
    const res = await router.handle(req);
    assertEquals(res.status, 429);
    await res.body?.cancel();
    const channel = getRequestDispatch(req)!;
    assertEquals(channel.units, undefined);
    assertEquals(channel.tokens, undefined);
    // The status still lands: the provider WAS reached and refused, which is a
    // different row from a provider that was never reached at all.
    assertEquals(channel.providerStatus, 429);
    thrown = undefined;
  });
});

// ---------------------------------------------------------------------------
// B.4 row 4: the native row's "survives an after-headers abort". The three
// steps above never drive an abort, and the branch used to be the only media
// dispatch with the client's abort still attached across the provider call.
// ---------------------------------------------------------------------------

Deno.test("native generateImage survives a client abort after the provider committed", async (t) => {
  // A REAL native adapter shape: it owns its own fetch, reads the whole body and
  // returns a parsed object. A stub that ignored `signal` would pass every arm
  // below vacuously, so the abort has to reach a real in-flight HTTP read.
  const mock = new MockProvider(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          // Status + headers are already committed; only the body is stalled,
          // which is the after-headers window B.4 row 4 is about.
          await new Promise((r) => setTimeout(r, 200));
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                created: 1,
                data: [{ b64_json: "a" }, { b64_json: "b" }],
              }),
            ),
          );
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  );
  const ctx = makeContext(mock.url);
  const target = ctx.providers.resolve("openai/gpt-image-1");
  let reachedProvider = 0;
  target.adapter.generateImage = async (_req, context) => {
    reachedProvider++;
    const upstream = await fetch(`${mock.url}/images:predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "fjord" }),
      signal: context?.signal,
    });
    return await upstream.json();
  };
  const router = mediaRouter(ctx);
  try {
    await t.step("no abort: two images counted", async () => {
      const req = imageRequest({ n: 2 });
      const res = await router.handle(req);
      assertEquals(res.status, 200);
      await res.body?.cancel();
      const channel = getRequestDispatch(req)!;
      assertEquals(channel.units, { imageCount: 2 });
      assertEquals(channel.providerStatus, 200);
    });

    await t.step(
      "abort mid-body: the provider's work is still counted",
      async () => {
        const before = reachedProvider;
        const ac = new AbortController();
        const req = imageRequest({ n: 2 }, { signal: ac.signal });
        const inflight = router.handle(req);
        // Well inside the 200 ms body stall, and after the provider committed a
        // 200. The provider renders and charges either way; the only thing an
        // abort here can change is whether the gateway counts it.
        setTimeout(() => ac.abort(), 60);
        const res = await inflight;
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(reachedProvider - before, 1);
        const channel = getRequestDispatch(req)!;
        assertEquals(channel.units, { imageCount: 2 });
        assertEquals(channel.providerStatus, 200);
        // A settled dispatch is not a pre-headers abort.
        assertEquals(ctx.metrics.get("media.abort_pre_headers"), 0);
      },
    );

    await t.step(
      "already aborted at entry: the provider is never reached",
      async () => {
        const before = reachedProvider;
        const ac = new AbortController();
        ac.abort();
        const req = imageRequest({ n: 2 }, { signal: ac.signal });
        // Detaching AFTER the dispatch must not become "never detach": an
        // abandoned request still has to cost the provider nothing.
        await assertRejects(() => router.handle(req));
        assertEquals(
          reachedProvider - before,
          1,
          "the adapter is entered, but its fetch is refused by the pre-aborted signal",
        );
        assertEquals(getRequestDispatch(req)!.units, undefined);
        assertEquals(getRequestDispatch(req)!.providerStatus, undefined);
        assertEquals(ctx.metrics.get("media.abort_pre_headers"), 1);
      },
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Condition 13's TTS clause: zero reservation, asserted while in flight
// ---------------------------------------------------------------------------

Deno.test("TTS holds no in-flight reservation at all", async (t) => {
  const parked = gate();
  let seenDuringFlight = -1;
  const mock = new MockProvider((call) => {
    // Sampled inside the provider handler, i.e. strictly between the route's
    // reservation point and its release. A reservation taken for TTS would be
    // visible here and nowhere else.
    seenDuringFlight = mediaInflightReserved();
    parked.open();
    if (call.path === "/audio/speech") {
      return new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }
    return jsonResponse({ created: 1, data: [{ b64_json: "aa" }] });
  });
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    assertEquals(mediaInflightReserved(), 0);
    const req = speechRequest("hei");
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    await parked.wait;
    assertEquals(
      seenDuringFlight,
      0,
      "TTS streams through untouched, so it reserves nothing",
    );
    assertEquals(mediaInflightReserved(), 0);
    assertEquals(getRequestDispatch(req)!.units, { characterCount: 3 });

    // The control, sampled at the SAME point by the SAME handler: without it a
    // zero here would also be what a broken sampler reads.
    await t.step(
      "a buffered surface sampled the same way is non-zero",
      async () => {
        seenDuringFlight = -1;
        const image = await router.handle(imageRequest({ n: 2 }));
        assertEquals(image.status, 200);
        await image.body?.cancel();
        assertEquals(seenDuringFlight, 2 * MEDIA_BYTES_PER_IMAGE);
        assertEquals(mediaInflightReserved(), 0);
      },
    );
  } finally {
    await mock.close();
  }
});

Deno.test("a dropped provider status is counted, never silent", async () => {
  const mock = new MockProvider(() => jsonResponse({ text: "w", duration: 2 }));
  const ctx = makeContext(mock.url);
  const router = mediaRouter(ctx);
  try {
    // mergeRequestStatus is first-write-wins, so a pre-recorded status makes the
    // route's own write a no-op. That is a silently unbilled row unless counted.
    const req = transcriptionRequest();
    setRequestDispatch(req, { providerId: "openai", model: "whisper-1" });
    mergeRequestStatus(req, 418);
    const res = await router.handle(req);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(ctx.metrics.get("accounting.status_dropped"), 1);
    assertEquals(getRequestDispatch(req)!.providerStatus, 418);
  } finally {
    await mock.close();
  }
});
