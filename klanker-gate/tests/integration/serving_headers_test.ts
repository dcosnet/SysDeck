// Serving-boundary framing headers (WP18 / decision-log 87).
//
// Every assertion here reads a CLIENT SOCKET, never a handler's return value.
// That is the whole point: at a route's return a broken and a fixed response are
// indistinguishable - both hold a valid `Response` object with a readable body.
// Only delivery discriminates, so a test on the return value passes on broken
// code.
//
// The fixture provider compresses with a real `CompressionStream("gzip")`. No
// test in this repository had ever done that, which is why nothing caught the
// break: Deno's `fetch` decompresses transparently but KEEPS `Content-Encoding`
// and the COMPRESSED `Content-Length`, so any rebuild of that body hands the
// client a lie.
//
// These live in tests/integration rather than beside middleware.ts because they
// need a real `Deno.serve`, a real `fetch` client and a raw TCP framing read.
// No test under packages/core opens a socket; the unit tests there are pure.

import { assert, assertEquals } from "@std/assert";
import { serveDir } from "@std/http/file-server";
import {
  applyMiddleware,
  makeRequestLogger,
} from "../../packages/core/src/middleware.ts";
import { ProviderClient } from "../../packages/providers/src/client.ts";

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

function gzipStream(bytes: Bytes): ReadableStream<Bytes> {
  // CompressionStream's writable takes BufferSource, so the source must too.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return source.pipeThrough(new CompressionStream("gzip"));
}

async function drain(stream: ReadableStream<Bytes>): Promise<Bytes> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function gzipBytes(bytes: Bytes): Promise<Bytes> {
  return drain(gzipStream(bytes));
}

/** Serves `handler` through the real middleware chain, exactly as main.ts
 * composes it: applyMiddleware + makeRequestLogger. The sink is a no-op so the
 * suite output stays readable; console noise is unavoidable (the logger prints
 * unconditionally) and harmless. */
function serveThroughChain(handler: (req: Request) => Promise<Response>) {
  const composed = applyMiddleware(handler, [makeRequestLogger(() => {})]);
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => composed(req),
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Reads the raw HTTP response head off a socket, so framing (chunked vs a
 * declared Content-Length) is observed on the wire rather than inferred from
 * what `fetch` chose to expose. */
async function wireHead(url: string, path = "/"): Promise<string> {
  const u = new URL(path, url);
  const conn = await Deno.connect({
    hostname: u.hostname,
    port: Number(u.port),
  });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Accept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      ),
    );
    const decoder = new TextDecoder();
    const buf = new Uint8Array(4096);
    let seen = "";
    // One read is enough for a head on loopback, but loop until the blank line
    // appears so a split TCP segment cannot make this flaky.
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      seen += decoder.decode(buf.subarray(0, n), { stream: true });
      if (seen.includes("\r\n\r\n")) break;
    }
    return seen.split("\r\n\r\n")[0];
  } finally {
    try {
      conn.close();
    } catch {
      // already closed by Connection: close
    }
  }
}

function assertFramingHeadersAbsent(res: Response, label: string): void {
  assertEquals(
    res.headers.get("content-encoding"),
    null,
    `${label}: content-encoding must not survive a rebuild`,
  );
  assertEquals(
    res.headers.get("content-length"),
    null,
    `${label}: a provider content-length describes the ENCODED bytes`,
  );
  // `transfer-encoding` cannot be asserted absent at a client: for an
  // unknown-length body the header IS the framing, and Deno.serve mints its own
  // `chunked` downstream of this middleware. Measured: the gateway forwards only
  // content-type/date/x-request-id, so the provider's value is genuinely dropped
  // and what remains is the runtime's. The observable invariant is therefore
  // "never a provider value", checked here and on the raw wire below.
  const te = res.headers.get("transfer-encoding");
  assert(
    te === null || te === "chunked",
    `${label}: transfer-encoding must be the runtime's framing, got ${te}`,
  );
}

/** Socket-level framing proof: no encoding claim, no declared length, and
 * exactly one framing header on the wire. */
async function assertWireIsCleanChunked(
  url: string,
  path: string,
  label: string,
): Promise<void> {
  const lines = (await wireHead(url, path)).toLowerCase().split("\r\n");
  assertEquals(
    lines.filter((l) => l.startsWith("content-encoding:")),
    [],
    `${label}: no encoding claim on the wire`,
  );
  assertEquals(
    lines.filter((l) => l.startsWith("content-length:")),
    [],
    `${label}: no declared length on the wire`,
  );
  assertEquals(
    lines.filter((l) => l.startsWith("transfer-encoding:")),
    ["transfer-encoding: chunked"],
    `${label}: exactly one framing mechanism, minted by the runtime`,
  );
}

// ---------------------------------------------------------------------------
// D1-T22(a) - the un-buffered surface (TTS shape: gzip, chunked, no CL)
// ---------------------------------------------------------------------------

