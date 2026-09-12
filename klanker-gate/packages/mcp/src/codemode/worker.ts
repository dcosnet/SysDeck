import { sanitizeIdentifier } from "./sanitize.ts";

/** Public catalog entry the INIT message carries (no schema, no secret). */
interface PublicToolInfo {
  server: string;
  qualifiedName: string;
}

/** Main → worker INIT message (program + public catalog + output cap). */
interface WorkerInitMessage {
  type: "init";
  program: string;
  catalog: PublicToolInfo[];
  maxOutputBytes: number;
}

/** Main → worker reply for a correlated `tool_call` (only ok + text content). */
interface WorkerToolResultMessage {
  type: "tool_result";
  callId: number;
  ok: boolean;
  content: string;
}

interface WorkerScope {
  postMessage(message: unknown): void;
}

/** Caps a UTF-8 string to a byte budget (worker-side output cap, design §6). */
function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return `${head}\n[truncated: output exceeded ${maxBytes} bytes]`;
}

/** Serializes the program's return value to a string for transport. */
function serializeResult(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Wires the worker's message loop: the RPC pending-map, the trusted SDK builder,
 * and the `new Function` program runner. Exported (not auto-run) so importing
 * this module in a unit test never registers a listener — the guard at the
 * bottom only installs it inside a real Worker global scope.
 */
export function installCodeModeWorker(): void {
  const scope = self as unknown as WorkerScope;
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  let started = false;

  // Each SDK leaf forwards a GATEWAY-CONSTRUCTED qualifiedName to the broker and
  // suspends the program on the returned promise until the correlated reply.
  function frostyCall(qualifiedName: string, args: unknown): Promise<string> {
    const callId = ++seq;
    return new Promise<string>((resolve, reject) => {
      pending.set(callId, { resolve, reject });
      scope.postMessage({ type: "tool_call", callId, qualifiedName, args });
    });
  }

  // Build the trusted SDK: `sdk[server][tool]` with the SAME sanitized names the
  // codegen TS emission uses (sanitize.ts), so a program authored against the
  // display SDK binds to the runtime one. Dispatch identity stays qualifiedName.
  function buildSdk(
    catalog: PublicToolInfo[],
  ): Record<string, Record<string, (args: unknown) => Promise<string>>> {
    const sdk: Record<
      string,
      Record<string, (args: unknown) => Promise<string>>
    > = {};
    for (const info of catalog) {
      if (
        !info || typeof info.server !== "string" ||
        typeof info.qualifiedName !== "string"
      ) {
        continue;
      }
      const serverKey = sanitizeIdentifier(info.server);
      const prefix = `${info.server}__`;
      const rawTool = info.qualifiedName.startsWith(prefix)
        ? info.qualifiedName.slice(prefix.length)
        : info.qualifiedName;
      const methodKey = sanitizeIdentifier(rawTool);
      (sdk[serverKey] ??= {})[methodKey] = (args: unknown) =>
        frostyCall(info.qualifiedName, args);
    }
    return sdk;
  }

  // A capped console: the program may log, but each message is byte-bounded and
  // posted as an inert `log` the harness ignores, so console cannot amplify.
  function makeCappedConsole(): Console {
    const emit = (level: string) => (...parts: unknown[]) => {
      const message = capBytes(parts.map(serializeResult).join(" "), 4096);
      scope.postMessage({ type: "log", level, message });
    };
    const noop = () => {};
    return {
      log: emit("log"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      debug: emit("debug"),
      trace: noop,
      dir: emit("dir"),
      assert: noop,
      count: noop,
      countReset: noop,
      group: noop,
      groupCollapsed: noop,
      groupEnd: noop,
      table: noop,
      time: noop,
      timeEnd: noop,
      timeLog: noop,
      clear: noop,
    } as unknown as Console;
  }

  async function runProgram(init: WorkerInitMessage): Promise<void> {
    const sdk = buildSdk(Array.isArray(init.catalog) ? init.catalog : []);
    try {
      // `new Function` compiles the untrusted body in a clean scope with ONLY the
      // injected `sdk`/`console`. Static import/export is a syntax error here, so
      // the program cannot pull code; a syntax error is a clean pre-run throw.
      const runner = new Function(
        "sdk",
        "console",
        '"use strict"; return (async () => {\n' + String(init.program) +
          "\n})();",
      );
      const result = await runner(sdk, makeCappedConsole());
      const serialized = capBytes(
        serializeResult(result),
        typeof init.maxOutputBytes === "number" ? init.maxOutputBytes : 65536,
      );
      scope.postMessage({ type: "done", ok: true, result: serialized });
    } catch (error) {
      scope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  addEventListener("message", (event) => {
    const message = (event as MessageEvent).data as
      | WorkerInitMessage
      | WorkerToolResultMessage
      | { type?: unknown }
      | null;
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: unknown }).type;

    // RPC reply: resolve/reject the matching pending promise. `content` is the
    // tool's TEXT result only; a `side_effect` denial never reaches here (the
    // harness aborts the run before posting it back).
    if (type === "tool_result") {
      const reply = message as WorkerToolResultMessage;
      if (typeof reply.callId !== "number") return;
      const waiter = pending.get(reply.callId);
      if (!waiter) return;
      pending.delete(reply.callId);
      if (reply.ok) {
        waiter.resolve(String(reply.content ?? ""));
      } else {
        waiter.reject(new Error(String(reply.content ?? "tool call failed")));
      }
      return;
    }

    // INIT runs the program exactly once.
    if (type === "init") {
      if (started) return;
      started = true;
      void runProgram(message as WorkerInitMessage);
      return;
    }
    // Anything else is ignored.
  });
}

const inWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
    "undefined";
if (inWorkerScope) {
  installCodeModeWorker();
}
