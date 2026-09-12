import { assert, assertEquals } from "@std/assert";
import { Router } from "../../../core/src/mod.ts";
import type { ToolExecutor } from "../../../core/src/mod.ts";
import { type AppContext, VERSION } from "../../../../apps/gateway/context.ts";
import {
  activeCodeModeRuns,
  type CodeModeWorkerLike,
  runCodeModeProgram,
} from "./executor.ts";
import { registerInferenceRoutes } from "../../../../apps/gateway/routes/inference.ts";
import { ProviderManager } from "../../../providers/src/mod.ts";
import { Metrics } from "../../../telemetry/src/metrics.ts";
import { LogBus } from "../../../telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../../governance/src/virtual_keys.ts";
import { MCPRegistry } from "../registry.ts";
import { PluginManager } from "../../../plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
} from "../../../testing/src/mod.ts";
import { setWorkerCapability } from "./flag.ts";

// S-FUT-4 (inference plane) + T14 (design §4, §8) — the Code Mode meta-tool on
// the real `/v1/chat/completions` route. Both executor gates are forced on for
// these tests (`FROSTY_CODE_MODE=on` + capability probe verdict), so the
// meta-tool is advertised and dispatched. Runs a REAL deny-all worker end-to-end.

const base = "http://gateway.test";

/** Real HTTP JSON-RPC MCP server recording every tools/call. */
function startMCPServer(
  tools: Array<Record<string, unknown>>,
  onCall: (name: string, args: unknown) => string,
) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json();
    let result: unknown = {};
    if (body.method === "initialize") {
      result = { protocolVersion: "2025-06-18" };
    } else if (body.method === "tools/list") {
      result = { tools };
    } else if (body.method === "tools/call") {
      calls.push({ name: body.params.name, args: body.params.arguments });
      result = {
        content: [{
          type: "text",
          text: onCall(body.params.name, body.params.arguments),
        }],
      };
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    calls,
    close: () => server.shutdown(),
  };
}

function makeCtx(providerUrl: string, mcp: MCPRegistry): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "k",
      baseUrl: providerUrl,
      enabled: true,
      models: ["m1"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp,
    plugins: new PluginManager(),
    toolExecutor: mcp.executor(),
    version: VERSION,
  } as unknown as AppContext;
}

/** Assistant turn that calls a tool by name. */
function toolCallBody(name: string, args = "{}") {
  return openAIChatBody("", {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name, arguments: args },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

async function withCodeModeOn(fn: () => Promise<void>): Promise<void> {
  const prior = Deno.env.get("FROSTY_CODE_MODE");
  Deno.env.set("FROSTY_CODE_MODE", "on");
  setWorkerCapability(true);
  try {
    await fn();
  } finally {
    setWorkerCapability(false);
    if (prior === undefined) Deno.env.delete("FROSTY_CODE_MODE");
    else Deno.env.set("FROSTY_CODE_MODE", prior);
  }
}

// ------------------------------------------------------------- S-FUT-4 (b)
Deno.test("S-FUT-4 inference confirm gate: unconfirmed side-effect ⇒ 403", async () => {
  await withCodeModeOn(async () => {
    const mcpServer = startMCPServer(
      [{ name: "commit", description: "writes" }], // no readOnlyHint ⇒ side-effecting
      () => "committed",
    );
    // Model asks Code Mode to run a program that calls the side-effecting tool.
    const provider = new MockProvider(() =>
      jsonResponse(
        toolCallBody(
          "frosty_code_mode_run",
          JSON.stringify({
            program: 'await sdk.sink.commit({ n: 1 }); return "ran";',
          }),
        ),
      )
    );
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    mcp.upsert({
      id: "sink",
      url: `${mcpServer.url}/rpc`,
      transport: "streamable-http",
      enabled: true,
    });
    await mcp.syncAll();
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    try {
      const res = await router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "commit" }],
          }),
        }),
      );
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error.type, "side_effect_denied");
      // The side-effecting tool was NEVER executed.
      assertEquals(mcpServer.calls.length, 0);
    } finally {
      await provider.close();
      await mcpServer.close();
    }
  });
});

Deno.test("S-FUT-4 inference confirm gate: confirmed ⇒ program runs the tool once", async () => {
  await withCodeModeOn(async () => {
    const mcpServer = startMCPServer(
      [{ name: "commit", description: "writes" }],
      () => "committed",
    );
    const provider = new MockProvider((_call, index) =>
      jsonResponse(
        index === 0
          ? toolCallBody(
            "frosty_code_mode_run",
            JSON.stringify({
              program: 'await sdk.sink.commit({ n: 1 }); return "ran";',
            }),
          )
          : openAIChatBody("all done"),
      )
    );
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    mcp.upsert({
      id: "sink",
      url: `${mcpServer.url}/rpc`,
      transport: "streamable-http",
      enabled: true,
    });
    await mcp.syncAll();
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    try {
      const res = await router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
            "x-frosty-confirm-side-effects": "true",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "commit" }],
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).choices[0].message.content, "all done");
      // Confirmed ⇒ the side-effecting tool executed EXACTLY once (raw name).
      assertEquals(mcpServer.calls, [{ name: "commit", args: { n: 1 } }]);
    } finally {
      await provider.close();
      await mcpServer.close();
    }
  });
});

