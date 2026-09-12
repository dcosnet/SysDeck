// The full validation suite as one command with one verdict.
//
//   deno task test:all               every stage that can run here
//   deno task test:all -- --bail     stop at the first failure
//   deno task test:all -- --list     print the plan and exit
//
// Stages run in dependency order: static checks before tests, backend before
// UI, and the two stages with external dependencies last. A stage whose
// prerequisite is missing is SKIPPED and reported as skipped - never silently
// dropped, because a suite that hides what it did not run reads as broader
// coverage than it has.

interface Stage {
  name: string;
  what: string;
  cmd: string[];
  cwd?: string;
  /** Returns null when runnable, or the reason it must be skipped. */
  requires?: () => Promise<string | null>;
}

type Outcome = "passed" | "failed" | "skipped";

interface Result {
  stage: Stage;
  outcome: Outcome;
  ms: number;
  detail: string;
}

const DENO = Deno.execPath();

/** The unstable flags the runtime contract depends on (permissions.md). */
const TEST_FLAGS = [
  "--unstable-net",
  "--unstable-worker-options",
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-run",
];

const GATEWAY_URL = Deno.env.get("FROSTY_BASE_URL") ?? "http://localhost:8080";

async function commandExists(bin: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(bin, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    return (await probe.output()).success;
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<string | null> {
  if (!await commandExists("docker")) {
    return "docker is not on PATH";
  }
  try {
    const info = new Deno.Command("docker", {
      args: ["info", "--format", "{{.ServerVersion}}"],
      stdout: "null",
      stderr: "null",
    });
    return (await info.output()).success ? null : "docker daemon unreachable";
  } catch {
    return "docker daemon unreachable";
  }
}

async function gatewayReady(): Promise<string | null> {
  if (!await commandExists("npx")) {
    return "npx is not on PATH (the browser harness is Node-based)";
  }
  try {
    const response = await fetch(`${GATEWAY_URL}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    return response.ok ? null : `${GATEWAY_URL} returned ${response.status}`;
  } catch {
    return `no gateway at ${GATEWAY_URL} (start one, or set FROSTY_BASE_URL)`;
  }
}

const STAGES: Stage[] = [
  {
    name: "fmt",
    what: "formatting",
    cmd: [DENO, "fmt", "--check"],
  },
  {
    name: "lint",
    what: "lint rules",
    cmd: [DENO, "lint"],
  },
  {
    name: "typecheck",
    what: "backend types",
    cmd: [DENO, "task", "check"],
  },
  {
    name: "unit",
    what: "per-package logic",
    cmd: [DENO, "test", ...TEST_FLAGS, "packages/"],
  },
  {
    name: "contract",
    what: "wire-format fidelity",
    cmd: [DENO, "test", ...TEST_FLAGS, "tests/contract/"],
  },
  {
    name: "integration",
    what: "cross-package behavior",
    cmd: [DENO, "test", ...TEST_FLAGS, "tests/integration/", "apps/gateway/"],
  },
  {
    name: "e2e",
    what: "real HTTP and SPA serving",
    cmd: [DENO, "test", ...TEST_FLAGS, "tests/e2e/"],
  },
  {
    name: "ui-typecheck",
    what: "control-ui types",
    cmd: [DENO, "task", "check-ui"],
  },
  {
    name: "ui-unit",
    what: "control-ui components",
    cmd: [DENO, "task", "test-ui"],
  },
  {
    name: "ui-build",
    what: "production bundle",
    cmd: [DENO, "task", "build-ui"],
  },
  {
    name: "live",
    what: "real PostgreSQL round trips",
    cmd: [DENO, "task", "test:live"],
    requires: dockerReady,
  },
  {
    name: "browser",
    what: "Playwright smoke against a running gateway",
    cmd: ["npx", "playwright", "test"],
    cwd: "tests/browser",
    requires: gatewayReady,
  },
];

async function run(stage: Stage): Promise<Result> {
  const skip = stage.requires ? await stage.requires() : null;
  if (skip !== null) {
    return { stage, outcome: "skipped", ms: 0, detail: skip };
  }
  console.log(`\n=== ${stage.name}: ${stage.what} ===`);
  const started = performance.now();
  const [bin, ...args] = stage.cmd;
  const child = new Deno.Command(bin, {
    args,
    cwd: stage.cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  const ms = performance.now() - started;
  return {
    stage,
    outcome: status.success ? "passed" : "failed",
    ms,
    detail: status.success ? "" : `exit ${status.code}`,
  };
}

if (import.meta.main) {
  const bail = Deno.args.includes("--bail");

  if (Deno.args.includes("--list")) {
    for (const stage of STAGES) {
      console.log(`${stage.name.padEnd(14)} ${stage.what}`);
    }
    Deno.exit(0);
  }

  const results: Result[] = [];
  for (const stage of STAGES) {
    const result = await run(stage);
    results.push(result);
    if (result.outcome === "failed" && bail) {
      console.error(`\n--bail: stopping at ${stage.name}`);
      break;
    }
  }

  const mark = { passed: "PASS", failed: "FAIL", skipped: "SKIP" } as const;
  console.log(`\n${"=".repeat(66)}\nFULL SUITE\n${"=".repeat(66)}`);
  for (const result of results) {
    const seconds = result.outcome === "skipped"
      ? "    -"
      : `${(result.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(
      `${mark[result.outcome]}  ${
        result.stage.name.padEnd(14)
      } ${seconds}  ${result.detail}`,
    );
  }

  const notRun = STAGES.length - results.length;
  const failed = results.filter((r) => r.outcome === "failed");
  const skipped = results.filter((r) => r.outcome === "skipped");
  console.log(
    `\n${results.filter((r) => r.outcome === "passed").length} passed, ` +
      `${failed.length} failed, ${skipped.length} skipped` +
      (notRun > 0 ? `, ${notRun} not reached` : ""),
  );
  // Skips are stated again at the end: the summary above scrolls away, and an
  // unnoticed skip is how a suite gets believed to cover more than it does.
  for (const result of skipped) {
    console.log(`  skipped ${result.stage.name}: ${result.detail}`);
  }
  Deno.exit(failed.length > 0 ? 1 : 0);
}
