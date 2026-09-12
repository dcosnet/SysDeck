import { assert, assertEquals, assertRejects } from "@std/assert";
import { AnthropicAdapter, AnthropicSSETransformer } from "./anthropic.ts";
import { NormalizationPipeline } from "../../core/src/mod.ts";
import { ProviderClient, ProviderError } from "./client.ts";

function mockFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return (input, init) => Promise.resolve(handler(input, init));
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectSSE(
  body: ReadableStream<Uint8Array>,
): Promise<Array<Record<string, unknown> | "[DONE]">> {
  const text = await new Response(body).text();
  const out: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice(6).trim();
    out.push(data === "[DONE]" ? "[DONE]" : JSON.parse(data));
  }
  return out;
}

Deno.test("AnthropicSSETransformer maps text deltas and stop", async () => {
  const events = [
    `event: message_start\ndata: {"type":"message_start"}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const body = NormalizationPipeline.create(
    new AnthropicSSETransformer("claude-test", 1),
    streamFromChunks(events),
  );
  const chunks = await collectSSE(body);

  const texts = chunks
    .filter((c): c is Record<string, unknown> => c !== "[DONE]")
    .map((c) =>
      (c.choices as Array<{ delta: { content?: string } }>)[0]?.delta.content
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  assertEquals(texts.join(""), "Hello world");

  const finish = chunks
    .filter((c): c is Record<string, unknown> => c !== "[DONE]")
    .map((c) =>
      (c.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason
    )
    .filter(Boolean);
  assertEquals(finish, ["stop"]);
  assertEquals(chunks.at(-1), "[DONE]");
});

Deno.test("AnthropicSSETransformer survives events split across network chunks", async () => {
  const full =
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"unbroken"}}\n\n` +
    `data: {"type":"message_stop"}\n\n`;
  // Split mid-JSON to simulate TCP fragmentation.
  const chunks = [full.slice(0, 37), full.slice(37, 61), full.slice(61)];
  const body = NormalizationPipeline.create(
    new AnthropicSSETransformer("claude-test", 1),
    streamFromChunks(chunks),
  );
  const events = await collectSSE(body);
  const texts = events
    .filter((c): c is Record<string, unknown> => c !== "[DONE]")
    .map((c) =>
      (c.choices as Array<{ delta: { content?: string } }>)[0]?.delta.content
    )
    .filter((t): t is string => Boolean(t));
  assertEquals(texts.join(""), "unbroken");
});

Deno.test("AnthropicSSETransformer surfaces usage as a final empty-choices chunk", async () => {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hei"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  const body = NormalizationPipeline.create(
    new AnthropicSSETransformer("claude-test", 1),
    streamFromChunks(events),
  );
  const chunks = (await collectSSE(body))
    .filter((c): c is Record<string, unknown> => c !== "[DONE]");

  const tail = chunks.at(-1)!;
  assertEquals(tail.choices, []);
  assertEquals(tail.usage, {
    prompt_tokens: 9,
    completion_tokens: 4,
    total_tokens: 13,
  });
});

