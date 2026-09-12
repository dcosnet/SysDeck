import { assertEquals, assertThrows } from "@std/assert";
import { ProviderError } from "./client.ts";
import {
  bareResourceId,
  buildBatchCreateBody,
  decodeBase64ToBytes,
  encodeBytesToBase64,
  geminiBatchStatus,
  geminiFileStatus,
  mapBatchResultLine,
  mapGeminiBatch,
  mapGeminiFile,
  parseGeminiTimestamp,
  qualifyResourceId,
} from "./gemini_advanced.ts";

Deno.test("decodeBase64ToBytes accepts standard, URL-safe, and unpadded input", () => {
  assertEquals(decodeBase64ToBytes("AQIDBA=="), new Uint8Array([1, 2, 3, 4]));
  // Missing padding is restored.
  assertEquals(decodeBase64ToBytes("AQIDBA"), new Uint8Array([1, 2, 3, 4]));
  // URL-safe alphabet ("----" is the URL-safe form of "++++").
  assertEquals(
    decodeBase64ToBytes("----"),
    new Uint8Array([0xfb, 0xef, 0xbe]),
  );
  assertEquals(
    decodeBase64ToBytes("_w"),
    new Uint8Array([0xff]),
  );
});

Deno.test("encodeBytesToBase64 emits standard RFC 4648 base64", () => {
  assertEquals(encodeBytesToBase64(new Uint8Array([1, 2, 3, 4])), "AQIDBA==");
  assertEquals(encodeBytesToBase64(new Uint8Array(0)), "");
  assertEquals(encodeBytesToBase64(new Uint8Array([0xfb, 0xef, 0xbe])), "++++");
});

Deno.test("resource ids round-trip the files/ and batches/ prefixes", () => {
  assertEquals(bareResourceId("files/abc", "files/"), "abc");
  assertEquals(bareResourceId("abc", "files/"), "abc");
  assertEquals(qualifyResourceId("abc", "files/"), "files/abc");
  assertEquals(qualifyResourceId("files/abc", "files/"), "files/abc");
  assertEquals(qualifyResourceId("xyz", "batches/"), "batches/xyz");
});

Deno.test("parseGeminiTimestamp maps RFC3339 to unix seconds, 0 otherwise", () => {
  assertEquals(
    parseGeminiTimestamp("2026-07-16T12:00:00Z"),
    Date.UTC(2026, 6, 16, 12) / 1000,
  );
  assertEquals(parseGeminiTimestamp(""), 0);
  assertEquals(parseGeminiTimestamp(undefined), 0);
  assertEquals(parseGeminiTimestamp("not-a-time"), 0);
});

Deno.test("geminiFileStatus maps native states, lowercasing unknowns", () => {
  assertEquals(geminiFileStatus("PROCESSING"), "processing");
  assertEquals(geminiFileStatus("ACTIVE"), "processed");
  assertEquals(geminiFileStatus("FAILED"), "error");
  assertEquals(geminiFileStatus("SOMETHING_NEW"), "something_new");
  assertEquals(geminiFileStatus(undefined), "");
});

Deno.test("geminiBatchStatus maps native states, passing unknowns through", () => {
  const cases: Array<[string | undefined, string]> = [
    ["BATCH_STATE_PENDING", "in_progress"],
    ["BATCH_STATE_RUNNING", "in_progress"],
    ["BATCH_STATE_SUCCEEDED", "completed"],
    ["BATCH_STATE_FAILED", "failed"],
    ["BATCH_STATE_CANCELLING", "cancelling"],
    ["BATCH_STATE_CANCELLED", "cancelled"],
    ["BATCH_STATE_EXPIRED", "expired"],
    ["BATCH_STATE_UNSPECIFIED", "BATCH_STATE_UNSPECIFIED"],
    [undefined, ""],
  ];
  for (const [state, expected] of cases) {
    assertEquals(geminiBatchStatus(state), expected, String(state));
  }
});

Deno.test("mapGeminiFile strips the prefix and parses the string size", () => {
  const mapped = mapGeminiFile({
    name: "files/abc123",
    displayName: "data.jsonl",
    sizeBytes: "2048",
    createTime: "2026-07-16T00:00:00Z",
    expirationTime: "2026-07-18T00:00:00Z",
    uri: "https://example/files/abc123",
    state: "ACTIVE",
  }, "batch");
  assertEquals(mapped, {
    id: "abc123",
    object: "file",
    bytes: 2048,
    created_at: Date.UTC(2026, 6, 16) / 1000,
    filename: "data.jsonl",
    purpose: "batch",
    status: "processed",
    uri: "https://example/files/abc123",
    expires_at: Date.UTC(2026, 6, 18) / 1000,
  });
});

Deno.test("mapGeminiFile tolerates a sparse file object", () => {
  assertEquals(mapGeminiFile({}, "vision"), {
    id: "",
    object: "file",
    bytes: 0,
    created_at: 0,
    filename: "",
    purpose: "vision",
    status: "",
  });
});

