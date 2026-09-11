/**
 * Fester PipelineEngine — port of backend/pipeline/engine.py.
 *
 * For each action:
 *   1. Schedule: pick best node via the weighted scheduler
 *   2. Emit task_update(scheduled) with deps + score + reason
 *   3. Cache check: CAS sha256 hit → cache_update + skip execution
 *   4. Execute: task_update(running) → run → task_update(done|failed)
 *   5. On failure: failure event + stop downstream actions
 *   6. On success with BTC enabled: btc_stamp event
 *
 * Execution is synthetic (real cross-distro builds are not possible in
 * this environment) but the DAG semantics — topo ordering, dependency
 * blocking, cancellation, debugger pause/step, cache behavior, critical
 * path — are the real algorithm.
 */

import { createHash } from 'crypto'
import type { EventBus, FesterEvent } from './events'
import type { Store } from './store'
import type { NodeRegistry } from './nodes'
import { chooseBestNode } from './scheduler'
import { sleep as clockSleep } from './clock'
import { PROJECTS, stepsFor } from './targets'

export interface ActionNode {
  name: string
  command: string
  deps: string[]
  state: 'pending' | 'scheduled' | 'running' | 'retry' | 'done' | 'failed' | 'skipped' | 'cancelled'
  node?: string
  score?: number
  reason?: string
  cacheHit?: boolean
  startedAt?: number
  endedAt?: number
  durationMs?: number
  attempts?: number
  failScheduled?: boolean
}

export interface BuildRun {
  buildId: string
  project: string
  targets: string[]
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  actions: Map<string, ActionNode>
  criticalPathMs?: number
  startedAt: number
  finishedAt?: number
  cancelRequested: boolean
  paused: boolean
  stepMode: boolean
  /** retry budget for failed actions (0–3) */
  retries: number
  /** gate() waiters paused mid-build (debugger): the action + the gate they
   *  block at (1 = pre-schedule, 2 = pre-run / retry attempt). */
  gateWaiters: { action: string; gate: number; resolve: () => void }[]
  /** one-shot passes: a step with no waiter yet is consumed by the next gated action */
  stepTickets: number
  /** per-action gate passes granted by a step (an action has two gates: pre-schedule, pre-run) */
  actionPasses: Map<string, number>
}

const BTC_ENABLED = true

/** gates per action: 1 = pre-schedule, 2 = pre-run (re-entered per retry attempt) */
const TOTAL_GATES = 2

// CAS survives `bun --hot` re-evaluations (module state is wiped on reload,
// globalThis is not) — cache hits keep working across code edits.
const G = globalThis as unknown as Record<string, unknown>
const CAS = (G.__fester_cas as Map<string, string> | undefined) ?? new Map<string, string>() // sha256(action) → buildId that produced it
G.__fester_cas = CAS

function hashAction(action: { name: string; command: string; deps: string[] }): string {
  return createHash('sha256').update(JSON.stringify(action)).digest('hex').slice(0, 16)
}

export class FesterEngine {
  private runs = new Map<string, BuildRun>()
  private debuggerHooks = new Map<string, { pause: () => void; resume: () => void; step: () => void }>()

  constructor(private bus: EventBus, private store: Store, private nodes: NodeRegistry) {}

  // ── build lifecycle ────────────────────────────────────────────

  startBuild(
    project: string,
    targets: string[],
    opts: { failAction?: string; noCache?: boolean; retries?: number } = {},
  ): string {
    const buildId = `${project}-${Date.now().toString(36)}`
    const actions = new Map<string, ActionNode>()

    for (const t of targets) {
      for (const step of stepsFor(project, t)) {
        actions.set(step.name, {
          name: step.name,
          command: step.command,
          deps: step.deps,
          state: 'pending',
          failScheduled: step.name === opts.failAction,
        })
      }
    }

    const run: BuildRun = {
      buildId,
      project,
      targets,
      state: 'queued',
      actions,
      startedAt: Date.now(),
      cancelRequested: false,
      paused: false,
      stepMode: false,
      retries: Math.max(0, Math.min(3, Math.trunc(opts.retries ?? 0) || 0)),
      gateWaiters: [],
      stepTickets: 0,
      actionPasses: new Map(),
    }
    this.runs.set(buildId, run)

    this.bus.emit({
      type: 'pipeline_update',
      timestamp: now(),
      build_id: buildId,
      state: 'queued',
      target: project,
      meta: { targets, actions: actions.size, retries: run.retries },
    })
    this.store.createBuild(buildId, project, targets)
    this.store.updateBuild(buildId, { state: 'running', actions_total: actions.size })
    run.state = 'running'

    // fire and forget — the async executor drives everything
    void this.executeRun(run, opts)
    return buildId
  }

