// SysDeck bridge — fester
// Server-side proxy commands against the dedicated fester mini-service
// (127.0.0.1:3010). The service is REAL, so every command declares source
// 'live'. The sub-app UI talks to it through POST /api/fester directly; this
// module exists for the standard bridge surface (status/summary/…) used by
// the SysDeck shell and any panel summary cards.
import { ok, fail, festerFetch } from './shared'

// ── upstream shapes (subset the bridge needs) ─────────────────────────
interface FesterHealth {
  ok?: boolean
  service?: string
  version?: string
  clock?: string
  nodes?: number
  uptime_s?: number
}

interface FesterMetrics {
  builds?: { total?: number; running?: number; succeeded?: number; failed?: number; cancelled?: number }
  actions?: { total?: number; done?: number; failed?: number; cache_hits?: number; cache_hit_rate?: number }
  nodes?: { name: string; state?: string; cpu_load?: number; temp?: number; active_jobs?: number; max_jobs?: number }[]
  utilization?: { node: string; pct: number }[]
}

interface FesterBuildRow {
  build_id: string
  project?: string
  targets?: string[]
  state?: string
  actions?: number
  actions_total?: number
  actions_done?: number
  actions_failed?: number
  cache_hits?: number
  critical_path_ms?: number
  started_at?: number
  finished_at?: number
  [k: string]: unknown
}

interface FesterEvent {
  id?: number
  ts?: number
  type?: string
  build_id?: string
  action?: string
  state?: string
  node?: string
  score?: number
  reason?: string
  [k: string]: unknown
}

export const commands = {
  /** Service liveness — health + uptime + node count. */
  status: async () => {
    const health = await festerFetch<FesterHealth>('/api/health')
    if (!health) return fail('fester service unreachable on 127.0.0.1:3010')
    return ok(
      {
        service: health.service ?? 'fester',
        version: health.version ?? 'unknown',
        clock: health.clock ?? null,
        nodes: health.nodes ?? 0,
        uptime_s: health.uptime_s ?? 0,
        port: 3010,
        transport: 'rest+ws',
      },
      'live',
    )
  },

  /** One-shot dashboard summary: metrics + builds + the most recent events. */
  summary: async () => {
    const [metrics, builds, timeline] = await Promise.all([
      festerFetch<FesterMetrics>('/api/metrics'),
      festerFetch<{ builds?: FesterBuildRow[]; history?: FesterBuildRow[] }>('/api/builds'),
      festerFetch<{ events?: FesterEvent[] }>('/api/timeline'),
    ])
    if (!metrics) return fail('fester service unreachable on 127.0.0.1:3010')
    const events = [...(timeline?.events ?? [])].slice(-30).reverse()
    return ok(
      {
        metrics,
        builds: {
          live: builds?.builds ?? [],
          history: builds?.history ?? [],
        },
        events,
      },
      'live',
    )
  },

  /** Build list: live runs (engine state) + recent history rows. */
  builds: async () => {
    const data = await festerFetch<{ builds?: FesterBuildRow[]; history?: FesterBuildRow[] }>('/api/builds')
    if (!data) return fail('fester service unreachable on 127.0.0.1:3010')
    return ok({ builds: data.builds ?? [], history: data.history ?? [] }, 'live')
  },

  /** Cluster node registry snapshot. */
  nodes: async () => {
    const data = await festerFetch<{ nodes?: Record<string, unknown>[] }>('/api/nodes')
    if (!data) return fail('fester service unreachable on 127.0.0.1:3010')
    return ok({ nodes: data.nodes ?? [] }, 'live')
  },

  /** Project / target catalog for starting builds. */
  targets: async () => {
    const data = await festerFetch<{
      projects?: { name: string; repo?: string; targets?: { name: string; command?: string; system?: string; arch?: string }[] }[]
    }>('/api/targets')
    if (!data) return fail('fester service unreachable on 127.0.0.1:3010')
    return ok({ projects: data.projects ?? [] }, 'live')
  },
}
