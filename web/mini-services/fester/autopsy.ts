/**
 * Fester failure autopsy — port of backend/analysis/failure_autopsy.py +
 * failure_propagation.py. Traces a failed action backward through its
 * dependency chain and computes the forward blast radius.
 *
 * Works for BOTH live engine builds (build.actions passed in) and
 * store-only historical builds: when no live action list is available the
 * DAG is reconstructed from the event journal — task_update(scheduled)
 * events carry meta.deps, and actions that were never scheduled (skipped
 * downstream) fall back to the canonical target DAG step list.
 */

import type { FesterEvent } from './events'
import { stepsFor } from './targets'

export interface Autopsy {
  action: string
  build_id: string
  failed: boolean
  source: 'engine' | 'events'
  last_scheduler_decision?: { node: string; score: number; reason: string }
  dependency_chain: { action: string; state: string; node?: string }[]
  blast_radius: string[]
  last_events: FesterEvent[]
}

interface ActionInfo {
  name: string
  deps: string[]
  state: string
  node?: string
}

export function failureAutopsy(
  buildId: string,
  action: string,
  events: FesterEvent[],
  build?: { actions?: { name: string; deps: string[]; state: string; node?: string }[] } | null,
): Autopsy {
  const relevant = events.filter((e) => e.action === action || e.build_id === buildId)
  const taskEvents = relevant.filter((e) => (e.type === 'task_update' || e.type === 'failure') && e.action === action)

  const scheduled = taskEvents.find((e) => e.state === 'scheduled')
  const failureEv = taskEvents.find((e) => e.state === 'failed')
  const failed = taskEvents.some((e) => e.state === 'failed')

  // ── the action graph ────────────────────────────────────────────
  let source: 'engine' | 'events' = 'events'
  let graph: Map<string, ActionInfo>

  if (build?.actions && build.actions.length > 0) {
    source = 'engine'
    graph = new Map(build.actions.map((a) => [a.name, { name: a.name, deps: a.deps, state: a.state, node: a.node }]))
  } else {
    graph = reconstructActions(events)
  }

  // ── backward dependency chain (deps of the failed action) ───────
  const chain: { action: string; state: string; node?: string }[] = []
  const seen = new Set<string>([action])
  const walk = (name: string) => {
    const info = graph.get(name)
    if (!info || seen.has(name)) return
    seen.add(name)
    for (const d of info.deps) walk(d)
    chain.push({ action: info.name, state: info.state, node: info.node })
  }
  for (const d of graph.get(action)?.deps ?? []) walk(d)
  // keep topo order (upstream first) — `walk` already appends after deps

  // ── forward blast radius (everything downstream) ────────────────
  const blast = new Set<string>()
  // 1. from the reconstructed/live graph (reverse edges, transitive)
  const addDownstream = (name: string) => {
    for (const info of graph.values()) {
      if (blast.has(info.name)) continue
      if (info.deps.includes(name)) {
        blast.add(info.name)
        addDownstream(info.name)
      }
    }
  }
  addDownstream(action)
  // 2. the engine records the immediate downstream on the failure event
  const evDownstream = Array.isArray(failureEv?.meta?.downstream) ? (failureEv?.meta?.downstream as string[]) : []
  for (const d of evDownstream) blast.add(d)
  // 3. skipped actions are by construction downstream of the failure
  for (const e of events) {
    if (e.type === 'task_update' && e.state === 'skipped' && e.reason === 'upstream failed' && e.action) {
      blast.add(e.action)
    }
  }
  blast.delete(action)

  const lastEvents = relevant.slice(-12)

  return {
    action,
    build_id: buildId,
    failed,
    source,
    last_scheduler_decision: scheduled
      ? { node: scheduled.node ?? 'unknown', score: scheduled.score ?? 0, reason: scheduled.reason ?? '' }
      : undefined,
    dependency_chain: chain,
    blast_radius: [...blast],
    last_events: lastEvents,
  }
}

/**
 * Rebuild the action DAG from the event journal alone:
 *  - deps: task_update(scheduled) events carry meta.deps
 *  - state: the LAST task_update/failure event per action wins
 *  - actions never scheduled (skipped/cancelled before the wave reached
 *    them) get their deps from the canonical target DAG when the action
 *    name matches the `<project>:<target>:<step>` convention.
 */
function reconstructActions(events: FesterEvent[]): Map<string, ActionInfo> {
  const graph = new Map<string, ActionInfo>()

  for (const e of events) {
    if (e.type === 'task_update' && e.action) {
      const cur = graph.get(e.action) ?? { name: e.action, deps: [], state: '', node: e.node }
      if (e.state === 'scheduled' && Array.isArray(e.meta?.deps)) {
        cur.deps = e.meta.deps as string[]
        cur.node = e.node ?? cur.node
      }
      if (e.state) cur.state = e.state
      if (e.node) cur.node = e.node
      graph.set(e.action, cur)
    }
    if (e.type === 'failure' && e.action) {
      const cur = graph.get(e.action) ?? { name: e.action, deps: [], state: '', node: e.node }
      cur.state = 'failed'
      if (e.node) cur.node = e.node
      graph.set(e.action, cur)
    }
  }

  // fill deps for never-scheduled actions from the canonical step DAG
  for (const info of graph.values()) {
    if (info.deps.length > 0) continue
    const canonical = canonicalDeps(info.name)
    if (canonical) info.deps = canonical
  }

  return graph
}

function canonicalDeps(actionName: string): string[] | null {
  const m = actionName.match(/^([^:]+):([^:]+):(.+)$/)
  if (!m) return null
  const step = stepsFor(m[1], m[2]).find((s) => s.name === actionName)
  return step ? step.deps : null
}

/** failure_propagation port — who did the failure spread to. */
export function propagateFailure(events: FesterEvent[], action: string): { skipped: string[]; failed_actions: string[] } {
  const skipped = events
    .filter((e) => e.type === 'task_update' && e.state === 'skipped' && e.reason === 'upstream failed')
    .map((e) => e.action ?? '')
    .filter(Boolean)
  const failedActions = events
    .filter((e) => e.type === 'failure' && e.action)
    .map((e) => (e.action as string) + (e.node ? `@${e.node}` : ''))
  return { skipped: [...new Set(skipped)], failed_actions: [...new Set(failedActions)] }
}
