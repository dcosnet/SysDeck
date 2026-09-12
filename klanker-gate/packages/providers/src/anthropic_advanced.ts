import { ProviderError } from "./client.ts";

/** Files API beta prefix. Sent on every native /files call (and on the
 * batch-input file-content fetch), NEVER on /messages/batches calls. */
export const ANTHROPIC_FILES_BETA = "files-api-2025-04-14";

/** Anthropic Message Batch wire object (POST/GET /v1/messages/batches). */
export interface AnthropicBatchWire {
  id?: string;
  type?: string;
  processing_status?: string;
  request_counts?: {
    processing?: number;
    succeeded?: number;
    errored?: number;
    canceled?: number;
    expired?: number;
  };
  ended_at?: string | null;
  created_at?: string;
  expires_at?: string;
  archived_at?: string | null;
  cancel_initiated_at?: string | null;
  results_url?: string | null;
}

/** Anthropic Files API wire object (POST/GET /v1/files). */
export interface AnthropicFileWire {
  id?: string;
  type?: string;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
  downloadable?: boolean;
}

/** One line of the /v1/messages/batches/{id}/results JSONL stream. */
export interface AnthropicBatchResultLine {
  custom_id?: string;
  result?: {
    type?: string; // "succeeded" | "errored" | "expired" | "canceled"
    message?: Record<string, unknown>;
    error?: { type?: string; message?: string };
  };
}

/**
 * Anthropic processing_status -> OpenAI batch status. `canceling` is respelled
 * to OpenAI's `cancelling`; `ended` is kept verbatim (Go parity — frosty's
 * widened BatchStatusSchema accepts it); unknown statuses pass through.
 */
export function anthropicBatchStatus(status: string): string {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "canceling":
      return "cancelling";
    case "ended":
      return "ended";
    default:
      return status;
  }
}

/** RFC3339(Nano) timestamp -> unix seconds; 0 on empty/unparseable input. */
export function isoToUnix(timestamp: string | null | undefined): number {
  if (!timestamp) {
    return 0;
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return 0;
  }
  return Math.floor(ms / 1000);
}

/**
 * Anthropic batch object -> OpenAI-shaped batch. Timestamps become unix
 * seconds (omitted when absent/unparseable, except created_at which Go always
 * emits); request_counts arithmetic mirrors Go: total is the sum of all
 * states, completed = succeeded, failed = errored. `results_url` and
 * `processing_status` ride along as passthrough extras.
 */
export function mapAnthropicBatch(
  batch: AnthropicBatchWire,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: batch.id ?? "",
    object: !batch.type || batch.type === "message_batch"
      ? "batch"
      : batch.type,
    status: anthropicBatchStatus(batch.processing_status ?? ""),
    created_at: isoToUnix(batch.created_at),
  };
  if (batch.processing_status !== undefined) {
    out.processing_status = batch.processing_status;
  }
  const expiresAt = isoToUnix(batch.expires_at);
  if (expiresAt > 0) {
    out.expires_at = expiresAt;
  }
  const completedAt = isoToUnix(batch.ended_at);
  if (completedAt > 0) {
    out.completed_at = completedAt;
  }
  const cancellingAt = isoToUnix(batch.cancel_initiated_at);
  if (cancellingAt > 0) {
    out.cancelling_at = cancellingAt;
  }
  const archivedAt = isoToUnix(batch.archived_at);
  if (archivedAt > 0) {
    out.archived_at = archivedAt;
  }
  if (batch.results_url) {
    out.results_url = batch.results_url;
  }
  const c = batch.request_counts;
  if (c) {
    out.request_counts = {
      total: (c.processing ?? 0) + (c.succeeded ?? 0) + (c.errored ?? 0) +
        (c.canceled ?? 0) + (c.expired ?? 0),
      completed: c.succeeded ?? 0,
      failed: c.errored ?? 0,
    };
  }
  return out;
}

/**
 * Anthropic file object -> OpenAI FileObject. Anthropic has no purpose field,
 * so `purpose` is hardcoded to "batch" and `status` to "processed" (Go
 * parity); `mime_type`/`downloadable` ride along as passthrough extras.
 */
export function mapAnthropicFile(
  file: AnthropicFileWire,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: file.id ?? "",
    object: "file",
    bytes: file.size_bytes ?? 0,
    created_at: isoToUnix(file.created_at),
    filename: file.filename ?? "",
    purpose: "batch",
    status: "processed",
  };
  if (file.mime_type !== undefined) {
    out.mime_type = file.mime_type;
  }
  if (file.downloadable !== undefined) {
    out.downloadable = file.downloadable;
  }
  return out;
}

/**
 * One Anthropic results JSONL line -> the OpenAI batch-output line shape.
 * Succeeded lines carry `{response: {status_code: 200, body: <message>}}`;
 * non-succeeded lines signal failure via `error` presence (status_code is
 * never rewritten) and keep the native result type as `result_type`.
 */
export function mapBatchResultLine(
  line: AnthropicBatchResultLine,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    custom_id: line.custom_id ?? "",
    response: line.result?.message
      ? { status_code: 200, body: line.result.message }
      : null,
  };
  if (line.result?.type !== undefined) {
    out.result_type = line.result.type;
  }
  if (line.result?.error) {
    out.error = {
      code: line.result.error.type ?? "",
      message: line.result.error.message ?? "",
    };
  }
  return out;
}

/**
 * Batch-input JSONL -> Anthropic `requests[]`. Each line is either a native
 * Anthropic item `{custom_id, params}` (used as-is) or an OpenAI batch line
 * `{custom_id, body: {model, messages, ...}}`, converted through `mapChat`
 * (the adapter's existing OpenAI->Anthropic chat mapper) with `stream`
 * stripped. Anything else is a 400.
 */
export function buildBatchRequests(
  jsonl: string,
  mapChat: (body: Record<string, unknown>) => Record<string, unknown>,
): Array<{ custom_id: string; params: Record<string, unknown> }> {
  const requests: Array<
    { custom_id: string; params: Record<string, unknown> }
  > = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ProviderError(
        400,
        "Bad Request",
        `Batch input file line ${i + 1} is not valid JSON.`,
      );
    }
    if (typeof parsed.custom_id !== "string" || parsed.custom_id === "") {
      throw new ProviderError(
        400,
        "Bad Request",
        `Batch input file line ${i + 1} is missing a custom_id.`,
      );
    }
    if (parsed.params && typeof parsed.params === "object") {
      requests.push({
        custom_id: parsed.custom_id,
        params: parsed.params as Record<string, unknown>,
      });
    } else if (parsed.body && typeof parsed.body === "object") {
      const params = mapChat(parsed.body as Record<string, unknown>);
      delete params.stream;
      requests.push({ custom_id: parsed.custom_id, params });
    } else {
      throw new ProviderError(
        400,
        "Bad Request",
        `Batch input file line ${
          i + 1
        } must carry either \`params\` (Anthropic) or \`body\` (OpenAI).`,
      );
    }
  }
  return requests;
}
