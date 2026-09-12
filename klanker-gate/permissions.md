# Deno Permission Policy

The gateway runs least-privileged. The canonical flag set (used by the tasks,
Dockerfile, and `deno compile`) is:

```
--unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write=data
```

Each granted flag, and why:

- **`--allow-net`**: Listening port, provider egress, MCP server calls, and the
  PostgreSQL connection. Tighten to a host allowlist
  (`--allow-net=api.openai.com,api.anthropic.com,…,0.0.0.0:8080,db-host:5432`)
  when the provider set is fixed.
- **`--allow-env`**: Provider keys and `FROSTY_*` configuration.
- **`--allow-read`**: `deno.jsonc` and the built UI under
  `apps/control-ui/dist`.
- **`--allow-write=data`**: process-local scratch only — no other write access.
  Durable state lives in PostgreSQL, so this no longer covers a database file.
- **`--unstable-net`**: `Deno.serve({ reusePort })`, which is how N worker
  processes share one port (decision-log 62). Read `FROSTY_WORKERS` to decide
  whether it is used at all; a single-process deployment never sets `reusePort`
  and the flag then grants nothing that is exercised.
- **`--unstable-worker-options`**: **NARROWS, never grants.** Enables
  per-`Worker` permission descriptors so the Code Mode sandbox worker can be
  spawned with **every** permission denied (a strict subset of the parent). This
  flag hands the process **no new capability** — it is the mechanism by which
  permissions are taken **away** from a child worker, the opposite of
  `--allow-run`. Without it, `new Worker(..., { deno: { permissions } })` is
  rejected and the Code Mode capability probe fails **closed** (executor
  refuses). Note: a standalone `deno compile` binary must be built **with**
  `--unstable-worker-options` for the enabled Code Mode path to work; a
  default-off binary lacking it fails the probe closed (safe).

## Flag-set history

The set changed once, in the PostgreSQL state consolidation (decision-log 62):
**`--unstable-kv` was removed** and **`--unstable-net` added**. Net count is
unchanged, and the process is strictly LESS capable than before - it can no
longer open a Deno KV database at all.

`--unstable-kv` survives in exactly one place: the `migrate:kv-pg` task, which
runs the one-time KV-to-PostgreSQL migration. That task also carries
`--allow-write=data`, which is unavoidable rather than intended - Deno KV opens
its SQLite file read-write even for a pure read, so read-only intent cannot be
expressed at the permission layer. The script enforces it instead, by only ever
calling `kv.list()`.

## Runtime module resolution (not a permission)

The container runtime image passes `--node-modules-dir=none` alongside the flags
above, so the gateway resolves its npm deps (`zod`, `postgres`) from Deno's
global module cache and bakes no `node_modules` into the image. It is a
module-resolution flag, not a permission, and grants no capability.

## Opt-in: stdio MCP servers (`--allow-run`)

stdio (subprocess) MCP servers are **disabled by default** (wave-4, decision
D10). Enabling them takes two deliberate steps, both required:

1. `FROSTY_MCP_ALLOW_STDIO=1` — application-level gate; without it the registry
   rejects stdio configs with a 400 and skips any persisted ones at boot (with a
   warning).
2. `--allow-run` appended to the run flags — permission-level gate. Tighten to
   an executable allowlist (`--allow-run=/usr/bin/my-mcp`) when the tool set is
   fixed.

Every HTTP transport works without either. The test task keeps `--allow-run` for
the stdio test fixture only.

## Opt-in: multi-process serving (`--allow-run=<deno>`)

`FROSTY_WORKERS>1` makes the entry process a supervisor that re-execs the Deno
binary once per worker, which needs run permission. Two properties keep that
from being a general escalation:

- **Scoped, not blanket.** `deploy/docker-entrypoint.sh` grants
  `--allow-run=$(command -v deno)` and nothing else, and only when
  `FROSTY_WORKERS>1`. The default single-process container has no run permission
  at all.
- **Supervisor only.** Children are spawned with the flag set in
  `apps/gateway/cluster.ts`, which excludes `--allow-run`. A worker therefore
  cannot spawn anything. The supervisor serves no traffic and holds no state, so
  the process that can spawn is not the process that touches request data.

