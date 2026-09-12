import { assert, assertEquals } from "@std/assert";
import { Router } from "../../../core/src/mod.ts";
import type { ToolExecutor } from "../../../core/src/mod.ts";
import type { AppContext } from "../../../../apps/gateway/context.ts";
import { registerCodeModeRoutes } from "../../../../apps/gateway/routes/codemode.ts";
import {
  activeCodeModeRuns,
  CodeModeBusyError,
  codeModeProbeUrl,
  CodeModeTimeoutError,
  type CodeModeWorkerLike,
  codeModeWorkerOptions,
  codeModeWorkerUrl,
  initCodeModeCapability,
  runCapabilityProbe,
  runCodeModeProgram,
} from "./executor.ts";
import { setWorkerCapability } from "./flag.ts";

// S-FUT-1..4 + T13 (design §8) — the executor-ENABLED acceptance gates, now
// REAL (they replace the a4f1c2 ignored placeholders). Run under
// `--unstable-worker-options`; the `test` task and focused gate both carry it.
//
// Deno version note: 2.9.x surfaces worker-scoped permission denials as
// `Deno.errors.NotCapable` (older builds: `PermissionDenied`). Both are a
// denial; the probe accepts either, so "denied" below means "the op was blocked
// inside the worker", which is exactly what S-FUT-1 must prove.

// --- shared helpers --------------------------------------------------------

const WORKER_OPTS = codeModeWorkerOptions() as unknown as WorkerOptions;

/** Wraps a REAL deny-all worker as a CodeModeWorkerLike, spying on terminate(). */
function wrapRealWorker(
  url: URL,
  onTerminate?: () => void,
): CodeModeWorkerLike {
  const real = new Worker(url, WORKER_OPTS);
  const like: CodeModeWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message: unknown) => real.postMessage(message),
    terminate: () => {
      onTerminate?.();
      real.terminate();
    },
  };
  real.onmessage = (event) => like.onmessage?.({ data: event.data });
  real.onerror = (event) => like.onerror?.(event);
  return like;
}

function noopExecutor(): ToolExecutor {
  return {
    has: () => false,
    isSideEffect: () => true,
    execute: () => Promise.resolve(""),
    resolve: () => undefined,
  };
}

// ---------------------------------------------------------------- S-FUT-1
Deno.test("S-FUT-1 deny-by-default worker perms proven (env/read/net denied)", async () => {
  // (a) A REAL deny-all worker reports every privileged op as denied.
  const verdict = await new Promise<Record<string, unknown>>((resolve) => {
    const probe = new Worker(codeModeProbeUrl(), WORKER_OPTS);
    const timer = setTimeout(() => {
      probe.terminate();
      resolve({ env: "timeout", read: "timeout", net: "timeout" });
    }, 5000);
    probe.onmessage = (event) => {
      clearTimeout(timer);
      probe.terminate();
      resolve(event.data as Record<string, unknown>);
    };
  });
  assertEquals(verdict.env, "denied", "Deno.env.get must be denied");
  assertEquals(verdict.read, "denied", "Deno.readFile must be denied");
  assertEquals(verdict.net, "denied", "fetch(metadata) must be denied");

  try {
    // (b) The probe helper agrees: all-denied ⇒ capability enforceable ⇒ true.
    assertEquals(await runCapabilityProbe(), true);
    // and the memoized boot entry returns true here.
    assertEquals(await initCodeModeCapability(), true);

    // (c) Fail-closed: a runtime that IGNORES the descriptor (an op "allowed")
    // is NOT enforceable ⇒ false; an options-rejected spawn ⇒ false.
    const notEnforceable = await runCapabilityProbe({
      spawnProbe: () => {
        const w: CodeModeWorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: () => {},
          terminate: () => {},
        };
        setTimeout(
          () =>
            w.onmessage?.({
              data: {
                type: "probe_result",
                env: "allowed",
                read: "denied",
                net: "denied",
              },
            }),
          0,
        );
        return w;
      },
    });
    assertEquals(notEnforceable, false);
    const optionsRejected = await runCapabilityProbe({
      spawnProbe: () => {
        throw new Error("worker options rejected (missing unstable flag)");
      },
    });
    assertEquals(optionsRejected, false);
  } finally {
    // initCodeModeCapability() flips the SHARED capability flag; restore the
    // fail-closed default so this test cannot leak an enabled state to others.
    setWorkerCapability(false);
  }
});