Deno.test("D1-T22(a) gzipped un-buffered provider body (TTS shape) is delivered decompressed", async () => {
  // 120 000 bytes of pseudo-audio, so the compressed size differs by orders of
  // magnitude from the plaintext and a length mix-up cannot pass by accident.
  const audio = new Uint8Array(120_000);
  for (let i = 0; i < audio.length; i++) audio[i] = (i * 31 + 7) & 0xff;

  const provider = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(gzipStream(audio), {
        headers: {
          // No content-length: this is the surface the gateway never buffers.
          "content-encoding": "gzip",
          "content-type": "audio/mpeg",
        },
      }),
  );
  const providerUrl = `http://127.0.0.1:${
    (provider.addr as Deno.NetAddr).port
  }`;

  const { server, url } = serveThroughChain(async (_req) => {
    // A plain fetch handing the provider Response straight back, the shape
    // OpenAIAdapter.rawProxy produces (through the client's guarded fetch): the
    // Response reaches the middleware intact and is broken only by the rebuild
    // there.
    return await fetch(providerUrl);
  });

  try {
    const res = await fetch(url);
    const body = new Uint8Array(await res.arrayBuffer());

    assertEquals(res.status, 200);
    assertEquals(
      body.length,
      audio.length,
      "client must receive the uncompressed original",
    );
    assertEquals(body, audio, "client bytes must be byte-identical");
    assertEquals(res.headers.get("content-type"), "audio/mpeg");
    assertFramingHeadersAbsent(res, "T22(a)");
    assert(res.headers.get("x-request-id"), "the logger still stamps its id");
    await assertWireIsCleanChunked(url, "/", "T22(a)");
  } finally {
    await server.shutdown();
    await provider.shutdown();
  }
});

// ---------------------------------------------------------------------------
// D1-T22(b) - the buffered surface (image shape: gzip + compressed CL)
// ---------------------------------------------------------------------------

Deno.test("D1-T22(b) gzipped JSON with a compressed content-length is delivered whole", async () => {
  const payload = JSON.stringify({
    created: 1_700_000_000,
    data: [
      { b64_json: "Q".repeat(40_000) },
      { b64_json: "Z".repeat(40_000) },
    ],
  });
  const plain = new TextEncoder().encode(payload);
  const compressed = await gzipBytes(plain);
  // The precondition of the whole defect: the declared length is the compressed
  // one, and it is far shorter than the body the client must actually read.
  assert(
    compressed.length < plain.length / 2,
    `fixture must actually compress (plain=${plain.length} gz=${compressed.length})`,
  );

  const provider = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(gzipStream(plain), {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(compressed.length),
          "content-type": "application/json",
          "openai-organization": "org-frosty",
          "x-ratelimit-remaining-requests": "4999",
          "x-ratelimit-reset-requests": "6ms",
        },
      }),
  );
  const providerUrl = `http://127.0.0.1:${
    (provider.addr as Deno.NetAddr).port
  }`;

  const { server, url } = serveThroughChain(async (_req) => {
    return await fetch(providerUrl);
  });

  try {
    const res = await fetch(url);
    const text = await res.text();
    const json = JSON.parse(text) as { data: unknown[] };

    assertEquals(res.status, 200);
    assertEquals(
      text.length,
      payload.length,
      "full JSON, not a truncated read",
    );
    assertEquals(json.data.length, 2);
    assertFramingHeadersAbsent(res, "T22(b)");
    // The denylist is exactly three entries: every other provider header,
    // including the ones clients meter against, must still arrive.
    assertEquals(res.headers.get("openai-organization"), "org-frosty");
    assertEquals(res.headers.get("x-ratelimit-remaining-requests"), "4999");
    assertEquals(res.headers.get("x-ratelimit-reset-requests"), "6ms");
    assertEquals(res.headers.get("content-type"), "application/json");
    await assertWireIsCleanChunked(url, "/", "T22(b)");
  } finally {
    await server.shutdown();
    await provider.shutdown();
  }
});

// ---------------------------------------------------------------------------
// D1-T31 - the second attach point, and the accepted static-asset regression
// ---------------------------------------------------------------------------

