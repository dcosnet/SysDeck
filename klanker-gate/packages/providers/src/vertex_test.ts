import { assert, assertEquals, assertRejects } from "@std/assert";
import { VertexAdapter } from "./vertex.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  fetchMetadataToken,
  isServiceAccountJson,
  loadAdcServiceAccount,
} from "./gcp_credentials.ts";

// A real RSA private key is needed so getToken() can sign the SA JWT offline.
async function serviceAccountJson(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", kp.privateKey),
  );
  let binary = "";
  for (const b of pkcs8) {
    binary += String.fromCharCode(b);
  }
  const b64 = btoa(binary).match(/.{1,64}/g)!.join("\n");
  const pem =
    `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    client_email: "svc@test.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "http://mock/token",
  });
}

/** Routes the SA token exchange to a stub and captures the API call. */
function captureFetch(
  apiResponse: Response,
  capture: (input: string, init?: RequestInit) => void,
): typeof fetch {
  return (input, init) => {
    const url = String(input);
    if (url.includes("/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    capture(url, init);
    return Promise.resolve(apiResponse.clone());
  };
}

Deno.test("VertexAdapter.embeddings maps :predict instances and predictions", async () => {
  let url = "";
  let auth: string | null = null;
  let body: { instances?: Array<{ content: string }> } = {};
  const fetchImpl = captureFetch(
    new Response(
      JSON.stringify({
        predictions: [
          {
            embeddings: { values: [0.1, 0.2], statistics: { token_count: 3 } },
          },
          {
            embeddings: { values: [0.3, 0.4], statistics: { token_count: 4 } },
          },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
    (u, init) => {
      url = u;
      auth = new Headers(init?.headers).get("Authorization");
      body = JSON.parse(String(init?.body));
    },
  );
  const adapter = new VertexAdapter({
    projectId: "proj",
    location: "us-central1",
    serviceAccountJson: await serviceAccountJson(),
    baseUrl: "http://mock",
    tokenUrl: "http://mock/token",
    fetchImpl,
  });

  const res = await adapter.embeddings({
    model: "google/text-embedding-004",
    input: ["a", "b"],
  });
  const json = await res.json() as {
    object: string;
    data: Array<{ object: string; index: number; embedding: number[] }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  assertEquals(
    url,
    "http://mock/v1/projects/proj/locations/us-central1" +
      "/publishers/google/models/text-embedding-004:predict",
  );
  assertEquals(auth, "Bearer vertex-token");
  assertEquals(body.instances, [{ content: "a" }, { content: "b" }]);
  assertEquals(json.object, "list");
  assertEquals(json.data[1], {
    object: "embedding",
    index: 1,
    embedding: [0.3, 0.4],
  });
  assertEquals(json.usage, { prompt_tokens: 7, total_tokens: 7 });
});

Deno.test("VertexAdapter.generateImage maps Imagen :predict instances and predictions", async () => {
  let url = "";
  let auth: string | null = null;
  let body: {
    instances?: Array<{ prompt: string }>;
    parameters?: Record<string, unknown>;
  } = {};
  const fetchImpl = captureFetch(
    new Response(
      JSON.stringify({
        predictions: [
          { bytesBase64Encoded: "aW1nMQ==", mimeType: "image/png" },
          { bytesBase64Encoded: "aW1nMg==", mimeType: "image/png" },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
    (u, init) => {
      url = u;
      auth = new Headers(init?.headers).get("Authorization");
      body = JSON.parse(String(init?.body));
    },
  );
  const adapter = new VertexAdapter({
    projectId: "proj",
    location: "us-central1",
    serviceAccountJson: await serviceAccountJson(),
    baseUrl: "http://mock",
    tokenUrl: "http://mock/token",
    fetchImpl,
  });

  const res = await adapter.generateImage({
    model: "imagen-3.0-generate-002",
    prompt: "a frosty fjord",
    n: 2,
    size: "1024x1792",
    negativePrompt: "blurry",
    seed: 7,
  });

  assertEquals(
    url,
    "http://mock/v1/projects/proj/locations/us-central1" +
      "/publishers/google/models/imagen-3.0-generate-002:predict",
  );
  assertEquals(auth, "Bearer vertex-token");
  assertEquals(body.instances, [{ prompt: "a frosty fjord" }]);
  assertEquals(body.parameters, {
    sampleCount: 2,
    aspectRatio: "9:16",
    negativePrompt: "blurry",
    seed: 7,
  });
  assertEquals(res.data.map((d) => d.b64_json), ["aW1nMQ==", "aW1nMg=="]);
  assertEquals(typeof res.created, "number");
});

Deno.test("VertexAdapter.countTokens uses the native :countTokens endpoint", async () => {
  let url = "";
  let body: {
    contents?: Array<{ role: string; parts: Array<{ text: string }> }>;
  } = {};
  const fetchImpl = captureFetch(
    new Response(JSON.stringify({ totalTokens: 11 }), {
      headers: { "Content-Type": "application/json" },
    }),
    (u, init) => {
      url = u;
      body = JSON.parse(String(init?.body));
    },
  );
  const adapter = new VertexAdapter({
    projectId: "proj",
    location: "us-central1",
    serviceAccountJson: await serviceAccountJson(),
    baseUrl: "http://mock",
    tokenUrl: "http://mock/token",
    fetchImpl,
  });

  const counted = await adapter.countTokens({
    model: "gemini-1.5-pro",
    messages: [{ role: "user", content: "hi there" }],
  });

  assertEquals(
    url,
    "http://mock/v1/projects/proj/locations/us-central1" +
      "/publishers/google/models/gemini-1.5-pro:countTokens",
  );
  assertEquals(body.contents?.[0], {
    role: "user",
    parts: [{ text: "hi there" }],
  });
  assertEquals(counted, { input_tokens: 11, estimated: false });
});

// --- Application Default Credentials fallback -------------------------------
//
// MOCKED-vs-LIVE: the metadata-server assertions drive a MOCKED fetch. They
// prove request construction (Metadata-Flavor header, token URL) + parsing, not
// live reachability of metadata.google.internal (unverifiable offline). The
// GOOGLE_APPLICATION_CREDENTIALS file path is fully real (local file read).

Deno.test("isServiceAccountJson distinguishes usable SAs from empty/partial", () => {
  assert(!isServiceAccountJson("{}"));
  assert(!isServiceAccountJson(undefined));
  assert(!isServiceAccountJson('{"client_email":"x"}')); // no private_key
  assert(
    isServiceAccountJson(
      '{"client_email":"x@y","private_key":"-----BEGIN..."}',
    ),
  );
});

Deno.test("loadAdcServiceAccount reads a valid SA from GOOGLE_APPLICATION_CREDENTIALS", async () => {
  const sa = await serviceAccountJson();
  const loaded = await loadAdcServiceAccount({
    env: (n) =>
      n === "GOOGLE_APPLICATION_CREDENTIALS" ? "/adc/sa.json" : undefined,
    readTextFile: (p) =>
      p === "/adc/sa.json"
        ? Promise.resolve(sa)
        : Promise.reject(new Error("no")),
  });
  assertEquals(loaded, sa);

  // Absent env -> undefined (no ADC file configured).
  assertEquals(
    await loadAdcServiceAccount({ env: () => undefined }),
    undefined,
  );
});

Deno.test("fetchMetadataToken calls the metadata server with the Google flavor header", async () => {
  let url = "";
  let flavor: string | null = null;
  const token = await fetchMetadataToken({
    env: () => undefined,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      flavor = new Headers(init?.headers).get("Metadata-Flavor");
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "metadata-token", expires_in: 1234 }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });
  assertEquals(
    url,
    "http://metadata.google.internal/computeMetadata/v1/instance/" +
      "service-accounts/default/token",
  );
  assertEquals(flavor, "Google");
  assertEquals(token, { token: "metadata-token", expiresIn: 1234 });
});

Deno.test("VertexAdapter falls back to the ADC SA file when the account has no SA", async () => {
  const sa = await serviceAccountJson();
  let auth: string | null = null;
  const fetchImpl = captureFetch(
    new Response(
      JSON.stringify({
        predictions: [{ embeddings: { values: [1, 2], statistics: {} } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
    (_u, init) => {
      auth = new Headers(init?.headers).get("Authorization");
    },
  );
  // Account SA is empty ("{}"); ADC file supplies the real SA.
  const adapter = new VertexAdapter({
    projectId: "proj",
    location: "us-central1",
    serviceAccountJson: "{}",
    baseUrl: "http://mock",
    fetchImpl,
    env: (n) =>
      n === "GOOGLE_APPLICATION_CREDENTIALS" ? "/adc/sa.json" : undefined,
    readTextFile: (p) =>
      p === "/adc/sa.json"
        ? Promise.resolve(sa)
        : Promise.reject(new Error("no")),
  });

  const res = await adapter.embeddings({
    model: "google/text-embedding-004",
    input: "hi",
  });
  await res.body?.cancel();
  // The ADC SA's JWT was exchanged at http://mock/token -> "vertex-token".
  assertEquals(auth, "Bearer vertex-token");
});

Deno.test("VertexAdapter falls back to the GCE metadata token when no SA is available", async () => {
  let auth: string | null = null;
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("computeMetadata")) {
      assertEquals(
        new Headers(init?.headers).get("Metadata-Flavor"),
        "Google",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "metadata-token", expires_in: 3600 }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    auth = new Headers(init?.headers).get("Authorization");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          predictions: [{ embeddings: { values: [1, 2], statistics: {} } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  // No account SA and no GOOGLE_APPLICATION_CREDENTIALS -> metadata server.
  const adapter = new VertexAdapter({
    projectId: "proj",
    location: "us-central1",
    serviceAccountJson: "{}",
    baseUrl: "http://mock",
    fetchImpl,
    env: () => undefined,
  });

  const res = await adapter.embeddings({
    model: "google/text-embedding-004",
    input: "hi",
  });
  await res.body?.cancel();
  assertEquals(auth, "Bearer metadata-token");
});

// ---------------------------------------------------------------------------
// D1-T18 on Vertex: generateImage is single-attempt, and the shared
// postWithToken helper KEEPS the retry for its two non-media callers.

Deno.test("D1-T18: vertex generateImage is one attempt, embeddings keeps its retry", async () => {
  const sa = await serviceAccountJson();
  const arm = async (
    label: string,
    call: (a: VertexAdapter) => Promise<unknown>,
  ): Promise<number> => {
    let attempts = 0;
    const fetchImpl = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      attempts++;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const adapter = new VertexAdapter({
      projectId: "proj",
      location: "us-central1",
      serviceAccountJson: sa,
      baseUrl: "http://mock",
      tokenUrl: "http://mock/token",
      // maxRetries: 3 is the shipped default, so a one-attempt result here is a
      // property of the transport chosen, not of the fixture.
      client: new ProviderClient(
        { maxRetries: 3, initialDelayMs: 1 },
        fetchImpl,
      ),
    });
    await assertRejects(() => call(adapter), ProviderError, undefined, label);
    return attempts;
  };

  assertEquals(
    await arm(
      "generateImage",
      (a) => a.generateImage({ model: "imagen-3.0-generate-002", prompt: "p" }),
    ),
    1,
    "an image render is paid work: exactly one attempt",
  );
  // The caution the shared helper carries: embeddings and countTokens are cheap
  // idempotent calls that still want the retry, so the default must not move.
  assertEquals(
    await arm(
      "embeddings",
      (a) => a.embeddings({ model: "google/text-embedding-004", input: "hi" }),
    ),
    4,
    "embeddings keeps fetchWithRetry: 1 + 3 retries",
  );
  assertEquals(
    await arm("countTokens", (a) =>
      a.countTokens({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
      })),
    4,
    "countTokens keeps fetchWithRetry: 1 + 3 retries",
  );
});