// ---------------------------------------------------------------- S-FUT-2
Deno.test("S-FUT-2 no secret crosses to the worker under a tool-call loop", async () => {
  const SENTINEL_HDR = "SENTINEL_HDR_a1b2c3";
  const SENTINEL_ENV = "SENTINEL_ENV_d4e5f6";
  const priorKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", SENTINEL_ENV);

  // Executor holds the MCP auth header (like config.headers) on the MAIN isolate
  // and uses it, but returns ONLY the tool's text result.
  const secretHeaders = { Authorization: `Bearer ${SENTINEL_HDR}` };
  const executor: ToolExecutor = {
    has: (n) => n === "svr__read",
    isSideEffect: () => false,
    execute: () => Promise.resolve("tool-ok"),
    resolve: (n) =>
      n === "svr__read"
        ? {
          isSideEffect: false,
          execute: () => {
            void secretHeaders.Authorization; // used here, never returned
            return Promise.resolve("tool-ok");
          },
        }
        : undefined,
  };

  // Fake worker: records EVERY message the harness posts to it (INIT + every
  // tool_result), and drives a budgeted loop of tool calls back to the harness.
  const workerBound: unknown[] = [];
  const spawnWorker = (): CodeModeWorkerLike => {
    const w: CodeModeWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {},
      postMessage: (message: unknown) => {
        workerBound.push(message);
        if ((message as { type?: string }).type === "init") {
          void (async () => {
            for (let i = 0; i < 12; i++) {
              w.onmessage?.({
                data: {
                  type: "tool_call",
                  callId: i,
                  qualifiedName: "svr__read",
                  args: { i },
                },
              });
              await new Promise((r) => setTimeout(r, 0));
            }
            w.onmessage?.({ data: { type: "done", result: "loop-done" } });
          })();
        }
      },
    };
    return w;
  };

  try {
    const out = await runCodeModeProgram({
      program: "loop",
      sideEffectsConfirmed: true,
      executor,
      catalog: [{ server: "svr", qualifiedName: "svr__read" }],
      spawnWorker,
      timeoutMs: 5000,
    });
    assertEquals(out, "loop-done");
    // INIT + 12 tool_results were posted to the worker.
    assert(
      workerBound.length >= 13,
      `worker-bound msgs: ${workerBound.length}`,
    );
    const blob = JSON.stringify(workerBound);
    assert(!blob.includes(SENTINEL_HDR), "config.headers secret crossed!");
    assert(!blob.includes(SENTINEL_ENV), "env secret crossed!");
    assert(!blob.includes("Authorization"), "auth header name crossed!");
  } finally {
    if (priorKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", priorKey);
  }
});

