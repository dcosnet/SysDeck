/**
 * Fester first-boot history seeding.
 *
 * When the builds table is empty (fresh DB), synthesize a rich set of past
 * builds so the Sessions / Replay / Timeline / Cause / Autopsy views have
 * real content immediately. Every seeded row + event is marked
 * meta: {synthetic: true}.
 *
 * Builds (timestamps spread over the last 24h):
 *   1. linux-tool/debian      — succeeded, cold cache (22h ago)
 *   2. linux-tool/debian      — succeeded, 6/7 CAS cache hits (15h ago)
 *   3. smgl-core/x86_64       — FAILED at compile (1 retry, downstream
 *                               skipped) — feeds the autopsy/cause views (8h ago)
 *   4. openwrt-image/arm64    — cancelled mid-compile (3h ago)
 * Each build gets a replay session in the sessions table.
 *
 * Events are written directly to the store (never broadcast) — clients read
 * them back through the timeline / session endpoints.
 */

import { createHash } from 'crypto'
import type { FesterEvent } from './events'
import type { Store } from './store'
import { stepsFor } from './targets'

const HOUR = 3600

/** Synthetic node state snapshot used to compute the historical scores. */
const NODE_STATS: Record<string, { cpu: number; temp: number; jobs: number; max: number; policy?: 'preferred' | 'avoid' }> = {
  localhost: { cpu: 18, temp: 46, jobs: 1, max: 4, policy: 'preferred' },
  'x99-v3': { cpu: 34, temp: 48, jobs: 2, max: 24 },
  'x99-v4': { cpu: 22, temp: 51, jobs: 0, max: 30 },
  'rpi-1': { cpu: 41, temp: 55, jobs: 0, max: 4, policy: 'avoid' },
  'ryzen-1': { cpu: 28, temp: 44, jobs: 1, max: 16 },
}

function scoreFor(node: string): { score: number; reason: string } {
  const s = NODE_STATS[node]
  const score = 100 - s.cpu - s.temp + (s.policy === 'preferred' ? 20 : 0) - (s.policy === 'avoid' ? 50 : 0) - (s.jobs / s.max) * 30
  return {
    score: Math.round(score * 10) / 10,
    reason: `cpu ${s.cpu}% · temp ${s.temp}°C · jobs ${s.jobs}/${s.max}`,
  }
}

interface SeedPlan {
  buildId: string
  project: string
  targets: string[]
  startedAt: number
  outcome: 'succeeded' | 'failed' | 'cancelled'
  failAt?: string
  retries?: number
  cancelAfter?: number // number of fully-executed actions before the cancel
  cacheFrom?: string // buildId whose CAS entries this build hits
  cacheHitFromStep?: number // index of the first step that hits the cache
  sessionLabel: string
}

/** Seed the history if the builds table is empty. Returns the number of builds seeded (0 if none). */
export function seedHistory(store: Store): number {
  if (store.buildCount() > 0) return 0

  const t0 = Date.now() / 1000
  const plans: SeedPlan[] = [
    {
      buildId: `linux-tool-${Math.floor((t0 - 22 * HOUR) * 1000).toString(36)}`,
      project: 'linux-tool',
      targets: ['debian'],
      startedAt: t0 - 22 * HOUR,
      outcome: 'succeeded',
      sessionLabel: 'Replay · linux-tool/debian cold build',
    },
    {
      buildId: `linux-tool-${Math.floor((t0 - 15 * HOUR) * 1000).toString(36)}`,
      project: 'linux-tool',
      targets: ['debian'],
      startedAt: t0 - 15 * HOUR,
      outcome: 'succeeded',
      cacheHitFromStep: 1, // fetch re-runs (upstream moved), the rest hit
      sessionLabel: 'Replay · linux-tool/debian warm cache (6 hits)',
    },
    {
      buildId: `smgl-core-${Math.floor((t0 - 8 * HOUR) * 1000).toString(36)}`,
      project: 'smgl-core',
      targets: ['x86_64'],
      startedAt: t0 - 8 * HOUR,
      outcome: 'failed',
      failAt: 'smgl-core:x86_64:compile',
      retries: 1,
      sessionLabel: 'Post-mortem · smgl-core compile failure',
    },
    {
      buildId: `openwrt-image-${Math.floor((t0 - 3 * HOUR) * 1000).toString(36)}`,
      project: 'openwrt-image',
      targets: ['arm64'],
      startedAt: t0 - 3 * HOUR,
      outcome: 'cancelled',
      cancelAfter: 3,
      sessionLabel: 'Replay · openwrt-image cancelled run',
    },
  ]
  plans[1].cacheFrom = plans[0].buildId

  const writes: Promise<unknown>[] = []
  const emit = (ev: FesterEvent) => {
    writes.push(store.appendEvent(ev).catch(() => undefined))
  }

  for (const plan of plans) seedBuild(plan, emit, store, writes)

  void Promise.allSettled(writes)
  return plans.length
}

