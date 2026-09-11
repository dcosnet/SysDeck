/**
 * Fester REST API — mirrors the repo's route surface (backend/main.py + api/).
 * Bun-native Request/Response handlers. Only the routes the SysDeck Fester
 * sub-app needs; everything else 404s JSON.
 */

import type { EventBus, FesterEvent } from './events'
import type { Store } from './store'
import type { NodeRegistry } from './nodes'
import type { FesterEngine } from './engine'
import { projectCatalog } from './engine'
import { failureAutopsy, propagateFailure } from './autopsy'
import { buildCauseGraph } from './cause'

export interface ApiCtx {
  req: Request
  url: URL
  bus: EventBus
  store: Store
  nodes: NodeRegistry
  engine: FesterEngine
}

interface PolicyEntry {
  key: string
  value: string
  ts: number
}

const POLICY = new Map<string, PolicyEntry>()

export async function handleApi(ctx: ApiCtx): Promise<Response> {
  const { req, url, store, nodes, engine } = ctx
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method.toUpperCase()

  try {
    // ── health ─────────────────────────────────────────────
    if (path === '/api/health') {
      return Response.json({ ok: true, service: 'fester', version: '0.2.1', clock: 'spawn-v2', nodes: nodes.names().length, uptime_s: process.uptime() })
    }

    // ── builds ─────────────────────────────────────────────
    if (path === '/api/build' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        project?: string
        targets?: string[]
        failAction?: string
        noCache?: boolean
        retries?: number
      }
      if (!body.project || !Array.isArray(body.targets) || body.targets.length === 0) {
        return Response.json({ ok: false, error: 'project and targets[] are required' }, { status: 400 })
      }
      const retries = body.retries ?? 0
      if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > 3) {
        return Response.json({ ok: false, error: 'retries must be an integer between 0 and 3' }, { status: 400 })
      }
      const buildId = engine.startBuild(body.project, body.targets, {
        failAction: body.failAction,
        noCache: body.noCache,
        retries,
      })
      return Response.json({ ok: true, build_id: buildId, retries })
    }

    if (path === '/api/builds') {
      return Response.json({ ok: true, builds: engine.listBuilds(), history: store.listBuilds(30) })
    }

    const buildMatch = path.match(/^\/api\/builds\/([^/]+)$/)
    if (buildMatch) {
      const buildId = decodeURIComponent(buildMatch[1])
      const live = engine.buildState(buildId)
      const record = store.getBuild(buildId)
      if (!live && !record) return Response.json({ ok: false, error: `build ${buildId} not found` }, { status: 404 })
      return Response.json({ ok: true, build: live ?? record })
    }

    const cancelMatch = path.match(/^\/api\/builds\/([^/]+)\/cancel$/)
    if (cancelMatch && method === 'POST') {
      const okCancel = engine.cancelBuild(decodeURIComponent(cancelMatch[1]))
      return Response.json({ ok: okCancel, error: okCancel ? undefined : 'build not running' }, { status: okCancel ? 200 : 409 })
    }

    // ── projects / targets ─────────────────────────────────
    if (path === '/api/targets') {
      return Response.json({ ok: true, projects: projectCatalog() })
    }
    if (path === '/api/targets/arches') {
      const arches = new Set<string>()
      for (const p of projectCatalog()) for (const t of p.targets) arches.add(t.arch)
      return Response.json({ ok: true, arches: [...arches] })
    }
    if (path === '/api/targets/runtimes') {
      return Response.json({ ok: true, runtimes: ['host', 'lxc', 'podman', 'firecracker', 'libvirt', 'tmux'] })
    }

    // ── nodes ──────────────────────────────────────────────
    if (path === '/api/nodes') {
      return Response.json({ ok: true, nodes: nodes.all() })
    }

    // ── policy ─────────────────────────────────────────────
    if (path === '/api/policy') {
      return Response.json({ ok: true, policy: [...POLICY.values()] })
    }
    if (path === '/api/policy/set' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string; value?: string }
      if (!body.key) return Response.json({ ok: false, error: 'key required' }, { status: 400 })
      POLICY.set(body.key, { key: body.key, value: body.value ?? '', ts: Date.now() / 1000 })
      ctx.bus.emit({ type: 'debug', timestamp: Date.now() / 1000, state: 'policy-set', meta: { key: body.key, value: body.value } })
      return Response.json({ ok: true })
    }
    if (path === '/api/policy/clear' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string }
      if (body.key) POLICY.delete(body.key)
      else POLICY.clear()
      return Response.json({ ok: true })
    }

    // ── timeline / replay ──────────────────────────────────
    const timelineMatch = path.match(/^\/api\/timeline(?:\/([^/]+))?$/)
    if (timelineMatch) {
      const buildId = timelineMatch[1] ? decodeURIComponent(timelineMatch[1]) : null
      const afterRaw = url.searchParams.get('after')
      if (afterRaw !== null) {
        const after = Number(afterRaw)
        if (!Number.isInteger(after) || after < 0) {
          return Response.json({ ok: false, error: 'after must be a non-negative integer event id' }, { status: 400 })
        }
        const events = store.listEventsAfter(buildId, after)
        const last = events.length > 0 ? (events[events.length - 1].id as number) : null
        return Response.json({ ok: true, build_id: buildId, after, events, next_cursor: last })
      }
      return Response.json({ ok: true, events: store.listEvents(buildId, 1000) })
    }

    // ── replay sessions (port of backend/api/replay.py intent) ──
    if (path === '/api/sessions' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { buildId?: string; label?: string }
      if (!body.buildId) return Response.json({ ok: false, error: 'buildId is required' }, { status: 400 })
      const buildId = body.buildId
      const exists = engine.buildState(buildId) ?? store.getBuild(buildId)
      if (!exists) return Response.json({ ok: false, error: `build ${buildId} not found` }, { status: 404 })
      const sessionId = store.createSession(buildId, body.label)
      ctx.bus.emit({
        type: 'replay',
        timestamp: Date.now() / 1000,
        build_id: buildId,
        state: 'session-created',
        meta: { session_id: sessionId, label: body.label ?? null },
      })
      const session = store.getSession(sessionId)
      return Response.json({ ok: true, session })
    }

    if (path === '/api/sessions') {
      const sessions = store.listSessions().map((s) => ({
        session_id: s.session_id,
        build_id: s.build_id,
        label: s.label,
        created_at: s.created_at,
        build: buildInfoOf(s),
      }))
      return Response.json({ ok: true, sessions })
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch && method === 'GET') {
      const sessionId = decodeURIComponent(sessionMatch[1])
      const session = store.getSession(sessionId)
      if (!session) return Response.json({ ok: false, error: `session ${sessionId} not found` }, { status: 404 })
      const events = store.listEvents((session.build_id as string) ?? null, 5000)
      return Response.json({ ok: true, session: { ...session, build: buildInfoOf(session) }, events })
    }

    // ── metrics (JSON view, computed from the store + registry) ──
    if (path === '/api/metrics') {
      const counts = store.buildStateCounts()
      const sums = store.buildActionSums()
      const utilization = store.nodeUtilization()
      const nodesList = nodes.all().map((n) => ({
        name: n.name,
        state: n.state,
        cpu_load: n.cpu_load,
        temp: n.temp,
        active_jobs: n.active_jobs,
        max_jobs: n.max_jobs,
      }))
      const utilizationList: { node: string; pct: number }[] = [
        ...nodesList.map((n) => ({ node: n.name, pct: utilization.get(n.name) ?? 0 })),
        ...[...utilization.entries()]
          .filter(([name]) => !nodesList.some((n) => n.name === name))
          .map(([node, pct]) => ({ node, pct })),
      ]
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      return Response.json({
        ok: true,
        builds: {
          total,
          running: counts.running ?? 0,
          succeeded: counts.succeeded ?? 0,
          failed: counts.failed ?? 0,
          cancelled: counts.cancelled ?? 0,
        },
        actions: {
          total: sums.total,
          done: sums.done,
          failed: sums.failed,
          cache_hits: sums.cache_hits,
          cache_hit_rate: sums.total > 0 ? Math.round((sums.cache_hits / sums.total) * 1000) / 10 : 0,
        },
        nodes: nodesList,
        utilization: utilizationList,
      })
    }

    // ── failure autopsy ────────────────────────────────────
    const autopsyMatch = path.match(/^\/api\/autopsy\/([^/]+)\/(.+)$/)
    if (autopsyMatch) {
      const buildId = decodeURIComponent(autopsyMatch[1])
      const action = decodeURIComponent(autopsyMatch[2])
      const events = store.listEvents(buildId, 5000) as unknown as FesterEvent[]
      const build = engine.buildState(buildId) ?? store.getBuild(buildId)
      const autopsy = failureAutopsy(buildId, action, events, build as never)
      return Response.json({ ok: true, autopsy, propagation: propagateFailure(events, action) })
    }

    // ── cause graph ────────────────────────────────────────
    const causeMatch = path.match(/^\/api\/cause\/([^/]+)$/)
    if (causeMatch) {
      const buildId = decodeURIComponent(causeMatch[1])
      const events = store.listEvents(buildId, 5000) as unknown as FesterEvent[]
      return Response.json({ ok: true, cause: buildCauseGraph(events) })
    }

    // ── debugger state ─────────────────────────────────────
    const dbgMatch = path.match(/^\/api\/debugger\/([^/]+)$/)
    if (dbgMatch) {
      const buildId = decodeURIComponent(dbgMatch[1])
      const state = engine.buildState(buildId)
      if (!state) return Response.json({ ok: false, error: 'build not found' }, { status: 404 })
      return Response.json({ ok: true, debugger: { paused: state.paused, step_mode: state.step_mode, state: state.state, actions: state.actions.length } })
    }

    // ── storage / CAS stats ────────────────────────────────
    if (path === '/api/storage/status') {
      return Response.json({
        ok: true,
        storage: {
          backend: 'sqlite-wal',
          cas: { entries: 'dynamic', shared_with: 'sorcery-go', reflink: 'unavailable' },
          snapshots: 0,
        },
      })
    }

    return Response.json({ ok: false, error: `no route: ${method} ${path}` }, { status: 404 })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/** Compact build info embedded in session rows (LEFT JOIN against builds). */
function buildInfoOf(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.build_id === null || row.project === undefined) return null
  return {
    build_id: row.build_id,
    project: row.project,
    state: row.build_state,
    started_at: row.started_at,
    finished_at: row.finished_at,
    actions_total: row.actions_total,
    actions_done: row.actions_done,
    actions_failed: row.actions_failed,
    cache_hits: row.cache_hits,
    critical_path_ms: row.critical_path_ms,
    rc: row.rc,
    note: row.note,
    meta: row.meta,
  }
}