// ---------------------------------------------------------------- S-FUT-3
Deno.test("S-FUT-3 timeout terminates an infinite loop within the deadline", async () => {
  let terminateCalls = 0;
  const spawnWorker = () =>
    wrapRealWorker(codeModeWorkerUrl(), () => terminateCalls++);
  const timeoutMs = 300;
  const started = Date.now();
  let caught: unknown;
  try {
    await runCodeModeProgram({
      program: "while (true) {}",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker,
      timeoutMs,
    });
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;
  assert(caught instanceof CodeModeTimeoutError, `got ${caught}`);
  assert(elapsed < timeoutMs + 4000, `run took ${elapsed}ms`);
  assert(terminateCalls >= 1, "harness must call worker.terminate()");
});

// ---------------------------------------------------------------- S-FUT-4a
Deno.test("S-FUT-4 /run confirm gate: unconfirmed side-effect ⇒ 403, confirmed ⇒ runs once", async () => {
  const priorFlag = Deno.env.get("FROSTY_CODE_MODE");
  Deno.env.set("FROSTY_CODE_MODE", "on");
  setWorkerCapability(true); // both gates on for this test

  let executed = 0;
  const executor: ToolExecutor = {
    has: (n) => n === "svr__write",
    isSideEffect: () => true,
    execute: () => {
      executed++;
      return Promise.resolve("write-ok");
    },
    resolve: (n) =>
      n === "svr__write"
        ? {
          isSideEffect: true,
          execute: () => {
            executed++;
            return Promise.resolve("write-ok");
          },
        }
        : undefined,
  };
  const ctx = {
    metrics: { increment: (_n: string) => {} },
    mcp: {
      toolCatalog: () => [
        { clientId: "svr", name: "write", qualifiedName: "svr__write" },
      ],
    },
    toolExecutor: executor,
  } as unknown as AppContext;
  const router = new Router();
  registerCodeModeRoutes(router, ctx);
  const program = 'await sdk.svr.write({ x: 1 }); return "done";';

  try {
    // Unconfirmed ⇒ 403 side_effect_denied, tool NEVER executed.
    const denied = await router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ program }),
      }),
    );
    assertEquals(denied.status, 403);
    assertEquals((await denied.json()).error.type, "side_effect_denied");
    assertEquals(executed, 0);

    // Confirmed ⇒ executes exactly once and returns the program output.
    const ok = await router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-frosty-confirm-side-effects": "true",
        },
        body: JSON.stringify({ program }),
      }),
    );
    assertEquals(ok.status, 200);
    assertEquals((await ok.json()).result, "done");
    assertEquals(executed, 1);
  } finally {
    setWorkerCapability(false);
    if (priorFlag === undefined) Deno.env.delete("FROSTY_CODE_MODE");
    else Deno.env.set("FROSTY_CODE_MODE", priorFlag);
  }
});

// ------------------------------------------------------------------- T13
Deno.test("T13 global-run cap queues excess concurrent runs (never exceeds max)", async () => {
  let live = 0;
  let maxLive = 0;
  const spawnWorker = (): CodeModeWorkerLike => {
    let done: (() => void) | null = null;
    const w: CodeModeWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {
        live = Math.max(0, live - 1);
      },
      postMessage: (message: unknown) => {
        if ((message as { type?: string }).type === "init") {
          live++;
          maxLive = Math.max(maxLive, live);
          // Finish shortly after starting, freeing the run slot.
          done = () => w.onmessage?.({ data: { type: "done", result: "ok" } });
          setTimeout(() => done?.(), 5);
        }
      },
    };
    return w;
  };

  const start = () =>
    runCodeModeProgram({
      program: "noop",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker,
      maxConcurrentRuns: 2,
      timeoutMs: 10_000,
    });

  const runs = [start(), start(), start(), start(), start()];
  await Promise.all(runs);
  assertEquals(maxLive, 2, "concurrent live workers must never exceed the cap");
  assertEquals(activeCodeModeRuns(), 0, "all run slots released");
});

// -------------------------------------------------- AT-M2 (bounded run-queue)
// D-MIN2-A: once the running slots AND the wait-queue are both full,
// acquireRunSlot fast-rejects with CodeModeBusyError, acquiring NO slot. These
// extend the T13 harness (inject spawnWorker, assert activeCodeModeRuns()).

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A pool of held workers whose runs never finish on their own; each `init`
 * registers a `finish()` that completes that run (freeing its slot). Tracks how
 * many workers were actually spawned (a rejected run must spawn none) and the
 * order programs were initialized (for FIFO drain checks).
 */
function makeHeldPool() {
  const finishers: Array<() => void> = [];
  const initOrder: string[] = [];
  let spawnCount = 0;
  let live = 0;
  let maxLive = 0;
  const spawnWorker = (): CodeModeWorkerLike => {
    spawnCount++;
    const w: CodeModeWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {
        live = Math.max(0, live - 1);
      },
      postMessage: (message: unknown) => {
        const m = message as { type?: string; program?: string };
        if (m.type === "init") {
          live++;
          maxLive = Math.max(maxLive, live);
          initOrder.push(m.program ?? "");
          finishers.push(() =>
            w.onmessage?.({ data: { type: "done", result: "ok" } })
          );
        }
      },
    };
    return w;
  };
  return {
    spawnWorker,
    finishers,
    initOrder,
    spawns: () => spawnCount,
    maxLive: () => maxLive,
  };
}

