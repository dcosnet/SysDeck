import { assert, assertEquals } from "@std/assert";
import {
  activeCodeModeRuns,
  CODE_MODE_WORKER_PERMISSIONS,
  codeModeCapable,
  codeModeWorkerOptions,
} from "./executor.ts";
import {
  appGateOn,
  codeModeExecutorEnabled,
  type EnvReader,
  isExecutorEnabled,
  probeWorkerPermissions,
  runRequested,
  vfsSurfaceEnabled,
} from "./flag.ts";

// Executor stays INERT until BOTH gates pass (design §5.2: S-OFF-3/4) + the
// scaffold's controls. The run primitive is now real (un-stubbed) but reachable
// only through the two-gate route (S-OFF-1/2, route_test.ts) and only after the
// real capability probe passes (S-OFF-4). These assert the executor never
// self-activates on import.

function fakeEnv(vars: Record<string, string>): EnvReader {
  return { get: (key) => vars[key] };
}

// ---------------------------------------------------------------- S-OFF-3
Deno.test("S-OFF-3 executor is inert on import: no probe auto-run, no active runs", () => {
  // Importing the module runs NO probe and spawns NO worker: capability stays
  // the fail-closed default and there are zero in-flight runs. The probe is only
  // triggered by initCodeModeCapability() (context.ts, app-gate-on only).
  assertEquals(codeModeCapable(), false);
  assertEquals(activeCodeModeRuns(), 0);
  // With capability unproven, the runtime gate refuses even when the app gate is
  // on — no execution path is reachable (fail-closed).
  assertEquals(
    codeModeExecutorEnabled(fakeEnv({ FROSTY_CODE_MODE: "on" })),
    false,
  );
});

// worker net stays false (DO-NOT-SHIP gate #3).
Deno.test("worker permissions are all-false; net stays false", () => {
  assertEquals(CODE_MODE_WORKER_PERMISSIONS.net, false);
  for (const value of Object.values(CODE_MODE_WORKER_PERMISSIONS)) {
    assertEquals(value, false);
  }
  assertEquals(codeModeWorkerOptions().deno.permissions.net, false);
  assertEquals(codeModeWorkerOptions().type, "module");
});

// ---------------------------------------------------------------- S-OFF-4
Deno.test("S-OFF-4 capability fail-closed: on-but-uncapable ⇒ disabled", () => {
  // Pure combiner: the app gate alone never enables.
  assertEquals(isExecutorEnabled({ appGateOn: true, capable: false }), false);
  assertEquals(isExecutorEnabled({ appGateOn: false, capable: true }), false);
  assertEquals(isExecutorEnabled({ appGateOn: true, capable: true }), true);
  // The real probe is a deliberate fail-closed stub in this increment.
  assertEquals(probeWorkerPermissions(), false);
  // Therefore even FROSTY_CODE_MODE=on stays disabled at runtime.
  assertEquals(
    codeModeExecutorEnabled(fakeEnv({ FROSTY_CODE_MODE: "on" })),
    false,
  );
});

Deno.test("flag: app gate parsing + default off + short-circuit", () => {
  assertEquals(appGateOn(fakeEnv({})), false); // default off
  assertEquals(appGateOn(fakeEnv({ FROSTY_CODE_MODE: "off" })), false);
  assertEquals(appGateOn(fakeEnv({ FROSTY_CODE_MODE: "ON" })), true);
  // Off ⇒ disabled without consulting the probe (no spawn path).
  assertEquals(codeModeExecutorEnabled(fakeEnv({})), false);
});

Deno.test("flag: VFS surface defaults on, hideable", () => {
  assertEquals(vfsSurfaceEnabled(fakeEnv({})), true);
  assertEquals(
    vfsSurfaceEnabled(fakeEnv({ FROSTY_CODE_MODE_VFS: "on" })),
    true,
  );
  assertEquals(
    vfsSurfaceEnabled(fakeEnv({ FROSTY_CODE_MODE_VFS: "off" })),
    false,
  );
});

Deno.test("flag: run header opt-in parsing", () => {
  assertEquals(
    runRequested(new Headers({ "x-frosty-code-mode": "run" })),
    true,
  );
  assertEquals(runRequested(new Headers()), false);
  assertEquals(
    runRequested(new Headers({ "x-frosty-code-mode": "auto" })),
    false,
  );
});

// -------------------------------------------------------------------- AT-M1-1
// MINOR-1's load-bearing structural guarantee: `deno.jsonc` MUST declare a
// top-level `"unstable"` array containing both "kv" and "worker-options", so
// `--unstable-worker-options` is present for every config-respecting launch and
// the Code Mode capability probe can render a verdict instead of aborting at
// `new Worker`. Regression-lock it. (Comment-tolerant: strips `//` line comments
// while respecting string literals, then JSON.parse.)
function stripJsoncComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

Deno.test("AT-M1-1 deno.jsonc declares top-level unstable = [net, worker-options]", async () => {
  const url = new URL("../../../../deno.jsonc", import.meta.url);
  const raw = await Deno.readTextFile(url);
  const config = JSON.parse(stripJsoncComments(raw)) as {
    unstable?: unknown;
  };
  assert(
    Array.isArray(config.unstable),
    "top-level `unstable` must be an array",
  );
  const unstable = config.unstable as unknown[];
  // `kv` was here until Deno KV was retired for PostgreSQL (decision-log 60);
  // `net` replaced it because Deno.serve({reusePort}) - how N worker processes
  // share one port - is gated behind --unstable-net (decision-log 62).
  assert(
    !unstable.includes("kv"),
    '"unstable" must NOT contain "kv": Deno KV is retired and the flag would ' +
      "re-grant a capability nothing uses",
  );
  assert(unstable.includes("net"), '"unstable" must contain "net"');
  assert(
    unstable.includes("worker-options"),
    '"unstable" must contain "worker-options" (MINOR-1 load-bearing token)',
  );
});
