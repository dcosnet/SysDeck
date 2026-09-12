// Process-topology decisions.
//
// The platform guard is the important one. `Deno.serve({reusePort: true})` is
// accepted on Windows and then FAILS AT BIND with os error 10048, because
// Windows has no SO_REUSEPORT. Without this planner a Windows operator setting
// FROSTY_WORKERS would get N processes racing for one port and N-1 opaque
// crashes; with it they get one process and a message saying why.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { denoRunFlags, planCluster, reusePortSupported } from "./cluster.ts";

Deno.test("reusePort is a POSIX capability", () => {
  assert(reusePortSupported("linux"));
  assert(reusePortSupported("darwin"));
  // Measured, not assumed: two Deno processes binding :18099 with
  // reusePort:true on Windows produce
  //   "Only one usage of each socket address ... (os error 10048)"
  assert(!reusePortSupported("windows"));
});

Deno.test("unset or 1 serves in-process", () => {
  assertEquals(planCluster(undefined, "linux").workers, 0);
  assertEquals(planCluster("", "linux").workers, 0);
  assertEquals(planCluster("1", "linux").workers, 0);
});

Deno.test("a valid count fans out on a platform that supports it", () => {
  const plan = planCluster("4", "linux");
  assertEquals(plan.workers, 4);
  assert(plan.reason.includes("SO_REUSEPORT"));
});

Deno.test("Windows refuses to fan out and says why", () => {
  const plan = planCluster("4", "windows");
  // Degrade to single-process rather than crash at bind time.
  assertEquals(plan.workers, 0);
  assert(plan.reason.includes("SO_REUSEPORT"));
  assert(plan.reason.includes("single-process"));
  // The message has to name the way out, or the operator is just stuck.
  assert(plan.reason.includes("Docker/Linux"));
});

Deno.test("malformed and out-of-range counts degrade to single-process", () => {
  for (const raw of ["abc", "-2", "2.5", "0"]) {
    const plan = planCluster(raw, "linux");
    assertEquals(plan.workers, 0, `FROSTY_WORKERS=${raw} must not fan out`);
  }
  // Past the cap, add machines rather than processes.
  const capped = planCluster("999", "linux");
  assertEquals(capped.workers, 0);
  assert(capped.reason.includes("cap"));
});

Deno.test("a worker child never re-forks", () => {
  // Guards against a fork bomb: the child re-runs the same entry script, so it
  // must read its role from the environment and serve rather than supervise.
  const previous = Deno.env.get("FROSTY_WORKER_ROLE");
  Deno.env.set("FROSTY_WORKER_ROLE", "child");
  try {
    const plan = planCluster("8", "linux");
    assertEquals(plan.workers, 0);
    assertEquals(plan.reason, "worker child");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("FROSTY_WORKER_ROLE");
    } else {
      Deno.env.set("FROSTY_WORKER_ROLE", previous);
    }
  }
});

Deno.test("planCluster: refuses to fan out without run permission", () => {
  // Regression for the containerised failure: the runtime permission set
  // deliberately omits --allow-run, so the supervisor used to die at the first
  // Deno.Command with an uncaught NotCapable instead of serving.
  const plan = planCluster("4", "linux", false);
  assertEquals(plan.workers, 0);
  assertStringIncludes(plan.reason, "run access");
  assertStringIncludes(plan.reason, "single-process");
});

Deno.test("planCluster: fans out when the platform and permission allow", () => {
  const plan = planCluster("4", "linux", true);
  assertEquals(plan.workers, 4);
  assertStringIncludes(plan.reason, "SO_REUSEPORT");
});

Deno.test("planCluster: permission is irrelevant where reusePort is absent", () => {
  // Ordering matters: the platform message is the actionable one on Windows.
  const plan = planCluster("4", "windows", true);
  assertEquals(plan.workers, 0);
  assertStringIncludes(plan.reason, "SO_REUSEPORT");
});

Deno.test("denoRunFlags: children mirror the supervisor's permission set", () => {
  const flags = denoRunFlags(undefined);
  // Least privilege: a child must NOT inherit the supervisor's --allow-run,
  // or every worker could spawn processes.
  assert(!flags.some((f) => f.startsWith("--allow-run")));
  assertEquals(flags.includes("--unstable-net"), true, "reusePort needs it");
  assertEquals(flags.includes("--allow-write=data"), true);
  assert(!flags.some((f) => f.startsWith("--node-modules-dir")));
});

Deno.test("denoRunFlags: module resolution is inherited when set", () => {
  const flags = denoRunFlags("none");
  assert(flags.includes("--node-modules-dir=none"));
});