/** Drains every held run to completion so module-level state returns to zero. */
async function drainAll(
  finishers: Array<() => void>,
  runs: Array<Promise<unknown>>,
) {
  for (let i = 0; i < 64 && activeCodeModeRuns() > 0; i++) {
    const f = finishers.shift();
    if (f) f();
    await tick();
  }
  await Promise.allSettled(runs);
}

// ------------------------------------------------------------------ AT-M2-1
Deno.test("AT-M2-1 queue bound: running+queue full ⇒ 5th run rejects CodeModeBusyError", async () => {
  const pool = makeHeldPool();
  const start = () =>
    runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      maxConcurrentRuns: 2,
      maxRunQueue: 2,
      timeoutMs: 30_000,
    });

  // 2 fill the slots, 2 fill the queue (4 pending), then the 5th must reject.
  const held: Array<Promise<unknown>> = [start(), start(), start(), start()];
  // Swallow the four pending rejections that only surface during cleanup.
  held.forEach((p) => p.catch(() => {}));
  let caught: unknown;
  try {
    await start();
  } catch (err) {
    caught = err;
  }
  try {
    assert(
      caught instanceof CodeModeBusyError,
      `5th run must reject CodeModeBusyError, got ${caught}`,
    );
    // Property (a): the reject acquired NO slot — count stayed at the cap (2),
    // never rose to 3, and the rejected run spawned no worker (only 2 so far).
    assertEquals(activeCodeModeRuns(), 2, "reject must not over-count slots");
    assertEquals(pool.spawns(), 2, "rejected run must spawn no worker");
  } finally {
    await drainAll(pool.finishers, held);
  }
  assertEquals(activeCodeModeRuns(), 0, "all slots released after drain");
});

// ------------------------------------------------------------------ AT-M2-2
Deno.test("AT-M2-2 no slot leak: after a BUSY reject, freeing held runs returns to 0", async () => {
  const pool = makeHeldPool();
  const start = () =>
    runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      maxConcurrentRuns: 2,
      maxRunQueue: 2,
      timeoutMs: 30_000,
    });

  const held: Array<Promise<unknown>> = [start(), start(), start(), start()];
  held.forEach((p) => p.catch(() => {}));
  let caught: unknown;
  try {
    await start();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof CodeModeBusyError, `got ${caught}`);

  // Free the four legitimately-held runs; the count must return to exactly 0
  // (the rejected 5th neither consumed a slot nor left one un-released), and
  // exactly 4 workers ever spawned (the rejected run spawned none).
  await drainAll(pool.finishers, held);
  assertEquals(activeCodeModeRuns(), 0, "count returns to 0 — no leak");
  assertEquals(pool.spawns(), 4, "only the 4 admitted runs ever spawned");
});

// ------------------------------------------------------------------ AT-M2-3
Deno.test("AT-M2-3 queue drains FIFO after release (maxLive never exceeds the cap)", async () => {
  const pool = makeHeldPool();
  const start = (tag: string) =>
    runCodeModeProgram({
      program: tag,
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      maxConcurrentRuns: 1,
      maxRunQueue: 2,
      timeoutMs: 30_000,
    });

  // 1 running (run-0), 2 queued (run-1, run-2); a 4th must reject.
  const held: Array<Promise<unknown>> = [
    start("run-0"),
    start("run-1"),
    start("run-2"),
  ];
  held.forEach((p) => p.catch(() => {}));
  await tick();
  let caught: unknown;
  try {
    await start("run-3");
  } catch (err) {
    caught = err;
  }
  try {
    assert(
      caught instanceof CodeModeBusyError,
      `4th must reject, got ${caught}`,
    );
    assertEquals(pool.initOrder, ["run-0"], "only the running one has started");

    // Release the running one ⇒ the FIRST-queued (run-1) starts next, not run-2.
    pool.finishers.shift()!();
    await tick();
    assertEquals(
      pool.initOrder,
      ["run-0", "run-1"],
      "FIFO: first-queued admitted next",
    );
    assertEquals(
      pool.maxLive(),
      1,
      "live workers never exceed maxConcurrentRuns",
    );

    // Release run-1 ⇒ run-2 (second-queued) starts next.
    pool.finishers.shift()!();
    await tick();
    assertEquals(
      pool.initOrder,
      ["run-0", "run-1", "run-2"],
      "FIFO order held",
    );
  } finally {
    await drainAll(pool.finishers, held);
  }
  assertEquals(pool.maxLive(), 1, "cap held across the whole drain");
  assertEquals(activeCodeModeRuns(), 0, "all slots released");
});