`planCluster()` checks the permission before fanning out and degrades to
single-process with a stated reason when it is absent, so a missing capability
is a log line rather than an uncaught `NotCapable` at the first spawn
(decision-log 67).

From source, multi-process needs the flag added by hand:
`deno run --allow-run=$(which deno) ... apps/gateway/main.ts`.

## Opt-in: MCP Code Mode executor (experimental, DEFAULT-OFF)

Code Mode has two surfaces with very different risk:

- **VFS / codegen metadata (LIVE).** `GET /api/mcp/codemode/vfs`
  deterministically generates inert tool-stub source from the MCP catalog (the
  same metadata `GET /api/mcp/tools` already exposes) — a Python **display**
  preview plus a TypeScript SDK the model authors against. It performs **no
  execution and reads no secrets** — it is a pure string transform over the
  catalog. Live by default; set `FROSTY_CODE_MODE_VFS=off` to hide even this
  metadata.
- **Sandboxed executor (BUILT, default-off).** Running LLM-authored code is a
  Tier-3 trust boundary (the model is treated as adversarial under prompt
  injection). The enabled path is now built — the program runs as TypeScript
  inside a **deny-all Deno Worker** (`new Function` async IIFE; no `import`),
  and its ONLY egress is the broker RPC on the main isolate — but it stays **off
  by default**, behind the same two-independent-gates doctrine as stdio (D10):

  1. `FROSTY_CODE_MODE=on` — application gate (**default `off`**; the executor
     is refused otherwise).
  2. A **real** boot worker-permission enforceability probe must pass —
     capability gate. At boot (only when the app gate is on) one deny-all probe
     worker attempts `Deno.env.get`, `Deno.readFile("data/frosty.kv")`, and
     `fetch("http://169.254.169.254/…")`; the executor enables **only** if the
     worker spawned with the descriptor **and** all three were denied. Any
     access that succeeds, a timeout, or an error ⇒ the executor is refused
     **even when `FROSTY_CODE_MODE=on`** (fail-closed, analogous to
     `--allow-run` for stdio). (Deno 2.9.x reports worker-scoped denials as
     `NotCapable`; the probe accepts that and `PermissionDenied` both.)

     **`--unstable-worker-options` is MANDATORY when `FROSTY_CODE_MODE=on`.**
     Per-worker permission scoping requires it. The top-level
     `"unstable": ["net", "worker-options"]` array in `deno.jsonc` now makes
     this flag **structurally present for every config-respecting launch** —
     `deno run`, `deno task dev`/`start`/`test`, and (baked into the binary)
     `deno compile` — so a normal app-gate-on launch can no longer omit it and
     abort at the probe's `new Worker`. The redundant `--unstable-*` CLI flags
     in the shipped tasks and the Docker CMD are kept as idempotent
     defense-in-depth. **Residual (still fail-_stopped_, never fail-open):** the
     boot abort remains reachable only by deliberately bypassing the project
     config — launching with `--no-config`, pointing `--config` at a file
     lacking the `worker-options` entry, or running a binary compiled against
     such a config. On current Deno there is no in-process way to detect the
     missing flag before the fatal `new Worker` (the abort is an uncatchable
     process exit), so the fix is structural (make the flag non-omittable via
     config), not a graceful in-process degrade. A default-off binary never runs
     the probe, so it starts normally regardless.

  **Reachability (both behind the two gates + probe):**
  - Admin route `POST /api/mcp/codemode/run` — state-changing `/api/*` behind
    the admin token + origin guard.
  - Inference opt-in `x-frosty-code-mode: run` on `/v1/chat/completions` and
    `/v1/responses` — advertises ONE gateway-owned meta-tool
    `frosty_code_mode_run({ program })` (non-streaming only). The header alone
    never enables anything; with the executor disabled the request is returned
    byte-unchanged (the meta-tool is simply not advertised — no mid-inference
    403). A process-wide concurrent-run cap (`CODE_MODE_MAX_CONCURRENT_RUNS`,
    default 4) bounds worker spawns from this plane, backed by a **bounded wait
    queue** (`CODE_MODE_MAX_RUN_QUEUE`, default 8): once all run slots AND the
    queue are full a run is fast-rejected — **429 `code_mode_busy`** on the
    admin route, or a "retry shortly" **tool-error** fed back to the model on
    the inference plane (chat continues; never a mid-inference 429/403). Total
    outstanding runs are capped at 4 + 8 = 12, so held-open requests and waiter
    closures can no longer accumulate unbounded.

  When disabled, `POST /api/mcp/codemode/run` returns **HTTP 403
  `code_mode_disabled`** — no worker spawned, no code parsed, no tool executed.
  The `x-frosty-confirm-side-effects` gate still governs every side-effecting
  tool a sandbox program calls: it is **request-sourced** (never from the model
  or a worker message) and re-checked per brokered call; an unconfirmed
  side-effect aborts the run as **403 `side_effect_denied`** on both planes.

  **Client-disconnect abort.** The HTTP request's own `AbortSignal`
  (`req.signal`) is threaded into the run harness, so a run is aborted the
  moment its client disconnects mid-flight, in each of the three run states: (1)
  **already aborted at entry** — the acquire rejects before any slot, worker, or
  queue entry; (2) **aborted while queued** — the waiter is spliced out of the
  wait queue and rejected **without** consuming a run slot (no semaphore leak);
  (3) **aborted while running** — the worker is `terminate()`d, the deadline
  timer cleared, and the run rejected via the same single-settle guard the
  timeout uses (whichever fires first wins; the other is a no-op). The abort
  path only terminates/rejects/cleans up — it never spawns without a slot,
  forges a tool call, bypasses the confirm gate, or leaks a secret; it strictly
  _reduces_ outstanding work, so a burst of disconnects frees slots and queue
  positions promptly instead of holding them to the 5s deadline. On the admin
  route an abort maps to **HTTP 499 `client_closed_request`** (distinct from the
  403/429/ 504 cases, each guarded by a disjoint `instanceof`); on the inference
  plane the meta-tool run rejects and the tool loop unwinds normally (no
  403/429). `signal` is optional — a caller that omits it simply never arms
  abort.

  The worker `net` permission stays **`false`** (no SSRF, no sandbox outbound);
  no subprocess and no new `--allow-run`; no Python/Pyodide execution (Python
  output remains a display artifact). There is **no per-worker memory cap** in
  Deno today — runs are bounded by the wall-clock timeout plus the
  call/concurrency/result/output caps and the global-run cap, not by memory.
  Flipping the **production default** to `on` remains a separate operator
  go-decision.