Deno.test("AnthropicSSETransformer maps tool_use deltas to tool_calls chunks", async () => {
  const events = [
    `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n`,
    `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n`,
    `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"Oslo\\"}"}}\n\n`,
    `data: {"type":"content_block_stop"}\n\n`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`,
  ];
  const body = NormalizationPipeline.create(
    new AnthropicSSETransformer("claude-test", 1),
    streamFromChunks(events),
  );
  const chunks = (await collectSSE(body))
    .filter((c): c is Record<string, unknown> => c !== "[DONE]");

  type ToolDelta = {
    delta: {
      tool_calls?: Array<
        {
          index: number;
          id?: string;
          function: { name?: string; arguments: string };
        }
      >;
    };
    finish_reason: string | null;
  };
  const toolChunks = chunks
    .map((c) => (c.choices as ToolDelta[])[0])
    .filter((c) => c.delta.tool_calls);

  assertEquals(toolChunks[0].delta.tool_calls![0].id, "toolu_1");
  assertEquals(toolChunks[0].delta.tool_calls![0].function.name, "get_weather");
  const args = toolChunks.slice(1)
    .map((c) => c.delta.tool_calls![0].function.arguments)
    .join("");
  assertEquals(JSON.parse(args), { city: "Oslo" });

  const finish = chunks
    .map((c) => (c.choices as ToolDelta[])[0].finish_reason)
    .filter(Boolean);
  assertEquals(finish, ["tool_calls"]);
});

Deno.test("AnthropicAdapter maps non-streaming responses to canonical chat", () => {
  const adapter = new AnthropicAdapter("k");
  const mapped = adapter.mapFromAnthropic(
    {
      id: "msg_abc",
      model: "claude-test",
      content: [
        { type: "text", text: "The weather is " },
        { type: "text", text: "sunny." },
        {
          type: "tool_use",
          id: "toolu_9",
          name: "get_weather",
          input: { city: "Oslo" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-test",
    123,
  );

  assertEquals(mapped.object, "chat.completion");
  assertEquals(mapped.choices[0].message.content, "The weather is sunny.");
  const toolCalls = mapped.choices[0].message.tool_calls as Array<
    { id: string; function: { name: string; arguments: string } }
  >;
  assertEquals(toolCalls[0].id, "toolu_9");
  assertEquals(JSON.parse(toolCalls[0].function.arguments), { city: "Oslo" });
  assertEquals(mapped.choices[0].finish_reason, "tool_calls");
  assertEquals(mapped.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

Deno.test("AnthropicAdapter maps canonical requests to Messages format", () => {
  const adapter = new AnthropicAdapter("k");
  const mapped = adapter.mapToAnthropic({
    model: "claude-test",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Oslo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "toolu_9",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
        }],
      },
      { role: "tool", tool_call_id: "toolu_9", content: '{"temp": 21}' },
    ],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: {} },
      },
    }],
    max_tokens: 100,
  }) as {
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string; input_schema: unknown }>;
  };

  assertEquals(mapped.system, "Be brief.");
  assertEquals(mapped.messages.length, 3);
  assertEquals(mapped.messages[0], {
    role: "user",
    content: "Weather in Oslo?",
  });
  const assistant = mapped.messages[1].content as Array<
    Record<string, unknown>
  >;
  assertEquals(assistant[0].type, "tool_use");
  assertEquals((assistant[0].input as { city: string }).city, "Oslo");
  const toolResult = mapped.messages[2].content as Array<
    Record<string, unknown>
  >;
  assertEquals(toolResult[0].type, "tool_result");
  assertEquals(toolResult[0].tool_use_id, "toolu_9");
  assert(mapped.tools);
  assertEquals(mapped.tools[0].name, "get_weather");
});

Deno.test("mapToAnthropic maps tool_choice only when tools are present", () => {
  const adapter = new AnthropicAdapter("k");
  const base = {
    model: "claude-test",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [{
      type: "function",
      function: { name: "f", parameters: { type: "object" } },
    }],
  };
  const choice = (tool_choice: unknown) =>
    adapter.mapToAnthropic({ ...base, tool_choice }).tool_choice;

  assertEquals(choice("auto"), { type: "auto" });
  assertEquals(choice("required"), { type: "any" });
  assertEquals(choice("none"), { type: "none" });
  assertEquals(
    choice({ type: "function", function: { name: "f" } }),
    { type: "tool", name: "f" },
  );
  assertEquals(choice(undefined), undefined);
  // No tools -> tool_choice is dropped even when the request carries one.
  assertEquals(
    adapter.mapToAnthropic({
      model: base.model,
      messages: base.messages,
      tool_choice: "auto",
    }).tool_choice,
    undefined,
  );
});

Deno.test("mapToAnthropic maps image_url parts to Anthropic image blocks", () => {
  const adapter = new AnthropicAdapter("k");
  const mapped = adapter.mapToAnthropic({
    model: "claude-test",
    messages: [
      { role: "system", content: "Describe the picture." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
          {
            type: "image_url",
            image_url: { url: "https://example.com/cat.png" },
          },
        ],
      },
    ],
  }) as { system?: string; messages: Array<{ content: unknown }> };

  assertEquals(mapped.system, "Describe the picture.");
  const blocks = mapped.messages[0].content as Array<Record<string, unknown>>;
  assertEquals(blocks, [
    { type: "text", text: "What is this?" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    },
    {
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    },
  ]);
});

// --- rawProxy: Message Batches + Files API translation ---

const BASE = "https://api.anthropic.com/v1";
const FILES_BETA = "files-api-2025-04-14";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  init?: RequestInit;
}

function recordingAdapter(
  handler: (call: RecordedCall) => Response | Promise<Response>,
  betaHeaders?: Record<string, "default" | "enabled" | "disabled">,
): { adapter: AnthropicAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = new ProviderClient(
    { maxRetries: 0 },
    mockFetch((input, init) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        init,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  const adapter = new AnthropicAdapter(
    "k",
    undefined,
    BASE,
    client,
    betaHeaders,
  );
  return { adapter, calls };
}

function jsonWire(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BATCH_WIRE = {
  id: "msgbatch_1",
  type: "message_batch",
  processing_status: "in_progress",
  created_at: "2020-01-01T00:00:00Z",
  expires_at: "2020-01-02T00:00:00Z",
};

const FILE_WIRE = {
  id: "file_1",
  type: "file",
  filename: "in.jsonl",
  mime_type: "application/jsonl",
  size_bytes: 5,
  created_at: "2020-01-01T00:00:00Z",
  downloadable: false,
};

Deno.test("rawProxy forwards inline batch requests verbatim without files beta", async () => {
  const { adapter, calls } = recordingAdapter(() => jsonWire(BATCH_WIRE));
  const res = await adapter.rawProxy(
    "/batches",
    new Request("http://internal/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ custom_id: "a", params: { model: "m", max_tokens: 1 } }],
      }),
    }),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${BASE}/messages/batches`);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("x-api-key"), "k");
  assertEquals(calls[0].headers.get("anthropic-version"), "2023-06-01");
  // Batch calls NEVER carry the files beta header.
  assertEquals(calls[0].headers.get("anthropic-beta"), null);
  // Params are an opaque map forwarded verbatim (Go parity).
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    requests: [{ custom_id: "a", params: { model: "m", max_tokens: 1 } }],
  });

  const body = await res.json();
  assertEquals(body.object, "batch");
  assertEquals(body.status, "in_progress");
  assertEquals(body.created_at, 1577836800);
});

