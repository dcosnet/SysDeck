import { assert, assertEquals, assertRejects } from "@std/assert";
import { BedrockAdapter } from "./bedrock.ts";
import { ProviderError } from "./client.ts";
import { encodeEventStreamMessage } from "./eventstream.ts";
import { AwsCredentialProvider } from "./aws_credentials.ts";
import { readSSE } from "../../testing/src/mod.ts";

const creds = {
  region: "us-east-1",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  endpoint: "http://mock",
};

const jsonEnc = new TextEncoder();

/** Builds a Bedrock converse-stream event frame (valid CRCs). */
function streamFrame(
  eventType: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Uint8Array {
  return encodeEventStreamMessage(
    {
      ":message-type": "event",
      ":event-type": eventType,
      ":content-type": "application/json",
      ...headers,
    },
    jsonEnc.encode(JSON.stringify(payload)),
  );
}

/** Concatenates frames into one response-body byte array. */
function concatFrames(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** Wraps raw eventstream bytes in a streaming Response (mocks Bedrock's body). */
function streamResponse(bytes: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: {} },
  },
};

Deno.test("BedrockAdapter maps tools, tool_calls and tool results into Converse toolConfig", async () => {
  let body: {
    toolConfig?: {
      tools: Array<{ toolSpec: { name: string; inputSchema: unknown } }>;
      toolChoice?: unknown;
    };
    messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  } = {};
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          output: { message: { content: [{ text: "ok" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.chatCompletions({
    model: "anthropic.claude-3-sonnet",
    messages: [
      { role: "user", content: "weather in Oslo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tu1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
        }],
      },
      { role: "tool", tool_call_id: "tu1", content: '{"temp":21}' },
    ],
    tools: [weatherTool],
    tool_choice: "auto",
  });
  await res.body?.cancel();

  assertEquals(body.toolConfig?.tools[0].toolSpec.name, "get_weather");
  assertEquals(body.toolConfig?.tools[0].toolSpec.inputSchema, {
    json: { type: "object", properties: {} },
  });
  assertEquals(body.toolConfig?.toolChoice, { auto: {} });
  // Assistant tool call -> toolUse content block.
  assertEquals(body.messages?.[1].content[0], {
    toolUse: { toolUseId: "tu1", name: "get_weather", input: { city: "Oslo" } },
  });
  // Tool result -> user turn with a toolResult block (JSON parsed to an object).
  assertEquals(body.messages?.[2].role, "user");
  assertEquals(body.messages?.[2].content[0], {
    toolResult: {
      toolUseId: "tu1",
      content: [{ json: { temp: 21 } }],
      status: "success",
    },
  });
});

Deno.test("BedrockAdapter parses Converse toolUse blocks into OpenAI tool_calls", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          output: {
            message: {
              content: [
                { text: "Let me check" },
                {
                  toolUse: {
                    toolUseId: "tu9",
                    name: "get_weather",
                    input: { city: "Oslo" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.chatCompletions({
    model: "anthropic.claude-3-sonnet",
    messages: [{ role: "user", content: "weather?" }],
    tools: [weatherTool],
  });
  const chat = await res.json() as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<
          { id: string; function: { name: string; arguments: string } }
        >;
      };
      finish_reason: string;
    }>;
  };

  assertEquals(chat.choices[0].finish_reason, "tool_calls");
  assertEquals(chat.choices[0].message.content, "Let me check");
  const call = chat.choices[0].message.tool_calls![0];
  assertEquals(call.id, "tu9");
  assertEquals(call.function.name, "get_weather");
  assertEquals(JSON.parse(call.function.arguments), { city: "Oslo" });
});

// --- converse-stream (binary eventstream) -----------------------------------

Deno.test("BedrockAdapter streams converse-stream frames as canonical SSE chunks", async () => {
  let url = "";
  let sentBody: { messages?: unknown } = {};
  const body = concatFrames(
    streamFrame("messageStart", { role: "assistant" }),
    streamFrame("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: "Hello" },
    }),
    streamFrame("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: " there" },
    }),
    streamFrame("contentBlockStop", { contentBlockIndex: 0 }),
    streamFrame("contentBlockStart", {
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: "tu1", name: "get_weather" } },
    }),
    streamFrame("contentBlockDelta", {
      contentBlockIndex: 1,
      delta: { toolUse: { input: '{"city":' } },
    }),
    streamFrame("contentBlockDelta", {
      contentBlockIndex: 1,
      delta: { toolUse: { input: '"Oslo"}' } },
    }),
    streamFrame("contentBlockStop", { contentBlockIndex: 1 }),
    streamFrame("messageStop", { stopReason: "tool_use" }),
    streamFrame("metadata", {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  );
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    sentBody = JSON.parse(String(init?.body));
    return Promise.resolve(streamResponse(body));
  }) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.chatCompletions({
    model: "anthropic.claude-3-sonnet",
    messages: [{ role: "user", content: "weather in Oslo?" }],
    stream: true,
  });

  assertEquals(res.headers.get("Content-Type"), "text/event-stream");
  assert(url.endsWith("/model/anthropic.claude-3-sonnet/converse-stream"));
  // Streaming reuses the identical converse request body.
  assert(Array.isArray(sentBody.messages));

  const events = await readSSE(res) as Array<
    | {
      choices: Array<{
        delta: {
          role?: string;
          content?: string;
          tool_calls?: Array<
            {
              index: number;
              id?: string;
              function: { name?: string; arguments: string };
            }
          >;
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    }
    | "[DONE]"
  >;

  // 8 canonical chunks + [DONE] (the two contentBlockStop events emit nothing).
  assertEquals(events.length, 9);
  assertEquals(events.at(-1), "[DONE]");

  const first = events[0] as {
    choices: Array<{ delta: { role: string; content: string } }>;
  };
  assertEquals(first.choices[0].delta.role, "assistant");
  assertEquals(first.choices[0].delta.content, "");

  const text = (events[1] as { choices: Array<{ delta: { content: string } }> })
    .choices[0].delta.content +
    (events[2] as { choices: Array<{ delta: { content: string } }> })
      .choices[0].delta.content;
  assertEquals(text, "Hello there");

  const toolStart = (events[3] as {
    choices: Array<{ delta: { tool_calls: Array<Record<string, unknown>> } }>;
  }).choices[0].delta.tool_calls[0];
  assertEquals(toolStart, {
    index: 0,
    id: "tu1",
    type: "function",
    function: { name: "get_weather", arguments: "" },
  });

  const args = (events[4] as {
    choices: Array<
      { delta: { tool_calls: Array<{ function: { arguments: string } }> } }
    >;
  }).choices[0].delta.tool_calls[0].function.arguments +
    (events[5] as {
      choices: Array<
        { delta: { tool_calls: Array<{ function: { arguments: string } }> } }
      >;
    }).choices[0].delta.tool_calls[0].function.arguments;
  assertEquals(JSON.parse(args), { city: "Oslo" });

  // messageStop -> tool_calls finish_reason.
  assertEquals(
    (events[6] as { choices: Array<{ finish_reason: string }> }).choices[0]
      .finish_reason,
    "tool_calls",
  );
  // metadata -> usage tail with empty choices (governance parses this).
  const usageChunk = events[7] as {
    choices: unknown[];
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  assertEquals(usageChunk.choices, []);
  assertEquals(usageChunk.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

Deno.test("BedrockAdapter converse-stream: an exception frame errors the stream", async () => {
  const body = concatFrames(
    streamFrame("messageStart", { role: "assistant" }),
    encodeEventStreamMessage(
      {
        ":message-type": "exception",
        ":exception-type": "throttlingException",
        ":content-type": "application/json",
      },
      jsonEnc.encode(JSON.stringify({ message: "slow down" })),
    ),
  );
  const fetchImpl =
    (() => Promise.resolve(streamResponse(body))) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.chatCompletions({
    model: "anthropic.claude-3-sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  await assertRejects(() => res.text());
});

// --- embeddings via InvokeModel (:invoke) -----------------------------------

Deno.test("BedrockAdapter.embeddings (Titan) fans a batch out to one invoke per text", async () => {
  const calls: Array<{ url: string; body: { inputText?: string } }> = [];
  const vectors: Record<string, number[]> = {
    hello: [0.1, 0.2],
    world: [0.3, 0.4],
  };
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { inputText: string };
    calls.push({ url: String(input), body: parsed });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          embedding: vectors[parsed.inputText],
          inputTextTokenCount: parsed.inputText.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.embeddings({
    model: "amazon.titan-embed-text-v2:0",
    input: ["hello", "world"],
  });
  const json = await res.json() as {
    object: string;
    data: Array<{ object: string; index: number; embedding: number[] }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  assertEquals(calls.length, 2);
  assert(
    calls[0].url.endsWith("/model/amazon.titan-embed-text-v2%3A0/invoke"),
    calls[0].url,
  );
  assertEquals(calls[0].body, { inputText: "hello" });
  assertEquals(calls[1].body, { inputText: "world" });
  assertEquals(json.object, "list");
  assertEquals(json.data[0], {
    object: "embedding",
    index: 0,
    embedding: [0.1, 0.2],
  });
  assertEquals(json.data[1], {
    object: "embedding",
    index: 1,
    embedding: [0.3, 0.4],
  });
  // Token counts sum across the fanned-out invokes ("hello"=5 + "world"=5).
  assertEquals(json.usage, { prompt_tokens: 10, total_tokens: 10 });
});

Deno.test("BedrockAdapter.embeddings (Cohere) sends one batched invoke with input_type", async () => {
  let url = "";
  let body: { texts?: string[]; input_type?: string; truncate?: string } = {};
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.embeddings({
    model: "cohere.embed-english-v3",
    input: ["a", "b"],
  });
  const json = await res.json() as {
    data: Array<{ index: number; embedding: number[] }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  assert(url.endsWith("/model/cohere.embed-english-v3/invoke"), url);
  assertEquals(body, {
    texts: ["a", "b"],
    input_type: "search_document",
    truncate: "END",
  });
  assertEquals(json.data.map((d) => d.embedding), [[0.1, 0.2], [0.3, 0.4]]);
  // Cohere-on-Bedrock reports no token counts.
  assertEquals(json.usage, { prompt_tokens: 0, total_tokens: 0 });
});

Deno.test("BedrockAdapter.embeddings (Cohere) accepts the {embeddings:{float:...}} shape", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ embeddings: { float: [[1, 2], [3, 4]] } }),
        { headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });
  const res = await adapter.embeddings({
    model: "cohere.embed-multilingual-v3",
    input: ["x", "y"],
  });
  const json = await res.json() as {
    data: Array<{ embedding: number[] }>;
  };
  assertEquals(json.data.map((d) => d.embedding), [[1, 2], [3, 4]]);
});

// --- credential chain feeding SigV4 (static keys absent) --------------------

Deno.test("BedrockAdapter without static keys signs with the credential provider chain", async () => {
  let auth: string | null = null;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("Authorization");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          output: { message: { content: [{ text: "ok" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  // No static keys; the chain resolves env credentials from a mocked env.
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: "AKIAENVCHAIN",
    AWS_SECRET_ACCESS_KEY: "envsecret",
    AWS_SESSION_TOKEN: "envsession",
  };
  const credentialProvider = new AwsCredentialProvider({
    region: "us-east-1",
    env: (n) => env[n],
  });
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    endpoint: "http://mock",
    fetchImpl,
    credentialProvider,
  });

  const res = await adapter.chatCompletions({
    model: "anthropic.claude-3-sonnet",
    messages: [{ role: "user", content: "hi" }],
  });
  await res.body?.cancel();

  assert(auth, "expected a signed Authorization header");
  // The env-chain access key id flows into the SigV4 Credential scope.
  assert(
    (auth as string).includes("Credential=AKIAENVCHAIN/"),
    auth as string,
  );
});

// --- rawProxy: batches as Model Invocation Jobs + files on S3 ----------------

interface ProxyCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Mock fetch that records calls and routes them through `handler`. */
function proxyFetch(
  handler: (url: string, method: string) => Response,
): { calls: ProxyCall[]; fetchImpl: typeof fetch } {
  const calls: ProxyCall[] = [];
  const decoder = new TextDecoder();
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
      ? decoder.decode(init.body)
      : "";
    calls.push({ url, method, headers: new Headers(init?.headers), body });
    return Promise.resolve(handler(url, method));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const JOB_ARN = "arn:aws:bedrock:us-east-1:123:model-invocation-job/j1";

const hydratedJob = {
  jobArn: JOB_ARN,
  status: "Submitted",
  jobName: "frosty-batch-1",
  modelId: "anthropic.claude-3",
  inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://out-bucket/in.jsonl" } },
  outputDataConfig: {
    s3OutputDataConfig: { s3Uri: "s3://out-bucket/results" },
  },
  submitTime: "2026-07-16T10:00:00Z",
};

Deno.test("BedrockAdapter batch create (inline) uploads JSONL then creates + hydrates", async () => {
  const { calls, fetchImpl } = proxyFetch((url, method) => {
    if (method === "PUT" && url.includes("/bifrost-batch-input/")) {
      return new Response("", { status: 200 });
    }
    if (method === "POST" && url.endsWith("/model-invocation-job")) {
      return new Response(JSON.stringify({ jobArn: JOB_ARN }), {
        status: 201,
      });
    }
    if (url.includes("manifest.json.out")) {
      return new Response("not found", { status: 404 });
    }
    if (method === "GET" && url.includes("/model-invocation-job/")) {
      return new Response(JSON.stringify(hydratedJob), { status: 200 });
    }
    throw new Error(`unexpected call: ${method} ${url}`);
  });
  const adapter = new BedrockAdapter({
    ...creds,
    batchRoleArn: "arn:aws:iam::123:role/config-role",
    batchOutputS3Uri: "s3://out-bucket/results",
    fetchImpl,
  });

  const res = await adapter.rawProxy(
    "/batches",
    new Request("http://internal/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic.claude-3",
        completion_window: "24h",
        role_arn: "arn:aws:iam::123:role/override-role",
        requests: [
          {
            custom_id: "r1",
            body: {
              model: "stripped",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 5,
            },
          },
        ],
      }),
    }),
  );
  const json = await res.json() as Record<string, unknown>;

  // 1) Inline requests became JSONL PUT into the output URI's bucket.
  const put = calls[0];
  assertEquals(put.method, "PUT");
  assert(
    put.url.startsWith(
      "https://out-bucket.s3.us-east-1.amazonaws.com/bifrost-batch-input/frosty-batch-",
    ),
    put.url,
  );
  assert(put.url.endsWith(".jsonl"), put.url);
  assertEquals(put.headers.get("content-type"), "application/jsonl");
  assertEquals(
    put.body,
    '{"recordId":"r1","modelInput":{"modelId":"anthropic.claude-3",' +
      '"messages":[{"role":"user","content":"hi"}],"max_tokens":5}}\n',
  );

  // 2) Control-plane create: body override beats the config role ARN.
  const create = calls[1];
  assertEquals(create.method, "POST");
  assertEquals(
    create.url,
    "https://bedrock.us-east-1.amazonaws.com/model-invocation-job",
  );
  const createBody = JSON.parse(create.body) as Record<string, unknown>;
  assertEquals(createBody.roleArn, "arn:aws:iam::123:role/override-role");
  assertEquals(createBody.modelId, "anthropic.claude-3");
  assertEquals(createBody.timeoutDurationInHours, 24);
  assert(String(createBody.jobName).startsWith("frosty-batch-"));
  const inputCfg = createBody.inputDataConfig as {
    s3InputDataConfig: { s3Uri: string; s3InputFormat: string };
  };
  assert(
    inputCfg.s3InputDataConfig.s3Uri.startsWith(
      "s3://out-bucket/bifrost-batch-input/",
    ),
    inputCfg.s3InputDataConfig.s3Uri,
  );
  assertEquals(inputCfg.s3InputDataConfig.s3InputFormat, "JSONL");
  assertEquals(createBody.outputDataConfig, {
    s3OutputDataConfig: { s3Uri: "s3://out-bucket/results" },
  });

  // 3) Hydration retrieve ran against the encoded ARN.
  const hydrate = calls[2];
  assertEquals(
    hydrate.url,
    `https://bedrock.us-east-1.amazonaws.com/model-invocation-job/${
      encodeURIComponent(JOB_ARN)
    }`,
  );

  assertEquals(json.id, JOB_ARN);
  assertEquals(json.object, "batch");
  assertEquals(json.status, "validating");
  assertEquals(json.request_counts, undefined); // manifest 404 -> no counts
});

Deno.test("BedrockAdapter batch create with input_file_id skips the S3 upload", async () => {
  const { calls, fetchImpl } = proxyFetch((url, method) => {
    if (method === "POST" && url.endsWith("/model-invocation-job")) {
      return new Response(JSON.stringify({ jobArn: JOB_ARN }), { status: 200 });
    }
    // Hydration retrieve fails -> minimal fallback object.
    return new Response("boom", { status: 500 });
  });
  const adapter = new BedrockAdapter({
    ...creds,
    batchRoleArn: "arn:aws:iam::123:role/config-role",
    batchOutputS3Uri: "s3://out-bucket/results",
    fetchImpl,
  });

  const res = await adapter.rawProxy(
    "/batches",
    new Request("http://internal/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // R1: input_file_id must reference an allowed bucket (here out-bucket,
      // the configured batchOutputS3Uri bucket — the natural home for inputs
      // uploaded via POST /v1/files).
      body: JSON.stringify({ input_file_id: "s3://out-bucket/batch.jsonl" }),
    }),
  );
  const json = await res.json() as Record<string, unknown>;

  assertEquals(calls[0].method, "POST"); // first call is the create, no PUT
  const createBody = JSON.parse(calls[0].body) as {
    inputDataConfig: { s3InputDataConfig: { s3Uri: string } };
    roleArn: string;
  };
  assertEquals(
    createBody.inputDataConfig.s3InputDataConfig.s3Uri,
    "s3://out-bucket/batch.jsonl",
  );
  assertEquals(createBody.roleArn, "arn:aws:iam::123:role/config-role");
  // Hydrate failed -> minimal fallback (Go parity).
  assertEquals(json, {
    id: JOB_ARN,
    object: "batch",
    status: "validating",
    input_file_id: "s3://out-bucket/batch.jsonl",
  });
});

Deno.test("BedrockAdapter batch create 400s naming the missing config field", async () => {
  const fetchImpl = (() => {
    throw new Error("no network expected");
  }) as unknown as typeof fetch;

  const noRole = new BedrockAdapter({ ...creds, fetchImpl });
  const roleErr = await assertRejects(
    () =>
      noRole.rawProxy(
        "/batches",
        new Request("http://internal/batches", {
          method: "POST",
          body: JSON.stringify({ input_file_id: "s3://b/k" }),
        }),
      ),
    ProviderError,
  );
  assertEquals(roleErr.status, 400);
  assert(roleErr.body.includes("awsBatchRoleArn"), roleErr.body);

  const noOutput = new BedrockAdapter({
    ...creds,
    batchRoleArn: "arn:aws:iam::123:role/r",
    fetchImpl,
  });
  const outErr = await assertRejects(
    () =>
      noOutput.rawProxy(
        "/batches",
        new Request("http://internal/batches", {
          method: "POST",
          body: JSON.stringify({ input_file_id: "s3://b/k" }),
        }),
      ),
    ProviderError,
  );
  assertEquals(outErr.status, 400);
  assert(outErr.body.includes("awsBatchOutputS3Uri"), outErr.body);
});

Deno.test("BedrockAdapter batch retrieve merges manifest counts from S3", async () => {
  const { calls, fetchImpl } = proxyFetch((url) => {
    if (url.includes("manifest.json.out")) {
      return new Response(
        JSON.stringify({
          totalRecordCount: 10,
          processedRecordCount: 8,
          errorRecordCount: 2,
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ ...hydratedJob, status: "Completed" }),
      { status: 200 },
    );
  });
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.rawProxy(
    `/batches/${encodeURIComponent(JOB_ARN)}`,
    new Request(
      `http://internal/batches/${encodeURIComponent(JOB_ARN)}`,
    ),
  );
  const json = await res.json() as Record<string, unknown>;

  assertEquals(
    calls[1].url,
    "https://out-bucket.s3.us-east-1.amazonaws.com/results/manifest.json.out",
  );
  assertEquals(json.status, "completed");
  assertEquals(json.request_counts, { total: 10, completed: 6, failed: 2 });
  assertEquals(json.output_file_id, "s3://out-bucket/results");
});

Deno.test("BedrockAdapter batch list maps limit/after and the nextToken cursor", async () => {
  const { calls, fetchImpl } = proxyFetch(() =>
    new Response(
      JSON.stringify({
        invocationJobSummaries: [
          {
            jobArn: JOB_ARN,
            jobName: "frosty-batch-1",
            modelId: "anthropic.claude-3",
            status: "InProgress",
            submitTime: "2026-07-16T10:00:00Z",
          },
        ],
        nextToken: "tok-2",
      }),
      { status: 200 },
    )
  );
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.rawProxy(
    "/batches",
    new Request("http://internal/batches?limit=2&after=tok-1"),
  );
  const json = await res.json() as {
    object: string;
    data: Array<Record<string, unknown>>;
    has_more: boolean;
    last_id?: string;
  };

  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/model-invocation-jobs");
  assertEquals(url.searchParams.get("maxResults"), "2");
  assertEquals(url.searchParams.get("nextToken"), "tok-1");
  assertEquals(json.object, "list");
  assertEquals(json.data[0].id, JOB_ARN);
  assertEquals(json.data[0].status, "in_progress");
  assertEquals(json.has_more, true);
  assertEquals(json.last_id, "tok-2");
});

Deno.test("BedrockAdapter batch cancel stops the job, tolerating a failed re-retrieve", async () => {
  const { calls, fetchImpl } = proxyFetch((url, method) => {
    if (method === "POST" && url.endsWith("/stop")) {
      return new Response("{}", { status: 200 });
    }
    return new Response("boom", { status: 500 });
  });
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.rawProxy(
    `/batches/${encodeURIComponent(JOB_ARN)}/cancel`,
    new Request(
      `http://internal/batches/${encodeURIComponent(JOB_ARN)}/cancel`,
      { method: "POST" },
    ),
  );
  const json = await res.json();

  assertEquals(
    calls[0].url,
    `https://bedrock.us-east-1.amazonaws.com/model-invocation-job/${
      encodeURIComponent(JOB_ARN)
    }/stop`,
  );
  assertEquals(json, { id: JOB_ARN, object: "batch", status: "cancelling" });
});

Deno.test("BedrockAdapter batch results aggregates .jsonl.out objects from S3", async () => {
  const listXml = `<ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>results/manifest.json.out</Key><Size>10</Size></Contents>
<Contents><Key>results/records.jsonl.out</Key><Size>100</Size></Contents>
<Contents><Key>results/notes.txt</Key><Size>5</Size></Contents>
</ListBucketResult>`;
  const outputLines = '{"recordId":"a","modelOutput":{"content":"ok"}}\n' +
    '{"recordId":"b","error":{"errorCode":424,"errorMessage":"boom"}}\n';
  const { calls, fetchImpl } = proxyFetch((url) => {
    if (url.includes("/model-invocation-job/")) {
      return new Response(
        JSON.stringify({ ...hydratedJob, status: "Completed" }),
        { status: 200 },
      );
    }
    if (url.includes("?list-type=2")) {
      return new Response(listXml, { status: 200 });
    }
    if (url.includes("manifest.json.out")) {
      return new Response("not found", { status: 404 });
    }
    if (url.endsWith("/results/records.jsonl.out")) {
      return new Response(outputLines, { status: 200 });
    }
    throw new Error(`unexpected call: ${url}`);
  });
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.rawProxy(
    `/batches/${encodeURIComponent(JOB_ARN)}/results`,
    new Request(
      `http://internal/batches/${encodeURIComponent(JOB_ARN)}/results`,
    ),
  );

  assertEquals(res.headers.get("Content-Type"), "application/jsonl");
  const lines = (await res.text()).trimEnd().split("\n").map((l) =>
    JSON.parse(l)
  );
  assertEquals(lines, [
    { custom_id: "a", response: { status_code: 200, body: { content: "ok" } } },
    {
      custom_id: "b",
      error: { code: "424", message: "boom" },
      response: { status_code: 424 },
    },
  ]);
  // The list call scoped to the output prefix; notes.txt was never fetched.
  const listCall = calls.find((c) => c.url.includes("?list-type=2"))!;
  assertEquals(new URL(listCall.url).searchParams.get("prefix"), "results");
  assert(!calls.some((c) => c.url.includes("notes.txt")));
});

Deno.test("BedrockAdapter batch results falls back to a direct GET when listing fails", async () => {
  const { calls, fetchImpl } = proxyFetch((url) => {
    if (url.includes("/model-invocation-job/")) {
      return new Response(
        JSON.stringify({ ...hydratedJob, status: "Completed" }),
        { status: 200 },
      );
    }
    if (url.includes("?list-type=2")) {
      return new Response("denied", { status: 403 });
    }
    if (url.endsWith("/results")) {
      return new Response(
        '{"recordId":"only","modelOutput":{"v":1}}\n',
        { status: 200 },
      );
    }
    throw new Error(`unexpected call: ${url}`);
  });
  const adapter = new BedrockAdapter({ ...creds, fetchImpl });

  const res = await adapter.rawProxy(
    `/batches/${encodeURIComponent(JOB_ARN)}/results`,
    new Request(
      `http://internal/batches/${encodeURIComponent(JOB_ARN)}/results`,
    ),
  );
  const lines = (await res.text()).trimEnd().split("\n");
  assertEquals(JSON.parse(lines[0]).custom_id, "only");
  // Direct fallback hit the output URI itself.
  assert(
    calls.some((c) =>
      c.url === "https://out-bucket.s3.us-east-1.amazonaws.com/results" &&
      c.method === "GET"
    ),
  );
});

Deno.test("BedrockAdapter file upload PUTs into the merged bucket/prefix", async () => {
  const { calls, fetchImpl } = proxyFetch(() =>
    new Response("", { status: 200 })
  );
  const adapter = new BedrockAdapter({
    ...creds,
    s3Bucket: "s3://files-bucket/base/",
    s3Prefix: "in",
    fetchImpl,
  });

  const form = new FormData();
  form.append(
    "file",
    new File(['{"x":1}'], "data.jsonl", { type: "application/jsonl" }),
  );
  form.append("purpose", "batch");
  const res = await adapter.rawProxy(
    "/files",
    new Request("http://internal/files", { method: "POST", body: form }),
  );
  const json = await res.json() as Record<string, unknown>;

  assertEquals(calls[0].method, "PUT");
  assertEquals(
    calls[0].url,
    "https://files-bucket.s3.us-east-1.amazonaws.com/base/in/data.jsonl",
  );
  assertEquals(
    calls[0].headers.get("content-type"),
    "application/octet-stream",
  );
  assert(calls[0].headers.get("x-amz-content-sha256"));
  assertEquals(json.id, "s3://files-bucket/base/in/data.jsonl");
  assertEquals(json.object, "file");
  assertEquals(json.bytes, 7);
  assertEquals(json.filename, "data.jsonl");
  assertEquals(json.purpose, "batch");
  assertEquals(json.status, "processed");
});

Deno.test("BedrockAdapter file list ?bucket= selects an allowed bucket", async () => {
  const { calls, fetchImpl } = proxyFetch(() =>
    new Response(
      `<ListBucketResult><IsTruncated>true</IsTruncated>
<NextContinuationToken>tok-9</NextContinuationToken>
<Contents><Key>qp/a.jsonl</Key><Size>3</Size>
<LastModified>2026-07-16T10:00:00Z</LastModified></Contents>
</ListBucketResult>`,
      { status: 200 },
    )
  );
  // R1: ?bucket= may only pick a bucket already on the account allowlist
  // (awsS3Bucket / awsBatchOutputS3Uri). query-bucket is the batch-output one.
  const adapter = new BedrockAdapter({
    ...creds,
    s3Bucket: "config-bucket",
    batchOutputS3Uri: "s3://query-bucket/out",
    fetchImpl,
  });

  const res = await adapter.rawProxy(
    "/files",
    new Request(
      "http://internal/files?bucket=query-bucket&prefix=qp&limit=2&after=tok-8",
    ),
  );
  const json = await res.json() as {
    data: Array<Record<string, unknown>>;
    has_more: boolean;
    last_id?: string;
  };

  const url = new URL(calls[0].url);
  assertEquals(url.host, "query-bucket.s3.us-east-1.amazonaws.com");
  assertEquals(url.searchParams.get("prefix"), "qp");
  assertEquals(url.searchParams.get("max-keys"), "2");
  assertEquals(url.searchParams.get("continuation-token"), "tok-8");
  assertEquals(json.data[0], {
    id: "s3://query-bucket/qp/a.jsonl",
    object: "file",
    bytes: 3,
    created_at: 1784196000,
    filename: "a.jsonl",
    purpose: "batch",
    status: "processed",
  });
  assertEquals(json.has_more, true);
  assertEquals(json.last_id, "tok-9");
});

Deno.test("BedrockAdapter rejects an off-allowlist ?bucket= (confused-deputy)", async () => {
  let fetched = false;
  const adapter = new BedrockAdapter({
    ...creds,
    s3Bucket: "config-bucket",
    fetchImpl: (() => {
      fetched = true;
      return Promise.resolve(new Response("nope"));
    }) as typeof fetch,
  });
  const err = await assertRejects(
    () =>
      adapter.rawProxy(
        "/files",
        new Request("http://internal/files?bucket=attacker-bucket"),
      ),
    ProviderError,
  );
  assertEquals((err as ProviderError).status, 400);
  assert(!fetched, "an off-allowlist bucket must never reach S3");
});

Deno.test("BedrockAdapter rejects an off-allowlist s3:// file id", async () => {
  const adapter = new BedrockAdapter({
    ...creds,
    s3Bucket: "config-bucket",
    fetchImpl: (() => Promise.resolve(new Response("nope"))) as typeof fetch,
  });
  const evilId = encodeURIComponent("s3://attacker-bucket/secret.jsonl");
  await assertRejects(
    () =>
      adapter.rawProxy(
        `/files/${evilId}`,
        new Request(`http://internal/files/${evilId}`),
      ),
    ProviderError,
  );
});

Deno.test("BedrockAdapter file retrieve/content/delete round-trip encoded s3:// ids", async () => {
  const fileId = "s3://files-bucket/base/in/data.jsonl";
  const encoded = encodeURIComponent(fileId);
  const { calls, fetchImpl } = proxyFetch((_url, method) => {
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "42",
          "last-modified": "Thu, 16 Jul 2026 10:00:00 GMT",
        },
      });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("hello-bytes", {
      status: 200,
      headers: { "content-type": "application/jsonl" },
    });
  });
  const adapter = new BedrockAdapter({
    ...creds,
    s3Bucket: "files-bucket",
    fetchImpl,
  });

  // Retrieve (HEAD).
  const meta = await adapter.rawProxy(
    `/files/${encoded}`,
    new Request(`http://internal/files/${encoded}`),
  );
  assertEquals(await meta.json(), {
    id: fileId,
    object: "file",
    bytes: 42,
    created_at: 1784196000,
    filename: "data.jsonl",
    purpose: "batch",
    status: "processed",
  });

  // Content (GET) propagates the upstream Content-Type.
  const content = await adapter.rawProxy(
    `/files/${encoded}/content`,
    new Request(`http://internal/files/${encoded}/content`),
  );
  assertEquals(content.headers.get("Content-Type"), "application/jsonl");
  assertEquals(await content.text(), "hello-bytes");

  // Delete (204 -> deleted:true).
  const deleted = await adapter.rawProxy(
    `/files/${encoded}`,
    new Request(`http://internal/files/${encoded}`, { method: "DELETE" }),
  );
  assertEquals(await deleted.json(), {
    id: fileId,
    object: "file",
    deleted: true,
  });

  // Every S3 call decoded the id into the virtual-hosted URL.
  for (const call of calls) {
    assert(
      call.url.startsWith(
        "https://files-bucket.s3.us-east-1.amazonaws.com/base/in/data.jsonl",
      ),
      call.url,
    );
  }
});

Deno.test("BedrockAdapter files 400 without a bucket, naming awsS3Bucket", async () => {
  const adapter = new BedrockAdapter({
    ...creds,
    fetchImpl: (() => {
      throw new Error("no network expected");
    }) as unknown as typeof fetch,
  });
  const err = await assertRejects(
    () => adapter.rawProxy("/files", new Request("http://internal/files")),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("awsS3Bucket"), err.body);
});

Deno.test("BedrockAdapter rawProxy rejects unsupported paths and control errors", async () => {
  const adapter = new BedrockAdapter({
    ...creds,
    fetchImpl: (() =>
      Promise.resolve(
        new Response(
          '{"__type":"ResourceNotFoundException","message":"job not found"}',
          { status: 404, statusText: "Not Found" },
        ),
      )) as typeof fetch,
  });

  const pathErr = await assertRejects(
    () =>
      adapter.rawProxy(
        "/audio/speech",
        new Request("http://internal/audio/speech", { method: "POST" }),
      ),
    ProviderError,
  );
  assertEquals(pathErr.status, 400);

  // Control-plane {__type,message} bodies surface the message.
  const jobErr = await assertRejects(
    () =>
      adapter.rawProxy(
        `/batches/${encodeURIComponent(JOB_ARN)}`,
        new Request(
          `http://internal/batches/${encodeURIComponent(JOB_ARN)}`,
        ),
      ),
    ProviderError,
  );
  assertEquals(jobErr.status, 404);
  assertEquals(jobErr.body, "job not found");
});
