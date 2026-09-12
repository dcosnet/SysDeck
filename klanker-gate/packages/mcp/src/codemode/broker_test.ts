import { assert, assertEquals } from "@std/assert";
import type { ToolExecutor } from "../../../core/src/mod.ts";
import { CodeModeBroker } from "./broker.ts";

// Broker boundary controls (design §5.3: S-BRK-1..4). Tested now with a FAKE
// worker (plain objects posted to handleMessage), because the broker only calls
// the EXISTING gated executor + confirm gate — no worker isolate is required to
// prove the controls hold. This gates the FUTURE enable.

interface ToolSpec {
  sideEffect: boolean;
  run: (args: unknown) => string;
}

function makeExecutor(tools: Record<string, ToolSpec>) {
  const executes: Array<{ name: string; args: unknown }> = [];
  const executor: ToolExecutor = {
    has: (name) => name in tools,
    isSideEffect: (name) => tools[name]?.sideEffect ?? true,
    execute: (name, args) => {
      const tool = tools[name];
      if (!tool) return Promise.reject(new Error("unknown"));
      executes.push({ name, args });
      return Promise.resolve(tool.run(args));
    },
    resolve: (name) => {
      const tool = tools[name];
      if (!tool) return undefined;
      return {
        isSideEffect: tool.sideEffect,
        execute: (args) => {
          executes.push({ name, args });
          return Promise.resolve(tool.run(args));
        },
      };
    },
  };
  return { executor, executes };
}

const TOOLS: Record<string, ToolSpec> = {
  "svr__read": { sideEffect: false, run: () => "read-ok" },
  "svr__write": { sideEffect: true, run: () => "write-ok" },
};

// ---------------------------------------------------------------- S-BRK-1
Deno.test("S-BRK-1 confirm gate across the boundary", async () => {
  // Unconfirmed side-effecting tool ⇒ denied, execute NEVER called.
  {
    const { executor, executes } = makeExecutor(TOOLS);
    const broker = new CodeModeBroker({
      executor,
      sideEffectsConfirmed: false,
    });
    const res = await broker.handleMessage({
      type: "tool_call",
      callId: 1,
      qualifiedName: "svr__write",
    });
    assertEquals(res?.ok, false);
    assert(res?.content.includes("side effects"));
    assertEquals(executes.length, 0);
  }
  // Confirmed ⇒ executes exactly once.
  {
    const { executor, executes } = makeExecutor(TOOLS);
    const broker = new CodeModeBroker({ executor, sideEffectsConfirmed: true });
    const res = await broker.handleMessage({
      type: "tool_call",
      callId: 2,
      qualifiedName: "svr__write",
      args: { x: 1 },
    });
    assertEquals(res, {
      type: "tool_result",
      callId: 2,
      ok: true,
      content: "write-ok",
    });
    assertEquals(executes, [{ name: "svr__write", args: { x: 1 } }]);
  }
});

// ---------------------------------------------------------------- S-BRK-2
Deno.test("S-BRK-2 registry allowlists honored (unknown ⇒ error, no execution)", async () => {
  const { executor, executes } = makeExecutor(TOOLS);
  const broker = new CodeModeBroker({ executor, sideEffectsConfirmed: true });
  const res = await broker.handleMessage({
    type: "tool_call",
    callId: 9,
    qualifiedName: "svr__not_exposed",
  });
  assertEquals(res?.ok, false);
  assert(res?.content.includes("unknown or unexposed"));
  assertEquals(executes.length, 0);
});

// M1: a resolver WITHOUT the atomic `resolve` gate fails closed (no non-atomic
// has()+isSideEffect()+execute() TOCTOU fallback).
Deno.test("S-BRK-2 non-atomic executor (no resolve) is refused, no execution", async () => {
  let executed = 0;
  const nonAtomic: ToolExecutor = {
    has: () => true,
    isSideEffect: () => false,
    execute: () => {
      executed++;
      return Promise.resolve("should-not-run");
    },
    // resolve intentionally omitted.
  };
  const broker = new CodeModeBroker({
    executor: nonAtomic,
    sideEffectsConfirmed: true,
  });
  const res = await broker.handleMessage({
    type: "tool_call",
    callId: 1,
    qualifiedName: "svr__read",
  });
  assertEquals(res?.ok, false);
  assert(res?.content.includes("atomic"));
  assertEquals(executed, 0);
});

// ---------------------------------------------------------------- S-BRK-3
Deno.test("S-BRK-3 hostile / malformed messages are dropped", async () => {
  const { executor, executes } = makeExecutor(TOOLS);
  const broker = new CodeModeBroker({ executor, sideEffectsConfirmed: false });

  assertEquals(await broker.handleMessage(null), undefined);
  assertEquals(await broker.handleMessage({}), undefined);
  assertEquals(await broker.handleMessage("nope"), undefined);
  // Unknown type dropped.
  assertEquals(
    await broker.handleMessage({
      type: "evil",
      callId: 1,
      qualifiedName: "svr__read",
    }),
    undefined,
  );
  // A worker-FORGED tool_result (result it never earned) is dropped.
  assertEquals(
    await broker.handleMessage({
      type: "tool_result",
      callId: 1,
      ok: true,
      content: "x",
    }),
    undefined,
  );
  // log/done produce no result.
  assertEquals(
    await broker.handleMessage({ type: "log", callId: 1 }),
    undefined,
  );

  // A worker-supplied `confirmed` flag is IGNORED — the decision comes from the
  // HTTP request only. Side-effecting + unconfirmed ⇒ still denied, no execute.
  const forged = await broker.handleMessage({
    type: "tool_call",
    callId: 5,
    qualifiedName: "svr__write",
    confirmed: true,
    sideEffectsConfirmed: true,
  });
  assertEquals(forged?.ok, false);
  assertEquals(executes.length, 0);
});

// ---------------------------------------------------------------- S-BRK-4
Deno.test("S-BRK-4 tool-call budget caps amplification", async () => {
  const { executor, executes } = makeExecutor(TOOLS);
  const broker = new CodeModeBroker({
    executor,
    sideEffectsConfirmed: false,
    maxCalls: 1,
  });
  const first = await broker.handleMessage({
    type: "tool_call",
    callId: 1,
    qualifiedName: "svr__read",
  });
  assertEquals(first?.ok, true);
  const second = await broker.handleMessage({
    type: "tool_call",
    callId: 2,
    qualifiedName: "svr__read",
  });
  assertEquals(second?.ok, false);
  assert(second?.content.includes("budget exceeded"));
  assertEquals(executes.length, 1);
});

Deno.test("S-BRK-4 oversized result is truncated + errored", async () => {
  const big = "x".repeat(1000);
  const { executor } = makeExecutor({
    "svr__read": { sideEffect: false, run: () => big },
  });
  const broker = new CodeModeBroker({
    executor,
    sideEffectsConfirmed: false,
    maxResultBytes: 100,
  });
  const res = await broker.handleMessage({
    type: "tool_call",
    callId: 1,
    qualifiedName: "svr__read",
  });
  assertEquals(res?.ok, false);
  assert(res?.content.includes("[truncated"));
  assert((res?.content.length ?? 0) < big.length);
});
