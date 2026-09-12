import { assert, assertEquals } from "@std/assert";
import { Router } from "../../../core/src/mod.ts";
import type { ToolExecutor } from "../../../core/src/mod.ts";
import { SideEffectDeniedError } from "../../../core/src/mod.ts";
import type { AppContext } from "../../../../apps/gateway/context.ts";
import {
  mapCodeModeRunError,
  registerCodeModeRoutes,
} from "../../../../apps/gateway/routes/codemode.ts";
import {
  activeCodeModeRuns,
  CodeModeBusyError,
  CodeModeTimeoutError,
  type CodeModeWorkerLike,
  runCodeModeProgram,
} from "./executor.ts";
import { setWorkerCapability } from "./flag.ts";

// Run-endpoint refusal contract (design §5.2: S-OFF-1/2) driven through the real
// route + router, plus the VFS route shape the Wave-3 UI consumes.

function makeCtx(): AppContext {
  return {
    metrics: { increment: (_name: string) => {} },
    mcp: { toolCatalog: () => [] },
  } as unknown as AppContext;
}

function withCleanEnvAndWorkerSpy(
  fn: (spawns: () => number) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const priorFlag = Deno.env.get("FROSTY_CODE_MODE");
    Deno.env.delete("FROSTY_CODE_MODE"); // ensure disabled default
    const g = globalThis as unknown as { Worker: unknown };
    const originalWorker = g.Worker;
    let spawns = 0;
    g.Worker = class {
      constructor() {
        spawns++;
        throw new Error("Code Mode must not spawn a worker while disabled");
      }
    };
    try {
      await fn(() => spawns);
    } finally {
      g.Worker = originalWorker;
      if (priorFlag === undefined) {
        Deno.env.delete("FROSTY_CODE_MODE");
      } else {
        Deno.env.set("FROSTY_CODE_MODE", priorFlag);
      }
    }
  };
}

Deno.test(
  "S-OFF-1 POST run ⇒ 403 code_mode_disabled, zero worker spawns",
  withCleanEnvAndWorkerSpy(async (spawns) => {
    const router = new Router();
    registerCodeModeRoutes(router, makeCtx());
    const res = await router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assertEquals(res.status, 403);
    const body = await res.json() as {
      error: { type: string; message: string };
    };
    assertEquals(body.error.type, "code_mode_disabled");
    assert(body.error.message.includes("FROSTY_CODE_MODE=off"));
    assertEquals(spawns(), 0);
  }),
);

Deno.test(
  "S-OFF-2 header x-frosty-code-mode: run cannot enable when flag off",
  withCleanEnvAndWorkerSpy(async (spawns) => {
    Deno.env.set("FROSTY_CODE_MODE", "off");
    const router = new Router();
    registerCodeModeRoutes(router, makeCtx());
    const res = await router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-frosty-code-mode": "run",
        },
        body: "{}",
      }),
    );
    assertEquals(res.status, 403);
    const body = await res.json() as { error: { type: string } };
    assertEquals(body.error.type, "code_mode_disabled");
    assertEquals(spawns(), 0);
  }),
);

// ------------------------------------------------------------------ AT-M2-5
// Admin plane: a saturated global run-semaphore ⇒ POST /run rejects with
// CodeModeBusyError, which mapCodeModeRunError renders as 429 `code_mode_busy` —
// distinct from 403 `side_effect_denied` and 504 `code_mode_timeout`.

function noopExecutor(): ToolExecutor {
  return {
    has: () => false,
    isSideEffect: () => true,
    execute: () => Promise.resolve(""),
    resolve: () => undefined,
  };
}

/** Held workers that never finish, so the runs they back keep their slots. */
function makeHeldPool() {
  const finishers: Array<() => void> = [];
  const spawnWorker = (): CodeModeWorkerLike => {
    const w: CodeModeWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {},
      postMessage: (message: unknown) => {
        if ((message as { type?: string }).type === "init") {
          finishers.push(() =>
            w.onmessage?.({ data: { type: "done", result: "ok" } })
          );
        }
      },
    };
    return w;
  };
  return { spawnWorker, finishers };
}

function makeRunCtx(): AppContext {
  return {
    metrics: { increment: (_name: string) => {} },
    mcp: { toolCatalog: () => [] },
    toolExecutor: noopExecutor(),
  } as unknown as AppContext;
}