Deno.test("mapGeminiBatch parses string batchStats with Number()", () => {
  const mapped = mapGeminiBatch({
    metadata: {
      name: "batches/xyz",
      state: "BATCH_STATE_SUCCEEDED",
      createTime: "2026-07-16T00:00:00Z",
      inputConfig: { fileName: "files/in-1" },
      batchStats: {
        requestCount: "10",
        pendingRequestCount: "4",
        successfulRequestCount: "5",
      },
    },
    dest: { fileName: "files/out-1" },
  });
  assertEquals(mapped.id, "xyz");
  assertEquals(mapped.object, "batch");
  assertEquals(mapped.status, "completed");
  assertEquals(mapped.input_file_id, "in-1");
  assertEquals(mapped.output_file_id, "out-1");
  assertEquals(mapped.created_at, Date.UTC(2026, 6, 16) / 1000);
  // total 10, completed = 10-4 = 6, failed = 6-5 = 1.
  assertEquals(mapped.request_counts, { total: 10, completed: 6, failed: 1 });
});

Deno.test("mapGeminiBatch omits request_counts without batchStats and honors extras", () => {
  const mapped = mapGeminiBatch(
    { metadata: { name: "batches/xyz", state: "BATCH_STATE_PENDING" } },
    { inputFileId: "in-2", endpoint: "/v1/embeddings" },
  );
  assertEquals(mapped.status, "in_progress");
  assertEquals(mapped.input_file_id, "in-2");
  assertEquals(mapped.endpoint, "/v1/embeddings");
  assertEquals("request_counts" in mapped, false);
});

Deno.test("buildBatchCreateBody: file-based input prefixes files/ and defaults the model", () => {
  const { model, payload } = buildBatchCreateBody({
    input_file_id: "in-1",
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  assertEquals(model, "gemini-2.5-flash");
  const batch = payload.batch as {
    display_name: string;
    input_config: { file_name?: string };
  };
  assertEquals(batch.input_config, { file_name: "files/in-1" });
  assertEquals(batch.display_name.startsWith("frosty-batch-"), true);
});

Deno.test("buildBatchCreateBody: metadata.model wins over body model", () => {
  assertEquals(
    buildBatchCreateBody({
      input_file_id: "in-1",
      model: "gemini-2.0-flash",
      metadata: { model: "gemini-2.5-pro" },
    }).model,
    "gemini-2.5-pro",
  );
  assertEquals(
    buildBatchCreateBody({ input_file_id: "in-1", model: "gemini-2.0-flash" })
      .model,
    "gemini-2.0-flash",
  );
});

Deno.test("buildBatchCreateBody: inline requests map roles and custom_id", () => {
  const { payload } = buildBatchCreateBody({
    requests: [
      {
        custom_id: "a",
        body: {
          model: "gemini-2.5-flash",
          messages: [
            { role: "system", content: "skipped" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "yo" },
          ],
        },
      },
      { body: { messages: [{ role: "user", content: "solo" }] } },
    ],
  });
  const batch = payload.batch as {
    input_config: { requests: { requests: unknown[] } };
  };
  assertEquals(batch.input_config.requests.requests[0], {
    request: {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "yo" }] },
      ],
    },
    metadata: { key: "a" },
  });
  // No custom_id -> no metadata key.
  assertEquals(batch.input_config.requests.requests[1], {
    request: { contents: [{ role: "user", parts: [{ text: "solo" }] }] },
  });
});

Deno.test("buildBatchCreateBody: exactly one of input_file_id/requests", () => {
  const neither = assertThrows(
    () => buildBatchCreateBody({}),
    ProviderError,
  );
  assertEquals(neither.status, 400);
  assertEquals(
    neither.body,
    "either input_file_id or requests must be provided",
  );
  const both = assertThrows(
    () =>
      buildBatchCreateBody({
        input_file_id: "in-1",
        requests: [{ custom_id: "a", body: { messages: [] } }],
      }),
    ProviderError,
  );
  assertEquals(both.status, 400);
  assertEquals(both.body, "cannot specify both input_file_id and requests");
});

Deno.test("mapBatchResultLine maps a successful file line", () => {
  const mapped = mapBatchResultLine({
    key: "a",
    response: {
      candidates: [{
        content: { parts: [{ text: "hello " }, { text: "world" }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      },
    },
  }, 0);
  assertEquals(mapped, {
    custom_id: "a",
    response: {
      status_code: 200,
      body: {
        text: "hello world",
        finish_reason: "STOP",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    },
  });
});

Deno.test("mapBatchResultLine maps errors and falls back to request-<i>", () => {
  assertEquals(
    mapBatchResultLine({ error: { code: 429, message: "rate limited" } }, 3),
    { custom_id: "request-3", error: { code: "429", message: "rate limited" } },
  );
  // Inline responses carry the id in metadata.key.
  assertEquals(
    mapBatchResultLine({
      metadata: { key: "inline-1" },
      response: { candidates: [{ content: { parts: [] } }] },
    }, 0),
    {
      custom_id: "inline-1",
      response: { status_code: 200, body: { finish_reason: "" } },
    },
  );
});