// ---------------------------------------------------------- AT-ABORT-1..5
// Client-disconnect abort (design §2/§7). `signal` is optional; the three run
// states plus the admit⇄abort race are honored. All build on the existing
// makeHeldPool()/drainAll/tick/wrapRealWorker harness above.

// ------------------------------------------------------------------ AT-ABORT-1
Deno.test("AT-ABORT-1 already aborted at entry (State A): no acquire, no spawn", async () => {
  const pool = makeHeldPool();
  const ac = new AbortController();
  ac.abort();
  let caught: unknown;
  try {
    await runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      signal: ac.signal,
      timeoutMs: 30_000,
    });
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof DOMException && caught.name === "AbortError",
    `must reject an AbortError DOMException, got ${caught}`,
  );
  assertEquals(pool.spawns(), 0, "State A must never spawn a worker");
  assertEquals(activeCodeModeRuns(), 0, "State A must never acquire a slot");
});

// ------------------------------------------------------------------ AT-ABORT-2
Deno.test("AT-ABORT-2 aborted WHILE QUEUED dequeues without leaking a slot", async () => {
  const pool = makeHeldPool();
  const start = (signal?: AbortSignal) =>
    runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      maxConcurrentRuns: 1,
      maxRunQueue: 4,
      timeoutMs: 30_000,
      signal,
    });

  // run-0 fills the single slot and never finishes on its own.
  const run0 = start();
  run0.catch(() => {});
  await tick();
  assertEquals(activeCodeModeRuns(), 1, "run-0 holds the slot");
  assertEquals(pool.spawns(), 1, "run-0 spawned");

  // run-Q queues under its OWN controller (slot is taken).
  const qac = new AbortController();
  const runQ = start(qac.signal);
  runQ.catch(() => {});
  await tick();
  assertEquals(activeCodeModeRuns(), 1, "run-Q is queued, not running");
  assertEquals(pool.spawns(), 1, "run-Q has NOT spawned a worker");

  // Abort the queued run: it splices out of runWaiters and rejects WITHOUT
  // touching activeRuns (the splice does not decrement).
  qac.abort();
  let caughtQ: unknown;
  try {
    await runQ;
  } catch (err) {
    caughtQ = err;
  }
  assert(
    caughtQ instanceof DOMException && caughtQ.name === "AbortError",
    `run-Q must reject AbortError, got ${caughtQ}`,
  );
  assertEquals(
    activeCodeModeRuns(),
    1,
    "queued-abort splice does NOT decrement activeRuns",
  );
  assertEquals(pool.spawns(), 1, "still no worker for the aborted queued run");

  // THE LOAD-BEARING ASSERTION: finishing run-0 must return the count to 0. If
  // the dead waiter had leaked into runWaiters, releaseRunSlot would shift() it
  // and phantom-increment activeRuns, leaving it 1 forever.
  pool.finishers.shift()!();
  await tick();
  assertEquals(
    activeCodeModeRuns(),
    0,
    "no slot leak: freed slot drained a live (empty) queue, not a dead waiter",
  );

  // A fresh run then acquires the just-freed slot and runs.
  const runN = start();
  runN.catch(() => {});
  await tick();
  assertEquals(activeCodeModeRuns(), 1, "fresh run acquired the freed slot");
  assertEquals(pool.spawns(), 2, "fresh run spawned a worker");

  await drainAll(pool.finishers, [run0, runQ, runN]);
  assertEquals(activeCodeModeRuns(), 0, "all slots released after drain");
});

