import type { ChatCompletionRequest } from "../../contracts/src/mod.ts";
import { ToolCallSchema } from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderError } from "./client.ts";
import { signRequest } from "./sigv4.ts";
import {
  type CanonicalChunk,
  createSSEResponse,
  SSENormalizationStream,
} from "../../core/src/mod.ts";
import {
  type DecodedEventStreamMessage,
  EventStreamDecoderStream,
  headerString,
} from "./eventstream.ts";
import { AwsCredentialProvider } from "./aws_credentials.ts";
import { parseS3Uri, S3Client } from "./s3.ts";
import {
  type BatchRequestCounts,
  bedrockControlError,
  type BedrockJob,
  buildBatchInputJsonl,
  manifestCounts,
  mapBatchResultsJsonl,
  mapBedrockJob,
  mapS3ObjectToFile,
  parseTimeoutHours,
} from "./bedrock_advanced.ts";

interface ConverseContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
}

interface ConverseResponse {
  output?: { message?: { content?: ConverseContentBlock[] } };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    default:
      return "stop";
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((
        p,
      ) => (typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "")
      )
      .join("");
  }
  return "";
}

/** Tool-result string -> Converse toolResult content. Valid JSON becomes a
 * json block (bare arrays wrapped, since Bedrock rejects top-level arrays);
 * anything else stays a text block. */
function toolResultContent(text: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return [{ json: { results: parsed } }];
    }
    return [{ json: parsed }];
  } catch {
    return [{ text }];
  }
}

/** Canonical messages -> Converse messages + system blocks, preserving
 * assistant tool_calls (toolUse) and grouped tool results (toolResult). */
function convertMessages(
  messages: ChatCompletionRequest["messages"],
): {
  messages: Array<Record<string, unknown>>;
  system: Array<{ text: string }>;
} {
  const system: Array<{ text: string }> = [];
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      system.push({ text: contentText(m.content) });
    } else if (m.role === "user" || m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = contentText(m.content);
      if (text.length > 0) {
        content.push({ text });
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        for (const raw of m.tool_calls) {
          const parsed = ToolCallSchema.safeParse(raw);
          if (!parsed.success) {
            continue;
          }
          let input: unknown = {};
          try {
            input = JSON.parse(parsed.data.function.arguments || "{}");
          } catch {
            input = {};
          }
          content.push({
            toolUse: {
              toolUseId: parsed.data.id,
              name: parsed.data.function.name,
              input,
            },
          });
        }
      }
      out.push({ role: m.role, content });
    } else if (m.role === "tool") {
      // Group consecutive tool messages into a single Converse user turn.
      const content: Array<Record<string, unknown>> = [];
      let j = i;
      for (; j < messages.length && messages[j].role === "tool"; j++) {
        const tm = messages[j];
        content.push({
          toolResult: {
            toolUseId: tm.tool_call_id,
            content: toolResultContent(contentText(tm.content)),
            status: "success",
          },
        });
      }
      i = j - 1;
      out.push({ role: "user", content });
    }
    // role "function": no Converse equivalent; skipped.
  }
  return { messages: out, system };
}

/** Canonical OpenAI tool_choice -> Converse toolChoice. */
function convertToolChoice(
  choice: unknown,
): Record<string, unknown> | undefined {
  if (choice === "required") {
    return { any: {} };
  }
  if (choice === "auto") {
    return { auto: {} };
  }
  const c = choice as
    | { type?: string; function?: { name?: string } }
    | null
    | undefined;
  if (c?.type === "function" && c.function?.name) {
    return { tool: { name: c.function.name } };
  }
  return undefined; // "none"/unset -> Bedrock's default (auto)
}

/** Canonical tools -> Converse toolConfig, or undefined when no tools. */
function convertToolConfig(
  req: ChatCompletionRequest,
): Record<string, unknown> | undefined {
  if (!req.tools?.length) {
    return undefined;
  }
  const tools = req.tools.map((t) => {
    const raw = t as Record<string, unknown>;
    const fn = (raw.function ?? raw) as Record<string, unknown>;
    return {
      toolSpec: {
        name: fn.name,
        description: fn.description ?? "Function tool",
        inputSchema: {
          json: fn.parameters ?? { type: "object", properties: {} },
        },
      },
    };
  });
  const toolChoice = convertToolChoice(req.tool_choice);
  return { tools, ...(toolChoice ? { toolChoice } : {}) };
}

