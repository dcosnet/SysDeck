import type { ChatCompletionRequest } from "../../contracts/src/mod.ts";
import { ToolCallSchema } from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  type CanonicalChunk,
  createSSEResponse,
  NormalizationPipeline,
} from "../../core/src/mod.ts";

// Cohere v2 chat/embed/tokenize translation (behavioral reference:
// core/providers/cohere/*.go). Tools translate to Cohere v2's OpenAI-shaped
// tool surface in both directions.

function mapFinish(reason: string | undefined): string {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "TOOL_CALL":
      return "tool_calls";
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

/** Canonical OpenAI tool_choice -> Cohere v2 tool_choice. Cohere accepts only
 * REQUIRED/NONE; auto (the default) and unmapped values are omitted. */
function mapToolChoice(choice: unknown): string | undefined {
  switch (choice) {
    case "none":
      return "NONE";
    case "required":
      return "REQUIRED";
  }
  const c = choice as { type?: string } | null | undefined;
  if (c?.type === "function") {
    return "REQUIRED";
  }
  return undefined;
}

/** Canonical OpenAI tools -> Cohere v2 tools (same function shape, no strict). */
function mapTools(tools: unknown[]): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const raw = t as Record<string, unknown>;
    const fn = (raw.function ?? raw) as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? { type: "object", properties: {} },
      },
    };
  });
}

/** Canonical messages -> Cohere v2 messages, preserving tool_calls and tool
 * results (the surface that makes tool conversations round-trip). */
function mapMessages(
  messages: ChatCompletionRequest["messages"],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "function") {
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: contentText(m.content),
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const raw of m.tool_calls) {
        const parsed = ToolCallSchema.safeParse(raw);
        if (!parsed.success) {
          continue;
        }
        toolCalls.push({
          id: parsed.data.id,
          type: "function",
          function: {
            name: parsed.data.function.name,
            arguments: parsed.data.function.arguments,
          },
        });
      }
      const text = contentText(m.content);
      out.push({
        role: "assistant",
        ...(text.length > 0 ? { content: text } : {}),
        tool_calls: toolCalls,
      });
      continue;
    }
    out.push({ role: m.role, content: contentText(m.content) });
  }
  return out;
}

interface CohereToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface CohereV2Response {
  id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    tool_calls?: CohereToolCall[];
    tool_plan?: string;
  };
  finish_reason?: string;
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
  };
}