// ------------------------------------------------------------------ AT-M2-6
// D-MIN2-B: on the inference plane a busy run must surface as a TOOL-ERROR
// message (chat continues), NOT an HTTP 429/403. The distinct SideEffectDenied
// ⇒ 403 branch is proven by the S-FUT-4 "unconfirmed side-effect ⇒ 403" test
// above; busy is deliberately routed through the generic tool-error branch.

function noopExecutor(): ToolExecutor {
  return {
    has: () => false,
    isSideEffect: () => true,
    execute: () => Promise.resolve(""),
    resolve: () => undefined,
  };
}

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

Deno.test("AT-M2-6 inference busy ⇒ tool-error message, chat continues (no 429/403)", async () => {
  await withCodeModeOn(async () => {
    // Saturate the shared global run-semaphore (4 running + 8 queued) so the
    // meta-tool's runCodeModeProgram rejects CodeModeBusyError.
    const pool = makeHeldPool();
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

    let toolMsg = "";
    const provider = new MockProvider((call, index) => {
      if (index === 1) {
        const msgs =
          (call.body as { messages?: Array<{ role: string; content: string }> })
            .messages ?? [];
        toolMsg = msgs.find((m) => m.role === "tool")?.content ?? "";
      }
      return jsonResponse(
        index === 0
          ? toolCallBody(
            "frosty_code_mode_run",
            JSON.stringify({ program: 'return "x";' }),
          )
          : openAIChatBody("recovered"),
      );
    });
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    try {
      const res = await router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "run something" }],
          }),
        }),
      );
      // Chat continues to a normal 200 — NOT a mid-inference 429 or 403.
      assertEquals(res.status, 200);
      assertEquals((await res.json()).choices[0].message.content, "recovered");
      // The busy condition reached the model as a tool-error message.
      assert(
        toolMsg.includes("capacity"),
        `tool message must carry the busy signal, got: ${toolMsg}`,
      );
      assert(toolMsg.includes("tool execution failed"), `got: ${toolMsg}`);
    } finally {
      await provider.close();
      // Drain the held runs so module-level slots return to 0.
      for (let i = 0; i < 64 && activeCodeModeRuns() > 0; i++) {
        const f = pool.finishers.shift();
        if (f) f();
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      await Promise.allSettled(held);
      assertEquals(activeCodeModeRuns(), 0);
    }
  });
});

// ------------------------------------------------------------------ AT-ABORT-7
// Inference plane: when the client disconnects mid-run the meta-tool's
// runCodeModeProgram rejects AbortError. With the optional orchestrator
// re-throw, the tool loop unwinds IMMEDIATELY (no extra dispatch turn); the
// request never surfaces as a 403 or 429, and the run's slot is released. The
// distinct denial branch (unconfirmed side-effect ⇒ 403) is proven by the
// "S-FUT-4 inference confirm gate: unconfirmed side-effect ⇒ 403" test above,
// so abort and denial stay on separate branches.
Deno.test("AT-ABORT-7 inference plane unwinds on abort (no 403/429, slot released, no extra dispatch)", async () => {
  await withCodeModeOn(async () => {
    let dispatchCount = 0;
    const provider = new MockProvider((_call, index) => {
      dispatchCount++;
      return jsonResponse(
        index === 0
          ? toolCallBody(
            "frosty_code_mode_run",
            // A spinning program so the run stays in-flight until the abort.
            JSON.stringify({ program: "while (true) {}" }),
          )
          : openAIChatBody("should-not-reach"),
      );
    });
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    const ac = new AbortController();
    try {
      const reqP = router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "run something" }],
          }),
          signal: ac.signal,
        }),
      );
      // Wait until the meta-tool run is in-flight, then the client disconnects.
      for (
        let i = 0;
        i < 200 && activeCodeModeRuns() === 0;
        i++
      ) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      ac.abort();

      let caught: unknown;
      let res: Response | undefined;
      try {
        res = await reqP;
      } catch (err) {
        caught = err;
      }
      // The request unwinds — never a mid-inference 403 or 429. With the
      // orchestrator re-throw the AbortError propagates out of runToolLoop and
      // mapDispatchError re-throws it (top-level errorHandler ⇒ 500 in prod), so
      // router.handle rejects with the AbortError here.
      if (res) {
        assert(
          res.status !== 403 && res.status !== 429,
          `abort must not surface as 403/429, got ${res.status}`,
        );
        await res.body?.cancel();
      } else {
        assert(
          caught instanceof DOMException && caught.name === "AbortError",
          `expected an AbortError unwind, got ${caught}`,
        );
      }
      // The re-throw unwinds immediately: exactly one dispatch (turn 0), no
      // extra turn after the abort.
      assertEquals(dispatchCount, 1, "no extra dispatch after the abort");
    } finally {
      await provider.close();
      // The harness `finally` releases the terminated run's slot.
      for (
        let i = 0;
        i < 64 && activeCodeModeRuns() > 0;
        i++
      ) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      assertEquals(activeCodeModeRuns(), 0, "run slot released on abort");
    }
  });
});

