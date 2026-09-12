import { assertEquals } from "@std/assert";
import { ProviderRegistry } from "../../contracts/src/mod.ts";
import { OpenAIAdapter } from "./openai.ts";

// Mistral Voxtral transcription (G4) is a pure capability flip: mistral
// accounts ride the stock OpenAIAdapter, whose rawProxy already forwards the
// OpenAI-wire multipart byte-identical to Mistral's own
// POST /v1/audio/transcriptions. These tests pin that wire and the flag.

Deno.test("ProviderRegistry advertises mistral audio support", () => {
  assertEquals(ProviderRegistry.mistral.supportsAudio, true);
});

Deno.test("OpenAIAdapter.rawProxy forwards a Mistral transcription multipart verbatim", async () => {
  let url = "";
  let method: string | undefined;
  let auth: string | null = null;
  let contentType: string | null = null;
  let bodyText = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    url = String(input);
    method = init?.method;
    const headers = new Headers(init?.headers);
    auth = headers.get("Authorization");
    contentType = headers.get("Content-Type");
    bodyText = await new Response(init?.body as BodyInit).text();
    return new Response(
      JSON.stringify({ text: "bonjour le monde", language: "fr" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("mistral-key", "http://mock/v1");
    const multipart = "multipart/form-data; boundary=----voxtral";
    const payload = "------voxtral\r\n" +
      'Content-Disposition: form-data; name="model"\r\n\r\n' +
      "voxtral-mini-latest\r\n" +
      "------voxtral--\r\n";
    const res = await adapter.rawProxy(
      "/audio/transcriptions",
      new Request("http://internal/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": multipart },
        body: payload,
      }),
    );
    const json = await res.json() as { text: string };

    assertEquals(url, "http://mock/v1/audio/transcriptions");
    assertEquals(method, "POST");
    assertEquals(auth, "Bearer mistral-key");
    // The caller's multipart boundary must survive untouched.
    assertEquals(contentType, multipart);
    assertEquals(bodyText, payload);
    assertEquals(json.text, "bonjour le monde");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