// ------------------------------------------------------------------ AT-ABORT-3
Deno.test("AT-ABORT-3 aborted WHILE RUNNING (State C): terminate + release", async () => {
  let terminateCalls = 0;
  const ac = new AbortController();
  const runP = runCodeModeProgram({
    program: "while (true) {}",
    sideEffectsConfirmed: false,
    executor: noopExecutor(),
    catalog: [],
    spawnWorker: () =>
      wrapRealWorker(codeModeWorkerUrl(), () => terminateCalls++),
    // A long deadline so the deadline timer cannot be what stops the run —
    // only the abort can (abort must beat the deadline).
    timeoutMs: 30_000,
    signal: ac.signal,
  });
  runP.catch(() => {});
  await tick();
  ac.abort();
  let caught: unknown;
  try {
    await runP;
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof DOMException && caught.name === "AbortError",
    `must reject AbortError, got ${caught}`,
  );
  assert(terminateCalls >= 1, "harness must terminate the worker on abort");
  assertEquals(activeCodeModeRuns(), 0, "the finally released the slot");
});

// ------------------------------------------------------------------ AT-ABORT-4
Deno.test("AT-ABORT-4 admit⇄abort race (State B→C handoff): no slot left held", async () => {
  const pool = makeHeldPool();
  const start = (signal?: AbortSignal) =>
    runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
      maxConcurrentRuns: 1,
      maxRunQueue: 4,
      timeoutMs: 30_000,
      signal,
    });

  const run0 = start();
  run0.catch(() => {});
  await tick();
  assertEquals(activeCodeModeRuns(), 1, "run-0 holds the slot");

  const qac = new AbortController();
  const runQ = start(qac.signal);
  runQ.catch(() => {});
  await tick();
  assertEquals(activeCodeModeRuns(), 1, "run-Q queued");

  // The race: abort the queued run AND free the running slot in the SAME
  // synchronous block, exercising the tick where a waiter may be admitted as
  // the signal aborts.
  qac.abort();
  pool.finishers.shift()!();

  let caughtQ: unknown;
  try {
    await runQ;
  } catch (err) {
    caughtQ = err;
  }
  await tick();
  assert(
    caughtQ instanceof DOMException && caughtQ.name === "AbortError",
    `run-Q must settle exactly once as AbortError, got ${caughtQ}`,
  );
  // The invariant to lock: no interleaving leaves activeCodeModeRuns() > 0.
  assertEquals(activeCodeModeRuns(), 0, "no slot held after the race drains");
  // At most the admitted worker was ever spawned (and any spawned one was
  // terminated) — never more than the two runs that entered.
  assert(pool.spawns() <= 2, `unexpected spawn count ${pool.spawns()}`);

  await drainAll(pool.finishers, [run0, runQ]);
  assertEquals(activeCodeModeRuns(), 0, "all slots released");
});

// ------------------------------------------------------------------ AT-ABORT-5
Deno.test("AT-ABORT-5 listener hygiene: no abort listener leaks across many runs", async () => {
  // A never-aborted signal reused across sequential quick runs. Spy on
  // add/removeEventListener: each run must net to zero registered listeners.
  const realAc = new AbortController();
  let added = 0;
  let removed = 0;
  const spySignal = {
    get aborted() {
      return realAc.signal.aborted;
    },
    get reason() {
      return realAc.signal.reason;
    },
    addEventListener: (
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      added++;
      realAc.signal.addEventListener(type, listener, options);
    },
    removeEventListener: (
      type: string,
      listener: EventListener,
      options?: EventListenerOptions,
    ) => {
      removed++;
      realAc.signal.removeEventListener(type, listener, options);
    },
  } as unknown as AbortSignal;

  // Finish-on-init pool: each run completes immediately, freeing its slot.
  const spawnWorker = (): CodeModeWorkerLike => {
    const w: CodeModeWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {},
      postMessage: (message: unknown) => {
        if ((message as { type?: string }).type === "init") {
          w.onmessage?.({ data: { type: "done", result: "ok" } });
        }
      },
    };
    return w;
  };

  const N = 20;
  for (let i = 0; i < N; i++) {
    const out = await runCodeModeProgram({
      program: "quick",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker,
      signal: spySignal,
      timeoutMs: 30_000,
    });
    assertEquals(out, "ok");
  }
  assertEquals(added, N, "exactly one abort listener added per run");
  assertEquals(
    removed,
    N,
    "exactly one abort listener removed per run (net zero residual)",
  );
  assertEquals(activeCodeModeRuns(), 0, "all slots released");
});
