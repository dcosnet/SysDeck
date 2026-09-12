import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProviderClient, ProviderError } from "./client.ts";
import { OpenAIAdapter } from "./openai.ts";
import { readSSE } from "../../testing/src/mod.ts";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

Deno.test("ProviderClient retries on 429 then succeeds", async () => {
  let attempts = 0;
  const client = new ProviderClient(
    { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 },
    mockFetch(() => {
      attempts++;
      return attempts < 3
        ? new Response("rate limited", { status: 429 })
        : new Response("ok", { status: 200 });
    }),
  );
  const response = await client.fetchWithRetry("http://mock/");
  assertEquals(response.status, 200);
  assertEquals(attempts, 3);
});

Deno.test("ProviderClient throws ProviderError after max retries", async () => {
  const client = new ProviderClient(
    { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2 },
    mockFetch(() => new Response("boom", { status: 500 })),
  );
  await assertRejects(
    () => client.fetchWithRetry("http://mock/"),
    ProviderError,
  );
});

Deno.test("OpenAIAdapter sends canonical request with auth header", async () => {
  let capturedUrl = "";
  let capturedAuth: string | null = null;
  let capturedBody: Record<string, unknown> = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get("Authorization");
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const adapter = new OpenAIAdapter("sk-test", "http://mock/v1", client);
  const response = await adapter.chatCompletions({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  await response.body?.cancel();

  assertEquals(capturedUrl, "http://mock/v1/chat/completions");
  assertEquals(capturedAuth, "Bearer sk-test");
  assertEquals(capturedBody.model, "gpt-4o");
});

Deno.test("OpenAIAdapter normalizes streaming and appends missing [DONE]", async () => {
  const upstream = [
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n`,
    // upstream ends WITHOUT [DONE] on purpose
  ].join("");
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() =>
      new Response(upstream, {
        headers: { "Content-Type": "text/event-stream" },
      })
    ),
  );
  const adapter = new OpenAIAdapter("sk-test", "http://mock/v1", client);
  const response = await adapter.chatCompletions({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });

  assertEquals(response.headers.get("Content-Type"), "text/event-stream");
  const events = await readSSE(response);
  assertEquals(events.length, 3);
  const first = events[0] as { choices: Array<{ delta: { content: string } }> };
  assertEquals(first.choices[0].delta.content, "Hel");
  assertEquals(events.at(-1), "[DONE]");
});

Deno.test("OpenAIAdapter throws ProviderError with upstream body on 4xx", async () => {
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
      })
    ),
  );
  const adapter = new OpenAIAdapter("sk-bad", "http://mock/v1", client);
  const err = await assertRejects(
    () =>
      adapter.chatCompletions({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ProviderError,
  );
  assertEquals(err.status, 401);
  assert(err.body.includes("bad key"));
});

Deno.test("OpenAIAdapter.countTokens (native) hits /responses/input_tokens", async () => {
  let url = "";
  let body: {
    model?: string;
    input?: Array<{ role: string; content: string }>;
  } = {};
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  // nativeCountTokens=true is how the manager builds the real `openai` account.
  const adapter = new OpenAIAdapter("sk-test", "http://mock/v1", client, true);
  const counted = await adapter.countTokens({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "t1", content: "result" },
    ],
  });

  assertEquals(url, "http://mock/v1/responses/input_tokens");
  assertEquals(body.model, "gpt-4o");
  // Non-Responses roles (tool/function) collapse to "user" for counting.
  assertEquals(body.input, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "user", content: "result" },
  ]);
  assertEquals(counted, { input_tokens: 42, estimated: false });
});

Deno.test("OpenAIAdapter.countTokens falls back to a chars/4 estimate for shared vendors", async () => {
  let calls = 0;
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch(() => {
      calls++;
      return new Response("should not be called", { status: 500 });
    }),
  );
  // Default (nativeCountTokens=false) is how groq/mistral/nebius/… are built.
  const adapter = new OpenAIAdapter("sk-test", "http://mock/v1", client);
  const counted = await adapter.countTokens({
    model: "mixtral",
    messages: [{ role: "user", content: "12345678" }], // 8 chars -> ceil(8/4)=2
  });

  assertEquals(calls, 0); // no native endpoint call for shared vendors
  assertEquals(counted, { input_tokens: 2, estimated: true });
});
