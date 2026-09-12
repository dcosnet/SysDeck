import { assert, assertEquals, assertRejects } from "@std/assert";
import { ElevenLabsAdapter } from "./elevenlabs.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import { buildAdapter } from "./manager.ts";
import type { IProviderAdapter } from "./types.ts";

Deno.test("ElevenLabsAdapter forwards /audio/transcriptions to Scribe STT as multipart passthrough", async () => {
  let url = "";
  let apiKey: string | null = null;
  let contentType: string | null = null;
  let method: string | undefined;
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    const headers = new Headers(init?.headers);
    apiKey = headers.get("xi-api-key");
    contentType = headers.get("Content-Type");
    method = init?.method;
    return Promise.resolve(
      new Response(JSON.stringify({ text: "transcribed" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const adapter = new ElevenLabsAdapter(
    "el-key",
    "http://mock",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );

  const multipart = "multipart/form-data; boundary=----frosty";
  const res = await adapter.rawProxy(
    "/audio/transcriptions",
    new Request("http://internal/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": multipart },
      body: "--frosty--\r\n",
    }),
  );
  const json = await res.json() as { text: string };

  assertEquals(url, "http://mock/v1/speech-to-text");
  assertEquals(method, "POST");
  assertEquals(apiKey, "el-key");
  // The caller-supplied multipart boundary is preserved intact.
  assertEquals(contentType, multipart);
  assertEquals(json.text, "transcribed");
});

Deno.test("ElevenLabsAdapter rejects unsupported passthrough paths", async () => {
  const adapter = new ElevenLabsAdapter(
    "el-key",
    "http://mock",
    new ProviderClient(
      { maxRetries: 0 },
      (() => Promise.resolve(new Response("x"))) as typeof fetch,
    ),
  );
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/translations",
        new Request("http://internal/v1/audio/translations", {
          method: "POST",
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("/audio/transcriptions"));
});

// ---------------------------------------------------------------------------
// D1-T18 on the ElevenLabs media surfaces. Before this, manager.ts satisfied
// the adapter's fetch parameter with `client.fetch` - i.e. fetchWithRetry - so
// one caller request cost up to four paid renders on BOTH surfaces.

Deno.test("D1-T18: elevenlabs media surfaces make exactly one attempt on a 429", async () => {
  const surfaces: Array<[string, (a: IProviderAdapter) => Promise<unknown>]> = [
    ["speech", (a) =>
      a.rawProxy!(
        "/audio/speech",
        new Request("http://internal/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "eleven_multilingual_v2",
            input: "hei",
            voice: "Rachel",
          }),
        }),
      )],
    ["transcriptions", (a) =>
      a.rawProxy!(
        "/audio/transcriptions",
        new Request("http://internal/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Content-Type": "multipart/form-data; boundary=----frosty",
          },
          body: "------frosty--\r\n",
        }),
      )],
  ];
  // Both construction paths, because the measured defect lived in the WIRING:
  // manager.ts satisfied the old `fetchImpl` parameter with `client.fetch`.
  const builders: Array<[string, (c: ProviderClient) => IProviderAdapter]> = [
    ["direct", (c) => new ElevenLabsAdapter("el-key", "http://mock", c)],
    ["buildAdapter", (c) =>
      buildAdapter({
        id: "el",
        type: "elevenlabs",
        apiKey: "el-key",
        baseUrl: "http://mock",
        enabled: true,
        models: ["eleven_multilingual_v2"],
        priority: 0,
      }, c)],
  ];
  for (const [label, call] of surfaces) {
    for (const [how, build] of builders) {
      let attempts = 0;
      // maxRetries: 3 is the shipped default; through fetchWithRetry this fixture
      // bills four attempts.
      const adapter = build(
        new ProviderClient(
          { maxRetries: 3, initialDelayMs: 1 },
          (() => {
            attempts++;
            return Promise.resolve(
              new Response(JSON.stringify({ detail: "slow down" }), {
                status: 429,
                statusText: "Too Many Requests",
                headers: { "Content-Type": "application/json" },
              }),
            );
          }) as typeof fetch,
        ),
      );
      const err = await assertRejects(() => call(adapter), ProviderError);
      assertEquals(err.status, 429, `${label}/${how}`);
      assertEquals(attempts, 1, `${label}/${how}: exactly one paid attempt`);
    }
  }
});
