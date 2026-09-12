import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Message,
  ToolCall,
} from "../../contracts/src/mod.ts";
import { ToolCallSchema } from "../../contracts/src/mod.ts";

/**
 * Gateway-side tool execution surface. MCP-backed in the plugin runtime;
 * tests use scripted executors. Tools the executor does not own are treated
 * as client tools and returned to the caller untouched.
 */
/** A tool bound at resolution time: gate and execution see ONE instance. */
export interface ResolvedTool {
  isSideEffect: boolean;
  execute(args: unknown): Promise<string>;
}

export interface ToolExecutor {
  has(name: string): boolean;
  /** Side-effect tools require explicit confirmation before execution. */
  isSideEffect(name: string): boolean;
  execute(name: string, args: unknown): Promise<string>;
  /**
   * Atomic bind for gate + execute: catalogs may re-sync between the
   * side-effect decision and the call, so both must observe the same tool
   * (TOCTOU). Callers prefer this when available.
   */
  resolve?(name: string): ResolvedTool | undefined;
}

export class SideEffectDeniedError extends Error {
  constructor(public toolName: string) {
    super(
      `Tool "${toolName}" performs side effects and was not confirmed. ` +
        `Retry with explicit side-effect confirmation to execute it.`,
    );
    this.name = "SideEffectDeniedError";
  }
}

export class ToolLoopExceededError extends Error {
  constructor(public maxTurns: number) {
    super(`Tool orchestration exceeded the maximum of ${maxTurns} turns.`);
    this.name = "ToolLoopExceededError";
  }
}

export interface ToolLoopOptions {
  maxTurns?: number;
  /** Set from an explicit caller confirmation; defaults to denying side effects. */
  sideEffectsConfirmed?: boolean;
  /**
   * Reserved GATEWAY-OWNED meta-tools, matched by STRICT NAME EQUALITY BEFORE
   * the MCP registry resolve (design §4.2, threat T14). A meta-tool routes to
   * gateway logic (e.g. the Code Mode run harness), never to the MCP executor,
   * so no untrusted MCP tool can shadow the reserved name or be reached through
   * it. The reserved name is chosen to be structurally impossible as a
   * `qualifiedName` (`<clientId>__<tool>`), so precedence is unambiguous.
   */
  metaTools?: Record<string, (args: unknown) => Promise<string>>;
  /** Optional plugin boundary immediately before gateway-owned MCP execution. */
  onMCPPre?: (call: { name: string; arguments: unknown }) => Promise<{
    name: string;
    arguments: unknown;
  }>;
  /** Optional plugin boundary before a tool result is returned to the model. */
  onMCPPost?: (result: {
    name: string;
    result: string;
    isError?: boolean;
  }) => Promise<{ name: string; result: string; isError?: boolean }>;
}

export interface ToolLoopResult {
  response: ChatCompletionResponse;
  turns: number;
  executedTools: string[];
}

export function extractToolCalls(
  response: ChatCompletionResponse,
): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const choice of response.choices) {
    for (const raw of choice.message?.tool_calls ?? []) {
      const parsed = ToolCallSchema.safeParse(raw);
      if (parsed.success) {
        calls.push(parsed.data);
      }
    }
  }
  return calls;
}

/**
 * Multi-turn tool orchestration: dispatch the request, execute any
 * gateway-owned tool calls, feed results back, and repeat until the model
 * produces a final answer or requests a client-owned tool.
 */
export async function runToolLoop(
  request: ChatCompletionRequest,
  dispatch: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>,
  executor: ToolExecutor,
  options: ToolLoopOptions = {},
): Promise<ToolLoopResult> {
  const maxTurns = options.maxTurns ?? 4;
  const messages: Message[] = [...request.messages];
  const executed: string[] = [];
  const metaTools = options.metaTools ?? {};
  // A reserved meta-tool counts as gateway-owned even though the MCP executor
  // does not (and must not) know it — strict-equality precedence (T14).
  const gatewayOwns = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(metaTools, name) || executor.has(name);
  // Runs the optional onMCPPost hook, falling back to the identity result.
  const applyPost = async (
    name: string,
    result: string,
    isError: boolean,
  ): Promise<{ name: string; result: string; isError?: boolean }> =>
    await options.onMCPPost?.({ name, result, isError }) ??
      { name, result, isError };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await dispatch({ ...request, messages, stream: false });
    const calls = extractToolCalls(response);

    // Done, or the model wants a tool the gateway does not own: hand the
    // response back to the client unchanged.
    if (
      calls.length === 0 || calls.some((c) => !gatewayOwns(c.function.name))
    ) {
      return { response, turns: turn, executedTools: executed };
    }

    messages.push(response.choices[0].message);

    for (const call of calls) {
      let toolCall: { name: string; arguments: unknown };
      try {
        toolCall = {
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments || "{}"),
        };
      } catch {
        const result = await applyPost(
          call.function.name,
          JSON.stringify({ error: "malformed tool arguments" }),
          true,
        );
        executed.push(call.function.name);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.result,
        });
        continue;
      }

      toolCall = await options.onMCPPre?.(toolCall) ?? toolCall;
      const name = toolCall.name;

      if (Object.prototype.hasOwnProperty.call(metaTools, name)) {
        let content: string;
        let isError = false;
        try {
          content = await metaTools[name](toolCall.arguments);
        } catch (err) {
          if (err instanceof SideEffectDeniedError) {
            throw err;
          }
          if (err instanceof DOMException && err.name === "AbortError") {
            throw err;
          }
          isError = true;
          content = JSON.stringify({
            error: `tool execution failed: ${String(err)}`,
          });
        }
        const transformed = await applyPost(name, content, isError);
        executed.push(name);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: transformed.result,
        });
        continue;
      }

      const resolved = executor.resolve?.(name) ?? {
        isSideEffect: executor.isSideEffect(name),
        execute: (args: unknown) => executor.execute(name, args),
      };
      if (resolved.isSideEffect && !options.sideEffectsConfirmed) {
        throw new SideEffectDeniedError(name);
      }

      let content: string;
      let isError = false;
      try {
        content = await resolved.execute(toolCall.arguments);
      } catch (err) {
        isError = true;
        content = JSON.stringify({
          error: `tool execution failed: ${String(err)}`,
        });
      }

      const transformed = await applyPost(name, content, isError);

      executed.push(name);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: transformed.result,
      });
    }
  }

  throw new ToolLoopExceededError(maxTurns);
}
