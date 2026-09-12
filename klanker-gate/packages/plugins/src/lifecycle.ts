import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../contracts/src/mod.ts";
import type { ReconstructedMessage } from "../../core/src/accumulate.ts";

/** A single MCP tool invocation, as seen by an MCP plugin hook. */
export interface MCPToolCall {
  /** Tool name (may be a qualified `<clientId>__<tool>` name). */
  name: string;
  /** Parsed tool-call arguments (post JSON.parse). */
  arguments: unknown;
}

/** The result of an MCP tool invocation, as seen by an MCP plugin hook. */
export interface MCPToolResult {
  /** Tool name this result belongs to. */
  name: string;
  /** Tool output (typically a JSON/text string) fed back to the model. */
  result: string;
  /** True when the tool reported an error result. */
  isError?: boolean;
}

export interface Plugin {
  name: string;
  onPreRequest?: (
    req: ChatCompletionRequest,
  ) => Promise<ChatCompletionRequest>;
  /**
   * Optional short-circuit pre-hook (Go parity: PreLLMHook returning an
   * LLMPluginShortCircuit). Runs before the upstream provider call. Resolving
   * with a response SKIPS the upstream call and returns that response to the
   * client; resolving with `undefined` lets the request proceed normally.
   * Throwing (e.g. a GatewayError) short-circuits with an error, which the
   * route's existing catch maps to the error envelope (used for error
   * injection).
   *
   * Additive and optional: plugins that do not set it are unaffected, and
   * `onPreRequest` (request transform) keeps its existing contract untouched.
   */
  onRequestShortCircuit?: (
    req: ChatCompletionRequest,
  ) => Promise<ChatCompletionResponse | undefined>;
  onPostRequest?: (
    res: ChatCompletionResponse,
  ) => Promise<ChatCompletionResponse>;
  /**
   * Optional transport (raw HTTP) pre-hook (Go parity:
   * HTTPTransportPreHook). Runs at the OUTERMOST layer on the inbound web
   * `Request` — before it is routed, authenticated, or parsed into a
   * ChatCompletionRequest. Executed in registration (forward) order. Additive
   * and optional: plugins that omit it are unaffected. The runner
   * (`executeTransportPre`) is a no-op until at least one plugin sets the hook.
   */
  onTransportPre?: (req: Request) => Promise<Request>;
  /**
   * Optional transport (raw HTTP) post-hook (Go parity:
   * HTTPTransportPostHook). Runs at the OUTERMOST layer on the outbound web
   * `Response` — after routing, just before it is returned to the client.
   * Executed in REVERSE registration order so the onion stays symmetric: the
   * plugin whose `onTransportPre` ran first has its `onTransportPost` run last.
   * Additive and optional.
   */
  onTransportPost?: (res: Response) => Promise<Response>;
  /**
   * Optional MCP tool-call pre-hook (Go parity: MCP PreHook). Runs inside the
   * tool loop just before an MCP tool executes; may inspect or transform the
   * call (e.g. redact arguments, deny/rewrite a tool). Executed in registration
   * (forward) order. Additive and optional: the runner (`executeMCPPre`) is a
   * no-op until a plugin sets the hook.
   */
  onMCPPre?: (call: MCPToolCall) => Promise<MCPToolCall>;
  /**
   * Optional MCP tool-call post-hook (Go parity: MCP PostHook). Runs after an
   * MCP tool returns, before its result is fed back to the model; may inspect
   * or transform the result. Executed in REVERSE registration order (onion
   * parity with `onMCPPre`). Additive and optional.
   */
  onMCPPost?: (result: MCPToolResult) => Promise<MCPToolResult>;
  /**
   * Called once per completed stream.
   * @param text concatenated assistant text (backward-compatible).
   * @param message the full reconstructed assistant message — tool calls,
   *   reasoning, refusal, finish_reason, usage. Additive and optional; existing
   *   `(text) => ...` hooks keep working unchanged.
   */
  onStreamComplete?: (
    text: string,
    message?: ReconstructedMessage,
  ) => Promise<void>;
}

