/** App gate: `off` (default) = executor disabled; `on` = requested (experimental). */
export const CODE_MODE_ENV = "FROSTY_CODE_MODE";
/** Optional metadata-surface switch (default on). */
export const CODE_MODE_VFS_ENV = "FROSTY_CODE_MODE_VFS";
/** Per-request opt-in header (parallels `x-frosty-mcp-tools: auto`). */
export const CODE_MODE_HEADER = "x-frosty-code-mode";

/** Resource bounds (design §3.5 / §6). Enforced by the broker + run harness. */
export const CODE_MODE_MAX_CALLS_DEFAULT = 32;
export const CODE_MODE_MAX_CONCURRENCY = 4;
export const CODE_MODE_TIMEOUT_MS_DEFAULT = 5000;
export const CODE_MODE_MAX_OUTPUT_BYTES = 64 * 1024;
export const CODE_MODE_MAX_RESULT_BYTES = 256 * 1024;
/**
 * Process-wide cap on concurrent Code Mode runs (design §4.4/§6, threat T13).
 * Each `x-frosty-code-mode: run` request can spawn a Worker (an OS thread +
 * isolate); the inference plane makes this reachable by a virtual-key client, so
 * the run harness holds a global semaphore of this size BEFORE `new Worker`.
 * The per-run in-flight cap (`CODE_MODE_MAX_CONCURRENCY`) does not bound this.
 */
export const CODE_MODE_MAX_CONCURRENT_RUNS = 4;
/**
 * Bounded wait-queue depth for Code Mode runs (design D-MIN2-A). Once the
 * running slots (CODE_MODE_MAX_CONCURRENT_RUNS) AND this many waiters are all
 * occupied, acquireRunSlot rejects with CodeModeBusyError -> 429 / tool-error.
 * A small queue smooths transient bursts without letting held-open requests or
 * waiter closures accumulate unbounded.
 */
export const CODE_MODE_MAX_RUN_QUEUE = 8;

/** Minimal env reader shape so tests can inject a fake environment. */
export interface EnvReader {
  get(key: string): string | undefined;
}

function env(reader?: EnvReader): EnvReader {
  return reader ?? Deno.env;
}

/** True when the app gate `FROSTY_CODE_MODE` is explicitly `on`. */
export function appGateOn(reader?: EnvReader): boolean {
  return (env(reader).get(CODE_MODE_ENV) ?? "off").toLowerCase() === "on";
}

/** True unless `FROSTY_CODE_MODE_VFS` is explicitly disabled (default on). */
export function vfsSurfaceEnabled(reader?: EnvReader): boolean {
  const value = (env(reader).get(CODE_MODE_VFS_ENV) ?? "on").toLowerCase();
  return value !== "off" && value !== "0" && value !== "false";
}

/** True when the request opts in via `x-frosty-code-mode: run`. */
export function runRequested(headers: Headers): boolean {
  return headers.get(CODE_MODE_HEADER) === "run";
}

/**
 * Memoized capability verdict, populated ONCE at boot by
 * `initCodeModeCapability()` (executor.ts) and only when the app gate is on
 * (context.ts). Held here — not imported from executor.ts — so `flag.ts` stays
 * free of the executor's Worker/broker graph (no import cycle). Defaults
 * `false`, so the executor is fail-closed until the empirical probe proves
 * per-worker deny-by-default permissions are enforceable.
 */
let workerCapability = false;

/**
 * Records the boot capability-probe verdict. Called exactly once by
 * `initCodeModeCapability()` in executor.ts after the probe worker reports.
 */
export function setWorkerCapability(capable: boolean): void {
  workerCapability = capable;
}

/**
 * Capability gate — the executor's SECOND, independent gate. Per-worker
 * deny-by-default permissions only hold if the runtime can enforce
 * `deno.permissions` on workers; if it cannot, we refuse even when
 * `FROSTY_CODE_MODE=on` (fail-closed, mirroring `--allow-run` for stdio).
 *
 * Returns the memoized verdict of the real boot probe (`initCodeModeCapability`,
 * executor.ts): `true` only when a deny-all worker empirically denied
 * `Deno.env.get` / `Deno.readFile` / `fetch` (S-FUT-1). Because the app gate
 * short-circuits BEFORE this is consulted (`codeModeExecutorEnabled`), with
 * `FROSTY_CODE_MODE=off` the probe never runs and NO worker is ever spawned.
 */
export function probeWorkerPermissions(): boolean {
  return workerCapability;
}

/**
 * Pure two-gate combiner (unit-testable). The executor runs only when the app
 * gate is on AND the capability probe passed.
 */
export function isExecutorEnabled(
  opts: { appGateOn: boolean; capable: boolean },
): boolean {
  return opts.appGateOn && opts.capable;
}

/**
 * The runtime decision used by the route: app gate first (short-circuit — the
 * capability probe never runs, and thus no worker is ever spawned, when the app
 * gate is off), then the capability probe.
 */
export function codeModeExecutorEnabled(reader?: EnvReader): boolean {
  if (!appGateOn(reader)) {
    return false;
  }
  return isExecutorEnabled({
    appGateOn: true,
    capable: probeWorkerPermissions(),
  });
}