  cancelBuild(buildId: string): boolean {
    const run = this.runs.get(buildId)
    if (!run || run.state !== 'running') return false
    run.cancelRequested = true
    // release every gated action so the wave loop can wind down
    this.releaseGates(run)
    return true
  }

  // ── debugger hooks ─────────────────────────────────────────────

  debuggerCommand(buildId: string, command: string): { ok: boolean; command: string; buildId: string; state?: string; error?: string } {
    const run = this.runs.get(buildId)
    if (!run) return { ok: false, command, buildId, error: 'build not found or already finished' }
    switch (command) {
      case 'pause':
        run.paused = true
        run.stepMode = false
        run.stepTickets = 0
        run.actionPasses.clear()
        this.bus.emit({ type: 'debug', timestamp: now(), build_id: buildId, state: 'paused' })
        return { ok: true, command, buildId, state: 'paused' }
      case 'resume':
        this.releaseGates(run)
        this.bus.emit({ type: 'debug', timestamp: now(), build_id: buildId, state: 'resumed' })
        return { ok: true, command, buildId, state: 'resumed' }
      case 'step': {
        run.stepMode = true
        // release exactly ONE action (one full attempt): prefer the head
        // waiter (it is blocked mid-gate); grant it passes for its CURRENT
        // gate + the remaining ones, so one step = one action attempt
        // actually executes — a later retry attempt blocks again. If nothing
        // is waiting (between waves), leave a ticket for the next gated
        // action; the ticket carries the same exactness (see gate()).
        const head = run.gateWaiters.shift()
        if (head) {
          run.actionPasses.set(head.action, (run.actionPasses.get(head.action) ?? 0) + (TOTAL_GATES - head.gate + 1))
          head.resolve()
        } else {
          run.stepTickets += 1
        }
        this.bus.emit({ type: 'debug', timestamp: now(), build_id: buildId, state: 'step' })
        return { ok: true, command, buildId, state: 'step' }
      }
      default:
        return { ok: false, command, buildId, error: `unknown debugger command: ${command}` }
    }
  }

  buildState(buildId: string) {
    const run = this.runs.get(buildId)
    if (run) {
      return {
        build_id: buildId,
        project: run.project,
        targets: run.targets,
        state: run.state,
        actions: [...run.actions.values()].map((a) => ({ ...a })),
        critical_path_ms: run.criticalPathMs,
        paused: run.paused,
        step_mode: run.stepMode,
      }
    }
    return null
  }

  listBuilds() {
    return [...this.runs.values()].map((r) => ({
      build_id: r.buildId,
      project: r.project,
      targets: r.targets,
      state: r.state,
      actions: r.actions.size,
      started_at: r.startedAt / 1000,
    }))
  }

  // ── the executor ───────────────────────────────────────────────

