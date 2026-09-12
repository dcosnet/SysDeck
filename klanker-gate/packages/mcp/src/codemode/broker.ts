import type { ToolExecutor } from "../../../core/src/mod.ts";
import {
  CODE_MODE_MAX_CALLS_DEFAULT,
  CODE_MODE_MAX_CONCURRENCY,
  CODE_MODE_MAX_RESULT_BYTES,
} from "./flag.ts";

/** Worker → main request to invoke an SDK-bound tool. */
export interface BrokerToolCall {
  type: "tool_call";
  callId: string | number;
  qualifiedName: string;
  args?: unknown;
}

/** Main → worker result for a correlated `tool_call`. */
export interface BrokerToolResult {
  type: "tool_result";
  callId: string | number;
  ok: boolean;
  content: string;
  /**
   * Typed marker (design §8, S-FUT-4) set ONLY on a confirm-gate denial, so the
   * run harness can distinguish a side-effect denial (→ abort the run, surface
   * 403 `side_effect_denied`, matching the inference tool-loop) from an ordinary
   * tool error (→ delivered to the program as a catchable error). This field is
   * for the harness on the main isolate; the harness strips it and delivers only
   * `{ ok, content }` to the worker, so the string the program sees stays plain.
   */
  denialReason?: "side_effect";
}

export interface BrokerOptions {
  executor: ToolExecutor;
  /** Sourced from `x-frosty-confirm-side-effects` on the HTTP request only. */
  sideEffectsConfirmed: boolean;
  /** Total tool calls per run (design §3.5). */
  maxCalls?: number;
  /** Max in-flight tool calls (design §3.4/§3.5). */
  maxConcurrency?: number;
  /** Cap on each brokered result (design §3.5). */
  maxResultBytes?: number;
}

/** Message types the broker will act on; everything else is dropped. */
const HANDLED_TYPES = new Set(["tool_call", "log", "done"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Stateful per-run broker. `handleMessage` is transport-agnostic so it can be
 * unit-tested with a fake worker (a plain object), which is exactly how the
 * boundary controls are proven now while the executor stays off.
 */
export class CodeModeBroker {
  private calls = 0;
  private inFlight = 0;

  constructor(private readonly opts: BrokerOptions) {}

  /**
   * Validates and dispatches one worker message. Returns a `tool_result` for a
   * valid `tool_call`, or `undefined` when the message is dropped (unknown
   * type, forged `tool_result`, `log`/`done`, or a malformed `tool_call` with
   * no usable correlation id).
   */
  async handleMessage(raw: unknown): Promise<BrokerToolResult | undefined> {
    if (!isRecord(raw)) {
      return undefined;
    }
    const type = raw["type"];
    // Type allowlist. A worker-forged `tool_result` (trying to inject a result
    // it never requested) is NOT in the actionable set below → dropped.
    if (typeof type !== "string" || !HANDLED_TYPES.has(type)) {
      return undefined;
    }
    if (type !== "tool_call") {
      // `log`/`done` are acknowledged silently; they produce no result.
      return undefined;
    }
    return await this.handleToolCall(raw);
  }

  private async handleToolCall(
    raw: Record<string, unknown>,
  ): Promise<BrokerToolResult | undefined> {
    const callId = raw["callId"];
    if (typeof callId !== "string" && typeof callId !== "number") {
      // No broker-correlatable id ⇒ cannot safely answer; drop.
      return undefined;
    }
    const qualifiedName = raw["qualifiedName"];
    if (typeof qualifiedName !== "string") {
      return this.deny(
        callId,
        "invalid tool_call: qualifiedName must be a string",
      );
    }

    // Budget: total tool calls per run (confused-deputy amplification cap).
    this.calls++;
    const maxCalls = this.opts.maxCalls ?? CODE_MODE_MAX_CALLS_DEFAULT;
    if (this.calls > maxCalls) {
      return this.deny(callId, `tool-call budget exceeded (max ${maxCalls})`);
    }

    // In-flight concurrency cap.
    const maxConcurrency = this.opts.maxConcurrency ??
      CODE_MODE_MAX_CONCURRENCY;
    if (this.inFlight >= maxConcurrency) {
      return this.deny(
        callId,
        `tool-call concurrency limit exceeded (max ${maxConcurrency})`,
      );
    }

    if (typeof this.opts.executor.resolve !== "function") {
      return this.deny(
        callId,
        "executor does not support atomic tool resolution; refusing to " +
          "dispatch without the TOCTOU-safe gate",
      );
    }
    const resolved = this.opts.executor.resolve(qualifiedName);
    if (!resolved) {
      return this.deny(
        callId,
        `unknown or unexposed MCP tool "${qualifiedName}"`,
      );
    }

    if (resolved.isSideEffect && !this.opts.sideEffectsConfirmed) {
      return {
        type: "tool_result",
        callId,
        ok: false,
        content:
          `Tool "${qualifiedName}" performs side effects and was not confirmed. ` +
          `Retry with explicit side-effect confirmation to execute it.`,
        denialReason: "side_effect",
      };
    }

    this.inFlight++;
    try {
      const content = await resolved.execute(raw["args"]);
      const capped = this.capResult(content);
      return {
        type: "tool_result",
        callId,
        ok: capped.ok,
        content: capped.content,
      };
    } catch (error) {
      return this.deny(
        callId,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.inFlight--;
    }
  }

  private capResult(content: string): { ok: boolean; content: string } {
    const max = this.opts.maxResultBytes ?? CODE_MODE_MAX_RESULT_BYTES;
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength <= max) {
      return { ok: true, content };
    }
    const truncated = new TextDecoder().decode(bytes.slice(0, max));
    return {
      ok: false,
      content: `${truncated}\n[truncated: result exceeded ${max} bytes]`,
    };
  }

  private deny(callId: string | number, message: string): BrokerToolResult {
    return { type: "tool_result", callId, ok: false, content: message };
  }
}
