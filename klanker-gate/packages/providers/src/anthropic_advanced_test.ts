import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  anthropicBatchStatus,
  buildBatchRequests,
  isoToUnix,
  mapAnthropicBatch,
  mapAnthropicFile,
  mapBatchResultLine,
} from "./anthropic_advanced.ts";
import { ProviderError } from "./client.ts";
import {
  BatchStatusSchema,
  FileObjectSchema,
} from "../../contracts/src/mod.ts";

Deno.test("anthropicBatchStatus maps canceling and keeps ended verbatim", () => {
  assertEquals(anthropicBatchStatus("in_progress"), "in_progress");
  assertEquals(anthropicBatchStatus("canceling"), "cancelling");
  // `ended` is deliberately NOT coerced to an OpenAI status (Go parity); the
  // widened BatchStatusSchema accepts it.
  assertEquals(anthropicBatchStatus("ended"), "ended");
  assert(BatchStatusSchema.safeParse(anthropicBatchStatus("ended")).success);
  assertEquals(
    anthropicBatchStatus("some_future_status"),
    "some_future_status",
  );
});

Deno.test("isoToUnix parses RFC3339 and RFC3339Nano, 0 otherwise", () => {
  assertEquals(isoToUnix("2020-01-01T00:00:00Z"), 1577836800);
  assertEquals(isoToUnix("2020-01-01T00:00:00.123456789Z"), 1577836800);
  assertEquals(isoToUnix(""), 0);
  assertEquals(isoToUnix(undefined), 0);
  assertEquals(isoToUnix(null), 0);
  assertEquals(isoToUnix("not-a-timestamp"), 0);
});

Deno.test("mapAnthropicBatch maps counts arithmetic and timestamps", () => {
  const mapped = mapAnthropicBatch({
    id: "msgbatch_1",
    type: "message_batch",
    processing_status: "ended",
    request_counts: {
      processing: 1,
      succeeded: 2,
      errored: 3,
      canceled: 4,
      expired: 5,
    },
    created_at: "2020-01-01T00:00:00Z",
    expires_at: "2020-01-02T00:00:00Z",
    ended_at: "2020-01-01T12:00:00Z",
    cancel_initiated_at: "2020-01-01T06:00:00Z",
    results_url:
      "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
  });

  assertEquals(mapped.id, "msgbatch_1");
  assertEquals(mapped.object, "batch");
  assertEquals(mapped.status, "ended");
  assertEquals(mapped.processing_status, "ended");
  assertEquals(mapped.created_at, 1577836800);
  assertEquals(mapped.expires_at, 1577923200);
  assertEquals(mapped.completed_at, 1577880000);
  assertEquals(mapped.cancelling_at, 1577858400);
  assertEquals(mapped.request_counts, { total: 15, completed: 2, failed: 3 });
  assertEquals(
    mapped.results_url,
    "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
  );
});

Deno.test("mapAnthropicBatch omits absent/unparseable timestamps and counts", () => {
  const mapped = mapAnthropicBatch({
    id: "msgbatch_2",
    type: "message_batch",
    processing_status: "in_progress",
    created_at: "garbage",
  });
  assertEquals(mapped.status, "in_progress");
  assertEquals(mapped.created_at, 0); // always emitted (Go parity)
  assert(!("expires_at" in mapped));
  assert(!("completed_at" in mapped));
  assert(!("cancelling_at" in mapped));
  assert(!("request_counts" in mapped));
  assert(!("results_url" in mapped));
});

Deno.test("mapAnthropicFile produces a schema-valid OpenAI FileObject", () => {
  const mapped = mapAnthropicFile({
    id: "file_1",
    type: "file",
    filename: "input.jsonl",
    mime_type: "application/jsonl",
    size_bytes: 42,
    created_at: "2020-01-01T00:00:00Z",
    downloadable: true,
  });
  const parsed = FileObjectSchema.parse(mapped);
  assertEquals(parsed.id, "file_1");
  assertEquals(parsed.object, "file");
  assertEquals(parsed.bytes, 42);
  assertEquals(parsed.created_at, 1577836800);
  assertEquals(parsed.filename, "input.jsonl");
  // Anthropic has no purpose field: hardcoded (Go parity).
  assertEquals(parsed.purpose, "batch");
  assertEquals(parsed.status, "processed");
  // Native extras ride along through the passthrough schema.
  assertEquals(mapped.mime_type, "application/jsonl");
  assertEquals(mapped.downloadable, true);
});

Deno.test("mapBatchResultLine maps succeeded and errored lines", () => {
  const ok = mapBatchResultLine({
    custom_id: "a",
    result: { type: "succeeded", message: { id: "msg_1", role: "assistant" } },
  });
  assertEquals(ok.custom_id, "a");
  assertEquals(ok.result_type, "succeeded");
  assertEquals(ok.response, {
    status_code: 200,
    body: { id: "msg_1", role: "assistant" },
  });
  assert(!("error" in ok));

  const failed = mapBatchResultLine({
    custom_id: "b",
    result: {
      type: "errored",
      error: { type: "invalid_request", message: "bad params" },
    },
  });
  assertEquals(failed.custom_id, "b");
  assertEquals(failed.result_type, "errored");
  assertEquals(failed.response, null);
  assertEquals(failed.error, {
    code: "invalid_request",
    message: "bad params",
  });
});

Deno.test("buildBatchRequests keeps native lines and converts OpenAI lines", () => {
  const jsonl = [
    '{"custom_id":"a","params":{"model":"claude-3","max_tokens":5}}',
    "",
    '{"custom_id":"b","body":{"model":"claude-3","stream":true,"messages":[]}}',
  ].join("\n");
  const requests = buildBatchRequests(jsonl, (body) => ({
    mapped: true,
    model: body.model,
    stream: body.stream,
  }));

  assertEquals(requests.length, 2);
  // Native {custom_id, params} lines pass through as-is.
  assertEquals(requests[0], {
    custom_id: "a",
    params: { model: "claude-3", max_tokens: 5 },
  });
  // OpenAI lines go through the chat mapper with `stream` stripped.
  assertEquals(requests[1].custom_id, "b");
  assertEquals(requests[1].params.mapped, true);
  assertEquals(requests[1].params.model, "claude-3");
  assert(!("stream" in requests[1].params));
});

Deno.test("buildBatchRequests rejects malformed lines with 400s", () => {
  const mapChat = (body: Record<string, unknown>) => body;

  let err = assertThrows(
    () => buildBatchRequests("not json", mapChat),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("line 1"));

  err = assertThrows(
    () => buildBatchRequests('{"params":{"model":"m"}}', mapChat),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("custom_id"));

  err = assertThrows(
    () => buildBatchRequests('{"custom_id":"a"}', mapChat),
    ProviderError,
  );
  assertEquals(err.status, 400);
  assert(err.body.includes("params"));
});
