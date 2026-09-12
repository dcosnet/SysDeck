import type { ToolExecutor } from "../../../core/src/mod.ts";
import { SideEffectDeniedError } from "../../../core/src/mod.ts";
import { CodeModeBroker } from "./broker.ts";
import {
  CODE_MODE_MAX_CONCURRENT_RUNS,
  CODE_MODE_MAX_OUTPUT_BYTES,
  CODE_MODE_MAX_RUN_QUEUE,
  CODE_MODE_TIMEOUT_MS_DEFAULT,
  setWorkerCapability,
} from "./flag.ts";

/**
 * Deny-by-default worker permission descriptor (design §3.1). The parent isolate
 * holds `--allow-env/-net/-read/-write=data`; a Worker can only receive a SUBSET,
 * and this subset is empty. `net` MUST stay `false` (no SSRF / no outbound from
 * the sandbox) until a separately-reviewed increment.
 */
export interface CodeModeWorkerPermissions {
  env: false;
  read: false;
  write: false;
  net: false;
  run: false;
  ffi: false;
  sys: false;
  import: false;
}

export const CODE_MODE_WORKER_PERMISSIONS: CodeModeWorkerPermissions = {
  env: false,
  read: false,
  write: false,
  net: false,
  run: false,
  ffi: false,
  sys: false,
  import: false,
};

/** Spawn descriptor passed to `new Worker(url, ...)` (narrows via unstable flag). */
export interface CodeModeWorkerOptions {
  type: "module";
  deno: { permissions: CodeModeWorkerPermissions };
}

/**
 * Builds the worker spawn options with all permissions denied (asserted by tests:
 * `net === false`). `--unstable-worker-options` on the gateway process is what
 * lets this descriptor NARROW the child worker; the probe proves it is enforced.
 */
export function codeModeWorkerOptions(): CodeModeWorkerOptions {
  return {
    type: "module",
    deno: { permissions: { ...CODE_MODE_WORKER_PERMISSIONS } },
  };
}

/** URL of the sandbox worker entrypoint (the untrusted-program runner). */
export function codeModeWorkerUrl(): URL {
  return new URL("./worker.ts", import.meta.url);
}

/** URL of the boot capability-probe worker. */
export function codeModeProbeUrl(): URL {
  return new URL("./probe.ts", import.meta.url);
}

/** Refusal when the executor is disabled (aligns with the route's 403). */
export class CodeModeDisabledError extends Error {
  constructor() {
    super(
      "Code Mode executor is disabled (FROSTY_CODE_MODE=off); this is an " +
        "experimental, security-gated surface.",
    );
    this.name = "CodeModeDisabledError";
  }
}