/** One decoded converse-stream event payload (fields we consume). */
interface ConverseStreamEvent {
  role?: string;
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId?: string; name?: string } };
  delta?: { text?: string; toolUse?: { input?: string } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  message?: string;
  Message?: string;
}

const streamDecoder = new TextDecoder();

/**
 * Maps decoded converse-stream events to canonical OpenAI `chat.completion.chunk`
 * objects (the same shape the Anthropic transformer emits, so downstream
 * normalization + governance parse them identically):
 *   messageStart      -> {role:"assistant", content:""}
 *   contentBlockStart -> tool_calls delta (id + name) when a toolUse block opens
 *   contentBlockDelta -> {content} for text, or tool_calls {arguments} for toolUse
 *   messageStop       -> finish_reason chunk
 *   metadata          -> final empty-choices chunk carrying usage
 * A non-"event" message (exception/error) errors the stream.
 */
export class BedrockStreamTransformer
  extends TransformStream<DecodedEventStreamMessage, CanonicalChunk> {
  constructor(model: string, created: number) {
    const id = `chatcmpl-bedrock-${created}`;
    let toolIndex = -1;
    let finishSent = false;

    const chunk = (
      delta: Record<string, unknown>,
      finish: string | null = null,
    ): Record<string, unknown> => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    super({
      transform(message, controller) {
        const messageType = headerString(message, ":message-type") ?? "event";
        const payload: ConverseStreamEvent = message.payload.length > 0
          ? JSON.parse(streamDecoder.decode(message.payload))
          : {};

        if (messageType !== "event") {
          const errType = headerString(message, ":exception-type") ??
            headerString(message, ":error-code") ?? messageType;
          controller.error(
            new Error(
              `Bedrock stream ${errType}: ${
                payload.message ?? payload.Message ?? "stream error"
              }`,
            ),
          );
          return;
        }

        switch (headerString(message, ":event-type")) {
          case "messageStart":
            controller.enqueue(chunk({ role: "assistant", content: "" }));
            break;
          case "contentBlockStart": {
            const toolUse = payload.start?.toolUse;
            if (toolUse) {
              toolIndex += 1;
              controller.enqueue(chunk({
                tool_calls: [{
                  index: toolIndex,
                  id: toolUse.toolUseId,
                  type: "function",
                  function: { name: toolUse.name, arguments: "" },
                }],
              }));
            }
            break;
          }
          case "contentBlockDelta": {
            const delta = payload.delta ?? {};
            if (typeof delta.text === "string" && delta.text.length > 0) {
              controller.enqueue(chunk({ content: delta.text }));
            } else if (typeof delta.toolUse?.input === "string") {
              controller.enqueue(chunk({
                tool_calls: [{
                  index: toolIndex,
                  function: { arguments: delta.toolUse.input },
                }],
              }));
            }
            break;
          }
          case "contentBlockStop":
            break;
          case "messageStop":
            if (!finishSent) {
              finishSent = true;
              controller.enqueue(chunk({}, mapStopReason(payload.stopReason)));
            }
            break;
          case "metadata": {
            const usage = payload.usage ?? {};
            const promptTokens = usage.inputTokens ?? 0;
            const completionTokens = usage.outputTokens ?? 0;
            controller.enqueue({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: usage.totalTokens ??
                  promptTokens + completionTokens,
              },
            });
            break;
          }
        }
      },
      flush(controller) {
        if (!finishSent) {
          controller.enqueue(chunk({}, "stop"));
        }
        controller.enqueue("[DONE]");
      },
    });
  }
}

export interface BedrockOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Endpoint override for tests. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /**
   * Injected AWS credential provider (tests + DI). Used only when static
   * `accessKeyId`/`secretAccessKey` are absent; otherwise the static account
   * keys are the first-choice source (backward-compatible).
   */
  credentialProvider?: AwsCredentialProvider;
  /** Batch (Model Invocation Jobs): IAM role ARN passed as roleArn on create. */
  batchRoleArn?: string;
  /** Batch: default s3://bucket/prefix URI for job output. */
  batchOutputS3Uri?: string;
  /** Files-on-S3 emulation: default bucket (may be s3://bucket/prefix). */
  s3Bucket?: string;
  /** Files-on-S3 emulation: default key prefix inside s3Bucket. */
  s3Prefix?: string;
}

export class BedrockAdapter implements IProviderAdapter {
  private fetchImpl: typeof fetch;
  private credentialProvider?: AwsCredentialProvider;
  private s3Client?: S3Client;

