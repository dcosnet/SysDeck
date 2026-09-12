import { ProviderError } from "./client.ts";

/** Bedrock Model Invocation Job as consumed from the control plane (both the
 * retrieve body and the list `invocationJobSummaries[]` entries). */
export interface BedrockJob {
  jobArn?: string;
  status?: string;
  jobName?: string;
  modelId?: string;
  inputDataConfig?: { s3InputDataConfig?: { s3Uri?: string } };
  outputDataConfig?: { s3OutputDataConfig?: { s3Uri?: string } };
  submitTime?: string;
  endTime?: string;
  jobExpirationTime?: string;
  message?: string;
}

/** manifest.json.out written by Bedrock next to the batch output. */
export interface BedrockBatchManifest {
  totalRecordCount?: number;
  processedRecordCount?: number;
  errorRecordCount?: number;
}

export interface BatchRequestCounts {
  total: number;
  completed: number;
  failed: number;
}

/** Bedrock job status -> OpenAI batch status (unknown values pass through). */
export function bedrockBatchStatus(status: string): string {
  switch (status) {
    case "Submitted":
    case "Validating":
    case "Scheduled":
      return "validating";
    case "InProgress":
      return "in_progress";
    case "Completed":
      return "completed";
    case "Failed":
    case "PartiallyCompleted":
      return "failed";
    case "Stopping":
      return "cancelling";
    case "Stopped":
      return "cancelled";
    case "Expired":
      return "expired";
    default:
      return status;
  }
}

/** RFC3339 timestamp -> unix seconds, or undefined when unparseable. */
export function rfc3339ToUnix(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Manifest record counts -> OpenAI batch request_counts arithmetic. */
export function manifestCounts(
  manifest: BedrockBatchManifest,
): BatchRequestCounts {
  const total = manifest.totalRecordCount ?? 0;
  const processed = manifest.processedRecordCount ?? 0;
  const errors = manifest.errorRecordCount ?? 0;
  return { total, completed: processed - errors, failed: errors };
}

/** Bedrock job -> OpenAI-shaped batch object (id = job ARN; `output_file_id`
 * is a passthrough extra carrying the output S3 URI). */
export function mapBedrockJob(
  job: BedrockJob,
  counts?: BatchRequestCounts,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: job.jobArn ?? "",
    object: "batch",
    status: bedrockBatchStatus(job.status ?? ""),
    created_at: rfc3339ToUnix(job.submitTime) ?? 0,
  };
  const inputUri = job.inputDataConfig?.s3InputDataConfig?.s3Uri;
  if (inputUri) {
    out.input_file_id = inputUri;
  }
  const outputUri = job.outputDataConfig?.s3OutputDataConfig?.s3Uri;
  if (outputUri) {
    out.output_file_id = outputUri;
  }
  const completedAt = rfc3339ToUnix(job.endTime);
  if (completedAt !== undefined) {
    out.completed_at = completedAt;
  }
  const expiresAt = rfc3339ToUnix(job.jobExpirationTime);
  if (expiresAt !== undefined) {
    out.expires_at = expiresAt;
  }
  const metadata: Record<string, string> = {};
  if (job.jobName) {
    metadata.job_name = job.jobName;
  }
  if (job.modelId) {
    metadata.model_id = job.modelId;
  }
  if (Object.keys(metadata).length > 0) {
    out.metadata = metadata;
  }
  if (counts) {
    out.request_counts = counts;
  }
  return out;
}

/** OpenAI completion_window (Go duration syntax, e.g. "24h", "1h30m") ->
 * whole timeoutDurationInHours; undefined when absent, unparseable, or < 1h
 * (Go's `omitempty` drops the zero value). */
export function parseTimeoutHours(window: unknown): number | undefined {
  if (typeof window !== "string" || window === "") {
    return undefined;
  }
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/
    .exec(window);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    return undefined;
  }
  const hours = Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60 +
    Number(m[3] ?? 0) / 3600;
  const whole = Math.trunc(hours);
  return whole > 0 ? whole : undefined;
}

/** Inline OpenAI batch `requests[]` -> Bedrock batch input JSONL: each line is
 * `{"recordId": custom_id, "modelInput": {"modelId", ...body sans "model"}}`. */
export function buildBatchInputJsonl(
  requests: Array<Record<string, unknown>>,
  modelId: string,
): string {
  const lines = requests.map((request) => {
    const modelInput: Record<string, unknown> = { modelId };
    const body = request.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (k !== "model") {
          modelInput[k] = v; // "model" would override modelId; drop it.
        }
      }
    }
    return JSON.stringify({
      recordId: typeof request.custom_id === "string" ? request.custom_id : "",
      modelInput,
    });
  });
  return lines.join("\n") + "\n";
}

/** One Bedrock output record line -> OpenAI batch result line, or undefined
 * when the line is not valid JSON (skipped, Go parity). */
export function mapBatchResultLine(
  line: string,
): Record<string, unknown> | undefined {
  let record: {
    recordId?: string;
    modelOutput?: Record<string, unknown>;
    error?: { errorCode?: number; errorMessage?: string };
  };
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  const out: Record<string, unknown> = { custom_id: record.recordId ?? "" };
  if (record.modelOutput) {
    out.response = { status_code: 200, body: record.modelOutput };
  }
  if (record.error) {
    out.error = {
      code: String(record.error.errorCode ?? 0),
      message: record.error.errorMessage ?? "",
    };
    if (!out.response) {
      out.response = { status_code: record.error.errorCode ?? 0 };
    }
  }
  return out;
}

/** Maps a whole Bedrock output JSONL document to OpenAI result lines
 * (already re-serialized); unparseable lines are skipped. */
export function mapBatchResultsJsonl(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const mapped = mapBatchResultLine(line);
    if (mapped) {
      out.push(JSON.stringify(mapped));
    }
  }
  return out;
}

/** S3 object summary -> OpenAI FileObject for the files-on-S3 emulation. */
export function mapS3ObjectToFile(
  bucket: string,
  object: { key: string; size: number; lastModified?: string },
): Record<string, unknown> {
  const filename = object.key.slice(object.key.lastIndexOf("/") + 1);
  return {
    id: `s3://${bucket}/${object.key}`,
    object: "file",
    bytes: object.size,
    created_at: rfc3339ToUnix(object.lastModified) ?? 0,
    filename,
    purpose: "batch",
    status: "processed",
  };
}

/** Bedrock control-plane errors are JSON `{"__type","message"}` — surface the
 * message when present, else the raw body (Go parity). Never retried. */
export function bedrockControlError(
  status: number,
  statusText: string,
  body: string,
): ProviderError {
  try {
    const parsed = JSON.parse(body) as { __type?: string; message?: string };
    if (parsed && typeof parsed.message === "string" && parsed.message !== "") {
      return new ProviderError(status, statusText, parsed.message);
    }
  } catch {
    // Not JSON — keep the raw body.
  }
  return new ProviderError(status, statusText, body);
}
