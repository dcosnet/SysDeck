import { ProviderError } from "./client.ts";

// Pure request/response mappers for GeminiAdapter.rawProxy's native Files and
// Batch API translation (sidecar to gemini.ts, the same split as imagen.ts).
// Everything here is I/O-free and exported for direct unit testing.

/** Base64 decode tolerant of URL-safe alphabets and missing padding: `_`/`-`
 * are folded back to `/`/`+` and `=` padding is restored (Go parity). */
export function decodeBase64ToBytes(b64: string): Uint8Array {
  let standard = b64.replaceAll("_", "/").replaceAll("-", "+");
  switch (standard.length % 4) {
    case 2:
      standard += "==";
      break;
    case 3:
      standard += "=";
      break;
  }
  const binary = atob(standard);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Standard (RFC 4648, non-URL-safe) base64 of raw bytes. Chunked so large
 * audio buffers never overflow the String.fromCharCode argument list. */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Gemini resource names ("files/abc", "batches/xyz") contain a slash, but the
// gateway's /v1/files/:id and /v1/batches/:id routes match a single path
// segment. Adapters therefore emit BARE ids and re-prefix on every native call.

export function bareResourceId(
  name: string,
  prefix: "files/" | "batches/",
): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function qualifyResourceId(
  id: string,
  prefix: "files/" | "batches/",
): string {
  // Encode the bare id segment (defense-in-depth path-injection guard, matching
  // the Anthropic/Bedrock adapters) while keeping the prefix slash literal.
  const bare = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  return `${prefix}${encodeURIComponent(bare)}`;
}

// ---------------------------------------------------------------------------
// generateContent response shapes shared by speech/transcription/batch results.

export interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

export interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] };
  finishReason?: string;
}

export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Files

export interface GeminiFile {
  name?: string;
  displayName?: string;
  mimeType?: string;
  /** The wire carries size as a STRING. */
  sizeBytes?: string;
  createTime?: string;
  updateTime?: string;
  expirationTime?: string;
  sha256Hash?: string;
  uri?: string;
  state?: string;
}

/** RFC3339 timestamp to unix seconds; 0 for empty/unparseable (Go parity). */
export function parseGeminiTimestamp(timestamp?: string): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/** Gemini file state to OpenAI-ish file status (Go parity, incl. the
 * lowercase fallthrough for unknown vendor states). */
export function geminiFileStatus(state?: string): string {
  switch (state) {
    case "PROCESSING":
      return "processing";
    case "ACTIVE":
      return "processed";
    case "FAILED":
      return "error";
    default:
      return (state ?? "").toLowerCase();
  }
}

/** Maps a native Gemini file to the OpenAI FileObject shape. `purpose` is the
 * request's purpose on upload and "vision" on list/get (Go hardcodes it). */
export function mapGeminiFile(
  file: GeminiFile,
  purpose: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: bareResourceId(file.name ?? "", "files/"),
    object: "file",
    bytes: Number(file.sizeBytes ?? 0) || 0,
    created_at: parseGeminiTimestamp(file.createTime),
    filename: file.displayName ?? "",
    purpose,
    status: geminiFileStatus(file.state),
  };
  if (file.uri) out.uri = file.uri;
  const expiresAt = parseGeminiTimestamp(file.expirationTime);
  if (expiresAt > 0) out.expires_at = expiresAt;
  return out;
}

// ---------------------------------------------------------------------------
// Batches

export const GEMINI_BATCH_ACTIVE_STATES = [
  "BATCH_STATE_PENDING",
  "BATCH_STATE_RUNNING",
] as const;

/** Native batch state to OpenAI batch status; unknown vendor states pass
 * through verbatim (BatchStatusSchema is deliberately widened for this). */
export function geminiBatchStatus(state?: string): string {
  switch (state) {
    case "BATCH_STATE_PENDING":
    case "BATCH_STATE_RUNNING":
      return "in_progress";
    case "BATCH_STATE_SUCCEEDED":
      return "completed";
    case "BATCH_STATE_FAILED":
      return "failed";
    case "BATCH_STATE_CANCELLING":
      return "cancelling";
    case "BATCH_STATE_CANCELLED":
      return "cancelled";
    case "BATCH_STATE_EXPIRED":
      return "expired";
    default:
      return state ?? "";
  }
}

export interface GeminiBatchStats {
  /** All three counts are wire STRINGS. */
  requestCount?: string | number;
  pendingRequestCount?: string | number;
  successfulRequestCount?: string | number;
}

export interface GeminiBatchJob {
  name?: string;
  metadata?: {
    name?: string;
    state?: string;
    createTime?: string;
    endTime?: string;
    updateTime?: string;
    inputConfig?: { fileName?: string };
    batchStats?: GeminiBatchStats;
  };
  dest?: {
    fileName?: string;
    inlinedResponses?: GeminiBatchResultLine[];
  };
}

/** One batch result: a JSONL file line ({key,...}) or an inlinedResponses[]
 * entry ({metadata:{key},...}) — the shapes only differ in where the id sits. */
export interface GeminiBatchResultLine {
  key?: string;
  metadata?: { key?: string };
  response?: GeminiGenerateContentResponse;
  error?: { code?: number; message?: string; status?: string };
}