/** Emit one seeded build: build row + full event timeline + replay session. */
function seedBuild(plan: SeedPlan, emit: (ev: FesterEvent) => void, store: Store, writes: Promise<unknown>[]): void {
  const steps = stepsFor(plan.project, plan.targets[0])
  const nodeRotation = ['localhost', 'x99-v4', 'x99-v3', 'ryzen-1', 'x99-v4', 'x99-v3', 'localhost']
  const baseDurations = [1240, 3210, 860, 4870, 2110, 1620, 410]

  // deterministic per-build duration jitter
  const jitter = (i: number, base: number) => Math.round(base + ((hashSeed(plan.buildId) + i * 37) % 900))

  let t = plan.startedAt
  const meta = (m: Record<string, unknown> = {}): Record<string, unknown> => ({ ...m, synthetic: true })

  // build row + pipeline: queued → running
  writes.push(
    store
      .createBuild(plan.buildId, plan.project, plan.targets, {
        startedAt: plan.startedAt,
        state: 'queued',
        meta: { synthetic: true, retries: plan.retries ?? 0 },
      })
      .catch(() => undefined),
  )
  emit({ type: 'pipeline_update', timestamp: t, build_id: plan.buildId, state: 'queued', target: plan.project, meta: meta({ targets: plan.targets, actions: steps.length, retries: plan.retries ?? 0 }) })
  t += 0.2
  emit({ type: 'pipeline_update', timestamp: t, build_id: plan.buildId, state: 'running', meta: meta({ actions: steps.length }) })
  t += 0.15

  let doneCount = 0
  let failedCount = 0
  let cacheHits = 0
  let executed = 0
  let cancelledRunning = false
  let criticalMs = 0

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const node = nodeRotation[i % nodeRotation.length]
    const { score, reason } = scoreFor(node)
    const isFailStep = step.name === plan.failAt
    const isCacheHit =
      !isFailStep && plan.cacheFrom !== undefined && plan.cacheHitFromStep !== undefined && i >= plan.cacheHitFromStep
    const inCancelPhase = plan.outcome === 'cancelled' && plan.cancelAfter !== undefined && executed >= plan.cancelAfter

    if (inCancelPhase) {
      if (!cancelledRunning) {
        // the action that was mid-flight when the operator cancelled
        cancelledRunning = true
        emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'scheduled', node, score, reason, parent: step.deps[0], meta: meta({ deps: step.deps }) })
        t += 0.06
        emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'running', node, meta: meta({ attempt: 1, max_attempts: 1, deps: step.deps }) })
        t += jitter(i, 3520) / 1000
        emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'cancelled', node, reason: 'build cancelled by operator', meta: meta() })
        t += 0.12
      } else {
        // never reached the scheduler
        emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'cancelled', reason: 'build cancelled', meta: meta() })
        t += 0.1
      }
      continue
    }

    // scheduled
    emit({
      type: 'task_update',
      timestamp: t,
      build_id: plan.buildId,
      action: step.name,
      state: 'scheduled',
      node,
      score,
      reason,
      parent: step.deps[0],
      meta: meta({ deps: step.deps }),
    })
    t += 0.06

    if (isCacheHit) {
      // CAS hit → cache_update + done (execution skipped)
      const key = casKey(step.name, step.command, step.deps)
      emit({ type: 'cache_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'hit', node, meta: meta({ key, producer: plan.cacheFrom, cache_source: 'cas' }) })
      t += 0.15
      emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'done', node, reason: 'cache hit — execution skipped', meta: meta({ duration_ms: 150, attempt: 1, cache: 'hit' }) })
      t += 0.12
      doneCount += 1
      cacheHits += 1
      continue
    }

    // running (with the retry loop for the failing step)
    const attempts = isFailStep ? 1 + (plan.retries ?? 0) : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      emit({
        type: 'task_update',
        timestamp: t,
        build_id: plan.buildId,
        action: step.name,
        state: 'running',
        node,
        meta: meta({ attempt, max_attempts: attempts, deps: step.deps }),
      })
      const dur = isFailStep ? jitter(i, 4120 + attempt * 340) : jitter(i, baseDurations[i % baseDurations.length])
      t += dur / 1000
      criticalMs += dur

      if (isFailStep && attempt < attempts) {
        // intermediate failure → retry event, then the next attempt
        emit({
          type: 'task_update',
          timestamp: t,
          build_id: plan.buildId,
          action: step.name,
          state: 'retry',
          node,
          reason: `non-zero exit code from ${step.command} — retrying`,
          meta: meta({ attempt, next_attempt: attempt + 1, max_attempts: attempts, rc: 2 }),
        })
        t += 0.2
        continue
      }

      if (isFailStep) {
        // final failed attempt → failure event with the immediate downstream
        const downstream = steps.filter((s) => s.deps.includes(step.name)).map((s) => s.name)
        emit({
          type: 'failure',
          timestamp: t,
          build_id: plan.buildId,
          action: step.name,
          node,
          state: 'failed',
          reason: `non-zero exit code from ${step.command}`,
          meta: meta({ rc: 2, attempt, max_attempts: attempts, downstream }),
        })
        t += 0.12
        failedCount += 1
        break
      }

      // done + BTC forensic stamp
      const out = outputsFor(plan.buildId, step.name, step.command)
      emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: step.name, state: 'done', node, score, meta: meta({ duration_ms: dur, attempt, outputs: out }) })
      t += 0.08
      emit({ type: 'btc_stamp', timestamp: t, build_id: plan.buildId, action: step.name, node, state: 'stamped', meta: meta({ toolchain: 'BTC-0.4.0', target: 'haswell-ep', outputs: out }) })
      t += 0.14
      doneCount += 1
      executed += 1
      break
    }

    if (isFailStep) {
      // everything downstream of the failure is skipped
      for (const s of steps) {
        if (s.name === step.name || !isDownstreamOf(steps, s.name, step.name)) continue
        emit({ type: 'task_update', timestamp: t, build_id: plan.buildId, action: s.name, state: 'skipped', reason: 'upstream failed', meta: meta() })
        t += 0.1
      }
      break
    }
  }

  // final pipeline event + build row update
  const totalMs = Math.round((t - plan.startedAt) * 1000)
  emit({
    type: 'pipeline_update',
    timestamp: t,
    build_id: plan.buildId,
    state: plan.outcome,
    meta: meta({
      actions: steps.length,
      done: doneCount,
      failed: failedCount,
      cache_hits: cacheHits,
      critical_path_ms: criticalMs || totalMs,
      total_ms: totalMs,
    }),
  })
  writes.push(
    store
      .updateBuild(plan.buildId, {
        state: plan.outcome,
        finished_at: t,
        actions_total: steps.length,
        actions_done: doneCount,
        actions_failed: failedCount,
        cache_hits: cacheHits,
        critical_path_ms: criticalMs || totalMs,
        rc: plan.outcome === 'succeeded' ? 0 : 1,
      })
      .catch(() => undefined),
  )

  // replay session for this build, created shortly after the build finished
  store.createSession(plan.buildId, plan.sessionLabel, { createdAt: t + 30 })
}

/** transitive downstream test over the canonical step list */
function isDownstreamOf(steps: { name: string; deps: string[] }[], name: string, of: string): boolean {
  const byName = new Map(steps.map((s) => [s.name, s]))
  const seen = new Set<string>()
  const walk = (n: string): boolean => {
    if (n === of) return true
    if (seen.has(n)) return false
    seen.add(n)
    return (byName.get(n)?.deps ?? []).some(walk)
  }
  return walk(name)
}

function casKey(name: string, command: string, deps: string[]): string {
  return createHash('sha256').update(JSON.stringify({ name, command, deps })).digest('hex').slice(0, 16)
}

function outputsFor(buildId: string, action: string, command: string): { path: string; sha256: string; bytes: number }[] {
  const sha256 = createHash('sha256').update(`${buildId}:${action}:${command}`).digest('hex')
  const bytes = 2_400_000 + (parseInt(sha256.slice(0, 8), 16) % 21) * 3_200_000
  return [{ path: `/var/lib/fester/out/${action}.tar.zst`, sha256, bytes }]
}

function hashSeed(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0)
}