  private async executeRun(run: BuildRun, opts: { failAction?: string; noCache?: boolean }): Promise<void> {
    this.bus.emit({ type: 'pipeline_update', timestamp: now(), build_id: run.buildId, state: 'running', meta: { actions: run.actions.size, retries: run.retries } })

    // process in topological waves — cancellation is re-checked between waves
    for (;;) {
      if (run.cancelRequested) break
      const wave = this.readyActions(run)
      if (wave.length === 0) break
      await Promise.all(wave.map((a) => this.executeAction(run, a, opts)))
    }

    // wind down whatever is left when cancelled (pending actions never
    // entered executeAction, so they get their cancelled event here)
    if (run.cancelRequested) {
      for (const a of run.actions.values()) {
        if (a.state === 'pending') {
          a.state = 'cancelled'
          this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: a.name, state: 'cancelled', reason: 'build cancelled' })
        } else if (a.state === 'scheduled' || a.state === 'running') {
          a.state = 'cancelled'
        }
      }
    }

    run.finishedAt = Date.now()
    run.criticalPathMs = this.computeCriticalPath(run)
    const failed = [...run.actions.values()].some((a) => a.state === 'failed')
    const cancelled = [...run.actions.values()].some((a) => a.state === 'cancelled')
    run.state = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded'

    const done = [...run.actions.values()].filter((a) => a.state === 'done').length
    const failedCount = [...run.actions.values()].filter((a) => a.state === 'failed').length
    const cacheHits = [...run.actions.values()].filter((a) => a.cacheHit).length
    // aggregate output manifest (content-addressed artifacts of this build)
    const outputs = [...run.actions.values()].filter((a) => a.state === 'done').flatMap((a) => simulatedOutputs(run.buildId, a))

    this.store.updateBuild(run.buildId, {
      state: run.state,
      finished_at: run.finishedAt / 1000,
      actions_done: done,
      actions_failed: failedCount,
      cache_hits: cacheHits,
      critical_path_ms: run.criticalPathMs,
      rc: run.state === 'succeeded' ? 0 : 1,
    })
    this.bus.emit({
      type: 'pipeline_update',
      timestamp: now(),
      build_id: run.buildId,
      state: run.state,
      meta: { actions: run.actions.size, done, failed: failedCount, cache_hits: cacheHits, critical_path_ms: run.criticalPathMs, outputs },
    })
  }

  private readyActions(run: BuildRun): ActionNode[] {
    const out: ActionNode[] = []
    for (const a of run.actions.values()) {
      if (a.state !== 'pending') continue
      const depsOk = a.deps.every((d) => {
        const dep = run.actions.get(d)
        return dep && dep.state === 'done'
      })
      const depFailed = a.deps.some((d) => {
        const dep = run.actions.get(d)
        return dep && (dep.state === 'failed' || dep.state === 'cancelled' || dep.state === 'skipped')
      })
      if (depFailed) {
        a.state = 'skipped'
        this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: a.name, state: 'skipped', reason: 'upstream failed' })
      } else if (depsOk) {
        out.push(a)
      }
    }
    return out
  }

  private async executeAction(run: BuildRun, action: ActionNode, opts: { noCache?: boolean }): Promise<void> {
    // debugger gate 1: block while paused unless stepping
    await this.gate(run, action, 1)

    if (run.cancelRequested) return

    // 1. schedule
    const decision = chooseBestNode(this.nodes.all(), this.policyMap())
    action.node = decision.node
    action.score = decision.score
    action.reason = decision.reason
    action.state = 'scheduled'
    this.nodes.update(decision.node, { active_jobs: (this.nodes.get(decision.node)?.active_jobs ?? 0) + 1 })
    this.bus.emit({
      type: 'task_update',
      timestamp: now(),
      build_id: run.buildId,
      action: action.name,
      state: 'scheduled',
      node: decision.node,
      score: decision.score,
      reason: decision.reason,
      parent: action.deps[0],
      meta: { deps: action.deps, scores: decision.scores, retries: run.retries },
    })

    // 2. cache check (CAS)
    const key = hashAction({ name: action.name, command: action.command, deps: action.deps })
    if (!opts.noCache && CAS.has(key)) {
      await clockSleep(150)
      if (run.cancelRequested) {
        action.state = 'cancelled'
        this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
        this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: action.name, state: 'cancelled', node: decision.node, reason: 'build cancelled' })
        return
      }
      action.cacheHit = true
      action.state = 'done'
      action.durationMs = 150
      action.endedAt = Date.now()
      action.attempts = 1
      this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
      this.bus.emit({ type: 'cache_update', timestamp: now(), build_id: run.buildId, action: action.name, state: 'hit', node: decision.node, meta: { key, producer: CAS.get(key) } })
      this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: action.name, state: 'done', node: decision.node, reason: 'cache hit — execution skipped', meta: { duration_ms: 150, attempt: 1, cache: 'hit' } })
      return
    }

    // 3. execute (synthetic work with realistic durations) — with retries:
    //    a failing action re-runs up to run.retries times; each intermediate
    //    failure emits task_update(state:'retry'); only the FINAL failed
    //    attempt emits the failure event.
    const maxAttempts = 1 + run.retries
    const firstStart = Date.now()
    let attempt = 0

    for (;;) {
      attempt += 1
      // debugger gate 2 (re-entered per retry attempt — a step releases ONE attempt)
      await this.gate(run, action, 2)
      if (run.cancelRequested) {
        action.state = 'cancelled'
        this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
        this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: action.name, state: 'cancelled', node: decision.node, reason: 'build cancelled' })
        return
      }

      action.state = 'running'
      action.startedAt = Date.now()
      this.bus.emit({
        type: 'task_update',
        timestamp: now(),
        build_id: run.buildId,
        action: action.name,
        state: 'running',
        node: decision.node,
        meta: { attempt, max_attempts: maxAttempts },
      })

      const workMs = 400 + Math.random() * 1800
      await clockSleep(workMs)
      if (run.cancelRequested) {
        action.state = 'cancelled'
        this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
        this.bus.emit({ type: 'task_update', timestamp: now(), build_id: run.buildId, action: action.name, state: 'cancelled', node: decision.node, reason: 'build cancelled' })
        return
      }

      action.endedAt = Date.now()

      if (action.failScheduled && attempt < maxAttempts) {
        // failed attempt with budget left → emit retry, then re-run
        action.state = 'retry'
        this.bus.emit({
          type: 'task_update',
          timestamp: now(),
          build_id: run.buildId,
          action: action.name,
          state: 'retry',
          node: decision.node,
          reason: `non-zero exit code from ${action.command} — retrying`,
          meta: { attempt, next_attempt: attempt + 1, max_attempts: maxAttempts, rc: 2 },
        })
        await clockSleep(200) // backoff before the next attempt
        continue
      }
      break
    }

    action.durationMs = action.endedAt - firstStart
    action.attempts = attempt

    if (action.failScheduled) {
      action.state = 'failed'
      this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
      this.bumpInstability(decision.node, +0.25)
      this.bus.emit({
        type: 'failure',
        timestamp: now(),
        build_id: run.buildId,
        action: action.name,
        node: decision.node,
        state: 'failed',
        reason: 'non-zero exit code from ' + action.command,
        meta: { rc: 2, attempt, max_attempts: maxAttempts, downstream: this.downstreamOf(run, action.name) },
      })
      return
    }

    action.state = 'done'
    CAS.set(key, run.buildId)
    this.nodes.update(decision.node, { active_jobs: Math.max(0, (this.nodes.get(decision.node)?.active_jobs ?? 1) - 1) })
    this.bumpInstability(decision.node, -0.05)
    this.bus.emit({
      type: 'task_update',
      timestamp: now(),
      build_id: run.buildId,
      action: action.name,
      state: 'done',
      node: decision.node,
      score: decision.score,
      meta: { duration_ms: action.durationMs, attempt, outputs: simulatedOutputs(run.buildId, action) },
    })

    // 4. BTC forensic stamp on outputs
    if (BTC_ENABLED) {
      await clockSleep(80)
      this.bus.emit({
        type: 'btc_stamp',
        timestamp: now(),
        build_id: run.buildId,
        action: action.name,
        node: decision.node,
        state: 'stamped',
        meta: { toolchain: 'BTC-0.4.0', target: 'haswell-ep', outputs: simulatedOutputs(run.buildId, action) },
      })
    }
  }

  /** gate() — block while the run is paused. A debugger 'step' releases
   *  exactly ONE action attempt (through its current + remaining gates);
   *  'resume' and cancel release everyone. */
  private async gate(run: BuildRun, action: ActionNode, gateIndex: number): Promise<void> {
    for (;;) {
      if (!run.paused) return
      const pass = run.actionPasses.get(action.name) ?? 0
      if (pass > 0) {
        run.actionPasses.set(action.name, pass - 1)
        return
      }
      if (run.stepTickets > 0) {
        run.stepTickets -= 1
        // carry passes for this action's REMAINING gates only (one attempt)
        run.actionPasses.set(action.name, TOTAL_GATES - gateIndex)
        return
      }
      await new Promise<void>((resolve) => {
        run.gateWaiters.push({ action: action.name, gate: gateIndex, resolve })
      })
    }
  }

  /** release every gated action (resume / cancel) and clear step state. */
  private releaseGates(run: BuildRun): void {
    run.paused = false
    run.stepMode = false
    run.stepTickets = 0
    run.actionPasses.clear()
    const waiters = run.gateWaiters.splice(0)
    for (const w of waiters) w.resolve()
  }

  /** scheduler feedback loop (F-04 port, bounded): failures make a node
   *  slightly less attractive, successes decay the penalty. */
  private bumpInstability(node: string, delta: number): void {
    const s = this.nodes.get(node)
    if (!s) return
    const next = delta > 0 ? Math.min(2, s.instability + delta) : Math.max(0, s.instability + delta * s.instability)
    this.nodes.update(node, { instability: Math.round(next * 1000) / 1000 })
  }

  private downstreamOf(run: BuildRun, action: string): string[] {
    const out: string[] = []
    for (const a of run.actions.values()) {
      if (a.deps.includes(action)) out.push(a.name)
    }
    return out
  }

  private computeCriticalPath(run: BuildRun): number {
    const memo = new Map<string, number>()
    const path = (name: string): number => {
      if (memo.has(name)) return memo.get(name) as number
      const a = run.actions.get(name)
      if (!a) return 0
      const depMax = Math.max(0, ...a.deps.map(path))
      const v = depMax + (a.durationMs ?? 0)
      memo.set(name, v)
      return v
    }
    let max = 0
    for (const a of run.actions.values()) max = Math.max(max, path(a.name))
    return Math.round(max)
  }

  private policyMap(): Map<string, 'preferred' | 'avoid'> {
    const m = new Map<string, 'preferred' | 'avoid'>()
    for (const c of this.nodes.configs()) {
      if (c.policy) m.set(c.name, c.policy)
    }
    return m
  }
}

function now(): number {
  return Date.now() / 1000
}

/** Simulated action output artifact (CAS-style content-addressed entry). */
function simulatedOutputs(buildId: string, action: ActionNode): { path: string; sha256: string; bytes: number }[] {
  const sha256 = createHash('sha256').update(`${buildId}:${action.name}:${action.command}`).digest('hex')
  const bytes = 2_400_000 + (parseInt(sha256.slice(0, 8), 16) % 21) * 3_200_000 // 2.4–67 MB
  return [{ path: `/var/lib/fester/out/${action.name}.tar.zst`, sha256, bytes }]
}

export function projectCatalog() {
  return PROJECTS
}
