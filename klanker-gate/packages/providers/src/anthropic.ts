import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Message,
  ToolCall,
} from "../../contracts/src/mod.ts";
import { ToolCallSchema } from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  ANTHROPIC_FILES_BETA,
  buildBatchRequests,
  mapAnthropicBatch,
  mapAnthropicFile,
  mapBatchResultLine,
} from "./anthropic_advanced.ts";
import type {
  AnthropicBatchResultLine,
  AnthropicBatchWire,
  AnthropicFileWire,
} from "./anthropic_advanced.ts";
import {
  type CanonicalChunk,
  createSSEResponse,
  NormalizationPipeline,
} from "../../core/src/mod.ts";

function mapStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}

function contentToText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        const p = part as Record<string, unknown>;
        return typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return "";
}

/**
 * OpenAI content parts -> Anthropic content blocks. Plain strings pass
 * through; image_url parts become base64 or URL image sources instead of
 * being dropped. Unrecognized parts are skipped.
 */
function contentToBlocks(
  content: Message["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : String(
        (p.image_url as Record<string, unknown> | undefined)?.url ?? "",
      );
      const dataUrl = url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (dataUrl) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: dataUrl[1],
            data: dataUrl[2],
          },
        });
      } else if (/^https?:\/\//.test(url)) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    } else if (typeof p.text === "string" && p.text.length > 0) {
      blocks.push({ type: "text", text: p.text });
    }
  }
  return blocks.length > 0 ? blocks : "";
}

/** Canonical OpenAI tool_choice -> Anthropic tool_choice. */
function mapToolChoice(choice: unknown): Record<string, unknown> | undefined {
  switch (choice) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
  }
  const c = choice as
    | { type?: string; function?: { name?: string } }
    | null
    | undefined;
  if (c?.type === "function" && typeof c.function?.name === "string") {
    return { type: "tool", name: c.function.name };
  }
  return undefined;
}

interface AnthropicStreamEvent {
  type?: string;
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
}

/**
 * Translates Anthropic Messages SSE events into canonical OpenAI chunks,
 * including tool-use deltas. Receives complete lines from the pipeline's
 * LineSplitterStream, so events split across network chunks are safe.
 * Usage from message_start/message_delta surfaces as a final empty-choices
 * chunk (OpenAI stream_options.include_usage shape) on message_stop —
 * downstream governance parses the SSE tail for exactly this.
 */
export class AnthropicSSETransformer
  extends TransformStream<string, CanonicalChunk> {
  constructor(model: string, created: number) {
    const id = `chatcmpl-${created}`;
    let toolIndex = -1;
    let inToolBlock = false;
    let finishSent = false;
    let promptTokens = 0;
    let completionTokens = 0;

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
      transform(line, controller) {
        if (!line.startsWith("data:")) {
          return; // ignore `event:` lines and blanks
        }
        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          return;
        }

        switch (event.type) {
          case "message_start":
            promptTokens = event.message?.usage?.input_tokens ?? promptTokens;
            controller.enqueue(chunk({ role: "assistant", content: "" }));
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use") {
              inToolBlock = true;
              toolIndex += 1;
              controller.enqueue(chunk({
                tool_calls: [{
                  index: toolIndex,
                  id: event.content_block.id,
                  type: "function",
                  function: {
                    name: event.content_block.name,
                    arguments: "",
                  },
                }],
              }));
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              controller.enqueue(chunk({ content: event.delta.text }));
            } else if (
              event.delta?.type === "input_json_delta" && inToolBlock
            ) {
              controller.enqueue(chunk({
                tool_calls: [{
                  index: toolIndex,
                  function: { arguments: event.delta.partial_json ?? "" },
                }],
              }));
            }
            break;
          case "content_block_stop":
            inToolBlock = false;
            break;
          case "message_delta": {
            completionTokens = event.usage?.output_tokens ?? completionTokens;
            const reason = mapStopReason(event.delta?.stop_reason);
            if (reason && !finishSent) {
              finishSent = true;
              controller.enqueue(chunk({}, reason));
            }
            break;
          }
          case "message_stop":
            if (!finishSent) {
              finishSent = true;
              controller.enqueue(chunk({}, "stop"));
            }
            controller.enqueue({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            });
            break;
        }
      },
      flush(controller) {
        controller.enqueue("[DONE]");
      },
    });
  }
}

