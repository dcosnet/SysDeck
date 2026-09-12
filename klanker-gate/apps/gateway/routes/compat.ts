import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolCall,
} from "../../../packages/contracts/src/mod.ts";
import {
  AnthropicMessagesRequestSchema,
  ToolCallSchema,
} from "../../../packages/contracts/src/mod.ts";
import {
  AnthropicStreamTranslator,
  createSSEResponse,
  type Router,
  translateSSEBody,
} from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import {
  carryGatewayHeaders,
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";
import { runChatCompletion } from "./inference.ts";

function blocksToText(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((b) => (typeof b.text === "string" ? b.text as string : ""))
    .join("");
}

/**
 * Anthropic `image` block -> canonical `image_url` part. Exact inverse of the
 * egress mapping in `packages/providers/src/anthropic.ts` (contentToBlocks),
 * so an Anthropic-in / Anthropic-out round trip preserves the image.
 */
function imageBlockToPart(
  block: Record<string, unknown>,
): { type: "image_url"; image_url: { url: string } } | null {
  const source = block.source as
    | { type?: string; media_type?: string; data?: string; url?: string }
    | undefined;
  if (!source) {
    return null;
  }
  if (typeof source.data === "string" && source.data.length > 0) {
    const media = source.media_type ?? "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${media};base64,${source.data}` },
    };
  }
  if (typeof source.url === "string" && source.url.length > 0) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Anthropic tool_choice -> canonical tool_choice (inverse of mapToolChoice). */
function mapAnthropicToolChoice(
  choice: unknown,
): ChatCompletionRequest["tool_choice"] {
  if (!choice || typeof choice !== "object") {
    return undefined;
  }
  const { type, name } = choice as { type?: string; name?: string };
  switch (type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      return name ? { type: "function", function: { name } } : "required";
    default:
      return undefined;
  }
}

function anthropicToCanonical(
  req: AnthropicMessagesRequest,
): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];

  if (req.system) {
    messages.push({ role: "system", content: blocksToText(req.system) });
  }

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    const textParts: string[] = [];
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> =
      [];
    const toolCalls: ToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const block of m.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        const part = imageBlockToPart(block);
        if (part) {
          imageParts.push(part);
        }
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          type: "function",
          function: {
            name: String(block.name ?? ""),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          id: String(block.tool_use_id ?? ""),
          content: typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? ""),
        });
      }
    }

    // Multimodal turns become canonical PART ARRAYS; text-only turns keep the
    // plain-string content shape they have always had.
    const text = textParts.join("");
    const multimodal = imageParts.length > 0;
    const parts = [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...imageParts,
    ];

    if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: multimodal ? parts : (text || null),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const result of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.content,
        });
      }
      if (textParts.length > 0 || multimodal || toolResults.length === 0) {
        messages.push({
          role: "user",
          content: multimodal ? parts : text,
        });
      }
    }
  }

  // Native fields with no canonical equivalent (top_k, thinking, metadata,
  // service_tier and any unknown vendor key the passthrough schema admitted)
  // ride along to egress rather than being silently dropped here.
  const {
    model: _model,
    messages: _messages,
    system: _system,
    max_tokens: _maxTokens,
    temperature: _temperature,
    top_p: _topP,
    stop_sequences: _stopSequences,
    tools: _tools,
    tool_choice: _toolChoice,
    stream: _stream,
    ...carried
  } = req as AnthropicMessagesRequest & Record<string, unknown>;

  return {
    ...carried,
    model: req.model,
    messages,
    stream: req.stream,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences,
    tools: req.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    tool_choice: mapAnthropicToolChoice(
      (req as Record<string, unknown>).tool_choice,
    ),
  };
}

function mapFinishToStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function canonicalToAnthropic(
  chat: ChatCompletionResponse,
): AnthropicMessagesResponse {
  const message = chat.choices[0]?.message;
  const content: Array<Record<string, unknown>> = [];

  // Reasoning leads the block list, exactly where an extended-thinking
  // response carries it on the real wire.
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message?.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const raw of message?.tool_calls ?? []) {
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
      type: "tool_use",
      id: parsed.data.id,
      name: parsed.data.function.name,
      input,
    });
  }

  const usage = chat.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;

  return {
    id: chat.id.replace(/^chatcmpl-/, "msg_"),
    type: "message",
    role: "assistant",
    model: chat.model,
    content,
    stop_reason: mapFinishToStopReason(chat.choices[0]?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

export function registerCompatRoutes(router: Router, ctx: AppContext): void {
  // Where an Anthropic SDK's client.messages.count_tokens() actually posts.
  // Same policy as POST /v1/count_tokens: native counting where the provider
  // offers it, else the documented chars/4 estimate.
  router.post("/v1/messages/count_tokens", async (req) => {
    const parsed = AnthropicMessagesRequestSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.compat.anthropic_count_tokens");
    try {
      const canonical = anthropicToCanonical(parsed.data);
      const target = ctx.providers.resolve(canonical.model);
      if (target.adapter.countTokens) {
        const counted = await target.adapter.countTokens(
          { ...canonical, model: target.model },
          { signal: req.signal },
        );
        return jsonResponse(counted);
      }
      const chars = canonical.messages
        .map((m) => (typeof m.content === "string" ? m.content.length : 0))
        .reduce((a, b) => a + b, 0);
      return jsonResponse({
        input_tokens: Math.ceil(chars / 4),
        estimated: true,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Anthropic-native Messages endpoint so Anthropic SDK clients can point
  // their base URL at the gateway. Streams translate the canonical chunk
  // stream into Anthropic Messages events at the edge (wave-2).
  router.post("/v1/messages", async (req) => {
    const parsed = AnthropicMessagesRequestSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const request = parsed.data;
    ctx.metrics.increment("requests.compat.anthropic");

    try {
      // One shared canonical execution for every dialect (runChatCompletion):
      // cache, plugins, the tool loop, capability gates and budget accounting
      // apply here exactly as they do on /v1/chat/completions. The plugin
      // stream tap lives inside it, on the CANONICAL stream, before this
      // edge translation (decision-log 15).
      const canonical = anthropicToCanonical(request);
      const response = await runChatCompletion(ctx, req, canonical);
      if (!response.ok) {
        return response;
      }
      if (canonical.stream) {
        return carryGatewayHeaders(
          response,
          createSSEResponse(
            translateSSEBody(
              response.body!,
              new AnthropicStreamTranslator(request.model),
            ),
          ),
        );
      }
      const chat = await response.json() as ChatCompletionResponse;
      return carryGatewayHeaders(
        response,
        jsonResponse(canonicalToAnthropic(chat)),
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });
}
