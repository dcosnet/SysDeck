// Decision-log item 12 closure: Azure long-tail passthrough. Files/batches
// address the account scope; images/audio address a deployment resolved from
// body.model or ?model=.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { AzureOpenAIAdapter } from "../../packages/providers/src/azure.ts";
import {
  ProviderClient,
  ProviderError,
} from "../../packages/providers/src/client.ts";

interface Seen {
  method: string;
  path: string;
  query: string;
  apiKey: string | null;
}

function mockAzure() {
  const seen: Seen[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      apiKey: req.headers.get("api-key"),
    });
    await req.body?.cancel();
    return Response.json({ ok: true });
  });
  return {
    seen,
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test("azure rawProxy: files and batches are account-scoped", async () => {
  const azure = mockAzure();
  try {
    const adapter = new AzureOpenAIAdapter("az-key", azure.url, "2024-06-01");
    const listFiles = new Request("http://internal/v1/files");
    const res = await adapter.rawProxy("/files", listFiles);
    assertEquals(await res.json(), { ok: true });

    const batch = new Request("http://internal/v1/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_file_id: "f1" }),
    });
    await (await adapter.rawProxy("/batches", batch)).body?.cancel();

    assertEquals(azure.seen[0].path, "/openai/files");
    assertEquals(azure.seen[1].path, "/openai/batches");
    assert(azure.seen.every((s) => s.query === "?api-version=2024-06-01"));
    assert(azure.seen.every((s) => s.apiKey === "az-key"));
  } finally {
    await azure.shutdown();
  }
});

Deno.test("azure rawProxy: deployment from body.model for JSON routes", async () => {
  const azure = mockAzure();
  try {
    const adapter = new AzureOpenAIAdapter("az-key", azure.url, "2024-06-01");
    const images = new Request("http://internal/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dalle3-dep", prompt: "a fjord" }),
    });
    await (await adapter.rawProxy("/images/generations", images)).body
      ?.cancel();
    assertEquals(
      azure.seen[0].path,
      "/openai/deployments/dalle3-dep/images/generations",
    );
  } finally {
    await azure.shutdown();
  }
});

Deno.test("azure rawProxy: deployment from ?model= for multipart routes", async () => {
  const azure = mockAzure();
  try {
    const adapter = new AzureOpenAIAdapter("az-key", azure.url, "2024-06-01");
    const transcribe = new Request(
      "http://internal/v1/audio/transcriptions?model=whisper-dep",
      {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=x" },
        body: "--x--",
      },
    );
    await (await adapter.rawProxy("/audio/transcriptions", transcribe)).body
      ?.cancel();
    assertEquals(
      azure.seen[0].path,
      "/openai/deployments/whisper-dep/audio/transcriptions",
    );
  } finally {
    await azure.shutdown();
  }
});

Deno.test("azure rawProxy: missing deployment is a 400 ProviderError", async () => {
  const azure = mockAzure();
  try {
    const adapter = new AzureOpenAIAdapter("az-key", azure.url);
    const bad = new Request("http://internal/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "no model" }),
    });
    const error = await assertRejects(
      () => adapter.rawProxy("/images/generations", bad),
      ProviderError,
      "Provider Error 400",
    );
    assert(error.body.includes("needs a deployment"));
    assertEquals(azure.seen.length, 0); // nothing left the gateway
  } finally {
    await azure.shutdown();
  }
});

// ---------------------------------------------------------------------------
// D1-T18 on the Azure media passthrough. rawProxy used a bare `fetch`, so it
// had neither the retry pin nor - the reason Stage 3 needed it - the
// establishment timeout that returns a media in-flight reservation.

Deno.test("D1-T18: azure rawProxy makes exactly one attempt on a 429", async () => {
  let attempts = 0;
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    attempts++;
    await req.body?.cancel();
    return Response.json({ error: "slow down" }, { status: 429 });
  });
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const adapter = new AzureOpenAIAdapter(
      "az-key",
      url,
      "2024-06-01",
      // maxRetries: 3 is the shipped default; through fetchWithRetry this would
      // be four paid image renders.
      new ProviderClient({ maxRetries: 3, initialDelayMs: 1 }),
    );
    const err = await assertRejects(
      () =>
        adapter.rawProxy(
          "/images/generations",
          new Request("http://internal/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "dall-e-3", prompt: "fjord" }),
          }),
        ),
      ProviderError,
    );
    assertEquals(err.status, 429);
    assertEquals(attempts, 1, "exactly one paid attempt");
  } finally {
    await server.shutdown();
  }
});

// The establishment timeout an operator sets is now honored on this path. Before
// this it was silently ignored, so a provider that accepted the connection and
// never answered pinned the caller (and its media reservation) forever.
Deno.test("azure rawProxy honors the establishment timeout", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  (async () => {
    for await (const conn of listener) held.push(conn); // accept, never answer
  })().catch(() => {});
  const url = `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`;
  try {
    const adapter = new AzureOpenAIAdapter(
      "az-key",
      url,
      "2024-06-01",
      new ProviderClient({ maxRetries: 0, requestTimeoutMs: 250 }),
    );
    // Raced against a bound rather than plain-awaited: the failure mode under
    // test is "never returns", so an unbounded await would HANG the suite
    // instead of failing it. `caller` releases the abandoned fetch so the
    // op sanitizer is not left holding it either.
    const caller = new AbortController();
    let guard: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => {
      guard = setTimeout(() => resolve("hung"), 4000);
    });
    const started = Date.now();
    const outcome = await Promise.race([
      adapter.rawProxy(
        "/audio/transcriptions",
        new Request("http://internal/v1/audio/transcriptions?model=whisper-1", {
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=b" },
          body: "--b--\r\n",
        }),
        { signal: caller.signal },
      ).then(() => "resolved" as const).catch((e: unknown) => e),
      hung,
    ]);
    clearTimeout(guard);
    caller.abort();
    assert(
      outcome instanceof DOMException &&
        (outcome as DOMException).name === "TimeoutError",
      `expected the client's establishment timeout, got ${String(outcome)}`,
    );
    assert(
      Date.now() - started < 4000,
      "the request must not outlive the timeout budget",
    );
  } finally {
    listener.close();
    for (const c of held) {
      try {
        c.close();
      } catch { /* already gone */ }
    }
  }
});
