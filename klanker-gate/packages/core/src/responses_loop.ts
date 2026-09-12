import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatTool,
  ResponsesRequest,
  ResponsesResponse,
} from "../../contracts/src/mod.ts";
import { extractToolCalls } from "./orchestrator.ts";

/**
 * Responses "agent loop" bridge. Non-streaming POST /v1/responses reuses the
 * canonical Chat Completions tool loop (runToolLoop): this module maps a
 * Responses request onto a chat request (forwarding tools + tool_choice) and
 * maps the final chat response back onto the Responses envelope. The route
 * runs the shared runToolLoop over the result of `responsesToChatRequest`,
 * exactly like /v1/chat/completions, and honors the same side-effect gate.
 *
 * EXECUTION CONTRACT (mirrors packages/contracts/src/responses.ts): only
 * `function` tools (mapped 1:1 below) and `mcp` tools (expanded by the caller
 * into the gateway's aggregated MCP catalog and handed in as `extraTools`) are
 * ever executed. Every other built-in/hosted tool type is accepted but has no
 * executable Chat Completions representation, so it is not mapped here (on the
 * native-passthrough path such tools are forwarded to the provider verbatim).
 */

type LooseTool = {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
};

/**
 * Maps Responses `function` tools (flat `{type,name,parameters}`) to the nested
 * Chat Completions function-tool shape. Non-function/built-in tool types are
 * skipped: they cannot be represented as — nor executed via — a chat tool.
 */
function responsesFunctionToolsToChat(
  tools: readonly unknown[] | undefined,
): ChatTool[] {
  const out: ChatTool[] = [];
  for (const tool of tools ?? []) {
    const t = tool as LooseTool;
    if (t.type !== "function" || typeof t.name !== "string") {
      continue;
    }
    const fn: ChatTool["function"] = { name: t.name };
    if (typeof t.description === "string") {
      fn.description = t.description;
    }
    if (t.parameters && typeof t.parameters === "object") {
      fn.parameters = t.parameters as Record<string, unknown>;
    }
    out.push({ type: "function", function: fn });
  }
  return out;
}

/**
 * Maps a Responses tool_choice onto the Chat Completions tool_choice shape.
 * Keyword forms (`auto`/`none`/`required`) pass through; a Responses
 * `{type:"function", name}` selector is renested under `function`; hosted-tool
 * selectors (no chat equivalent) are dropped so the chat upstream never sees a
 * choice it cannot honor.
 */
function responsesToolChoiceToChat(
  choice: unknown,
): ChatCompletionRequest["tool_choice"] {
  if (choice === undefined) {
    return undefined;
  }
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  const c = choice as { type?: unknown; name?: unknown };
  if (c.type === "function" && typeof c.name === "string") {
    return { type: "function", function: { name: c.name } };
  }
  return undefined;
}

/**
 * Flattens a Responses request onto the canonical chat request. `instructions`
 * becomes a system message; string or structured `input` becomes user/assistant
 * messages. Request `function` tools plus any `extraTools` (e.g. the expanded
 * MCP catalog) are forwarded, together with a mapped tool_choice.
 *
 * BACKWARD COMPAT: when the request carries no tools/tool_choice, the produced
 * chat request is byte-identical to the pre-agent-loop translation.
 */
export function responsesToChatRequest(
  req: ResponsesRequest,
  extraTools: readonly unknown[] = [],
): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else {
    for (const item of req.input) {
      const role = item.role === "developer" ? "system" : item.role;
      const content = typeof item.content === "string"
        ? item.content
        : item.content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("");
      messages.push({ role, content });
    }
  }

  const chat: ChatCompletionRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_output_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
  };

  const tools = [...responsesFunctionToolsToChat(req.tools), ...extraTools];
  if (tools.length > 0) {
    chat.tools = tools;
  }
  const toolChoice = responsesToolChoiceToChat(req.tool_choice);
  if (toolChoice !== undefined) {
    chat.tool_choice = toolChoice;
  }
  return chat;
}

/**
 * Maps a final chat response onto the Responses envelope. The assistant text
 * becomes an `output_text` message item (unchanged from the original mapping);
 * any tool calls the loop handed back — client-owned tools the gateway executor
 * does not run — are surfaced as `function_call` output items so the caller can
 * execute them and continue the conversation.
 */
export function responsesFromChat(
  request: ResponsesRequest,
  chat: ChatCompletionResponse,
): ResponsesResponse {
  const message = chat.choices[0]?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  const usage = chat.usage as
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    | undefined;

  const output: Array<Record<string, unknown>> = [{
    id: `msg_${chat.created}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }];

  for (const call of extractToolCalls(chat)) {
    output.push({
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  return {
    id: `resp_${(chat.id ?? "").replace(/^chatcmpl-/, "")}`,
    object: "response",
    created_at: chat.created,
    status: "completed",
    model: request.model,
    output,
    output_text: text,
    usage: usage
      ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
      : undefined,
  };
}