interface AnthropicResponseBody {
  id?: string;
  model?: string;
  content?: Array<Record<string, unknown>>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicAdapter implements IProviderAdapter {
  constructor(
    private apiKey: string,
    private version: string = "2023-06-01",
    private baseUrl: string = "https://api.anthropic.com/v1",
    private client: ProviderClient = new ProviderClient(),
    /**
     * Per-provider beta-header overrides ({prefix: "default"|"enabled"|
     * "disabled"}) from the account's betaHeaders group. Prefixes set to
     * "enabled" are joined into the `anthropic-beta` request header. The
     * gateway sets no default betas, so "disabled"/"default" are inert today.
     */
    private betaHeaders?: Record<string, "default" | "enabled" | "disabled">,
  ) {}

  /** Base auth/version headers plus any enabled `anthropic-beta` prefixes. */
  private messagesHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
    };
    const beta = this.betaHeaderValue();
    if (beta) {
      headers["anthropic-beta"] = beta;
    }
    return headers;
  }

  /** Auth/version headers for native Files API calls: the constant
   * files-api beta, comma-merged with any account-enabled betas. No
   * Content-Type — callers set it (or let fetch set the multipart boundary). */
  private filesHeaders(): Record<string, string> {
    const beta = this.betaHeaderValue();
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
      "anthropic-beta": beta
        ? `${ANTHROPIC_FILES_BETA},${beta}`
        : ANTHROPIC_FILES_BETA,
    };
  }

  private betaHeaderValue(): string | undefined {
    if (!this.betaHeaders) {
      return undefined;
    }
    const enabled = Object.entries(this.betaHeaders)
      .filter(([, mode]) => mode === "enabled")
      .map(([prefix]) => prefix);
    return enabled.length > 0 ? enabled.join(",") : undefined;
  }

  mapToAnthropic(req: ChatCompletionRequest): Record<string, unknown> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map(contentToText)
      .join("\n") || undefined;

    const messages: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === "system" || m.role === "function") {
        continue;
      }
      if (m.role === "tool") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: contentToText(m),
          }],
        });
      } else if (m.role === "assistant" && m.tool_calls?.length) {
        const blocks: Array<Record<string, unknown>> = [];
        const text = contentToText(m);
        if (text) {
          blocks.push({ type: "text", text });
        }
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
          blocks.push({
            type: "tool_use",
            id: parsed.data.id,
            name: parsed.data.function.name,
            input,
          });
        }
        messages.push({ role: "assistant", content: blocks });
      } else {
        messages.push({
          role: m.role === "user" ? "user" : "assistant",
          content: contentToBlocks(m.content),
        });
      }
    }

    const tools = req.tools?.map((t) => {
      const raw = t as Record<string, unknown>;
      const fn = (raw.function ?? raw) as Record<string, unknown>;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters ?? { type: "object" },
      };
    });

    return {
      model: req.model,
      system,
      messages,
      max_tokens: req.max_tokens ?? 1024,
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.top_p,
      stop_sequences: req.stop === undefined
        ? undefined
        : Array.isArray(req.stop)
        ? req.stop
        : [req.stop],
      tools,
      tool_choice: tools && tools.length > 0
        ? mapToolChoice(req.tool_choice)
        : undefined,
    };
  }

  mapFromAnthropic(
    body: AnthropicResponseBody,
    requestModel: string,
    created: number,
  ): ChatCompletionResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of body.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          type: "function",
          function: {
            name: String(block.name ?? ""),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const promptTokens = body.usage?.input_tokens ?? 0;
    const completionTokens = body.usage?.output_tokens ?? 0;

    return {
      id: `chatcmpl-${body.id ?? created}`,
      object: "chat.completion",
      created,
      model: body.model ?? requestModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(body.stop_reason) ?? "stop",
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/messages`,
      {
        method: "POST",
        headers: this.messagesHeaders(),
        body: JSON.stringify(this.mapToAnthropic(req)),
        signal: context?.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new ProviderError(response.status, response.statusText, body);
    }

    const created = Math.floor(Date.now() / 1000);

    if (req.stream && response.body) {
      const transformer = new AnthropicSSETransformer(req.model, created);
      return createSSEResponse(
        NormalizationPipeline.create(transformer, response.body),
      );
    }

    const body = await response.json() as AnthropicResponseBody;
    return new Response(
      JSON.stringify(this.mapFromAnthropic(body, req.model, created)),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  async listModels(context?: ProviderContext): Promise<string[]> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/models`,
      {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
        },
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id);
  }

  /** Native token counting via /messages/count_tokens, which rejects
   * sampling fields — only the counted surface may be forwarded. */
  async countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    const mapped = this.mapToAnthropic(req);
    const payload: Record<string, unknown> = {};
    for (const key of ["model", "messages", "system", "tools", "tool_choice"]) {
      if (mapped[key] !== undefined) {
        payload[key] = mapped[key];
      }
    }
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/messages/count_tokens`,
      {
        method: "POST",
        headers: this.messagesHeaders(),
        body: JSON.stringify(payload),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as { input_tokens?: number };
    return { input_tokens: body.input_tokens ?? 0, estimated: false };
  }

  /**
   * Translating passthrough for the gateway's OpenAI-wire /files and
   * /batches endpoints (ElevenLabs precedent): files map to the native Files
   * API (files-api beta), batches to the Message Batches API (no files
   * beta). Upstream bodies are buffered/rebuilt, never streamed, so calls
   * stay replay-safe; errors surface as ProviderError with the raw upstream
   * body preserved.
   */
  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/files") {
      return req.method === "POST"
        ? await this.uploadFile(req, context)
        : await this.listFiles(req, context);
    }
    let match = path.match(/^\/files\/([^/]+)\/content$/);
    if (match) {
      return await this.fileContent(decodeURIComponent(match[1]), context);
    }
    match = path.match(/^\/files\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      return req.method === "DELETE"
        ? await this.deleteFile(id, context)
        : await this.getFile(id, context);
    }
    if (path === "/batches") {
      return req.method === "POST"
        ? await this.createBatch(req, context)
        : await this.listBatches(req, context);
    }
    match = path.match(/^\/batches\/([^/]+)\/results$/);
    if (match) {
      return await this.batchResults(decodeURIComponent(match[1]), context);
    }
    match = path.match(/^\/batches\/([^/]+)\/cancel$/);
    if (match) {
      return await this.cancelBatch(decodeURIComponent(match[1]), context);
    }
    match = path.match(/^\/batches\/([^/]+)$/);
    if (match) {
      return await this.getBatch(decodeURIComponent(match[1]), context);
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `Anthropic passthrough supports /files and /batches endpoints only, ` +
        `got "${path}".`,
    );
  }

  /** Fetch through the account client; non-2xx throws ProviderError with the
   * upstream body. All rawProxy bodies are buffered, so this is replay-safe. */
  private async proxyFetch(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  private static json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** POST /files: rebuild the incoming OpenAI multipart (file + purpose) as
   * Anthropic's single-field `file` multipart — Anthropic has no purpose. */
  private async uploadFile(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new ProviderError(
        400,
        "Bad Request",
        "Anthropic file upload requires a multipart `file` field.",
      );
    }
    const filename = file instanceof File && file.name ? file.name : "file";
    const upstream = new FormData();
    upstream.append("file", file, filename);
    const response = await this.proxyFetch(`${this.baseUrl}/files`, {
      method: "POST",
      // No Content-Type: fetch sets the multipart boundary itself.
      headers: this.filesHeaders(),
      body: upstream,
      signal: context?.signal,
    });
    const body = await response.json() as AnthropicFileWire;
    return AnthropicAdapter.json(mapAnthropicFile(body));
  }

  /** GET /files?limit=&after= -> native /files?limit=&after_id=. */
  private async listFiles(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const incoming = new URL(req.url).searchParams;
    const query = new URLSearchParams();
    const limit = incoming.get("limit");
    if (limit) {
      query.set("limit", limit);
    }
    const after = incoming.get("after");
    if (after) {
      query.set("after_id", after);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const response = await this.proxyFetch(`${this.baseUrl}/files${suffix}`, {
      headers: this.filesHeaders(),
      signal: context?.signal,
    });
    const body = await response.json() as {
      data?: AnthropicFileWire[];
      has_more?: boolean;
      first_id?: string | null;
      last_id?: string | null;
    };
    return AnthropicAdapter.json({
      object: "list",
      data: (body.data ?? []).map(mapAnthropicFile),
      has_more: body.has_more ?? false,
      first_id: body.first_id ?? null,
      last_id: body.last_id ?? null,
    });
  }

  private async getFile(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/files/${encodeURIComponent(id)}`,
      { headers: this.filesHeaders(), signal: context?.signal },
    );
    const body = await response.json() as AnthropicFileWire;
    return AnthropicAdapter.json(mapAnthropicFile(body));
  }

  /** DELETE /files/:id. Upstream 204 synthesizes the OpenAI delete envelope;
   * 200 reports deleted from the native `type === "file_deleted"`. */
  private async deleteFile(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/files/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: this.filesHeaders(),
        signal: context?.signal,
      },
    );
    if (response.status === 204) {
      await response.body?.cancel();
      return AnthropicAdapter.json({ id, object: "file", deleted: true });
    }
    const body = await response.json() as { id?: string; type?: string };
    return AnthropicAdapter.json({
      id: body.id ?? id,
      object: "file",
      deleted: body.type === "file_deleted",
    });
  }

  /** GET /files/:id/content: raw bytes with the upstream Content-Type. */
  private async fileContent(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/files/${encodeURIComponent(id)}/content`,
      { headers: this.filesHeaders(), signal: context?.signal },
    );
    const contentType = response.headers.get("Content-Type") ??
      "application/octet-stream";
    return new Response(response.body, {
      headers: { "Content-Type": contentType },
    });
  }

  /**
   * POST /batches. Accepts either native `requests[]` (forwarded verbatim —
   * params is an opaque map, Go parity) or an OpenAI `input_file_id`, whose
   * JSONL content is fetched (files beta header) and converted per line via
   * mapToAnthropic. Neither -> 400.
   */
  private async createBatch(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const body = await req.json() as Record<string, unknown>;
    let requests: unknown;
    if (Array.isArray(body.requests)) {
      requests = body.requests;
    } else if (
      typeof body.input_file_id === "string" && body.input_file_id !== ""
    ) {
      const content = await this.proxyFetch(
        `${this.baseUrl}/files/${
          encodeURIComponent(body.input_file_id)
        }/content`,
        { headers: this.filesHeaders(), signal: context?.signal },
      );
      requests = buildBatchRequests(await content.text(), (line) => {
        if (!Array.isArray(line.messages)) {
          throw new ProviderError(
            400,
            "Bad Request",
            "OpenAI batch input line `body` must carry a `messages` array.",
          );
        }
        return this.mapToAnthropic(line as unknown as ChatCompletionRequest);
      });
    } else {
      throw new ProviderError(
        400,
        "Bad Request",
        "Anthropic batch create requires either `requests[]` or an " +
          "`input_file_id`.",
      );
    }
    const response = await this.proxyFetch(
      `${this.baseUrl}/messages/batches`,
      {
        method: "POST",
        headers: this.messagesHeaders(),
        body: JSON.stringify({ requests }),
        signal: context?.signal,
      },
    );
    const created = await response.json() as AnthropicBatchWire;
    return AnthropicAdapter.json(mapAnthropicBatch(created));
  }

  private async getBatch(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/messages/batches/${encodeURIComponent(id)}`,
      { headers: this.messagesHeaders(), signal: context?.signal },
    );
    const body = await response.json() as AnthropicBatchWire;
    return AnthropicAdapter.json(mapAnthropicBatch(body));
  }

  /** GET /batches?limit=&after= -> native ?limit=&after_id=. */
  private async listBatches(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const incoming = new URL(req.url).searchParams;
    const query = new URLSearchParams();
    const limit = incoming.get("limit");
    if (limit) {
      query.set("limit", limit);
    }
    const after = incoming.get("after");
    if (after) {
      query.set("after_id", after);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const response = await this.proxyFetch(
      `${this.baseUrl}/messages/batches${suffix}`,
      { headers: this.messagesHeaders(), signal: context?.signal },
    );
    const body = await response.json() as {
      data?: AnthropicBatchWire[];
      has_more?: boolean;
      first_id?: string | null;
      last_id?: string | null;
    };
    return AnthropicAdapter.json({
      object: "list",
      data: (body.data ?? []).map(mapAnthropicBatch),
      has_more: body.has_more ?? false,
      first_id: body.first_id ?? null,
      last_id: body.last_id ?? null,
    });
  }

  private async cancelBatch(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/messages/batches/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        headers: this.messagesHeaders(),
        signal: context?.signal,
      },
    );
    const body = await response.json() as AnthropicBatchWire;
    return AnthropicAdapter.json(mapAnthropicBatch(body));
  }

  /** GET /batches/:id/results: native JSONL re-emitted line-by-line in the
   * OpenAI batch-output shape. Unparseable lines are skipped (Go parity). */
  private async batchResults(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.proxyFetch(
      `${this.baseUrl}/messages/batches/${encodeURIComponent(id)}/results`,
      { headers: this.messagesHeaders(), signal: context?.signal },
    );
    const text = await response.text();
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        out.push(JSON.stringify(
          mapBatchResultLine(JSON.parse(trimmed) as AnthropicBatchResultLine),
        ));
      } catch {
        // Skip unparseable lines rather than failing the whole download.
      }
    }
    return new Response(out.length > 0 ? out.join("\n") + "\n" : "", {
      headers: { "Content-Type": "application/jsonl" },
    });
  }
}