Deno.test("rawProxy batch create via input_file_id fetches JSONL with files beta and converts OpenAI lines", async () => {
  const jsonl = [
    '{"custom_id":"a","params":{"model":"m","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}}',
    '{"custom_id":"b","body":{"model":"m","stream":true,"messages":[{"role":"user","content":"yo"}]}}',
  ].join("\n");
  const { adapter, calls } = recordingAdapter((call) =>
    call.url.endsWith("/files/file_1/content")
      ? new Response(jsonl, {
        headers: { "Content-Type": "application/jsonl" },
      })
      : jsonWire(BATCH_WIRE)
  );

  await adapter.rawProxy(
    "/batches",
    new Request("http://internal/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_file_id: "file_1",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      }),
    }),
  );

  assertEquals(calls.length, 2);
  // 1) Batch-input content fetch carries the files beta header.
  assertEquals(calls[0].url, `${BASE}/files/file_1/content`);
  assertEquals(calls[0].headers.get("anthropic-beta"), FILES_BETA);
  // 2) The batches POST does not.
  assertEquals(calls[1].url, `${BASE}/messages/batches`);
  assertEquals(calls[1].headers.get("anthropic-beta"), null);

  const posted = JSON.parse(String(calls[1].init?.body)) as {
    requests: Array<{ custom_id: string; params: Record<string, unknown> }>;
  };
  // Native line used as-is.
  assertEquals(posted.requests[0], {
    custom_id: "a",
    params: {
      model: "m",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  // OpenAI line converted through mapToAnthropic, `stream` stripped.
  assertEquals(posted.requests[1], {
    custom_id: "b",
    params: {
      model: "m",
      messages: [{ role: "user", content: "yo" }],
      max_tokens: 1024,
    },
  });
});

Deno.test("rawProxy batch create with neither requests nor input_file_id is a 400", async () => {
  const { adapter, calls } = recordingAdapter(() => jsonWire(BATCH_WIRE));
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/batches",
        new Request("http://internal/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata: {} }),
        }),
      ),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("rawProxy merges account-enabled betas after the files beta", async () => {
  const { adapter, calls } = recordingAdapter(
    (call) =>
      call.url.includes("/files/") ? jsonWire(FILE_WIRE) : jsonWire(BATCH_WIRE),
    { "context-1m-2025-08-07": "enabled", "off-beta": "disabled" },
  );

  await adapter.rawProxy("/files/file_9", new Request("http://internal/x"));
  assertEquals(calls[0].url, `${BASE}/files/file_9`);
  assertEquals(
    calls[0].headers.get("anthropic-beta"),
    `${FILES_BETA},context-1m-2025-08-07`,
  );

  await adapter.rawProxy("/batches/b1", new Request("http://internal/x"));
  assertEquals(calls[1].url, `${BASE}/messages/batches/b1`);
  // Account betas still apply to batch calls; the files beta never does.
  assertEquals(calls[1].headers.get("anthropic-beta"), "context-1m-2025-08-07");
});

Deno.test("rawProxy file upload rebuilds a single-field multipart with files beta", async () => {
  const { adapter, calls } = recordingAdapter(() => jsonWire(FILE_WIRE, 201));

  const incoming = new FormData();
  incoming.append("file", new File(["hello"], "in.jsonl"), "in.jsonl");
  incoming.append("purpose", "batch");
  const res = await adapter.rawProxy(
    "/files",
    new Request("http://internal/files", { method: "POST", body: incoming }),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${BASE}/files`);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("anthropic-beta"), FILES_BETA);
  // No explicit Content-Type: fetch supplies the multipart boundary.
  assertEquals(calls[0].headers.get("Content-Type"), null);
  const upstream = calls[0].init?.body as FormData;
  assert(upstream instanceof FormData);
  const file = upstream.get("file");
  assert(file instanceof File);
  assertEquals(file.name, "in.jsonl");
  assertEquals(await file.text(), "hello");
  // `purpose` is dropped: Anthropic's Files API has no purpose field.
  assertEquals(upstream.get("purpose"), null);
  assertEquals([...upstream.keys()], ["file"]);

  const body = await res.json();
  assertEquals(body.object, "file");
  assertEquals(body.purpose, "batch");
  assertEquals(body.bytes, 5);
});

Deno.test("rawProxy file list maps after -> after_id", async () => {
  const { adapter, calls } = recordingAdapter(() =>
    jsonWire({
      data: [FILE_WIRE],
      has_more: true,
      first_id: "file_1",
      last_id: "file_1",
    })
  );
  const res = await adapter.rawProxy(
    "/files",
    new Request(
      "http://internal/v1/files?provider=anthropic&limit=5&after=file_9",
    ),
  );

  assertEquals(calls[0].url, `${BASE}/files?limit=5&after_id=file_9`);
  assertEquals(calls[0].headers.get("anthropic-beta"), FILES_BETA);
  const body = await res.json();
  assertEquals(body.object, "list");
  assertEquals(body.has_more, true);
  assertEquals(body.data[0].id, "file_1");
  assertEquals(body.data[0].purpose, "batch");
  assertEquals(body.data[0].status, "processed");
});

Deno.test("rawProxy file content passes bytes and upstream Content-Type through", async () => {
  const { adapter, calls } = recordingAdapter(() =>
    new Response("payload", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  );
  const res = await adapter.rawProxy(
    "/files/file_1/content",
    new Request("http://internal/x"),
  );

  assertEquals(calls[0].url, `${BASE}/files/file_1/content`);
  assertEquals(calls[0].headers.get("anthropic-beta"), FILES_BETA);
  assertEquals(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assertEquals(await res.text(), "payload");
});

Deno.test("rawProxy file delete synthesizes the OpenAI envelope from a 204", async () => {
  const { adapter, calls } = recordingAdapter(() =>
    new Response(null, { status: 204 })
  );
  const res = await adapter.rawProxy(
    "/files/file_1",
    new Request("http://internal/x", { method: "DELETE" }),
  );

  assertEquals(calls[0].url, `${BASE}/files/file_1`);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].headers.get("anthropic-beta"), FILES_BETA);
  assertEquals(await res.json(), {
    id: "file_1",
    object: "file",
    deleted: true,
  });
});

Deno.test("rawProxy batch results re-emits OpenAI-shaped JSONL", async () => {
  const upstream = [
    '{"custom_id":"a","result":{"type":"succeeded","message":{"id":"msg_1"}}}',
    '{"custom_id":"b","result":{"type":"errored","error":{"type":"invalid_request","message":"bad"}}}',
  ].join("\n");
  const { adapter, calls } = recordingAdapter(() =>
    new Response(upstream, {
      headers: { "Content-Type": "application/x-jsonl" },
    })
  );
  const res = await adapter.rawProxy(
    "/batches/msgbatch_1/results",
    new Request("http://internal/x"),
  );

  assertEquals(calls[0].url, `${BASE}/messages/batches/msgbatch_1/results`);
  assertEquals(calls[0].headers.get("anthropic-beta"), null);
  assertEquals(res.headers.get("Content-Type"), "application/jsonl");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines[0], {
    custom_id: "a",
    response: { status_code: 200, body: { id: "msg_1" } },
    result_type: "succeeded",
  });
  assertEquals(lines[1], {
    custom_id: "b",
    response: null,
    result_type: "errored",
    error: { code: "invalid_request", message: "bad" },
  });
});

Deno.test("rawProxy batch cancel and list hit the native endpoints", async () => {
  const { adapter, calls } = recordingAdapter((call) =>
    call.url.includes("?")
      ? jsonWire({ data: [BATCH_WIRE], has_more: false })
      : jsonWire({ ...BATCH_WIRE, processing_status: "canceling" })
  );

  const cancelled = await adapter.rawProxy(
    "/batches/msgbatch_1/cancel",
    new Request("http://internal/x", { method: "POST" }),
  );
  assertEquals(calls[0].url, `${BASE}/messages/batches/msgbatch_1/cancel`);
  assertEquals(calls[0].method, "POST");
  assertEquals((await cancelled.json()).status, "cancelling");

  const listed = await adapter.rawProxy(
    "/batches",
    new Request("http://internal/v1/batches?limit=2&after=msgbatch_0"),
  );
  assertEquals(
    calls[1].url,
    `${BASE}/messages/batches?limit=2&after_id=msgbatch_0`,
  );
  const body = await listed.json();
  assertEquals(body.object, "list");
  assertEquals(body.data[0].id, "msgbatch_1");
});

Deno.test("rawProxy surfaces Anthropic errors as ProviderError with the body preserved", async () => {
  const wire =
    '{"type":"error","error":{"type":"not_found_error","message":"nope"}}';
  const { adapter } = recordingAdapter(() =>
    new Response(wire, { status: 404, statusText: "Not Found" })
  );
  const err = await assertRejects(
    () => adapter.rawProxy("/batches/b404", new Request("http://internal/x")),
    ProviderError,
  );
  assertEquals(err.status, 404);
  assertEquals(err.body, wire);
});

Deno.test("rawProxy rejects unknown passthrough paths", async () => {
  const { adapter, calls } = recordingAdapter(() => jsonWire({}));
  const err = await assertRejects(
    () => adapter.rawProxy("/audio/speech", new Request("http://internal/x")),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assertEquals(calls.length, 0);
});
