import { assert, assertEquals } from "@std/assert";
import {
  BatchEndpointSchema,
  BatchListResponseSchema,
  BatchRequestSchema,
  BatchResponseSchema,
  BatchStatusSchema,
  FileDeleteResponseSchema,
  FileListResponseSchema,
  FileObjectSchema,
} from "./file_batch.ts";

// --- New typed shapes parse ---

Deno.test("FileObjectSchema - enriched object with optional status/expiry", () => {
  const result = FileObjectSchema.safeParse({
    id: "file-1",
    object: "file",
    bytes: 120,
    created_at: 1,
    filename: "data.jsonl",
    purpose: "batch",
    status: "processed",
    status_details: null,
    expires_at: 999,
    vendor_extra: "kept",
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.status, "processed");
    assertEquals(
      (result.data as Record<string, unknown>).vendor_extra,
      "kept",
    );
  }
});

Deno.test("FileListResponseSchema - list envelope parses", () => {
  const result = FileListResponseSchema.safeParse({
    object: "list",
    data: [{
      id: "file-1",
      object: "file",
      bytes: 1,
      created_at: 1,
      filename: "a.jsonl",
      purpose: "batch",
    }],
    has_more: false,
    first_id: "file-1",
    last_id: "file-1",
  });
  assert(result.success);
});

Deno.test("FileDeleteResponseSchema - delete envelope parses", () => {
  const result = FileDeleteResponseSchema.safeParse({
    id: "file-1",
    object: "file",
    deleted: true,
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.deleted, true);
  }
});

Deno.test("BatchResponseSchema - full object with counts + timestamps", () => {
  const result = BatchResponseSchema.safeParse({
    id: "batch-1",
    object: "batch",
    input_file_id: "file-1",
    endpoint: "/v1/chat/completions",
    status: "completed",
    completion_window: "24h",
    output_file_id: "file-out",
    error_file_id: null,
    request_counts: { total: 3, completed: 3, failed: 0 },
    created_at: 1,
    completed_at: 5,
    metadata: { job: "nightly" },
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.request_counts?.completed, 3);
    assertEquals(result.data.output_file_id, "file-out");
  }
});

Deno.test("BatchListResponseSchema - list envelope parses", () => {
  const result = BatchListResponseSchema.safeParse({
    object: "list",
    data: [{
      id: "batch-1",
      object: "batch",
      input_file_id: "file-1",
      endpoint: "/v1/embeddings",
      status: "in_progress",
    }],
    has_more: true,
    last_id: "batch-1",
  });
  assert(result.success);
});

Deno.test("BatchStatus/BatchEndpoint - known enums and widened strings", () => {
  assert(BatchStatusSchema.safeParse("finalizing").success);
  assert(BatchEndpointSchema.safeParse("/v1/responses").success);
  // Widened: any future/vendor variant is accepted, never rejected.
  assert(BatchStatusSchema.safeParse("queued_by_vendor").success);
  assert(BatchEndpointSchema.safeParse("/v1/custom/endpoint").success);
});

// --- BACKWARD-COMPAT: the historical (pre-increment) shapes still parse ---

Deno.test("BACKWARD-COMPAT: minimal FileObject (old required-only) parses", () => {
  const result = FileObjectSchema.safeParse({
    id: "file-1",
    object: "file",
    bytes: 10,
    created_at: 1,
    filename: "data.jsonl",
    purpose: "batch",
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: minimal BatchResponse (old required-only) parses", () => {
  // Historical schema: { id, object:'batch', input_file_id, endpoint:string,
  // status:string } with no optional envelope fields.
  const result = BatchResponseSchema.safeParse({
    id: "batch-1",
    object: "batch",
    input_file_id: "file-1",
    endpoint: "/v1/chat/completions",
    status: "validating",
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: minimal BatchRequest (old shape) parses", () => {
  const result = BatchRequestSchema.safeParse({
    input_file_id: "file-1",
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  assert(result.success);
});