## Not granted

- Unscoped `--allow-write`: writes are confined to `data/`.
- `--allow-ffi`, `--allow-sys`: never needed.
- The Code Mode sandbox worker receives **no** permissions
  (`env/read/write/net/run/ffi/sys/import=false`), proven enforceable by the
  boot probe. `net` stays `false` (no sandbox outbound); the executor remains
  **default-off** and gated on the app flag + probe.

## Build-time vs runtime

The least-privilege policy above governs the **gateway runtime**. The control-UI
build tasks (`deno task build-ui | dev-ui | preview-ui | test-ui`) run with `-A`
because the Vite / Tailwind v4 toolchain needs broad build-time fs/env/run/ffi
access (Tailwind's oxide binary loads through FFI). That is a throwaway
build/dev surface: it never runs in the production image, which launches the
gateway with only the canonical least-privilege flag set above. In Docker the UI
is built in a separate, discarded builder stage before the gateway image is
assembled.

## Application-level controls

- Provider secrets never reach the browser: admin APIs return `hasApiKey` /
  `hasCloudCredentials` flags and token hints, and config export redacts keys
  unless `include_secrets=true` is requested explicitly.
- Side-effect MCP tools require the `x-frosty-confirm-side-effects: true` header
  per request — on the inference tool loop AND on the gateway's own `/mcp`
  server surface; unknown tools fail closed.
- stdio MCP servers only run commands an operator explicitly configured via the
  admin API (itself gateable with `FROSTY_ADMIN_TOKEN`).
- `/api/*` can be gated with `FROSTY_ADMIN_TOKEN`; `/v1/*` and `/mcp` with
  virtual keys (plus team/customer hierarchy budgets).
