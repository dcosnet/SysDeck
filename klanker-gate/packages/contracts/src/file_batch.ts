import { z } from "zod";

// Widened enums: accept the known OpenAI variants OR any future/vendor string
// the wire introduces. Never reject an unknown status or endpoint.
export const BatchStatusSchema = z.union([
  z.enum([
    "validating",
    "failed",
    "in_progress",
    "finalizing",
    "completed",
    "expired",
    "cancelling",
    "cancelled",
  ]),
  z.string(),
]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const BatchEndpointSchema = z.union([
  z.enum([
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/responses",
  ]),
  z.string(),
]);
export type BatchEndpoint = z.infer<typeof BatchEndpointSchema>;

export const FileObjectSchema = z.object({
  id: z.string(),
  object: z.literal("file"),
  bytes: z.number(),
  created_at: z.number(),
  filename: z.string(),
  purpose: z.string(),
  // Additive optional fields carried by the OpenAI Files wire.
  expires_at: z.number().nullable().optional(),
  status: z.union([z.enum(["uploaded", "processed", "error"]), z.string()])
    .optional(),
  status_details: z.string().nullable().optional(),
}).passthrough();
export type FileObject = z.infer<typeof FileObjectSchema>;

// GET /v1/files list envelope.
export const FileListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(FileObjectSchema),
  has_more: z.boolean().optional(),
  first_id: z.string().nullable().optional(),
  last_id: z.string().nullable().optional(),
}).passthrough();
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

// DELETE /v1/files/:id envelope.
export const FileDeleteResponseSchema = z.object({
  id: z.string(),
  object: z.literal("file"),
  deleted: z.boolean(),
}).passthrough();
export type FileDeleteResponse = z.infer<typeof FileDeleteResponseSchema>;

export const UploadFileRequestSchema = z.object({
  file: z.instanceof(File).or(z.custom<Blob>((val) => val instanceof Blob)),
  purpose: z.string(),
});
export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>;

export const BatchRequestCountsSchema = z.object({
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
}).passthrough();
export type BatchRequestCounts = z.infer<typeof BatchRequestCountsSchema>;

export const BatchRequestSchema = z.object({
  input_file_id: z.string(),
  endpoint: BatchEndpointSchema,
  completion_window: z.string(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
}).passthrough();
export type BatchRequest = z.infer<typeof BatchRequestSchema>;

export const BatchResponseSchema = z.object({
  id: z.string(),
  object: z.literal("batch"),
  input_file_id: z.string(),
  endpoint: BatchEndpointSchema,
  status: BatchStatusSchema,
  // Additive optional fields from the OpenAI Batch object.
  completion_window: z.string().optional(),
  output_file_id: z.string().nullable().optional(),
  error_file_id: z.string().nullable().optional(),
  errors: z.unknown().nullable().optional(),
  request_counts: BatchRequestCountsSchema.optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  created_at: z.number().optional(),
  in_progress_at: z.number().nullable().optional(),
  expires_at: z.number().nullable().optional(),
  finalizing_at: z.number().nullable().optional(),
  completed_at: z.number().nullable().optional(),
  failed_at: z.number().nullable().optional(),
  expired_at: z.number().nullable().optional(),
  cancelling_at: z.number().nullable().optional(),
  cancelled_at: z.number().nullable().optional(),
}).passthrough();
export type BatchResponse = z.infer<typeof BatchResponseSchema>;

// GET /v1/batches list envelope.
export const BatchListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(BatchResponseSchema),
  has_more: z.boolean().optional(),
  first_id: z.string().nullable().optional(),
  last_id: z.string().nullable().optional(),
}).passthrough();
export type BatchListResponse = z.infer<typeof BatchListResponseSchema>;