/** Cohere v2 stream events -> canonical OpenAI chat chunks. */
export class CohereStreamTransformer
  extends TransformStream<string, CanonicalChunk> {
  constructor(model: string) {
    const id = `chatcmpl-cohere-${crypto.randomUUID().slice(0, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: "chat.completion.chunk", created, model };
    super({
      transform(line, controller) {
        if (!line.startsWith("data:")) {
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          return;
        }
        const toolIndex = typeof event.index === "number" ? event.index : 0;
        if (event.type === "content-delta") {
          const delta = event.delta as
            | { message?: { content?: { text?: string } } }
            | undefined;
          const text = delta?.message?.content?.text ?? "";
          if (text.length > 0) {
            controller.enqueue({
              ...base,
              choices: [{
                index: 0,
                delta: { content: text },
                finish_reason: null,
              }],
            });
          }
        } else if (event.type === "tool-call-start") {
          const tc = (event.delta as {
            message?: { tool_calls?: CohereToolCall };
          } | undefined)?.message?.tool_calls;
          if (tc) {
            controller.enqueue({
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolIndex,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function?.name ?? "",
                      arguments: tc.function?.arguments ?? "",
                    },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
        } else if (event.type === "tool-call-delta") {
          const tc = (event.delta as {
            message?: { tool_calls?: CohereToolCall };
          } | undefined)?.message?.tool_calls;
          if (tc?.function) {
            controller.enqueue({
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolIndex,
                    function: { arguments: tc.function.arguments ?? "" },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
        } else if (event.type === "message-end") {
          const delta = event.delta as {
            finish_reason?: string;
            usage?: {
              billed_units?: { input_tokens?: number; output_tokens?: number };
            };
          } | undefined;
          controller.enqueue({
            ...base,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: mapFinish(delta?.finish_reason),
            }],
            ...(delta?.usage?.billed_units
              ? {
                usage: {
                  prompt_tokens: delta.usage.billed_units.input_tokens ?? 0,
                  completion_tokens: delta.usage.billed_units.output_tokens ??
                    0,
                },
              }
              : {}),
          });
        }
      },
      flush(controller) {
        controller.enqueue("[DONE]");
      },
    });
  }
}

export class CohereAdapter implements IProviderAdapter {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.cohere.com",
    private client: ProviderClient = new ProviderClient(),
  ) {
    this.baseUrl = this.baseUrl.replace(/\/$/, "");
  }

  private async post(
    path: string,
    body: unknown,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const tools = req.tools?.length ? mapTools(req.tools) : undefined;
    const toolChoice = tools ? mapToolChoice(req.tool_choice) : undefined;
    const body = {
      model: req.model,
      messages: mapMessages(req.messages),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...(req.top_p !== undefined ? { p: req.top_p } : {}),
      ...(req.stop !== undefined
        ? { stop_sequences: Array.isArray(req.stop) ? req.stop : [req.stop] }
        : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(req.stream ? { stream: true } : {}),
    };

    const response = await this.post("/v2/chat", body, context);
    if (req.stream && response.body) {
      return createSSEResponse(
        NormalizationPipeline.create(
          new CohereStreamTransformer(req.model),
          response.body,
        ),
      );
    }

    const cohere = await response.json() as CohereV2Response;
    const text = (cohere.message?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const toolCalls = (cohere.message?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      type: "function",
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      },
    }));
    const message = toolCalls.length > 0
      ? {
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls,
      }
      : { role: "assistant", content: text };
    const chat = {
      id: cohere.id
        ? `chatcmpl-${cohere.id}`
        : `chatcmpl-cohere-${crypto.randomUUID().slice(0, 8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{
        index: 0,
        message,
        finish_reason: mapFinish(cohere.finish_reason),
      }],
      usage: {
        prompt_tokens: cohere.usage?.billed_units?.input_tokens ?? 0,
        completion_tokens: cohere.usage?.billed_units?.output_tokens ?? 0,
        total_tokens: (cohere.usage?.billed_units?.input_tokens ?? 0) +
          (cohere.usage?.billed_units?.output_tokens ?? 0),
      },
    };
    return new Response(JSON.stringify(chat), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    const r = req as { model: string; input: string | string[] };
    const texts = Array.isArray(r.input) ? r.input : [r.input];
    const response = await this.post("/v2/embed", {
      model: r.model,
      texts,
      input_type: "search_query",
      embedding_types: ["float"],
    }, context);
    const cohere = await response.json() as {
      embeddings?: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };
    const vectors = cohere.embeddings?.float ?? [];
    const out = {
      object: "list",
      data: vectors.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding,
      })),
      model: r.model,
      usage: {
        prompt_tokens: cohere.meta?.billed_units?.input_tokens ?? 0,
        total_tokens: cohere.meta?.billed_units?.input_tokens ?? 0,
      },
    };
    return new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Native token pre-flight via Cohere's /v1/tokenize. Messages are flattened
   * to a single text payload; the token count is the length of the tokens. */
  async countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    const text = req.messages
      .map((m) => contentText(m.content))
      .filter((t) => t.length > 0)
      .join("\n");
    const response = await this.post("/v1/tokenize", {
      model: req.model,
      text,
    }, context);
    const body = await response.json() as {
      tokens?: number[];
      token_strings?: string[];
    };
    const count = body.tokens?.length ?? body.token_strings?.length ?? 0;
    return { input_tokens: count, estimated: false };
  }
}