Deno.test("AT-M2-5 saturated semaphore ⇒ POST run returns 429 code_mode_busy", async () => {
  const priorFlag = Deno.env.get("FROSTY_CODE_MODE");
  Deno.env.set("FROSTY_CODE_MODE", "on");
  setWorkerCapability(true); // both gates on so the route reaches the run harness
  const pool = makeHeldPool();
  // Fill the default global semaphore: 4 running + 8 queued = 12 outstanding.
  const held: Array<Promise<unknown>> = [];
  for (let i = 0; i < 12; i++) {
    const p = runCodeModeProgram({
      program: "held",
      sideEffectsConfirmed: false,
      executor: noopExecutor(),
      catalog: [],
      spawnWorker: pool.spawnWorker,
    });
    p.catch(() => {});
    held.push(p);
  }
  await new Promise<void>((r) => setTimeout(r, 0));

  try {
    const router = new Router();
    registerCodeModeRoutes(router, makeRunCtx());
    const res = await router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ program: 'return "x";' }),
      }),
    );
    assertEquals(res.status, 429);
    const body = await res.json() as { error: { type: string } };
    assertEquals(body.error.type, "code_mode_busy");
  } finally {
    // Drain every held run so module-level slots return to 0.
    for (let i = 0; i < 64 && activeCodeModeRuns() > 0; i++) {
      const f = pool.finishers.shift();
      if (f) f();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await Promise.allSettled(held);
    setWorkerCapability(false);
    if (priorFlag === undefined) Deno.env.delete("FROSTY_CODE_MODE");
    else Deno.env.set("FROSTY_CODE_MODE", priorFlag);
    assertEquals(activeCodeModeRuns(), 0);
  }
});

// ------------------------------------------------------------------ AT-ABORT-6
// Admin route: a run whose HTTP client disconnects mid-flight maps to 499
// `client_closed_request` — distinct from 403/429/504 (each guarded by a
// disjoint instanceof), and the run's slot is released by the harness `finally`.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("AT-ABORT-6 POST run: client disconnect mid-flight ⇒ 499 client_closed_request", async () => {
  const priorFlag = Deno.env.get("FROSTY_CODE_MODE");
  Deno.env.set("FROSTY_CODE_MODE", "on");
  setWorkerCapability(true); // both gates on so the route reaches the run harness

  const ac = new AbortController();
  try {
    const router = new Router();
    registerCodeModeRoutes(router, makeRunCtx());
    // A spinning program + long deadline so ONLY the abort can stop the run
    // (the real deny-all worker is spawned via the route's default path).
    const resP = router.handle(
      new Request("http://localhost/api/mcp/codemode/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ program: "while (true) {}" }),
        signal: ac.signal,
      }),
    );
    // Wait until the run is actually in-flight (State C), then disconnect.
    for (let i = 0; i < 100 && activeCodeModeRuns() === 0; i++) await tick();
    ac.abort();
    const res = await resP;
    assertEquals(res.status, 499);
    const body = await res.json() as { error: { type: string } };
    assertEquals(body.error.type, "client_closed_request");
  } finally {
    setWorkerCapability(false);
    if (priorFlag === undefined) Deno.env.delete("FROSTY_CODE_MODE");
    else Deno.env.set("FROSTY_CODE_MODE", priorFlag);
    // Allow the terminated run's `finally` to release the slot.
    for (let i = 0; i < 64 && activeCodeModeRuns() > 0; i++) await tick();
    assertEquals(activeCodeModeRuns(), 0, "run slot released after the abort");
  }
});

Deno.test("AT-ABORT-6b mapCodeModeRunError keeps abort (499) disjoint from 403/429/504", () => {
  assertEquals(
    mapCodeModeRunError(new SideEffectDeniedError("t")).status,
    403,
  );
  assertEquals(mapCodeModeRunError(new CodeModeTimeoutError(5)).status, 504);
  assertEquals(mapCodeModeRunError(new CodeModeBusyError()).status, 429);
  assertEquals(
    mapCodeModeRunError(new DOMException("gone", "AbortError")).status,
    499,
  );
});

Deno.test("GET codemode/vfs returns the VFS tree shape", async () => {
  const router = new Router();
  registerCodeModeRoutes(router, makeCtx());
  const res = await router.handle(
    new Request("http://localhost/api/mcp/codemode/vfs?binding=server"),
  );
  assertEquals(res.status, 200);
  const body = await res.json() as {
    bindingLevel: string;
    files: unknown[];
    generatedAt: null;
  };
  assertEquals(body.bindingLevel, "server-level");
  assertEquals(body.generatedAt, null);
  assert(Array.isArray(body.files));
});