/** Raised when a run exceeds the harness wall-clock deadline (design §6, T6/T9). */
export class CodeModeTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Code Mode run exceeded the ${timeoutMs}ms wall-clock timeout.`);
    this.name = "CodeModeTimeoutError";
  }
}

/** Raised when the process-wide concurrent-run cap is saturated (design §4.4, T13). */
export class CodeModeBusyError extends Error {
  constructor() {
    super("Code Mode is at its concurrent-run capacity; retry shortly.");
    this.name = "CodeModeBusyError";
  }
}

/**
 * The canonical client-disconnect rejection (matches the provider layer's shape:
 * a `DOMException` named `"AbortError"`, as `fallback.ts`/`client.ts` detect it).
 * Preserves `signal.reason` when it is already an `AbortError` DOMException so the
 * run's rejection is indistinguishable, at the type level, from any other abort.
 */
function abortError(signal?: AbortSignal): DOMException {
  const reason = signal?.reason;
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return reason; // preserve req.signal's own reason
  }
  return new DOMException(
    "Code Mode run aborted: the client disconnected.",
    "AbortError",
  );
}

/**
 * Minimal structural view of a spawned Worker the harness/probe rely on. Real
 * `Deno`/`Worker` satisfies it; tests inject fakes to drive the pump/semaphore
 * deterministically without a real isolate.
 */
export interface CodeModeWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

function defaultSpawnWorker(): CodeModeWorkerLike {
  return new Worker(
    codeModeWorkerUrl(),
    codeModeWorkerOptions() as unknown as WorkerOptions,
  ) as unknown as CodeModeWorkerLike;
}

function defaultSpawnProbe(): CodeModeWorkerLike {
  return new Worker(
    codeModeProbeUrl(),
    codeModeWorkerOptions() as unknown as WorkerOptions,
  ) as unknown as CodeModeWorkerLike;
}

// ----------------------------------------------------------------- capability

const PROBE_TIMEOUT_MS = 5000;
let capabilityMemo: Promise<boolean> | undefined;
let capabilityResult = false;

/** The memoized boot verdict (also mirrored into flag.ts for the runtime gate). */
export function codeModeCapable(): boolean {
  return capabilityResult;
}

interface ProbeResult {
  type?: unknown;
  env?: unknown;
  read?: unknown;
  net?: unknown;
}

/**
 * Runs the empirical capability probe ONCE per call (design §3.2): spawn a
 * deny-all worker; it must report env/read/net ALL denied. Fail-closed matrix:
 *   - `new Worker(...)` throws (options rejected, e.g. flag missing) ⇒ false.
 *   - any op reported "allowed" (descriptor ignored ⇒ inherited parent perms) ⇒ false.
 *   - timeout / error / malformed report ⇒ false.
 * Not memoized here (that is `initCodeModeCapability`), so tests can exercise the
 * real probe AND a simulated not-enforceable construction independently.
 */
export function runCapabilityProbe(
  options: { spawnProbe?: () => CodeModeWorkerLike; timeoutMs?: number } = {},
): Promise<boolean> {
  const spawn = options.spawnProbe ?? defaultSpawnProbe;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let probe: CodeModeWorkerLike;
    try {
      probe = spawn();
    } catch {
      // Options rejected — cannot scope worker perms ⇒ treat as in-process ⇒ refuse.
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (verdict: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        probe.terminate();
      } catch { /* already gone */ }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    probe.onerror = () => finish(false);
    probe.onmessage = (event) => {
      const m = (event?.data ?? {}) as ProbeResult;
      if (m.type !== "probe_result") return;
      finish(
        m.env === "denied" && m.read === "denied" && m.net === "denied",
      );
    };
  });
}

/**
 * Boot entry (design §3.3): runs the capability probe ONCE, memoizes the verdict,
 * and mirrors it into flag.ts so `probeWorkerPermissions()` (and thus
 * `codeModeExecutorEnabled()`) returns it synchronously at request time. Called
 * by `createDefaultContext` ONLY when the app gate is on, so with
 * `FROSTY_CODE_MODE=off` the probe never runs and no worker is ever spawned.
 */
export function initCodeModeCapability(): Promise<boolean> {
  if (!capabilityMemo) {
    capabilityMemo = runCapabilityProbe().then((capable) => {
      capabilityResult = capable;
      setWorkerCapability(capable);
      return capable;
    });
  }
  return capabilityMemo;
}

// -------------------------------------------------------------- run harness

/** Public tool metadata that seeds the worker's SDK (no schema, no secret). */
export interface CodeModeToolInfo {
  server: string;
  qualifiedName: string;
}

export interface CodeModeRunRequest {
  /** Untrusted, model-authored program body. */
  program: string;
  /** Sourced ONLY from the HTTP request's `x-frosty-confirm-side-effects`. */
  sideEffectsConfirmed: boolean;
  /** Gated MCP executor; `execute`/secrets stay on this (main) isolate. */
  executor: ToolExecutor;
  /** Public `{ server, qualifiedName }` catalog for the INIT message. */
  catalog?: CodeModeToolInfo[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxConcurrentRuns?: number;
  maxRunQueue?: number;
  maxCalls?: number;
  maxConcurrency?: number;
  maxResultBytes?: number;
  /** Aborts the run when the HTTP client disconnects (routes pass req.signal). */
  signal?: AbortSignal;
  /** Test seam. Defaults to a real deny-all Deno Worker. */
  spawnWorker?: () => CodeModeWorkerLike;
}

// Process-wide concurrent-run semaphore (design §4.4/§6, threat T13). Module-
// level so it bounds runs across ALL requests, admin route AND inference plane.
let activeRuns = 0;
const runWaiters: Array<() => void> = [];

/** Observability for tests (T13). */
export function activeCodeModeRuns(): number {
  return activeRuns;
}

function acquireRunSlot(
  max: number,
  maxQueue: number,
  signal?: AbortSignal,
): Promise<void> {
  // State A: already aborted at entry -> never acquire, never queue, never spawn.
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  if (activeRuns < max) {
    activeRuns++;
    return Promise.resolve();
  }
  if (runWaiters.length >= maxQueue) {
    // Running slots AND queue both full -> fast-reject (D-MIN2-A). No slot is
    // acquired on this path (activeRuns untouched), so there is no leak.
    return Promise.reject(new CodeModeBusyError());
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    // `admit` is BOTH the drain callback AND this waiter's identity.
    const admit = () => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      activeRuns++; // the ONLY place a queued waiter increments
      resolve();
    };
    // State B: aborted WHILE queued -> splice THIS exact waiter out (removing it
    // does NOT touch activeRuns), then reject. Because the dead waiter is
    // physically removed, releaseRunSlot's shift() can only ever pick a live one.
    if (signal) {
      onAbort = () => {
        const i = runWaiters.indexOf(admit);
        if (i !== -1) runWaiters.splice(i, 1);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    runWaiters.push(admit);
  });
}

function releaseRunSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  const next = runWaiters.shift();
  if (next) next();
}

function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return `${head}\n[truncated: output exceeded ${maxBytes} bytes]`;
}

function errorEventMessage(event: unknown): string {
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "code-mode worker error";
}

/**
 * Runs one model-authored program (design §2.2). Acquires the global-run slot
 * BEFORE spawning (T13), spawns the deny-all worker, posts INIT (program + public
 * catalog + output cap), pumps `tool_call` messages through the broker, owns the
 * wall-clock deadline (`terminate()` — the broker cannot stop a spin loop,
 * S-FUT-3), aborts on the FIRST side-effect denial as a 403 (S-FUT-4), and caps
 * output. Resolves with the program's text output.
 */
export async function runCodeModeProgram(
  request: CodeModeRunRequest,
): Promise<string> {
  const maxRuns = request.maxConcurrentRuns ?? CODE_MODE_MAX_CONCURRENT_RUNS;
  const maxQueue = request.maxRunQueue ?? CODE_MODE_MAX_RUN_QUEUE;
  await acquireRunSlot(maxRuns, maxQueue, request.signal);
  try {
    return await executeRun(request);
  } finally {
    releaseRunSlot();
  }
}

function executeRun(request: CodeModeRunRequest): Promise<string> {
  const timeoutMs = request.timeoutMs ?? CODE_MODE_TIMEOUT_MS_DEFAULT;
  const maxOutputBytes = request.maxOutputBytes ?? CODE_MODE_MAX_OUTPUT_BYTES;
  const catalog = request.catalog ?? [];
  const signal = request.signal;
  const broker = new CodeModeBroker({
    executor: request.executor,
    sideEffectsConfirmed: request.sideEffectsConfirmed,
    maxCalls: request.maxCalls,
    maxConcurrency: request.maxConcurrency,
    maxResultBytes: request.maxResultBytes,
  });
  const spawn = request.spawnWorker ?? defaultSpawnWorker;

  return new Promise<string>((resolve, reject) => {
    // LAYER 1 (entry): aborted during the admit -> executeRun microtask gap,
    // where addEventListener would NOT fire on an already-aborted signal.
    if (signal?.aborted) {
      reject(abortError(signal));
      return; // no spawn; the finally in runCodeModeProgram releases the slot
    }

    let worker: CodeModeWorkerLike;
    try {
      worker = spawn();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let settled = false;
    let terminated = false;
    let onAbort: (() => void) | undefined;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      try {
        worker.terminate();
      } catch { /* already gone */ }
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Hygiene on EVERY exit (resolve/reject/timeout/error/abort) so no Code
      // Mode listener leaks onto a long-lived signal across many runs.
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      terminate();
      action();
    };

    // Harness-owned deadline. A `while(true){}` spin loop never yields to the
    // broker, so ONLY the harness can stop it — via terminate() (S-FUT-3).
    const timer = setTimeout(() => {
      settle(() => reject(new CodeModeTimeoutError(timeoutMs)));
    }, timeoutMs);

    // LAYER 2 (running): wire abort -> terminate + reject via the existing
    // single-settle guard, then re-check to close the subscribe-after-abort gap
    // (addEventListener does not fire on an already-aborted signal).
    if (signal) {
      onAbort = () => settle(() => reject(abortError(signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort(); // aborted during the subscribe window
    }

    const handleToolCall = async (raw: Record<string, unknown>) => {
      const result = await broker.handleMessage(raw);
      if (!result || settled) return;
      if (result.denialReason === "side_effect") {
        // First confirm-gate denial aborts the run → surfaced as 403, matching
        // the inference tool-loop's SideEffectDeniedError.
        const name = typeof raw["qualifiedName"] === "string"
          ? (raw["qualifiedName"] as string)
          : "unknown";
        settle(() => reject(new SideEffectDeniedError(name)));
        return;
      }
      // Post ONLY the wire fields back — the `denialReason` marker never crosses.
      worker.postMessage({
        type: "tool_result",
        callId: result.callId,
        ok: result.ok,
        content: result.content,
      });
    };

    worker.onerror = (event) => {
      settle(() => reject(new Error(errorEventMessage(event))));
    };

    worker.onmessage = (event) => {
      const data = event?.data;
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      switch (message["type"]) {
        case "tool_call":
          void handleToolCall(message);
          return;
        case "done": {
          const result = typeof message["result"] === "string"
            ? (message["result"] as string)
            : "";
          settle(() => resolve(capBytes(result, maxOutputBytes)));
          return;
        }
        case "error": {
          const msg = typeof message["message"] === "string"
            ? (message["message"] as string)
            : "code-mode program error";
          settle(() => reject(new Error(msg)));
          return;
        }
          // "log" and anything else are ignored (telemetry only).
      }
    };

    // Seed the run. INIT carries the program + PUBLIC catalog only.
    worker.postMessage({
      type: "init",
      program: request.program,
      catalog: catalog.map((c) => ({
        server: c.server,
        qualifiedName: c.qualifiedName,
      })),
      maxOutputBytes,
    });
  });
}
