/** Env var naming the child role, so a child never re-forks. */
const ROLE_ENV = "FROSTY_WORKER_ROLE";

/**
 * Internal, set by the container entrypoint so children resolve modules the
 * same way the supervisor does. Not an operator knob.
 */
const NODE_MODULES_ENV = "FROSTY_NODE_MODULES_DIR";

/** Upper bound on FROSTY_WORKERS. Past this, add machines, not processes. */
const MAX_WORKERS = 64;

export interface ClusterPlan {
  /** How many child processes to spawn. 0 means serve in this process. */
  workers: number;
  /** Human-readable reason, logged at boot so the mode is never a surprise. */
  reason: string;
}

/** True when this process was spawned by the supervisor. */
export function isWorkerChild(): boolean {
  return Deno.env.get(ROLE_ENV) === "child";
}

/**
 * SO_REUSEPORT is a POSIX socket option. Deno exposes `reusePort` on every
 * platform but the Windows bind fails, so the capability is decided by OS
 * rather than by probing (a probe would have to bind twice to learn anything).
 */
export function reusePortSupported(os: string = Deno.build.os): boolean {
  return os === "linux" || os === "darwin";
}

/**
 * Whether this process may re-exec the Deno binary, which is how workers are
 * spawned. Absent by design in the default permission set (permissions.md), so
 * it is checked BEFORE fanning out rather than crashing at the first spawn.
 */
function spawnPermitted(): boolean {
  try {
    return Deno.permissions.querySync({
      name: "run",
      command: Deno.execPath(),
    }).state === "granted";
  } catch {
    // Permission querying itself unavailable: assume no, and serve.
    return false;
  }
}

/**
 * Decides how many processes to run. Returns 0 workers - meaning "serve here" -
 * for every case where fanning out is impossible or not asked for, so the
 * caller has exactly one branch.
 */
export function planCluster(
  raw = Deno.env.get("FROSTY_WORKERS"),
  os: string = Deno.build.os,
  canSpawn: boolean = spawnPermitted(),
): ClusterPlan {
  if (isWorkerChild()) {
    return { workers: 0, reason: "worker child" };
  }
  const requested = Number(raw ?? "");
  if (!raw || !Number.isInteger(requested) || requested <= 1) {
    if (raw && (!Number.isInteger(requested) || requested < 0)) {
      return {
        workers: 0,
        reason: `FROSTY_WORKERS=${raw} is not a positive integer; ` +
          `serving single-process`,
      };
    }
    return { workers: 0, reason: "single process (FROSTY_WORKERS unset or 1)" };
  }
  if (requested > MAX_WORKERS) {
    return {
      workers: 0,
      reason: `FROSTY_WORKERS=${requested} exceeds the ${MAX_WORKERS} cap; ` +
        `serving single-process`,
    };
  }
  if (!reusePortSupported(os)) {
    return {
      workers: 0,
      reason:
        `FROSTY_WORKERS=${requested} ignored: ${os} has no SO_REUSEPORT, ` +
        `so processes cannot share a port. Serving single-process. ` +
        `Use Docker/Linux for multi-process, or run replicas on separate ` +
        `ports behind a load balancer.`,
    };
  }
  if (!canSpawn) {
    return {
      workers: 0,
      reason:
        `FROSTY_WORKERS=${requested} ignored: spawning workers needs run ` +
        `access to the Deno binary, which this process was not granted. ` +
        `Serving single-process. In Docker this is handled automatically; ` +
        `from source, add --allow-run=$(which deno).`,
    };
  }
  return {
    workers: requested,
    reason: `${requested} worker processes sharing the port via SO_REUSEPORT`,
  };
}

/**
 * Spawns and supervises `workers` children, each re-running this same entry
 * script with FROSTY_WORKER_ROLE=child. Resolves when every child has exited.
 *
 * Each child opens its OWN PostgreSQL pool and its own LISTEN connection, which
 * is why the connection budget is `workers x FROSTY_PG_POOL_SIZE + workers`.
 * All durable state is shared, so which child answers a request does not matter
 * - that is the property the Postgres consolidation bought.
 */
export async function superviseCluster(workers: number): Promise<void> {
  const children: Deno.ChildProcess[] = [];
  const shuttingDown = { value: false };

  for (let i = 0; i < workers; i++) {
    children.push(spawnChild(i));
  }

  const stopAll = () => {
    if (shuttingDown.value) {
      return;
    }
    shuttingDown.value = true;
    for (const child of children) {
      // Already-dead children throw; a supervisor mid-shutdown does not care.
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  };

  // Forward the operator's signal instead of dying and orphaning the children.
  // SIGBREAK/SIGTERM availability differs by platform, so each is optional.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, stopAll);
    } catch {
      // Not supported on this platform; the other signal still covers it.
    }
  }

  const statuses = await Promise.all(children.map((c) => c.status));
  const failed = statuses.filter((s) => !s.success).length;
  if (failed > 0 && !shuttingDown.value) {
    console.error(
      `${failed} of ${workers} worker processes exited non-zero. ` +
        `The supervisor does not restart them - run under a process manager ` +
        `(Docker restart policy, systemd, Kubernetes) that does.`,
    );
  }
}

function spawnChild(index: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", ...denoRunFlags(), Deno.mainModule],
    env: { [ROLE_ENV]: "child", FROSTY_WORKER_INDEX: String(index) },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

/**
 * The permission set a child needs. It mirrors the `start` task in deno.jsonc
 * rather than reading the parent's flags, because Deno exposes no way to
 * enumerate the permissions the current process was granted - and a child that
 * silently ran with MORE permission than the parent would be a sandbox escape.
 * Keep this in sync with deno.jsonc; permissions.md records the contract.
 */
export function denoRunFlags(
  nodeModulesDir = Deno.env.get(NODE_MODULES_ENV),
): string[] {
  const flags = [
    "--unstable-net",
    "--unstable-worker-options",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-write=data",
  ];
  // Module resolution must match the supervisor's. The container runs with
  // --node-modules-dir=none; without it here, four children race for the
  // node_modules lock at boot ("Blocking waiting for file lock").
  if (nodeModulesDir) {
    flags.push(`--node-modules-dir=${nodeModulesDir}`);
  }
  return flags;
}