/** Maps a native batch job to the OpenAI Batch object shape. */
export function mapGeminiBatch(
  job: GeminiBatchJob,
  extras: { inputFileId?: string; endpoint?: string } = {},
): Record<string, unknown> {
  const meta = job.metadata ?? {};
  const out: Record<string, unknown> = {
    id: bareResourceId(meta.name ?? job.name ?? "", "batches/"),
    object: "batch",
    input_file_id: extras.inputFileId ??
      bareResourceId(meta.inputConfig?.fileName ?? "", "files/"),
    endpoint: extras.endpoint ?? "/v1/chat/completions",
    status: geminiBatchStatus(meta.state),
    created_at: parseGeminiTimestamp(meta.createTime),
  };
  const stats = meta.batchStats;
  if (stats) {
    const total = Number(stats.requestCount ?? 0) || 0;
    const pending = Number(stats.pendingRequestCount ?? 0) || 0;
    const succeeded = Number(stats.successfulRequestCount ?? 0) || 0;
    const completed = total - pending;
    out.request_counts = {
      total,
      completed,
      failed: completed - succeeded,
    };
  }
  if (job.dest?.fileName) {
    out.output_file_id = bareResourceId(job.dest.fileName, "files/");
  }
  return out;
}

/** Default model when neither metadata.model nor body.model names one. */
export const DEFAULT_GEMINI_BATCH_MODEL = "gemini-2.5-flash";

/**
 * Translates an OpenAI batch-create body into the model to call plus the
 * native `:batchGenerateContent` payload. NOTE: unlike generateContent, the
 * create body is snake_case on the wire (display_name/input_config/file_name).
 * Exactly one of input_file_id / requests must be present (Go parity).
 */
export function buildBatchCreateBody(
  raw: unknown,
): { model: string; payload: Record<string, unknown> } {
  const body = (raw ?? {}) as {
    input_file_id?: unknown;
    requests?: unknown;
    metadata?: Record<string, unknown> | null;
    model?: unknown;
  };
  const inputFileId =
    typeof body.input_file_id === "string" && body.input_file_id !== ""
      ? body.input_file_id
      : undefined;
  const requests = Array.isArray(body.requests) && body.requests.length > 0
    ? body.requests
    : undefined;
  if (!inputFileId && !requests) {
    throw new ProviderError(
      400,
      "Bad Request",
      "either input_file_id or requests must be provided",
    );
  }
  if (inputFileId && requests) {
    throw new ProviderError(
      400,
      "Bad Request",
      "cannot specify both input_file_id and requests",
    );
  }
  const metaModel = typeof body.metadata?.model === "string"
    ? body.metadata.model
    : undefined;
  const bodyModel = typeof body.model === "string" && body.model !== ""
    ? body.model
    : undefined;
  const model = metaModel ?? bodyModel ?? DEFAULT_GEMINI_BATCH_MODEL;
  const inputConfig = inputFileId
    ? { file_name: qualifyResourceId(inputFileId, "files/") }
    : { requests: { requests: requests!.map(mapInlineBatchRequest) } };
  return {
    model,
    payload: {
      batch: {
        display_name: `frosty-batch-${Date.now()}`,
        input_config: inputConfig,
      },
    },
  };
}

/** OpenAI inline batch line {custom_id, body:{messages}} to a native batch
 * item: assistant maps to model, system lines are skipped, string content
 * only (Go parity). */
function mapInlineBatchRequest(raw: unknown): Record<string, unknown> {
  const item = (raw ?? {}) as {
    custom_id?: unknown;
    body?: Record<string, unknown> | null;
    params?: Record<string, unknown> | null;
  };
  const data = item.body ?? item.params ?? {};
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const rawRole = (message as { role?: unknown }).role;
    let role = "user";
    if (typeof rawRole === "string") {
      if (rawRole === "system") continue;
      role = rawRole === "assistant" ? "model" : rawRole;
    }
    const parts: Array<{ text: string }> = [];
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push({ text: content });
    contents.push({ role, parts });
  }
  const out: Record<string, unknown> = { request: { contents } };
  if (typeof item.custom_id === "string" && item.custom_id !== "") {
    out.metadata = { key: item.custom_id };
  }
  return out;
}

/**
 * Maps one batch result (file JSONL line or inlined response) to the OpenAI
 * output-JSONL line shape. `index` supplies the `request-<i>` fallback id.
 */
export function mapBatchResultLine(
  line: GeminiBatchResultLine,
  index: number,
): Record<string, unknown> {
  const customId = line.key || line.metadata?.key || `request-${index}`;
  const out: Record<string, unknown> = { custom_id: customId };
  if (line.error) {
    out.error = {
      code: String(line.error.code ?? 0),
      message: line.error.message ?? "",
    };
  } else if (line.response) {
    const body: Record<string, unknown> = {};
    const candidate = line.response.candidates?.[0];
    if (candidate) {
      const text = (candidate.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (text !== "") body.text = text;
      body.finish_reason = candidate.finishReason ?? "";
    }
    const usage = line.response.usageMetadata;
    if (usage) {
      body.usage = {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0,
      };
    }
    out.response = { status_code: 200, body };
  }
  return out;
}
