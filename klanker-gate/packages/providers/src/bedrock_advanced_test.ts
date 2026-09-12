import { assert, assertEquals } from "@std/assert";
import {
  bedrockBatchStatus,
  bedrockControlError,
  buildBatchInputJsonl,
  manifestCounts,
  mapBatchResultLine,
  mapBatchResultsJsonl,
  mapBedrockJob,
  mapS3ObjectToFile,
  parseTimeoutHours,
  rfc3339ToUnix,
} from "./bedrock_advanced.ts";

Deno.test("bedrockBatchStatus maps the full job status table", () => {
  assertEquals(bedrockBatchStatus("Submitted"), "validating");
  assertEquals(bedrockBatchStatus("Validating"), "validating");
  assertEquals(bedrockBatchStatus("Scheduled"), "validating");
  assertEquals(bedrockBatchStatus("InProgress"), "in_progress");
  assertEquals(bedrockBatchStatus("Completed"), "completed");
  assertEquals(bedrockBatchStatus("Failed"), "failed");
  assertEquals(bedrockBatchStatus("PartiallyCompleted"), "failed");
  assertEquals(bedrockBatchStatus("Stopping"), "cancelling");
  assertEquals(bedrockBatchStatus("Stopped"), "cancelled");
  assertEquals(bedrockBatchStatus("Expired"), "expired");
  // Unknown vendor statuses pass through verbatim (widened schema).
  assertEquals(bedrockBatchStatus("SomethingNew"), "SomethingNew");
});

Deno.test("rfc3339ToUnix parses timestamps and rejects garbage", () => {
  assertEquals(rfc3339ToUnix("2026-07-16T10:00:00Z"), 1784196000);
  assertEquals(rfc3339ToUnix("2026-07-16T10:00:00.500Z"), 1784196000);
  assertEquals(rfc3339ToUnix("not-a-time"), undefined);
  assertEquals(rfc3339ToUnix(undefined), undefined);
  assertEquals(rfc3339ToUnix(""), undefined);
});

Deno.test("manifestCounts derives request_counts arithmetic", () => {
  assertEquals(
    manifestCounts({
      totalRecordCount: 10,
      processedRecordCount: 8,
      errorRecordCount: 2,
    }),
    { total: 10, completed: 6, failed: 2 },
  );
  assertEquals(manifestCounts({}), { total: 0, completed: 0, failed: 0 });
});

Deno.test("parseTimeoutHours parses Go-style durations, omitting zero", () => {
  assertEquals(parseTimeoutHours("24h"), 24);
  assertEquals(parseTimeoutHours("1h30m"), 1);
  assertEquals(parseTimeoutHours("90m"), 1);
  assertEquals(parseTimeoutHours("7200s"), 2);
  assertEquals(parseTimeoutHours("30m"), undefined); // < 1h -> omitempty
  assertEquals(parseTimeoutHours("bogus"), undefined);
  assertEquals(parseTimeoutHours(""), undefined);
  assertEquals(parseTimeoutHours(undefined), undefined);
  assertEquals(parseTimeoutHours(24), undefined);
});

Deno.test("buildBatchInputJsonl emits recordId/modelInput lines, stripping model", () => {
  const jsonl = buildBatchInputJsonl(
    [
      {
        custom_id: "r1",
        body: { model: "ignored", messages: [{ role: "user", content: "hi" }] },
      },
      { custom_id: "r2", body: { max_tokens: 5 } },
      { custom_id: "r3" },
    ],
    "anthropic.claude-3",
  );
  const lines = jsonl.trimEnd().split("\n");
  assertEquals(lines.length, 3);
  assertEquals(
    lines[0],
    '{"recordId":"r1","modelInput":{"modelId":"anthropic.claude-3",' +
      '"messages":[{"role":"user","content":"hi"}]}}',
  );
  assertEquals(
    lines[1],
    '{"recordId":"r2","modelInput":{"modelId":"anthropic.claude-3","max_tokens":5}}',
  );
  assertEquals(
    lines[2],
    '{"recordId":"r3","modelInput":{"modelId":"anthropic.claude-3"}}',
  );
  assert(jsonl.endsWith("\n"));
});