Deno.test("D1-T31 a ProviderClient.withBody response (stale CE + compressed CL) is delivered intact", async () => {
  // Not a simulated shape: this drives the real ProviderClient, whose
  // guardNonStreamBody -> withBody (client.ts:171-180) rebuilds the body while
  // copying the provider's headers verbatim. requestTimeoutMs is passed
  // explicitly so the guard is armed regardless of the ambient
  // FROSTY_HTTP_TIMEOUT_MS, matching the production default.
  const payload = JSON.stringify({
    object: "list",
    data: [{ embedding: Array.from({ length: 1536 }, (_, i) => i / 1536) }],
  });
  const plain = new TextEncoder().encode(payload);
  const compressed = await gzipBytes(plain);

  const provider = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(gzipStream(plain), {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(compressed.length),
          "content-type": "application/json",
          "openai-organization": "org-frosty",
        },
      }),
  );
  const providerUrl = `http://127.0.0.1:${
    (provider.addr as Deno.NetAddr).port
  }`;

  const client = new ProviderClient({ requestTimeoutMs: 30_000 });
  let attached: { ce: string | null; cl: string | null; mutable: boolean } = {
    ce: null,
    cl: null,
    mutable: false,
  };

  const { server, url } = serveThroughChain(async (_req) => {
    const upstream = await client.fetchWithRetry(providerUrl);
    // Record what withBody handed us, to prove the corruption attached two
    // layers below the middleware. Mutable headers are the tell: a fetch()
    // Response is immutable, so a mutable one is a rebuild.
    let mutable = false;
    try {
      upstream.headers.set("x-frosty-probe", "1");
      upstream.headers.delete("x-frosty-probe");
      mutable = true;
    } catch {
      mutable = false;
    }
    attached = {
      ce: upstream.headers.get("content-encoding"),
      cl: upstream.headers.get("content-length"),
      mutable,
    };
    return upstream;
  });

  try {
    const res = await fetch(url);
    const text = await res.text();

    assertEquals(attached.ce, "gzip", "withBody copies the stale encoding");
    assertEquals(
      attached.cl,
      String(compressed.length),
      "withBody copies the COMPRESSED length over a decompressed body",
    );
    assert(
      attached.mutable,
      "mutable headers prove this is withBody's object, not the fetch Response",
    );

    assertEquals(res.status, 200);
    assertEquals(text.length, payload.length);
    assertEquals(
      (JSON.parse(text) as { data: { embedding: number[] }[] }).data[0]
        .embedding.length,
      1536,
    );
    assertFramingHeadersAbsent(res, "T31");
    assertEquals(res.headers.get("openai-organization"), "org-frosty");
    await assertWireIsCleanChunked(url, "/", "T31");
  } finally {
    client.close();
    await server.shutdown();
    await provider.shutdown();
  }
});

Deno.test("D1-T31 accepted regression: a serveDir static asset keeps its bytes and moves to chunked framing", async () => {
  // Real serveDir over a real file, not a simulated known-length stream: this is
  // the one response class that legitimately carries a correct Content-Length.
  const root = await Deno.makeTempDir();
  const asset = "S".repeat(50_000);
  await Deno.writeTextFile(`${root}/asset.txt`, asset);

  const { server, url } = serveThroughChain((req) =>
    serveDir(req, { fsRoot: root, quiet: true })
  );

  try {
    const res = await fetch(`${url}/asset.txt`);
    const text = await res.text();

    // The accepted cost, asserted so it is a decision and not a surprise.
    assertEquals(text.length, asset.length, "body bytes are identical");
    assertEquals(text, asset);
    assertEquals(
      res.headers.get("content-length"),
      null,
      "accepted: static assets lose their declared length",
    );

    // Framing observed on the wire, not inferred: the asset moves from a
    // declared length to chunked.
    await assertWireIsCleanChunked(url, "/asset.txt", "T31 static asset");
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The three no-op cases. "Provably a no-op everywhere else" is the claim that
// made this the chosen option, so it is asserted rather than argued.
// ---------------------------------------------------------------------------

Deno.test("no-op: a gateway-built JSON response keeps its content-length", async () => {
  const body = JSON.stringify({ pad: "p".repeat(5_000) });
  const { server, url } = serveThroughChain(() =>
    Promise.resolve(
      new Response(body, { headers: { "content-type": "application/json" } }),
    )
  );

  try {
    const res = await fetch(url);
    const text = await res.text();
    assertEquals(text, body);
    // Deno.serve derives the length from the known-length body, so dropping the
    // header the gateway never set changes nothing observable.
    assertEquals(res.headers.get("content-length"), String(body.length));

    const head = (await wireHead(url)).toLowerCase();
    assert(
      head.includes(`content-length: ${body.length}`),
      `declared length must survive on the wire. head was:\n${head}`,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("no-op: Content-Range on a 206 survives", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/asset.txt`, "R".repeat(50_000));

  const { server, url } = serveThroughChain((req) =>
    serveDir(req, { fsRoot: root, quiet: true })
  );

  try {
    const res = await fetch(`${url}/asset.txt`, {
      headers: { range: "bytes=0-99" },
    });
    const text = await res.text();
    assertEquals(res.status, 206);
    assertEquals(text.length, 100);
    // Content-Range is NOT in the denylist: it describes the selection, not the
    // encoding, and the client needs it to place the bytes.
    assertEquals(
      res.headers.get("content-range"),
      "bytes 0-99/50000",
    );
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("no-op: a 304 is unaffected", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/asset.txt`, "N".repeat(50_000));

  const { server, url } = serveThroughChain((req) =>
    serveDir(req, { fsRoot: root, quiet: true })
  );

  try {
    const first = await fetch(`${url}/asset.txt`);
    await first.body?.cancel();
    const etag = first.headers.get("etag");
    assert(etag, "serveDir must mint an etag for the conditional request");

    const res = await fetch(`${url}/asset.txt`, {
      headers: { "if-none-match": etag },
    });
    await res.body?.cancel();
    assertEquals(res.status, 304);
    assertEquals(res.headers.get("etag"), etag);
    // A 304 carries no body and no content-length either way, so there is
    // nothing for the denylist to remove.
    assertEquals(res.headers.get("content-length"), null);
    assert(res.headers.get("x-request-id"), "the logger still stamps its id");
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