// -------------------------------------------------------------------- T14
Deno.test("T14a reserved name is structurally distinct and off the auto surface", async () => {
  await withCodeModeOn(async () => {
    // An MCP tool whose RAW name equals the reserved meta-tool name.
    const mcpServer = startMCPServer(
      [{ name: "frosty_code_mode_run", annotations: { readOnlyHint: true } }],
      () => "mcp-tool-ran",
    );
    const provider = new MockProvider(() => jsonResponse(openAIChatBody("ok")));
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    mcp.upsert({
      id: "svr",
      url: `${mcpServer.url}/rpc`,
      transport: "streamable-http",
      enabled: true,
    });
    await mcp.syncAll();

    try {
      // Reserved name has no "__" ⇒ can never BE a qualifiedName.
      assert(!"frosty_code_mode_run".includes("__"));
      // The auto surface (x-frosty-mcp-tools: auto catalog) advertises the tool
      // ONLY under its qualifiedName — never the bare reserved name.
      const advertised = ctx.mcp.toolDefinitions().map((d) => d.function.name);
      assert(advertised.includes("svr__frosty_code_mode_run"));
      assert(!advertised.includes("frosty_code_mode_run"));
    } finally {
      await provider.close();
      await mcpServer.close();
    }
  });
});

Deno.test("T14b meta-tool wins: calling the reserved name runs the harness, not the MCP tool", async () => {
  await withCodeModeOn(async () => {
    const mcpServer = startMCPServer(
      [{ name: "frosty_code_mode_run", annotations: { readOnlyHint: true } }],
      () => "mcp-tool-ran",
    );
    // Model calls the reserved name; the program makes NO tool call.
    const provider = new MockProvider((_call, index) =>
      jsonResponse(
        index === 0
          ? toolCallBody(
            "frosty_code_mode_run",
            JSON.stringify({ program: 'return "meta-ran";' }),
          )
          : openAIChatBody("finished"),
      )
    );
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    mcp.upsert({
      id: "svr",
      url: `${mcpServer.url}/rpc`,
      transport: "streamable-http",
      enabled: true,
    });
    await mcp.syncAll();
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    try {
      const res = await router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
            "x-frosty-mcp-tools": "auto",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "go" }],
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals((await res.json()).choices[0].message.content, "finished");
      // The identically-raw-named MCP tool was NOT reached through the meta-tool.
      assertEquals(mcpServer.calls.length, 0);
    } finally {
      await provider.close();
      await mcpServer.close();
    }
  });
});

Deno.test("T14c the MCP tool stays reachable via its qualifiedName", async () => {
  await withCodeModeOn(async () => {
    const mcpServer = startMCPServer(
      [{ name: "frosty_code_mode_run", annotations: { readOnlyHint: true } }],
      () => "mcp-tool-ran",
    );
    // Model calls the QUALIFIED name ⇒ the real MCP tool, not the harness.
    const provider = new MockProvider((_call, index) =>
      jsonResponse(
        index === 0
          ? toolCallBody("svr__frosty_code_mode_run")
          : openAIChatBody("tool answered"),
      )
    );
    const mcp = new MCPRegistry();
    const ctx = makeCtx(provider.url, mcp);
    mcp.upsert({
      id: "svr",
      url: `${mcpServer.url}/rpc`,
      transport: "streamable-http",
      enabled: true,
    });
    await mcp.syncAll();
    const router = new Router();
    registerInferenceRoutes(router, ctx);

    try {
      const res = await router.handle(
        new Request(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-frosty-code-mode": "run",
            "x-frosty-mcp-tools": "auto",
          },
          body: JSON.stringify({
            model: "m1",
            messages: [{ role: "user", content: "go" }],
          }),
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(
        (await res.json()).choices[0].message.content,
        "tool answered",
      );
      // Reached via the qualifiedName ⇒ the MCP tool ran once (raw name upstream).
      assertEquals(mcpServer.calls, [{
        name: "frosty_code_mode_run",
        args: {},
      }]);
    } finally {
      await provider.close();
      await mcpServer.close();
    }
  });
});