export class PluginManager {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }

  executePreHooks(
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionRequest> {
    return this.foldForward(req, (p, r) => p.onPreRequest?.(r));
  }

  /**
   * Runs short-circuit pre-hooks in registration order and returns the first
   * synthesized response, or `undefined` when no plugin short-circuits (the
   * request then proceeds to the provider as usual). Errors are intentionally
   * NOT swallowed: a plugin that throws (e.g. mocked error injection) must
   * propagate to the caller's error handling. Plugins without
   * `onRequestShortCircuit` are skipped, so this is a no-op unless a
   * short-circuiting plugin (e.g. the mocker) is registered.
   */
  async executeShortCircuit(
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse | undefined> {
    for (const plugin of this.plugins) {
      if (plugin.onRequestShortCircuit) {
        const short = await plugin.onRequestShortCircuit(req);
        if (short) {
          return short;
        }
      }
    }
    return undefined;
  }

  /**
   * Runs registered plugins' `onPostRequest` in REVERSE registration order
   * (Bifrost parity, core/schemas/plugin.go: PostHooks run last-registered
   * first, the mirror of `executePreHooks`' forward order). This forms the
   * symmetric middleware "onion" — a plugin's post-hook wraps everything that
   * registered after it.
   *
   * Backward-compat: with 0 or 1 post-hook plugin the reverse order is
   * indistinguishable from forward, so every existing single-plugin call site
   * and test (jsonparser, mocker, observability, mcp_plugins) is unaffected;
   * the ordering change is observable only when 2+ plugins define
   * `onPostRequest`. The gateway registers at most one post-hook plugin
   * (jsonparser), so production behavior is byte-identical.
   */
  executePostHooks(
    res: ChatCompletionResponse,
  ): Promise<ChatCompletionResponse> {
    return this.foldReverse(res, (p, r) => p.onPostRequest?.(r));
  }

  /**
   * Transport (raw HTTP) pre-hook runner: threads the inbound web `Request`
   * through each plugin's `onTransportPre` in registration (forward) order.
   * Returns the request unchanged when no plugin defines the hook, so this is a
   * pure no-op by default. The gateway invokes it at its raw HTTP boundary.
   */
  executeTransportPre(req: Request): Promise<Request> {
    return this.foldForward(req, (p, r) => p.onTransportPre?.(r));
  }

  /**
   * Transport (raw HTTP) post-hook runner: threads the outbound web `Response`
   * through each plugin's `onTransportPost` in REVERSE registration order
   * (onion parity with `executeTransportPre`). No-op when unused.
   */
  executeTransportPost(res: Response): Promise<Response> {
    return this.foldReverse(res, (p, r) => p.onTransportPost?.(r));
  }

  /**
   * MCP tool-call pre-hook runner: threads a tool call through each plugin's
   * `onMCPPre` in registration (forward) order before the tool executes. No-op
   * when unused; the gateway passes it into the tool loop.
   */
  executeMCPPre(call: MCPToolCall): Promise<MCPToolCall> {
    return this.foldForward(call, (p, c) => p.onMCPPre?.(c));
  }

  /**
   * MCP tool-call post-hook runner: threads a tool result through each plugin's
   * `onMCPPost` in REVERSE registration order (onion parity with
   * `executeMCPPre`) before it is fed back to the model. No-op when unused.
   */
  executeMCPPost(result: MCPToolResult): Promise<MCPToolResult> {
    return this.foldReverse(result, (p, r) => p.onMCPPost?.(r));
  }

  async executeStreamComplete(
    text: string,
    message?: ReconstructedMessage,
  ): Promise<void> {
    // Completion hooks are observers, not transformers: one plugin's
    // failure must neither abort the client's stream termination nor
    // starve the remaining plugins (mirrors LogBus subscriber isolation).
    for (const plugin of this.plugins) {
      if (plugin.onStreamComplete) {
        try {
          await plugin.onStreamComplete(text, message);
        } catch (error) {
          console.error(
            `plugin "${plugin.name}" onStreamComplete failed: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
    }
  }

  /**
   * Threads `value` through every plugin's transform hook in REGISTRATION
   * (forward) order. `invoke` returns the hook's promise when the plugin
   * defines it (invoked on the plugin so `this` is preserved) or `undefined`
   * to skip. Shared by all "pre"-style runners so forward ordering lives in
   * exactly one place.
   */
  private async foldForward<T>(
    value: T,
    invoke: (plugin: Plugin, value: T) => Promise<T> | undefined,
  ): Promise<T> {
    let current = value;
    for (const plugin of this.plugins) {
      const next = invoke(plugin, current);
      if (next !== undefined) {
        current = await next;
      }
    }
    return current;
  }

  /**
   * Threads `value` through every plugin's transform hook in REVERSE
   * registration order (Bifrost's post-hook onion: last-registered runs
   * first). Shared by all "post"-style runners so reverse ordering lives in
   * exactly one place.
   */
  private async foldReverse<T>(
    value: T,
    invoke: (plugin: Plugin, value: T) => Promise<T> | undefined,
  ): Promise<T> {
    let current = value;
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const next = invoke(this.plugins[i], current);
      if (next !== undefined) {
        current = await next;
      }
    }
    return current;
  }
}