  constructor(private options: BedrockOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Runtime host (converse/invoke). The `endpoint` option overrides it. */
  private endpoint(): string {
    return (this.options.endpoint ??
      `https://bedrock-runtime.${this.options.region}.amazonaws.com`)
      .replace(/\/$/, "");
  }

  /** Control-plane host (Model Invocation Jobs). Runtime-only `endpoint()`
   * never applies here. */
  private controlEndpoint(): string {
    return `https://bedrock.${this.options.region}.amazonaws.com`;
  }

  /** Lazy S3 client sharing this adapter's credentials + fetch (files
   * emulation, batch input upload, batch result aggregation). */
  private s3(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: this.options.region,
        credentials: () => this.credentials(),
        fetchImpl: this.fetchImpl,
      });
    }
    return this.s3Client;
  }

  /**
   * Resolves credentials for signing. Static account keys are the first-choice
   * source (backward-compatible + byte-identical signing); only when they are
   * absent does the AWS provider chain run (env -> profile -> IMDS -> ECS ->
   * STS web-identity). The chain uses a raw short-timeout fetch for metadata
   * probes, never the retrying provider client, so an off-EC2 probe fails fast.
   */
  private async credentials(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }> {
    if (this.options.accessKeyId && this.options.secretAccessKey) {
      return {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        sessionToken: this.options.sessionToken,
      };
    }
    if (!this.credentialProvider) {
      this.credentialProvider = this.options.credentialProvider ??
        new AwsCredentialProvider({ region: this.options.region });
    }
    const resolved = await this.credentialProvider.resolve();
    return {
      accessKeyId: resolved.accessKeyId,
      secretAccessKey: resolved.secretAccessKey,
      sessionToken: resolved.sessionToken,
    };
  }

  /** SigV4-signs a POST to the Bedrock runtime with the resolved credentials. */
  private async signBedrock(
    url: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const creds = await this.credentials();
    return await signRequest({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...extraHeaders },
      body,
      region: this.options.region,
      service: "bedrock",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
  }

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const { messages, system } = convertMessages(req.messages);
    const toolConfig = convertToolConfig(req);

    const body = JSON.stringify({
      ...(system.length > 0 ? { system } : {}),
      messages,
      inferenceConfig: {
        ...(req.max_tokens !== undefined ? { maxTokens: req.max_tokens } : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(req.top_p !== undefined ? { topP: req.top_p } : {}),
        ...(req.stop !== undefined
          ? {
            stopSequences: Array.isArray(req.stop) ? req.stop : [req.stop],
          }
          : {}),
      },
      ...(toolConfig ? { toolConfig } : {}),
    });

    // Streaming uses the converse-stream verb (binary event framing); the
    // request body is identical to the non-streaming converse call.
    const verb = req.stream ? "converse-stream" : "converse";
    const url = `${this.endpoint()}/model/${
      encodeURIComponent(req.model)
    }/${verb}`;
    const headers = await this.signBedrock(url, body);

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: context?.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }

    if (req.stream) {
      if (!response.body) {
        throw new ProviderError(
          502,
          "Bad Gateway",
          "Bedrock converse-stream returned no response body.",
        );
      }
      // AWS vnd.amazon.eventstream frames -> canonical chunks -> OpenAI SSE.
      const created = Math.floor(Date.now() / 1000);
      const stream = response.body
        .pipeThrough(new EventStreamDecoderStream())
        .pipeThrough(new BedrockStreamTransformer(req.model, created))
        .pipeThrough(new SSENormalizationStream())
        .pipeThrough(new TextEncoderStream());
      return createSSEResponse(stream);
    }

    const converse = await response.json() as ConverseResponse;

    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    for (const block of converse.output?.message?.content ?? []) {
      if (typeof block.text === "string" && block.text.length > 0) {
        textParts.push(block.text);
      } else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId ?? `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: block.toolUse.name ?? "",
            arguments: JSON.stringify(block.toolUse.input ?? {}),
          },
        });
      }
    }
    const text = textParts.join("");
    const message = toolCalls.length > 0
      ? {
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls,
      }
      : { role: "assistant", content: text };
    const chat = {
      id: `chatcmpl-bedrock-${crypto.randomUUID().slice(0, 8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{
        index: 0,
        message,
        finish_reason: mapStopReason(converse.stopReason),
      }],
      usage: {
        prompt_tokens: converse.usage?.inputTokens ?? 0,
        completion_tokens: converse.usage?.outputTokens ?? 0,
        // Mirror the streaming path: fall back to input+output when the
        // Converse payload omits totalTokens, so usage/billing isn't zeroed.
        total_tokens: converse.usage?.totalTokens ??
          ((converse.usage?.inputTokens ?? 0) +
            (converse.usage?.outputTokens ?? 0)),
      },
    };
    return new Response(JSON.stringify(chat), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** SigV4-signs and POSTs a native InvokeModel (`:invoke`) request. */
  private async invokeModel(
    model: string,
    payload: unknown,
    context?: ProviderContext,
  ): Promise<Response> {
    const url = `${this.endpoint()}/model/${encodeURIComponent(model)}/invoke`;
    const body = JSON.stringify(payload);
    const headers = await this.signBedrock(url, body, {
      "accept": "application/json",
    });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: context?.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  /**
   * Native embeddings via InvokeModel (`:invoke`). Titan
   * (`amazon.titan-embed-*`) is single-text per call, so a batch fans out to
   * one invoke per input; Cohere-on-Bedrock (`cohere.embed-*`) is natively
   * batched. Both map to the canonical OpenAI embeddings response.
   */
  async embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    const r = req as {
      model: string;
      input: unknown;
      dimensions?: number;
    };
    const texts = embeddingTexts(r.input);

    if (r.model.startsWith("cohere.")) {
      // Cohere embed: one batched call. input_type is required by the model;
      // default to search_document (the embedding-side default).
      const response = await this.invokeModel(r.model, {
        texts,
        input_type: "search_document",
        truncate: "END",
      }, context);
      const body = await response.json() as {
        embeddings?: number[][] | {
          float?: number[][];
          embeddings?: number[][];
        };
      };
      const vectors = Array.isArray(body.embeddings)
        ? body.embeddings
        : body.embeddings?.float ?? body.embeddings?.embeddings ?? [];
      // Cohere-on-Bedrock does not report token counts.
      return embeddingResponse(r.model, vectors, 0);
    }

    // Titan (default): fan a batch out to one invoke per input text.
    const vectors: number[][] = [];
    let promptTokens = 0;
    for (const text of texts) {
      const payload: Record<string, unknown> = { inputText: text };
      if (r.dimensions !== undefined) {
        payload.dimensions = r.dimensions; // Titan v2 only; v1 rejects it
      }
      const response = await this.invokeModel(r.model, payload, context);
      const body = await response.json() as {
        embedding?: number[];
        inputTextTokenCount?: number;
      };
      vectors.push(body.embedding ?? []);
      promptTokens += body.inputTextTokenCount ?? 0;
    }
    return embeddingResponse(r.model, vectors, promptTokens);
  }

  /**
   * Passthrough surface: `/files*` is emulated on S3 (file ids are
   * `s3://bucket/key` URIs, URL-encoded in gateway paths) and `/batches*`
   * translates to Model Invocation Jobs on the control plane. No retries —
   * multipart/creation bodies are not replayable.
   */
  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/files" || path.startsWith("/files/")) {
      return await this.filesProxy(path, req, context);
    }
    if (path === "/batches" || path.startsWith("/batches/")) {
      return await this.batchesProxy(path, req, context);
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `Bedrock passthrough supports /files* and /batches* only, got "${path}".`,
    );
  }

  // --- batches: Model Invocation Jobs (control plane, SigV4 "bedrock") ------

  /** SigV4-signs (service "bedrock") one control-plane request. */
  private async controlFetch(
    method: string,
    path: string,
    body?: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const url = `${this.controlEndpoint()}${path}`;
    const creds = await this.credentials();
    const headers = await signRequest({
      method,
      url,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body ?? "",
      region: this.options.region,
      service: "bedrock",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    return await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: context?.signal,
    });
  }

  private async batchesProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/batches") {
      if (req.method === "POST") {
        return await this.batchCreate(req, context);
      }
      return await this.batchList(req, context);
    }
    // Batch ids are job ARNs, URL-encoded by the client (single path segment).
    const rest = path.slice("/batches/".length);
    if (rest.endsWith("/results")) {
      const arn = decodeURIComponent(rest.slice(0, -"/results".length));
      return await this.batchResults(arn, context);
    }
    if (rest.endsWith("/cancel")) {
      const arn = decodeURIComponent(rest.slice(0, -"/cancel".length));
      return await this.batchCancel(arn, context);
    }
    return jsonResponse(
      await this.retrieveJobMapped(decodeURIComponent(rest), context),
    );
  }

  /** GETs a Model Invocation Job; control-plane errors surface as
   * ProviderError with the `{"__type","message"}` message extracted. */
  private async fetchJob(
    jobArn: string,
    context?: ProviderContext,
  ): Promise<BedrockJob> {
    const response = await this.controlFetch(
      "GET",
      `/model-invocation-job/${encodeURIComponent(jobArn)}`,
      undefined,
      context,
    );
    const text = await response.text();
    if (!response.ok) {
      throw bedrockControlError(response.status, response.statusText, text);
    }
    return JSON.parse(text) as BedrockJob;
  }

  /** Request counts live in S3 (`{output_s3_uri}/manifest.json.out`), not the
   * job API. A missing manifest (404 — job still in progress) or any other
   * failure simply omits the counts. */
  private async fetchManifestCounts(
    outputS3Uri: string | undefined,
    context?: ProviderContext,
  ): Promise<BatchRequestCounts | undefined> {
    if (!outputS3Uri) {
      return undefined;
    }
    const { bucket, key } = parseS3Uri(outputS3Uri);
    if (!bucket) {
      return undefined;
    }
    const base = key.replace(/^\/+|\/+$/g, "");
    const manifestKey = base === ""
      ? "manifest.json.out"
      : `${base}/manifest.json.out`;
    try {
      const response = await this.s3().getObject(
        bucket,
        manifestKey,
        context?.signal,
      );
      return manifestCounts(await response.json());
    } catch {
      return undefined;
    }
  }

  /** Retrieve = job GET + manifest counts, mapped to the OpenAI batch shape.
   * Shared by retrieve, create-hydration, and cancel re-retrieve. */
  private async retrieveJobMapped(
    jobArn: string,
    context?: ProviderContext,
  ): Promise<Record<string, unknown>> {
    const job = await this.fetchJob(jobArn, context);
    const counts = await this.fetchManifestCounts(
      job.outputDataConfig?.s3OutputDataConfig?.s3Uri,
      context,
    );
    return mapBedrockJob(job, counts);
  }

  private async batchCreate(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const body = await req.json().catch(() => {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock batch create requires a JSON body.",
      );
    }) as {
      input_file_id?: unknown;
      requests?: unknown;
      completion_window?: unknown;
      metadata?: unknown;
      model?: unknown;
      role_arn?: unknown;
      output_s3_uri?: unknown;
    };
    const metadata =
      (body.metadata && typeof body.metadata === "object"
        ? body.metadata
        : {}) as Record<string, unknown>;

    // Request-level overrides win over account config (Go parity).
    const roleArn =
      (typeof body.role_arn === "string" && body.role_arn !== ""
        ? body.role_arn
        : undefined) ?? this.options.batchRoleArn;
    if (!roleArn) {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock batch jobs require an IAM role ARN: set awsBatchRoleArn on " +
          "the account or pass role_arn in the request body.",
      );
    }
    const outputS3Uri =
      (typeof body.output_s3_uri === "string" && body.output_s3_uri !== ""
        ? body.output_s3_uri
        : undefined) ?? this.options.batchOutputS3Uri;
    if (!outputS3Uri) {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock batch jobs require an output S3 URI: set awsBatchOutputS3Uri " +
          "on the account or pass output_s3_uri in the request body.",
      );
    }
    // A request-supplied output_s3_uri must stay on the configured allowlist.
    this.assertBucketAllowed(parseS3Uri(outputS3Uri).bucket);

    const jobName =
      typeof metadata.job_name === "string" && metadata.job_name !== ""
        ? metadata.job_name
        : `frosty-batch-${Math.floor(Date.now() / 1000)}`;
    const model = typeof body.model === "string" && body.model !== ""
      ? body.model
      : typeof metadata.model === "string" && metadata.model !== ""
      ? metadata.model
      : undefined;

    // Input: either a caller-provided s3:// URI, or inline requests[] built
    // into JSONL and PUT into the output URI's bucket.
    let inputFileId = typeof body.input_file_id === "string"
      ? body.input_file_id
      : "";
    if (
      inputFileId === "" && Array.isArray(body.requests) &&
      body.requests.length > 0
    ) {
      if (!model) {
        throw new ProviderError(
          400,
          "Bad Request",
          "Bedrock inline batch requests require a model (body `model` or " +
            "`metadata.model`).",
        );
      }
      const jsonl = buildBatchInputJsonl(
        body.requests as Array<Record<string, unknown>>,
        model,
      );
      const inputKey = `bifrost-batch-input/${jobName}-${Date.now()}.jsonl`;
      const { bucket } = parseS3Uri(outputS3Uri);
      await this.s3().putObject(
        bucket,
        inputKey,
        new TextEncoder().encode(jsonl),
        "application/jsonl",
        context?.signal,
      );
      inputFileId = `s3://${bucket}/${inputKey}`;
    }
    if (inputFileId === "") {
      throw new ProviderError(
        400,
        "Bad Request",
        "either input_file_id (S3 URI) or a requests array is required for " +
          "Bedrock batches.",
      );
    }
    // A caller-provided input_file_id must also stay on the allowlist (an
    // inline-built input already lives in the validated output bucket).
    this.assertBucketAllowed(parseS3Uri(inputFileId).bucket);

    const createBody: Record<string, unknown> = {
      jobName,
      ...(model !== undefined ? { modelId: model } : {}),
      roleArn,
      inputDataConfig: {
        s3InputDataConfig: { s3Uri: inputFileId, s3InputFormat: "JSONL" },
      },
      outputDataConfig: { s3OutputDataConfig: { s3Uri: outputS3Uri } },
    };
    const timeoutHours = parseTimeoutHours(body.completion_window);
    if (timeoutHours !== undefined) {
      createBody.timeoutDurationInHours = timeoutHours;
    }

    const response = await this.controlFetch(
      "POST",
      "/model-invocation-job",
      JSON.stringify(createBody),
      context,
    );
    const text = await response.text();
    if (response.status !== 200 && response.status !== 201) {
      throw bedrockControlError(response.status, response.statusText, text);
    }
    const jobArn = (JSON.parse(text) as { jobArn?: string }).jobArn ?? "";

    // CreateModelInvocationJob returns only {jobArn}: hydrate via retrieve,
    // falling back to a minimal object when the retrieve fails (Go parity).
    try {
      const mapped = await this.retrieveJobMapped(jobArn, context);
      if (!mapped.input_file_id) {
        mapped.input_file_id = inputFileId;
      }
      return jsonResponse(mapped);
    } catch {
      return jsonResponse({
        id: jobArn,
        object: "batch",
        status: "validating",
        input_file_id: inputFileId,
      });
    }
  }

  private async batchList(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const query = new URL(req.url).searchParams;
    const params = new URLSearchParams();
    const limit = query.get("limit");
    if (limit) {
      params.set("maxResults", limit);
    }
    const after = query.get("after");
    if (after) {
      params.set("nextToken", after);
    }
    const qs = params.toString();
    const response = await this.controlFetch(
      "GET",
      `/model-invocation-jobs${qs === "" ? "" : `?${qs}`}`,
      undefined,
      context,
    );
    const text = await response.text();
    if (!response.ok) {
      throw bedrockControlError(response.status, response.statusText, text);
    }
    const parsed = JSON.parse(text) as {
      invocationJobSummaries?: BedrockJob[];
      nextToken?: string;
    };
    const out: Record<string, unknown> = {
      object: "list",
      data: (parsed.invocationJobSummaries ?? []).map((job) =>
        mapBedrockJob(job)
      ),
      has_more: !!parsed.nextToken,
    };
    if (parsed.nextToken) {
      out.last_id = parsed.nextToken; // native nextToken passes through as the cursor
    }
    return jsonResponse(out);
  }

  private async batchCancel(
    jobArn: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.controlFetch(
      "POST",
      `/model-invocation-job/${encodeURIComponent(jobArn)}/stop`,
      "",
      context,
    );
    const text = await response.text();
    if (!response.ok) {
      throw bedrockControlError(response.status, response.statusText, text);
    }
    // Re-retrieve for the fresh state; on failure answer a minimal
    // "cancelling" object rather than erroring the stop that succeeded.
    try {
      return jsonResponse(await this.retrieveJobMapped(jobArn, context));
    } catch {
      return jsonResponse({
        id: jobArn,
        object: "batch",
        status: "cancelling",
      });
    }
  }

  /** Results aggregation: list the output prefix, download every
   * `.jsonl.out`/`.jsonl` object (manifest skipped), and emit the mapped
   * OpenAI result lines as application/jsonl. When listing fails, fall back
   * to fetching the output URI directly as a single file (Go parity). */
  private async batchResults(
    jobArn: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const job = await this.fetchJob(jobArn, context);
    const outputS3Uri = job.outputDataConfig?.s3OutputDataConfig?.s3Uri ?? "";
    if (outputS3Uri === "") {
      throw new ProviderError(
        400,
        "Bad Request",
        "batch results not available: output S3 URI is empty (batch may not " +
          "be completed)",
      );
    }
    const { bucket, key } = parseS3Uri(outputS3Uri);
    const prefix = key.replace(/^\/+|\/+$/g, "");

    let keys: string[] | undefined;
    try {
      const found: string[] = [];
      let token: string | undefined;
      do {
        const page = await this.s3().listObjectsV2(bucket, {
          prefix,
          maxKeys: 100,
          continuationToken: token,
        }, context?.signal);
        for (const object of page.contents) {
          found.push(object.key);
        }
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      keys = found;
    } catch {
      keys = undefined;
    }

    const lines: string[] = [];
    if (keys === undefined) {
      // Listing failed: the output URI may already be a file path.
      try {
        const response = await this.s3().getObject(
          bucket,
          key,
          context?.signal,
        );
        lines.push(...mapBatchResultsJsonl(await response.text()));
      } catch {
        throw new ProviderError(
          502,
          "Bad Gateway",
          `failed to access batch results at ${outputS3Uri}: listing failed ` +
            "and direct access failed",
        );
      }
    } else {
      for (const objectKey of keys) {
        const basename = objectKey.slice(objectKey.lastIndexOf("/") + 1);
        if (basename === "manifest.json.out") {
          continue;
        }
        if (
          !objectKey.endsWith(".jsonl.out") && !objectKey.endsWith(".jsonl")
        ) {
          continue;
        }
        try {
          const response = await this.s3().getObject(
            bucket,
            objectKey,
            context?.signal,
          );
          lines.push(...mapBatchResultsJsonl(await response.text()));
        } catch {
          // Unreadable result file: skip it (Go logs + continues).
        }
      }
    }
    const body = lines.length > 0 ? lines.join("\n") + "\n" : "";
    return new Response(body, {
      headers: { "Content-Type": "application/jsonl" },
    });
  }

  // --- files: S3 emulation (no native API; SigV4 service "s3") --------------

  /**
   * Buckets this account is permitted to touch: the operator-configured
   * `awsS3Bucket` and the bucket of `awsBatchOutputS3Uri`. Request-supplied
   * `?bucket=` / `s3://` values are validated against this set so a caller
   * cannot aim the gateway's signed S3 operations at an arbitrary bucket the
   * IAM role happens to reach (confused-deputy). Empty set => fail closed.
   */
  private allowedBuckets(): Set<string> {
    const set = new Set<string>();
    if (this.options.s3Bucket) {
      set.add(parseS3Uri(this.options.s3Bucket).bucket);
    }
    if (this.options.batchOutputS3Uri) {
      set.add(parseS3Uri(this.options.batchOutputS3Uri).bucket);
    }
    set.delete("");
    return set;
  }

  /** Rejects any bucket not on the configured allowlist (fail-closed). */
  private assertBucketAllowed(bucket: string): void {
    const allowed = this.allowedBuckets();
    if (!allowed.has(bucket)) {
      throw new ProviderError(
        400,
        "Bad Request",
        "S3 bucket is not permitted for this account: only the configured " +
          "awsS3Bucket / awsBatchOutputS3Uri bucket(s) may be used.",
      );
    }
  }

  /** Bucket/prefix resolution: `?bucket=`/`?prefix=` query overrides beat the
   * account config; the bucket may itself be `s3://bucket/prefix` (merged).
   * The resolved bucket must be on the configured allowlist. */
  private resolveBucketPrefix(url: URL): { bucket: string; prefix: string } {
    const rawBucket = url.searchParams.get("bucket") ||
      this.options.s3Bucket || "";
    if (rawBucket === "") {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock file APIs require an S3 bucket: set awsS3Bucket on the " +
          "account or pass ?bucket=.",
      );
    }
    let prefix = url.searchParams.get("prefix") || this.options.s3Prefix || "";
    const parsed = parseS3Uri(rawBucket);
    if (parsed.key !== "") {
      prefix = parsed.key + prefix;
    }
    this.assertBucketAllowed(parsed.bucket);
    return { bucket: parsed.bucket, prefix };
  }

  /** Decodes a gateway file id (URL-encoded `s3://bucket/key`) and enforces
   * the bucket allowlist. */
  private parseFileId(id: string): { bucket: string; key: string } {
    const { bucket, key } = parseS3Uri(id);
    if (bucket === "" || key === "") {
      throw new ProviderError(
        400,
        "Bad Request",
        "invalid S3 URI format, expected s3://bucket/key",
      );
    }
    this.assertBucketAllowed(bucket);
    return { bucket, key };
  }

  private async filesProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    if (path === "/files") {
      if (req.method === "POST") {
        return await this.fileUpload(req, url, context);
      }
      return await this.fileList(url, context);
    }
    // File ids are s3:// URIs, URL-encoded to survive the single-segment
    // route parameter; decode before use.
    const rest = path.slice("/files/".length);
    if (rest.endsWith("/content")) {
      const id = decodeURIComponent(rest.slice(0, -"/content".length));
      return await this.fileContent(id, context);
    }
    const id = decodeURIComponent(rest);
    if (req.method === "DELETE") {
      return await this.fileDelete(id, context);
    }
    return await this.fileRetrieve(id, context);
  }

  private async fileUpload(
    req: Request,
    url: URL,
    context?: ProviderContext,
  ): Promise<Response> {
    const { bucket, prefix } = this.resolveBucketPrefix(url);
    const form = await req.formData().catch(() => {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock file upload requires a multipart body with a `file` field.",
      );
    });
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ProviderError(
        400,
        "Bad Request",
        "Bedrock file upload requires a `file` field.",
      );
    }
    const purposeEntry = form.get("purpose");
    const purpose = typeof purposeEntry === "string" && purposeEntry !== ""
      ? purposeEntry
      : "batch";
    const filename = file.name !== "" ? file.name : `file-${Date.now()}.jsonl`;
    const cleanedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    const key = cleanedPrefix === ""
      ? filename
      : `${cleanedPrefix}/${filename}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    await this.s3().putObject(
      bucket,
      key,
      bytes,
      "application/octet-stream",
      context?.signal,
    );
    return jsonResponse({
      id: `s3://${bucket}/${key}`,
      object: "file",
      bytes: bytes.length,
      created_at: Math.floor(Date.now() / 1000),
      filename,
      purpose,
      status: "processed",
    });
  }

  private async fileList(
    url: URL,
    context?: ProviderContext,
  ): Promise<Response> {
    const { bucket, prefix } = this.resolveBucketPrefix(url);
    const limit = url.searchParams.get("limit");
    const after = url.searchParams.get("after");
    const page = await this.s3().listObjectsV2(bucket, {
      prefix,
      ...(limit ? { maxKeys: Number(limit) } : {}),
      ...(after ? { continuationToken: after } : {}),
    }, context?.signal);
    const out: Record<string, unknown> = {
      object: "list",
      data: page.contents.map((object) => mapS3ObjectToFile(bucket, object)),
      has_more: page.isTruncated,
    };
    if (page.nextContinuationToken) {
      out.last_id = page.nextContinuationToken;
    }
    return jsonResponse(out);
  }

  private async fileRetrieve(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const { bucket, key } = this.parseFileId(id);
    const response = await this.s3().headObject(bucket, key, context?.signal);
    await response.body?.cancel();
    const bytes = Number(response.headers.get("content-length") ?? 0);
    const lastModified = response.headers.get("last-modified");
    const parsedMs = lastModified ? Date.parse(lastModified) : NaN;
    return jsonResponse({
      id,
      object: "file",
      bytes: Number.isFinite(bytes) ? bytes : 0,
      created_at: Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : 0,
      filename: key.slice(key.lastIndexOf("/") + 1),
      purpose: "batch",
      status: "processed",
    });
  }

  private async fileContent(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const { bucket, key } = this.parseFileId(id);
    const response = await this.s3().getObject(bucket, key, context?.signal);
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") ??
          "application/octet-stream",
      },
    });
  }

  private async fileDelete(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const { bucket, key } = this.parseFileId(id);
    await this.s3().deleteObject(bucket, key, context?.signal);
    return jsonResponse({ id, object: "file", deleted: true });
  }
}

/** JSON Response helper for the passthrough surface. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Coerces canonical embeddings input to a text array (Bedrock text-embedding
 * models take strings; numeric token inputs are rejected). */
function embeddingTexts(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input) && input.every((x) => typeof x === "string")) {
    return input as string[];
  }
  throw new ProviderError(
    400,
    "Bad Request",
    "Bedrock embeddings require string or string[] input; numeric token " +
      "inputs are not supported.",
  );
}

/** Builds the canonical OpenAI embeddings response from raw vectors. */
function embeddingResponse(
  model: string,
  vectors: number[][],
  promptTokens: number,
): Response {
  const data = vectors.map((embedding, index) => ({
    object: "embedding",
    index,
    embedding,
  }));
  const out = {
    object: "list",
    data,
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
  return new Response(JSON.stringify(out), {
    headers: { "Content-Type": "application/json" },
  });
}
