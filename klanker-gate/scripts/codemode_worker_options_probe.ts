// AT-M1-3 helper — minimal out-of-process reproduction of MINOR-1's load-bearing
// behavior WITHOUT booting the whole gateway. Spawns ONE deny-all permission-
// scoped Worker (the same descriptor the Code Mode capability probe uses) and
// reports the outcome via the PROCESS EXIT CODE:
//
//   exit 0  -> `new Worker(url, { deno: { permissions } })` succeeded, i.e.
//             `--unstable-worker-options` was structurally present (from the
//             `deno.jsonc` "unstable" array or a CLI flag) and the deny-all
//             descriptor was accepted. Prints the worker's enforcement report.
//   exit 70 -> the flag was absent; Deno aborts at `new Worker` with
//             "Unstable API 'Worker.deno.permissions'..." BEFORE this script can
//             catch anything (the abort is uncatchable — that is MINOR-1).
//
// This is intentionally NOT a `deno test`: the exit-70 case kills the process,
// so it can only be observed from the outside. `codemode_launch_matrix.sh` runs
// this under the launch grid and asserts the exit codes.

const workerSrc = `
(async () => {
  const check = async (fn) => {
    try { await fn(); return "allowed"; } catch { return "denied"; }
  };
  const env = await check(() => Deno.env.get("PATH"));
  self.postMessage({ type: "probe_result", env });
  self.close();
})();
`;
const url = `data:application/javascript,${encodeURIComponent(workerSrc)}`;

// The exact deny-all descriptor Code Mode uses (executor.ts).
const permissions = {
  env: false,
  read: false,
  write: false,
  net: false,
  run: false,
  ffi: false,
  sys: false,
  import: false,
} as const;

console.log("[probe] before spawn");
// If --unstable-worker-options is absent, the next line ABORTS the process
// (exit 70) — uncatchable. If present, it returns a Worker.
const worker = new Worker(url, {
  type: "module",
  deno: { permissions },
} as unknown as WorkerOptions);
console.log("[probe] after spawn (no abort)");

const result = await new Promise<Record<string, unknown>>((resolve) => {
  const timer = setTimeout(() => resolve({ env: "timeout" }), 3000);
  worker.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data as Record<string, unknown>);
  };
});
worker.terminate();
console.log(`[probe] probe_result: ${JSON.stringify(result)}`);
// env MUST be "denied": the descriptor was not only accepted but ENFORCED.
if (result.env !== "denied") {
  console.error("[probe] FAIL: deny-all descriptor not enforced");
  Deno.exit(1);
}
console.log("[probe] OK: worker-options present and descriptor enforced");