Deno.test("mapBatchResultLine maps success, error, and mixed records", () => {
  assertEquals(
    mapBatchResultLine(
      '{"recordId":"a","modelOutput":{"content":"ok"}}',
    ),
    {
      custom_id: "a",
      response: { status_code: 200, body: { content: "ok" } },
    },
  );
  assertEquals(
    mapBatchResultLine(
      '{"recordId":"b","error":{"errorCode":424,"errorMessage":"boom"}}',
    ),
    {
      custom_id: "b",
      error: { code: "424", message: "boom" },
      response: { status_code: 424 },
    },
  );
  // Error alongside output keeps the 200 response and attaches the error.
  assertEquals(
    mapBatchResultLine(
      '{"recordId":"c","modelOutput":{"x":1},"error":{"errorCode":500,"errorMessage":"partial"}}',
    ),
    {
      custom_id: "c",
      response: { status_code: 200, body: { x: 1 } },
      error: { code: "500", message: "partial" },
    },
  );
  assertEquals(mapBatchResultLine("not json"), undefined);
});

Deno.test("mapBatchResultsJsonl skips blank and unparseable lines", () => {
  const mapped = mapBatchResultsJsonl(
    '{"recordId":"a","modelOutput":{"v":1}}\n\ngarbage\n{"recordId":"b","modelOutput":{"v":2}}\n',
  );
  assertEquals(mapped.length, 2);
  assertEquals(JSON.parse(mapped[0]).custom_id, "a");
  assertEquals(JSON.parse(mapped[1]).custom_id, "b");
});

Deno.test("mapBedrockJob maps ids, uris, timestamps, metadata, and counts", () => {
  const mapped = mapBedrockJob(
    {
      jobArn: "arn:aws:bedrock:us-east-1:1:model-invocation-job/j1",
      status: "Completed",
      jobName: "frosty-batch-1",
      modelId: "anthropic.claude-3",
      inputDataConfig: { s3InputDataConfig: { s3Uri: "s3://b/in.jsonl" } },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/out" } },
      submitTime: "2026-07-16T10:00:00Z",
      endTime: "2026-07-16T11:00:00Z",
      jobExpirationTime: "2026-07-19T10:00:00Z",
    },
    { total: 4, completed: 3, failed: 1 },
  );
  assertEquals(mapped, {
    id: "arn:aws:bedrock:us-east-1:1:model-invocation-job/j1",
    object: "batch",
    status: "completed",
    created_at: 1784196000,
    input_file_id: "s3://b/in.jsonl",
    output_file_id: "s3://b/out",
    completed_at: 1784199600,
    expires_at: 1784455200,
    metadata: { job_name: "frosty-batch-1", model_id: "anthropic.claude-3" },
    request_counts: { total: 4, completed: 3, failed: 1 },
  });
});

Deno.test("mapBedrockJob omits absent fields (summary shape)", () => {
  const mapped = mapBedrockJob({ jobArn: "arn:x", status: "InProgress" });
  assertEquals(mapped, {
    id: "arn:x",
    object: "batch",
    status: "in_progress",
    created_at: 0,
  });
});

Deno.test("mapS3ObjectToFile maps key/size/lastModified to a FileObject", () => {
  assertEquals(
    mapS3ObjectToFile("bkt", {
      key: "base/in/data.jsonl",
      size: 42,
      lastModified: "2026-07-16T10:00:00Z",
    }),
    {
      id: "s3://bkt/base/in/data.jsonl",
      object: "file",
      bytes: 42,
      created_at: 1784196000,
      filename: "data.jsonl",
      purpose: "batch",
      status: "processed",
    },
  );
});

Deno.test("bedrockControlError extracts the __type/message body when present", () => {
  const err = bedrockControlError(
    400,
    "Bad Request",
    '{"__type":"ValidationException","message":"roleArn is invalid"}',
  );
  assertEquals(err.status, 400);
  assertEquals(err.body, "roleArn is invalid");

  const raw = bedrockControlError(500, "Server Error", "<html>oops</html>");
  assertEquals(raw.body, "<html>oops</html>");

  const noMessage = bedrockControlError(403, "Forbidden", '{"__type":"X"}');
  assertEquals(noMessage.body, '{"__type":"X"}');
});
