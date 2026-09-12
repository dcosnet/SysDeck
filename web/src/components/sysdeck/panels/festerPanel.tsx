'use client'

// ─────────────────────────────────────────────────────────────────────────────
// FESTER — the distributed DAG build orchestration sub-app.
//
// A port of the standalone fester 8-page UI (index / live_dag / replay /
// sessions / cause / timeline / debugger / metrics) into one tabbed React
// sub-app that takes over the whole SysDeck panel area with its own dark
// terminal identity.
//
//   REST  → always through the server-side proxy: fetch('/api/fester', …)
//           (never an absolute URL / never 127.0.0.1:3010 from the browser)
//   WS    → raw WebSocket, single connection for the whole sub-app:
//           `${ws|wss}://${location.host}/?XTransformPort=3010`
//           auto-reconnect 800ms ×1.6 capped 8s (port of fester ui/app.js)
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from 'sonner'
import { DataTable, StatCard } from '@/components/sysdeck/ui'
import { cn } from '@/lib/utils'

// ── types ───────────────────────────────────────────────────────────────────

interface Fev {
  /** receive sequence number assigned client-side (monotonic) */
  seq?: number
  id?: number
  ts?: number
  timestamp?: number
  type: string
  build_id?: string
  /* debugger-ack frames use camelCase (WS hub shape) */
  buildId?: string
  command?: string
  action?: string
  state?: string
  node?: string
  score?: number
  reason?: string
  parent?: string
  target?: string
  meta?: Record<string, unknown>
  /* hello frame */
  service?: string
  version?: string
  clients?: number
  /* heartbeat frame */
  heartbeat?: boolean
  nodes?: number
  /* node_update spread (NodeState snapshot) */
  name?: string
  cpu_load?: number
  memory_load?: number
  temp?: number
  active_jobs?: number
  max_jobs?: number
  instability?: number
  host?: string
  runtime?: string
  arch?: string
  [k: string]: unknown
}

interface FesterNode {
  name: string
  state: string
  cpu_load: number
  memory_load?: number
  temp: number
  active_jobs: number
  max_jobs: number
  instability?: number
  host?: string
  runtime?: string
  arch?: string
}

interface DagAction {
  name: string
  deps: string[]
  state: string
  node?: string
  score?: number
  reason?: string
  durationMs?: number
  cacheHit?: boolean
}

interface BuildRow {
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
  rc?: number
  note?: string | null
  [k: string]: unknown
}

interface BuildDetail {
  build_id: string
  project?: string
  targets?: string[]
  state?: string
  actions?: { name: string; state?: string; node?: string; score?: number; durationMs?: number; cacheHit?: boolean; deps?: string[]; [k: string]: unknown }[]
  actions_total?: number
  actions_done?: number
  actions_failed?: number
  critical_path_ms?: number
  started_at?: number
  finished_at?: number
  paused?: boolean
  step_mode?: boolean
  rc?: number
  note?: string | null
  [k: string]: unknown
}

interface FesterMetrics {
  builds?: { total?: number; running?: number; succeeded?: number; failed?: number; cancelled?: number }
  actions?: { total?: number; done?: number; failed?: number; cache_hits?: number; cache_hit_rate?: number }
  nodes?: { name: string; state?: string; cpu_load?: number; temp?: number; active_jobs?: number; max_jobs?: number }[]
  utilization?: { node: string; pct: number }[]
}

interface FesterProject {
  name: string
  repo?: string
  targets?: { name: string; command?: string; system?: string; arch?: string }[]
}

interface SessionRow {
  session_id: string
  build_id: string
  label?: string | null
  created_at?: number
  /** list rows embed the build; the detail endpoint flattens it */
  build?: BuildRow | null
  project?: string | null
  build_state?: string | null
}

interface CauseNode {
  id: string
  kind: 'decision' | 'task' | 'failure' | 'cache' | 'policy' | 'stamp'
  label: string
  detail?: string
}

interface CauseEdge {
  from: string
  to: string
  label?: string
}

type WsStatus = 'connecting' | 'online' | 'offline'
type TabId = 'dashboard' | 'dag' | 'replay' | 'sessions' | 'timeline' | 'cause' | 'debugger' | 'metrics'

// ── REST client (server-side proxy only — relative URL) ─────────────────────

interface ApiRes<T> {
  ok: boolean
  status: number
  data: (T & { ok?: boolean; error?: string }) | null
  error?: string
}

async function festerApi<T = unknown>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<ApiRes<T>> {
  try {
    const res = await fetch('/api/fester', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, method, body }),
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* non-json upstream body */
    }
    const data = json as (T & { ok?: boolean; error?: string }) | null
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: data?.error ?? `HTTP ${res.status}` }
    }
    if (data && data.ok === false) {
      return { ok: false, status: res.status, data, error: data?.error ?? 'request failed' }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── formatting + palette ────────────────────────────────────────────────────

const C = {
  pending: '#71717a',
  scheduled: '#2dd4bf',
  running: '#f59e0b',
  done: '#10b981',
  failed: '#ef4444',
  retry: '#fb923c',
  skipped: '#52525b',
  cancelled: '#6b7280',
  cache: '#22d3ee',
  edge: '#3f3f46',
  edgeDim: '#27272a',
}

function stateColor(state?: string): string {
  switch ((state ?? '').toLowerCase()) {
    case 'done':
    case 'succeeded':
    case 'ok':
      return C.done
    case 'running':
      return C.running
    case 'scheduled':
      return C.scheduled
    case 'retry':
      return C.retry
    case 'failed':
    case 'error':
      return C.failed
    case 'hit':
      return C.cache
    default:
      return C.pending
  }
}

function badgeCls(state?: string): string {
  switch ((state ?? '').toLowerCase()) {
    case 'done':
    case 'succeeded':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
    case 'running':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400'
    case 'queued':
      return 'border-zinc-600/60 bg-zinc-800/60 text-zinc-400'
    case 'scheduled':
      return 'border-teal-500/40 bg-teal-500/10 text-teal-400'
    case 'retry':
      return 'border-orange-500/40 bg-orange-500/10 text-orange-400'
    case 'failed':
      return 'border-red-500/40 bg-red-500/10 text-red-500'
    case 'cancelled':
      return 'border-zinc-600/60 bg-zinc-800/60 text-zinc-400'
    default:
      return 'border-zinc-600/60 bg-zinc-800/60 text-zinc-400'
  }
}

const TYPE_CLS: Record<string, string> = {
  node_update: 'text-teal-400',
  task_update: 'text-amber-400',
  pipeline_update: 'text-fuchsia-400',
  cache_update: 'text-cyan-400',
  failure: 'text-red-400',
  debug: 'text-zinc-400',
  btc_stamp: 'text-emerald-400',
  replay: 'text-violet-400',
  hello: 'text-zinc-400',
  'debugger-ack': 'text-orange-400',
  subscribed: 'text-teal-400',
  unsubscribed: 'text-zinc-400',
}

const ALL_TYPES = ['node_update', 'task_update', 'pipeline_update', 'cache_update', 'failure', 'debug', 'btc_stamp', 'replay']

function typeCls(t?: string): string {
  return TYPE_CLS[t ?? ''] ?? 'text-zinc-400'
}

function evTs(ev: Fev): number {
  return (ev.ts ?? ev.timestamp ?? 0) || 0
}

function fmtClock(ts?: number): string {
  if (!ts) return '--:--:--'
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtRel(ts?: number): string {
  if (!ts) return '—'
  const diff = Math.max(0, (Date.now() - (ts < 1e12 ? ts * 1000 : ts)) / 1000)
  if (diff < 60) return `${Math.floor(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function fmtDur(ms?: number): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function fmtUp(s?: number): string {
  if (s == null) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s)}s`
}

function shortAction(name: string): string {
  const parts = name.split(':')
  return parts.slice(-2).join(':')
}

// history rows persist `targets` as a JSON-encoded string (sqlite);
// live rows carry real arrays — normalize both to string[].
function normTargets(t: unknown): string[] {
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  if (typeof t === 'string') {
    try {
      const parsed: unknown = JSON.parse(t)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function normalizeRow(b: BuildRow): BuildRow {
  return { ...b, targets: normTargets(b.targets) }
}

function shortBuild(b?: BuildRow | null): string {
  if (!b) return '—'
  const t = normTargets(b.targets).join('+')
  return t ? `${b.project}:${t}` : (b.project ?? b.build_id)
}

function heatColor(pct: number): string {
  if (pct < 40) return C.done
  if (pct < 60) return '#84cc16'
  if (pct < 80) return C.running
  return C.failed
}

function eventMessage(ev: Fev): string {
  const meta = ev.meta ?? {}
  switch (ev.type) {
    case 'node_update':
      if (ev.heartbeat) return `heartbeat · ${ev.nodes ?? '?'} nodes online`
      return `${ev.name ?? ev.node ?? '—'} ${ev.state ?? ''} · cpu ${Math.round(ev.cpu_load ?? 0)}% · ${Math.round(ev.temp ?? 0)}°C · jobs ${ev.active_jobs ?? 0}/${ev.max_jobs ?? '?'}`
    case 'task_update': {
      const bits = [ev.state ?? '']
      if (ev.node) bits.push(`@ ${ev.node}`)
      if (ev.score != null) bits.push(`score ${ev.score}`)
      if (meta.duration_ms != null) bits.push(fmtDur(meta.duration_ms as number))
      return `${shortAction(ev.action ?? '?')} ${bits.join(' ')}`
    }
    case 'pipeline_update':
      return `pipeline ${ev.state ?? ''}${meta.actions != null ? ` · ${meta.actions} actions` : ''}${meta.retries != null ? ` · retries ${meta.retries}` : ''}`
    case 'cache_update':
      return `${shortAction(ev.action ?? '?')} cache ${ev.state ?? ''}`
    case 'failure':
      return `${shortAction(ev.action ?? '?')} FAILED — ${ev.reason ?? 'unknown'}`
    case 'debug':
      return `debug ${ev.state ?? ''} ${ev.reason ?? ''}`.trim()
    case 'btc_stamp':
      return `${shortAction(ev.action ?? '?')} stamped ${String(meta.toolchain ?? 'BTC')}`
    case 'replay':
      return `session ${ev.state ?? ''}${meta.session_id ? ` ${meta.session_id}` : ''}`
    case 'debugger-ack':
      return `debugger ${ev.command ?? ''} ${ev.state ?? ''} ${ev.error ?? ''}`.trim()
    case 'hello':
      return `hello from fester v${ev.version ?? '?'}`
    case 'subscribed':
      return `subscribed to ${ev.buildId ?? ''} — foreign events filtered`
    case 'unsubscribed':
      return 'unsubscribed — full event broadcast'
    default:
      return JSON.stringify(ev).slice(0, 140)
  }
}

// ── event fold → action map (shared by Live DAG + Replay) ───────────────────

function foldEvent(acc: Map<string, DagAction>, ev: Fev): void {
  const t = ev.type
  const meta = ev.meta ?? {}
  if (t === 'task_update' && ev.action) {
    const prev = acc.get(ev.action)
    const deps = Array.isArray(meta.deps) ? (meta.deps as string[]) : (prev?.deps ?? [])
    acc.set(ev.action, {
      name: ev.action,
      deps,
      state: (ev.state as string) ?? (prev?.state ?? 'pending'),
      node: ev.node ?? prev?.node,
      score: ev.score ?? prev?.score,
      reason: ev.reason ?? prev?.reason,
      durationMs: typeof meta.duration_ms === 'number' ? meta.duration_ms : prev?.durationMs,
      cacheHit: meta.cache === 'hit' ? true : (prev?.cacheHit ?? false),
    })
  } else if (t === 'cache_update' && ev.action && ev.state === 'hit') {
    const prev = acc.get(ev.action) ?? { name: ev.action, deps: [], state: 'pending' }
    acc.set(ev.action, { ...prev, cacheHit: true })
  } else if (t === 'failure' && ev.action) {
    const prev = acc.get(ev.action) ?? { name: ev.action, deps: [], state: 'pending' }
    acc.set(ev.action, { ...prev, state: 'failed', reason: ev.reason })
  }
}

function foldEvents(events: Fev[]): Map<string, DagAction> {
  const map = new Map<string, DagAction>()
  for (const ev of events) foldEvent(map, ev)
  return map
}

// Running replay fold per journal (see ReplayBody's frame memo) — keyed by
// the immutable events array so an old journal's fold state GCs with it.
const replayFolds = new WeakMap<Fev[], { cursor: number; map: Map<string, DagAction> }>()

// ── DAG layout (depth-based layering; x = index, y = depth) ─────────────────

interface LaidDag {
  nodes: { a: DagAction; x: number; y: number }[]
  edges: { from: string; to: string }[]
  width: number
  height: number
}

function layoutDag(actions: Map<string, DagAction>, compact = false): LaidDag {
  const NW = compact ? 128 : 172
  const NH = compact ? 34 : 44
  const GX = compact ? 26 : 56
  const names = [...actions.keys()]
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const getDepth = (name: string): number => {
    const d = depth.get(name)
    if (d !== undefined) return d
    if (visiting.has(name)) return 0 // cycle guard
    visiting.add(name)
    let dd = 0
    const a = actions.get(name)
    for (const dep of a?.deps ?? []) {
      if (actions.has(dep)) dd = Math.max(dd, getDepth(dep) + 1)
    }
    visiting.delete(name)
    depth.set(name, dd)
    return dd
  }
  for (const n of names) getDepth(n)

  const byDepth: string[][] = []
  for (const n of names) {
    const d = depth.get(n) ?? 0
    while (byDepth.length <= d) byDepth.push([])
    byDepth[d].push(n)
  }
  // compress vertical gaps when the graph is deep so fit-scaling stays readable
  const GY = compact ? (byDepth.length > 6 ? 22 : 34) : byDepth.length > 6 ? 34 : 58

  const pos = new Map<string, { x: number; y: number }>()
  byDepth.forEach((row, d) => {
    let ordered: string[]
    if (d > 0) {
      // order by mean x of already-placed deps → fewer edge crossings.
      // Scores are computed once per node (decorate-sort-undecorate),
      // never per comparison.
      const scored = row.map((name) => {
        const a = actions.get(name)
        const xs = (a?.deps ?? []).filter((dep) => pos.has(dep)).map((dep) => pos.get(dep)!.x)
        return { name, s: xs.length ? xs.reduce((acc, v) => acc + v, 0) / xs.length : Number.MAX_SAFE_INTEGER }
      })
      scored.sort((p, q) => p.s - q.s || p.name.localeCompare(q.name))
      ordered = scored.map((p) => p.name)
    } else {
      ordered = [...row].sort()
    }
    ordered.forEach((name, i) => pos.set(name, { x: 16 + i * (NW + GX), y: 16 + d * (NH + GY) }))
    byDepth[d] = ordered
  })

  const maxRow = Math.max(1, ...byDepth.map((r) => r.length))
  const edges: { from: string; to: string }[] = []
  for (const a of actions.values()) {
    for (const dep of a.deps) if (actions.has(dep)) edges.push({ from: dep, to: a.name })
  }
  return {
    nodes: [...actions.values()].map((a) => ({ a, x: pos.get(a.name)!.x, y: pos.get(a.name)!.y })),
    edges,
    width: 16 * 2 + maxRow * NW + Math.max(0, maxRow - 1) * GX,
    height: 16 * 2 + byDepth.length * NH + Math.max(0, byDepth.length - 1) * GY,
  }
}

// ── the WS hook (one connection for the whole sub-app) ──────────────────────

export interface FesterStream {
  status: WsStatus
  hello: { version?: string; clients?: number } | null
  /** bump counter — increments on every (throttled ~150ms) event batch */
  version: number
  /** snapshot of the live buffer (last 2000 events) — fresh identity per flush */
  events: Fev[]
  nodes: FesterNode[]
  nodeScores: Record<string, number>
  subscribed: string | null
  setSubscription: (buildId: string | null) => void
  sendDebugger: (buildId: string, command: 'pause' | 'resume' | 'step') => boolean
  seedNodes: (nodes: FesterNode[]) => void
}

function useFesterStream(): FesterStream {
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [hello, setHello] = useState<{ version?: string; clients?: number } | null>(null)
  const [version, setVersion] = useState(0)
  const [nodes, setNodes] = useState<FesterNode[]>([])
  const [nodeScores, setNodeScores] = useState<Record<string, number>>({})
  const [subscribed, setSubscribed] = useState<string | null>(null)
  /** render-visible snapshot of the live buffer — replaced by flush() */
  const [events, setEvents] = useState<Fev[]>([])

  const bufferRef = useRef<Fev[]>([])
  const seqRef = useRef(0)
  const nodeMapRef = useRef<Map<string, FesterNode>>(new Map())
  const scoreRef = useRef<Map<string, number>>(new Map())
  const subRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const flushTimerRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    setVersion((v) => v + 1)
    setEvents(bufferRef.current.slice())
    setNodes([...nodeMapRef.current.values()].sort((a, b) => a.name.localeCompare(b.name)))
    setNodeScores(Object.fromEntries(scoreRef.current))
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current != null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      flush()
    }, 150)
  }, [flush])

  const handleEvent = useCallback(
    (ev: Fev) => {
      const e = { ...ev, seq: ++seqRef.current }
      if (e.type === 'hello') {
        setHello({ version: e.version, clients: e.clients })
      }
      if (e.type === 'node_update' && !e.heartbeat && typeof e.name === 'string') {
        nodeMapRef.current.set(e.name, {
          name: e.name,
          state: (e.state as string) ?? 'online',
          cpu_load: (e.cpu_load as number) ?? 0,
          memory_load: (e.memory_load as number) ?? undefined,
          temp: (e.temp as number) ?? 0,
          active_jobs: (e.active_jobs as number) ?? 0,
          max_jobs: (e.max_jobs as number) ?? 1,
          instability: (e.instability as number) ?? undefined,
          host: (e.host as string) ?? undefined,
          runtime: (e.runtime as string) ?? undefined,
          arch: (e.arch as string) ?? undefined,
        })
      }
      if (e.type === 'task_update' && e.state === 'scheduled') {
        if (e.node && typeof e.score === 'number') scoreRef.current.set(e.node, e.score)
        const scores = e.meta?.scores
        if (Array.isArray(scores)) {
          for (const s of scores as { node?: string; score?: number }[]) {
            if (s && typeof s.node === 'string' && typeof s.score === 'number') scoreRef.current.set(s.node, s.score)
          }
        }
      }
      bufferRef.current.push(e)
      if (bufferRef.current.length > 2000) bufferRef.current.splice(0, bufferRef.current.length - 2000)
      scheduleFlush()
    },
    [scheduleFlush],
  )

  const setSubscription = useCallback((buildId: string | null) => {
    subRef.current = buildId
    setSubscribed(buildId)
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (buildId) ws.send(JSON.stringify({ type: 'subscribe', buildId }))
      else ws.send(JSON.stringify({ type: 'unsubscribe' }))
    }
  }, [])

  const sendDebugger = useCallback((buildId: string, command: 'pause' | 'resume' | 'step') => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'debugger', buildId, command }))
      return true
    }
    return false
  }, [])

  const seedNodes = useCallback((incoming: FesterNode[]) => {
    for (const n of incoming) nodeMapRef.current.set(n.name, n)
    flush()
  }, [flush])

  useEffect(() => {
    let closed = false
    let delay = 800
    let reconnectTimer: number | null = null
    let ws: WebSocket | null = null

    const scheduleReconnect = () => {
      if (closed || reconnectTimer != null) return
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
      delay = Math.min(delay * 1.6, 8000)
    }

    const connect = () => {
      if (closed) return
      setStatus('connecting')
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        // gateway contract: path is ALWAYS '/' + the transform port query —
        // never a port in the URL, never an absolute host.
        ws = new WebSocket(`${proto}://${location.host}/?XTransformPort=3010`)
      } catch {
        setStatus('offline')
        scheduleReconnect()
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        if (closed) return
        delay = 800
        setStatus('online')
        if (subRef.current) ws?.send(JSON.stringify({ type: 'subscribe', buildId: subRef.current }))
      }
      ws.onmessage = (msg: MessageEvent) => {
        try {
          handleEvent(JSON.parse(String(msg.data)) as Fev)
        } catch {
          /* malformed frame — ignore */
        }
      }
      ws.onerror = () => {
        /* onclose follows */
      }
      ws.onclose = () => {
        if (closed) return
        setStatus('offline')
        scheduleReconnect()
      }
    }

    connect()
    return () => {
      closed = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current)
      ws?.close()
      wsRef.current = null
    }
  }, [handleEvent])

  return {
    status,
    hello,
    version,
    events,
    nodes,
    nodeScores,
    subscribed,
    setSubscription,
    sendDebugger,
    seedNodes,
  }
}

// ── shared polling hook ─────────────────────────────────────────────────────

function usePoll<T>(loader: () => Promise<T>, deps: unknown[], intervalMs: number, enabled = true): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: number | undefined
    const run = async () => {
      const next = await loader()
      if (!cancelled) setData(next)
    }
    void run()
    if (intervalMs > 0) timer = window.setInterval(run, intervalMs)
    return () => {
      cancelled = true
      if (timer != null) window.clearInterval(timer)
    }
  }, [enabled, intervalMs, ...deps])
  return data
}

function useBuildDetail(buildId: string | null, intervalMs = 0): BuildDetail | null {
  const loader = useCallback(async () => {
    if (!buildId) return null
    const res = await festerApi<{ build?: BuildDetail }>(`/api/builds/${encodeURIComponent(buildId)}`)
    return res.ok ? (res.data?.build ?? null) : null
  }, [buildId])
  return usePoll(loader, [buildId], intervalMs)
}

// ── terminal atoms ──────────────────────────────────────────────────────────

const TERMINAL_VARS = {
  '--background': '#09090b',
  '--foreground': '#e4e4e7',
  '--card': '#131316',
  '--card-foreground': '#e4e4e7',
  '--popover': '#18181b',
  '--popover-foreground': '#e4e4e7',
  '--primary': '#f59e0b',
  '--primary-foreground': '#18181b',
  '--secondary': '#27272a',
  '--secondary-foreground': '#e4e4e7',
  '--muted': '#27272a',
  '--muted-foreground': '#a1a1aa',
  '--accent': '#27272a',
  '--accent-foreground': '#e4e4e7',
  '--border': '#27272a',
  '--input': '#27272a',
  '--ring': '#f59e0b',
  '--destructive': '#ef4444',
  '--destructive-foreground': '#fafafa',
} as CSSProperties

function FBadge({ state, className }: { state?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
        badgeCls(state),
        className,
      )}
    >
      {state ?? '—'}
    </span>
  )
}

function TypeTag({ type }: { type?: string }) {
  return (
    <span className={cn('inline-flex w-[104px] shrink-0 font-mono text-[10px] font-semibold uppercase', typeCls(type))}>
      {type ?? 'event'}
    </span>
  )
}

function Tile({
  label,
  value,
  unit,
  tone,
  hint,
}: {
  label: string
  value: React.ReactNode
  unit?: string
  tone?: 'good' | 'bad' | 'warn' | 'run' | 'default'
  hint?: string
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-500'
        : tone === 'warn'
          ? 'text-amber-500'
          : tone === 'run'
            ? 'text-teal-400'
            : 'text-zinc-100'
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('mt-0.5 font-mono text-xl font-semibold tabular-nums', color)}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-zinc-500">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{hint}</p> : null}
    </div>
  )
}

function HeatBar({ pct, color, height = 4 }: { pct: number; color: string; height?: number }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-sm bg-zinc-800" style={{ height }}>
      <div
        className="h-full rounded-sm transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
      />
    </div>
  )
}

function NodeDot({ state }: { state: string }) {
  const s = (state ?? '').toLowerCase()
  const cls =
    s === 'online'
      ? 'bg-emerald-500'
      : s === 'degraded'
        ? 'bg-amber-500'
        : s === 'offline'
          ? 'bg-red-500'
          : 'bg-zinc-600'
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', cls, s !== 'offline' && 'sd-live-dot')} aria-hidden />
}

function NodeRow({ n, score }: { n: FesterNode; score?: number }) {
  const jobsPct = (n.active_jobs / Math.max(1, n.max_jobs)) * 100
  return (
    <div className="border-b border-zinc-800/70 px-3 py-2.5 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <NodeDot state={n.state} />
          <span className="truncate font-mono text-sm font-semibold text-zinc-100">{n.name}</span>
          {n.runtime ? (
            <span className="shrink-0 rounded border border-zinc-700 bg-zinc-800/60 px-1 font-mono text-[9px] uppercase text-zinc-400">
              {n.runtime}
            </span>
          ) : null}
          {n.arch ? <span className="shrink-0 font-mono text-[10px] text-zinc-600">{n.arch}</span> : null}
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{n.state}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
        <span className="w-6 shrink-0 text-zinc-600">cpu</span>
        <HeatBar pct={n.cpu_load} color={heatColor(n.cpu_load)} />
        <span className="w-9 shrink-0 text-right tabular-nums text-zinc-400">{Math.round(n.cpu_load)}%</span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
        <span className="w-6 shrink-0 text-zinc-600">tmp</span>
        <HeatBar pct={n.temp} color={heatColor(n.temp)} />
        <span className="w-9 shrink-0 text-right tabular-nums text-zinc-400">{Math.round(n.temp)}°</span>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
        <span className="w-6 shrink-0 text-zinc-600">job</span>
        <HeatBar pct={jobsPct} color="#2dd4bf" />
        <span className="w-9 shrink-0 text-right tabular-nums text-zinc-400">
          {n.active_jobs}/{n.max_jobs}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-zinc-600">
        <span>{n.host ?? '—'}</span>
        {score != null ? <span className="text-teal-400">score {score.toFixed(1)}</span> : null}
      </div>
    </div>
  )
}

function EventLog({ events, maxRows = 120, ariaLabel }: { events: Fev[]; maxRows?: number; ariaLabel: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length])
  const slice = events.length > maxRows ? events.slice(events.length - maxRows) : events
  return (
    <div
      ref={boxRef}
      role="log"
      aria-label={ariaLabel}
      className="sd-scroll h-full overflow-y-auto bg-zinc-950/80 px-2 py-1.5 font-mono text-[11px] leading-5"
    >
      {slice.length === 0 ? <p className="p-4 text-center text-zinc-600">waiting for events…</p> : null}
      {slice.map((ev, i) => (
        <div key={ev.seq ?? ev.id ?? `i${i}`} className="flex gap-2 whitespace-nowrap">
          <span className="shrink-0 text-zinc-600">{fmtClock(evTs(ev))}</span>
          <TypeTag type={ev.type} />
          <span className="truncate text-zinc-300">{eventMessage(ev)}</span>
        </div>
      ))}
    </div>
  )
}

// ── DAG SVG (shared: Live DAG + Replay mini graph) ──────────────────────────

function DagSvg({
  actions,
  compact = false,
  activeName,
  focusedName,
  onNode,
  ariaLabel = 'Action dependency DAG',
}: {
  actions: Map<string, DagAction>
  compact?: boolean
  activeName?: string
  focusedName?: string | null
  onNode?: (a: DagAction) => void
  ariaLabel?: string
}) {
  const laid = useMemo(() => layoutDag(actions, compact), [actions, compact])
  const NW = compact ? 128 : 172
  const NH = compact ? 34 : 44
  const byName = useMemo(() => new Map(laid.nodes.map((n) => [n.a.name, n])), [laid])

  if (laid.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-zinc-600">no actions yet</div>
    )
  }

  const isFailed = (name: string) => (actions.get(name)?.state ?? '') === 'failed'

  return (
    <svg
      viewBox={`0 0 ${laid.width} ${laid.height}`}
      className="h-full w-full"
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <marker id="fd-a-zinc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.edge} />
        </marker>
        <marker id="fd-a-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.running} />
        </marker>
        <marker id="fd-a-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.failed} />
        </marker>
        <marker id="fd-a-teal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.scheduled} />
        </marker>
      </defs>

      {laid.edges.map((e) => {
        const from = byName.get(e.from)
        const to = byName.get(e.to)
        if (!from || !to) return null
        const x1 = from.x + NW / 2
        const y1 = from.y + NH
        const x2 = to.x + NW / 2
        const y2 = to.y
        const toState = (to.a.state ?? '').toLowerCase()
        const failedUp = isFailed(e.from)
        const flowing = toState === 'running'
        const stroke = failedUp ? C.failed : flowing ? C.running : toState === 'scheduled' ? C.scheduled : C.edge
        const marker = failedUp ? 'fd-a-red' : flowing ? 'fd-a-amber' : toState === 'scheduled' ? 'fd-a-teal' : 'fd-a-zinc'
        return (
          <path
            key={`${e.from}->${e.to}`}
            d={`M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) * 0.4}, ${x2} ${y2 - (y2 - y1) * 0.4}, ${x2} ${y2}`}
            fill="none"
            stroke={stroke}
            strokeWidth={flowing || failedUp ? 1.8 : 1.2}
            markerEnd={`url(#${marker})`}
            className={flowing ? 'sd-flow-edge' : undefined}
          />
        )
      })}

      {laid.nodes.map(({ a, x, y }) => {
        const color = stateColor(a.state)
        const isActive = activeName === a.name
        const isFocused = focusedName === a.name
        const st = (a.state ?? '').toLowerCase()
        return (
          <g
            key={a.name}
            transform={`translate(${x} ${y})`}
            className={cn(onNode && 'cursor-pointer')}
            tabIndex={onNode ? 0 : undefined}
            role={onNode ? 'button' : undefined}
            aria-label={`${a.name} ${a.state}`}
            onClick={onNode ? () => onNode(a) : undefined}
            onKeyDown={
              onNode
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onNode(a)
                    }
                  }
                : undefined
            }
          >
            <title>{`${a.name} — ${a.state}${a.node ? ` @ ${a.node}` : ''}${a.reason ? ` · ${a.reason}` : ''}`}</title>
            <rect
              width={NW}
              height={NH}
              rx={7}
              fill={`${color}14`}
              stroke={color}
              strokeWidth={isFocused || isActive ? 2 : 1.2}
              className={st === 'running' ? 'animate-pulse' : undefined}
            />
            {isActive ? <rect width={NW} height={NH} rx={7} fill="none" stroke={C.cache} strokeWidth={1} /> : null}
            <text x={NW / 2} y={compact ? 14 : 17} textAnchor="middle" fontSize={compact ? 10 : 11.5} fill={color} fontFamily="var(--font-geist-mono, monospace)">
              {shortAction(a.name)}
            </text>
            <text x={NW / 2} y={compact ? 26 : 33} textAnchor="middle" fontSize={compact ? 8.5 : 9.5} fill="#71717a" fontFamily="var(--font-geist-mono, monospace)">
              {[
                st === 'done' && a.cacheHit ? 'cache' : a.node,
                st === 'done' || st === 'failed' ? fmtDur(a.durationMs) : null,
                st === 'running' && a.score != null ? `s${a.score.toFixed(0)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Dashboard tab ───────────────────────────────────────────────────────────

function DashboardTab({
  stream,
  live,
  history,
  metrics,
  onGoToBuild,
  onStartBuild,
}: {
  stream: FesterStream
  live: BuildRow[]
  history: BuildRow[]
  metrics: FesterMetrics | null
  onGoToBuild: (id: string) => void
  onStartBuild: () => void
}) {
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<Fev[]>([])
  const active = live.find((b) => b.state === 'running' || b.state === 'queued') ?? null
  const detail = useBuildDetail(active?.build_id ?? null, active ? 3000 : 0)

  const shown = paused ? frozen : stream.events

  const mb = metrics?.builds ?? {}
  const ma = metrics?.actions ?? {}
  const recent = [...live, ...history]
    .filter((b, i, arr) => arr.findIndex((x) => x.build_id === b.build_id) === i)
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    .slice(0, 10)

  const doneCount = detail?.actions
    ? detail.actions.filter((a) => ['done', 'skipped', 'cancelled'].includes((a.state ?? '').toLowerCase())).length
    : (detail?.actions_done ?? 0)
  const totalCount = detail?.actions ? detail.actions.length : (detail?.actions_total ?? active?.actions ?? 0)
  const progressPct = totalCount > 0 ? (doneCount / totalCount) * 100 : 0

  return (
    <div className="grid h-full grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-[340px_minmax(0,1fr)_360px] sd-scroll">
      {/* LEFT — cluster nodes (WS node_update + REST seed) */}
      <Card className="flex h-full min-h-[420px] flex-col overflow-hidden border-zinc-800 bg-zinc-900/40">
        <CardHeader className="flex-row items-center justify-between border-b border-zinc-800 py-2.5">
          <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">Cluster · {stream.nodes.length} nodes</CardTitle>
          <span className="font-mono text-[10px] text-zinc-600">ws {stream.status}</span>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0 sd-scroll">
          {stream.nodes.map((n) => (
            <NodeRow key={n.name} n={n} score={stream.nodeScores[n.name]} />
          ))}
        </CardContent>
      </Card>

      {/* CENTER — live event stream */}
      <Card className="flex h-full min-h-[420px] flex-col overflow-hidden border-zinc-800 bg-zinc-900/40">
        <CardHeader className="flex-row items-center justify-between border-b border-zinc-800 py-2.5">
          <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">Live event stream</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            onClick={() => {
              if (!paused) setFrozen(stream.events.slice())
              setPaused((p) => !p)
            }}
            aria-pressed={paused}
          >
            {paused ? '▶ resume' : '⏸ pause'}
          </Button>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <EventLog events={shown} ariaLabel="Fester live event stream" />
        </CardContent>
      </Card>

      {/* RIGHT — stats + active build + recent builds */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <Tile label="builds" value={mb.total ?? '—'} hint={`${mb.running ?? 0} running`} />
          <Tile label="ok / fail" value={`${mb.succeeded ?? 0}/${mb.failed ?? 0}`} tone="good" hint={`${mb.cancelled ?? 0} cancelled`} />
          <Tile label="cache" value={ma.cache_hit_rate ?? '—'} unit="%" tone="run" hint={`${ma.cache_hits ?? 0} hits`} />
        </div>

        <Card className="overflow-hidden border-zinc-800 bg-zinc-900/40">
          <CardHeader className="flex-row items-center justify-between border-b border-zinc-800 py-2.5">
            <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">Active build</CardTitle>
            {active ? <FBadge state={active.state} /> : <span className="font-mono text-[10px] text-zinc-600">idle</span>}
          </CardHeader>
          <CardContent className="p-3">
            {active ? (
              <div className="space-y-2">
                <p className="truncate font-mono text-xs text-zinc-200">{shortBuild(active)}</p>
                <p className="truncate font-mono text-[10px] text-zinc-500">{active.build_id}</p>
                <Progress value={progressPct} className="h-2 [&>div]:bg-amber-500" />
                <div className="flex justify-between font-mono text-[10px] text-zinc-500">
                  <span>
                    {doneCount}/{totalCount} actions
                  </span>
                  <span>{detail?.paused ? 'paused' : 'executing'}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full border-zinc-700 bg-transparent font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
                  onClick={() => onGoToBuild(active.build_id)}
                >
                  open in live DAG →
                </Button>
              </div>
            ) : (
              <div className="space-y-2 py-2 text-center">
                <p className="font-mono text-[11px] text-zinc-500">no build running</p>
                <Button
                  size="sm"
                  className="h-7 w-full bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
                  onClick={onStartBuild}
                >
                  ▶ start build
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800 bg-zinc-900/40">
          <CardHeader className="flex-row items-center justify-between border-b border-zinc-800 py-2.5">
            <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">Recent builds</CardTitle>
            <span className="font-mono text-[10px] text-zinc-600">{recent.length}</span>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-0 sd-scroll">
            {recent.map((b) => (
              <button
                key={b.build_id}
                type="button"
                onClick={() => onGoToBuild(b.build_id)}
                className="flex w-full items-center justify-between gap-2 border-b border-zinc-800/70 px-3 py-2 text-left last:border-0 hover:bg-zinc-800/50 focus-visible:bg-zinc-800/50 focus-visible:outline-none"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px] text-zinc-200">{shortBuild(b)}</p>
                  <p className="truncate font-mono text-[9px] text-zinc-600">
                    {b.build_id} · {fmtRel(b.started_at)}
                    {b.critical_path_ms != null ? ` · ${fmtDur(b.critical_path_ms)}` : ''}
                  </p>
                </div>
                <FBadge state={b.state} className="shrink-0" />
              </button>
            ))}
            {recent.length === 0 ? <p className="p-4 text-center font-mono text-[11px] text-zinc-600">no builds yet</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── Live DAG tab ────────────────────────────────────────────────────────────

const STEP_NAMES = ['fetch', 'toolchain', 'configure', 'compile', 'test', 'package', 'stamp']

function StartBuildDialog({
  open,
  onOpenChange,
  projects,
  onStarted,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  projects: FesterProject[]
  onStarted: (buildId: string) => void
}) {
  const [project, setProject] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [failAction, setFailAction] = useState('none')
  const [noCache, setNoCache] = useState(false)
  const [retries, setRetries] = useState('0')
  const [busy, setBusy] = useState(false)

  // derived default: first project until the user picks one (no effect sync)
  const effectiveProject = project || (projects.length > 0 ? projects[0].name : '')
  const proj = projects.find((p) => p.name === effectiveProject) ?? null
  const actionOptions = useMemo(() => {
    const opts: string[] = []
    for (const t of targets) for (const step of STEP_NAMES) opts.push(`${effectiveProject}:${t}:${step}`)
    return opts
  }, [effectiveProject, targets])

  const start = async () => {
    if (!effectiveProject || targets.length === 0) {
      toast.error('pick a project and at least one target')
      return
    }
    setBusy(true)
    const res = await festerApi<{ build_id: string }>('/api/build', 'POST', {
      project: effectiveProject,
      targets,
      failAction: failAction === 'none' ? undefined : failAction,
      noCache,
      retries: Number(retries),
    })
    setBusy(false)
    if (res.ok && res.data?.build_id) {
      toast.success(`build started — ${res.data.build_id}`)
      onOpenChange(false)
      setTargets([])
      setFailAction('none')
      setNoCache(false)
      setRetries('0')
      onStarted(res.data.build_id)
    } else {
      toast.error(res.error ?? 'build failed to start')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-200 sm:max-w-md" style={TERMINAL_VARS}>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wider text-zinc-100">start build</DialogTitle>
          <DialogDescription className="font-mono text-[11px] text-zinc-500">
            POST /api/build — schedule a DAG across the cluster
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">project</label>
            <Select value={effectiveProject} onValueChange={(v) => { setProject(v); setTargets([]); setFailAction('none') }}>
              <SelectTrigger className="h-8 border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Project">
                <SelectValue placeholder="project" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
                {projects.map((p) => (
                  <SelectItem key={p.name} value={p.name} className="font-mono text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset>
            <legend className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              targets {proj ? `(${proj.targets?.length ?? 0})` : ''}
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              {(proj?.targets ?? []).map((t) => {
                const checked = targets.includes(t.name)
                return (
                  <label
                    key={t.name}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 font-mono text-[11px]',
                      checked ? 'border-teal-600/60 bg-teal-500/10 text-teal-300' : 'border-zinc-700 bg-zinc-950 text-zinc-400',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(c) => {
                        setTargets((prev) => (c ? [...prev, t.name] : prev.filter((x) => x !== t.name)))
                        setFailAction('none')
                      }}
                      aria-label={`target ${t.name}`}
                    />
                    <span className="truncate">
                      {t.name} <span className="text-zinc-600">{t.arch}</span>
                    </span>
                  </label>
                )
              })}
              {proj && (proj.targets?.length ?? 0) === 0 ? (
                <p className="col-span-2 p-2 font-mono text-[11px] text-zinc-600">no targets</p>
              ) : null}
            </div>
          </fieldset>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">inject failure (optional)</label>
            <Select value={failAction} onValueChange={setFailAction} disabled={actionOptions.length === 0}>
              <SelectTrigger className="h-8 border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Inject failure into action">
                <SelectValue placeholder={actionOptions.length === 0 ? 'pick targets first' : 'none'} />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
                <SelectItem value="none" className="font-mono text-xs">
                  none
                </SelectItem>
                {actionOptions.map((a) => (
                  <SelectItem key={a} value={a} className="font-mono text-xs">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">retries</label>
            <div className="flex gap-1.5">
              {['0', '1', '2', '3'].map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={retries === r}
                  onClick={() => setRetries(r)}
                  className={cn(
                    'h-8 flex-1 rounded border font-mono text-xs',
                    retries === r ? 'border-amber-500/60 bg-amber-500/10 text-amber-400' : 'border-zinc-700 bg-zinc-950 text-zinc-400',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-zinc-400">
            <Checkbox checked={noCache} onCheckedChange={(c) => setNoCache(c === true)} aria-label="Bypass CAS cache" />
            noCache — bypass the CAS layer
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="font-mono text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            cancel
          </Button>
          <Button
            onClick={start}
            disabled={busy}
            className="bg-amber-500 font-mono text-xs text-zinc-950 hover:bg-amber-400"
          >
            {busy ? 'starting…' : '▶ start'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DagTab({
  stream,
  builds,
  selectedBuildId,
  selectBuild,
  projects,
  openStart,
  setOpenStart,
}: {
  stream: FesterStream
  builds: BuildRow[]
  selectedBuildId: string | null
  selectBuild: (id: string) => void
  projects: FesterProject[]
  openStart: boolean
  setOpenStart: (o: boolean) => void
}) {
  const [actions, setActions] = useState<Map<string, DagAction>>(new Map())
  const [focused, setFocused] = useState<string | null>(null)
  const appliedRef = useRef<{ buildId: string; lastSeq: number } | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const build = builds.find((b) => b.build_id === selectedBuildId) ?? null
  const isRunning = build?.state === 'running' || build?.state === 'queued'

  // initial fold from the build's journaled timeline — setState only in the
  // async continuation (a null selection is unreachable: the shell always
  // resolves a build before this tab renders content)
  useEffect(() => {
    if (!selectedBuildId) return
    let cancelled = false
    const startSeq = stream.events.length > 0 ? (stream.events[stream.events.length - 1].seq ?? 0) : 0
    void festerApi<{ events: Fev[] }>(`/api/timeline/${encodeURIComponent(selectedBuildId)}`).then((res) => {
      if (cancelled) return
      const map = foldEvents(res.data?.events ?? [])
      setActions(map)
      setFocused(null)
      appliedRef.current = { buildId: selectedBuildId, lastSeq: startSeq }
    })
    return () => {
      cancelled = true
    }
  }, [selectedBuildId])

  // incremental live updates from the WS stream
  useEffect(() => {
    const ap = appliedRef.current
    if (!ap || ap.buildId !== selectedBuildId) return
    const fresh = stream.events.filter((e) => (e.seq ?? 0) > ap.lastSeq && (e.build_id ?? null) === selectedBuildId)
    if (fresh.length === 0) return
    ap.lastSeq = fresh[fresh.length - 1].seq ?? ap.lastSeq
    setActions((prev) => {
      const map = new Map(prev)
      for (const e of fresh) foldEvent(map, e)
      return map
    })
  }, [stream.version, stream.events, selectedBuildId])

  const cancel = async () => {
    if (!selectedBuildId) return
    setCancelling(true)
    const res = await festerApi(`/api/builds/${encodeURIComponent(selectedBuildId)}/cancel`, 'POST')
    setCancelling(false)
    if (res.ok) toast.success(`cancel requested — ${selectedBuildId}`)
    else toast.error(res.error ?? 'cancel failed')
  }

  const rows = useMemo(() => [...actions.values()], [actions])
  const done = rows.filter((a) => a.state === 'done').length
  const failed = rows.filter((a) => a.state === 'failed').length
  const cacheHits = rows.filter((a) => a.cacheHit).length

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Select value={selectedBuildId ?? ''} onValueChange={(v) => selectBuild(v)}>
          <SelectTrigger
            className="h-8 w-[300px] max-w-full border-zinc-700 bg-zinc-950 font-mono text-xs"
            aria-label="Select build"
          >
            <SelectValue placeholder={builds.length === 0 ? 'no builds' : 'select build'} />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
            {builds.map((b) => (
              <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                {b.state === 'running' ? '● ' : ''}
                {b.build_id} · {b.state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {build ? <FBadge state={build.state} /> : null}
        {isRunning ? (
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            onClick={cancel}
            className="h-7 border-red-900/60 bg-transparent font-mono text-[11px] text-red-400 hover:bg-red-950/40"
          >
            {cancelling ? '…' : '■ cancel'}
          </Button>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          {done}/{rows.length} done · {failed} failed · {cacheHits} cache
          {build?.critical_path_ms != null ? ` · critical ${fmtDur(build.critical_path_ms)}` : ''}
        </span>
        <Button
          size="sm"
          onClick={() => setOpenStart(true)}
          className="h-7 bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
        >
          ▶ start build
        </Button>
      </div>

      {/* graph stage */}
      <div
        className="relative min-h-0 flex-1 overflow-auto"
        style={{
          backgroundColor: '#0b0b0d',
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        {builds.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-sm rounded border border-zinc-800 bg-zinc-900/70 p-6 text-center">
              <p className="font-mono text-sm text-zinc-300">no builds yet</p>
              <p className="mt-1 font-mono text-[11px] text-zinc-500">
                the DAG view renders a build&apos;s action graph live from the event stream
              </p>
              <Button
                size="sm"
                onClick={() => setOpenStart(true)}
                className="mt-4 bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
              >
                ▶ start build
              </Button>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-[360px] p-2">
            <DagSvg
              actions={actions}
              focusedName={focused}
              onNode={(a) => setFocused(a.name === focused ? null : a.name)}
            />
          </div>
        )}
        {/* legend */}
        <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-zinc-800 bg-zinc-950/85 px-2.5 py-1.5 font-mono text-[10px] text-zinc-400">
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.pending }} />pending</div>
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.scheduled }} />scheduled</div>
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.running }} />running</div>
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.done }} />done</div>
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.failed }} />failed</div>
          <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm border" style={{ borderColor: C.cache }} />cache hit</div>
        </div>
      </div>

      {/* action table */}
      <div className="max-h-56 shrink-0 overflow-auto border-t border-zinc-800 sd-scroll">
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr className="text-left">
              <th className="px-3 py-1.5 font-medium">action</th>
              <th className="px-3 py-1.5 font-medium">state</th>
              <th className="px-3 py-1.5 font-medium">node</th>
              <th className="px-3 py-1.5 font-medium">score</th>
              <th className="px-3 py-1.5 font-medium">duration</th>
              <th className="px-3 py-1.5 font-medium">cache</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr
                key={a.name}
                className={cn(
                  'border-t border-zinc-800/60',
                  focused === a.name && 'bg-zinc-800/60',
                  a.name === focused && 'outline outline-1 outline-zinc-700',
                )}
              >
                <td className="px-3 py-1.5 text-zinc-200">{a.name}</td>
                <td className="px-3 py-1.5">
                  <FBadge state={a.state} />
                </td>
                <td className="px-3 py-1.5 text-zinc-400">{a.node ?? '—'}</td>
                <td className="px-3 py-1.5 text-zinc-400">{a.score != null ? a.score.toFixed(1) : '—'}</td>
                <td className="px-3 py-1.5 text-zinc-400">{a.state === 'done' || a.state === 'failed' ? fmtDur(a.durationMs) : '—'}</td>
                <td className="px-3 py-1.5">{a.cacheHit ? <span className="text-cyan-400">hit</span> : <span className="text-zinc-600">—</span>}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-zinc-600">
                  no actions journaled for this build
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <StartBuildDialog
        open={openStart}
        onOpenChange={setOpenStart}
        projects={projects}
        onStarted={(id) => selectBuild(id)}
      />
    </div>
  )
}

// ── Sessions tab ────────────────────────────────────────────────────────────

/** detail drawer body — keyed by session id so each open starts fresh */
function SessionDrawerBody({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<{ session: SessionRow | null; events: Fev[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    void festerApi<{ session: SessionRow; events: Fev[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`).then((res) => {
      if (cancelled) return
      setDetail(res.ok ? { session: res.data?.session ?? null, events: res.data?.events ?? [] } : null)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])
  return (
    <div className="flex h-[calc(100%-3.25rem)] flex-col">
      <div className="space-y-1 border-b border-zinc-800 px-4 py-3 font-mono text-[11px] text-zinc-400">
        <p>label: {detail?.session?.label ?? '—'}</p>
        <p>build: {detail?.session?.build_id}</p>
        <p>
          project: {detail?.session?.project ?? detail?.session?.build?.project ?? '—'} · state{' '}
          {detail?.session?.build_state ?? detail?.session?.build?.state ?? '—'}
        </p>
        <p>created: {fmtRel(detail?.session?.created_at)}</p>
      </div>
      <div className="min-h-0 flex-1">
        <EventLog events={detail?.events ?? []} maxRows={500} ariaLabel="Session events" />
      </div>
    </div>
  )
}

function SessionsTab({ builds, onGoToBuild }: { builds: BuildRow[]; onGoToBuild: (id: string) => void }) {
  const sessions = usePoll(
    async () => {
      const res = await festerApi<{ sessions: SessionRow[] }>('/api/sessions')
      return res.ok ? (res.data?.sessions ?? []) : []
    },
    [],
    8000,
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newBuild, setNewBuild] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!newBuild) {
      toast.error('pick a build for the session')
      return
    }
    setBusy(true)
    const res = await festerApi<{ session: SessionRow }>('/api/sessions', 'POST', {
      buildId: newBuild,
      label: newLabel || undefined,
    })
    setBusy(false)
    if (res.ok) {
      toast.success(`session ${res.data?.session?.session_id ?? ''} created`)
      setCreateOpen(false)
      setNewLabel('')
      setOpenId(res.data?.session?.session_id ?? null)
    } else {
      toast.error(res.error ?? 'session creation failed')
    }
  }

  const list = sessions ?? []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">replay sessions · {list.length}</span>
        <Button
          size="sm"
          className="ml-auto h-7 bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
          onClick={() => setCreateOpen(true)}
        >
          + create session
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto sd-scroll">
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr className="text-left">
              <th className="px-3 py-1.5 font-medium">session</th>
              <th className="px-3 py-1.5 font-medium">label</th>
              <th className="px-3 py-1.5 font-medium">build</th>
              <th className="px-3 py-1.5 font-medium">state</th>
              <th className="px-3 py-1.5 font-medium">created</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr
                key={s.session_id}
                tabIndex={0}
                role="button"
                aria-label={`open session ${s.session_id}`}
                onClick={() => setOpenId(s.session_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpenId(s.session_id)
                  }
                }}
                className={cn(
                  'cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-800/50 focus-visible:bg-zinc-800/50 focus-visible:outline-none',
                  openId === s.session_id && 'bg-zinc-800/60',
                )}
              >
                <td className="px-3 py-1.5 text-zinc-200">{s.session_id}</td>
                <td className="px-3 py-1.5 text-zinc-400">{s.label ?? '—'}</td>
                <td className="px-3 py-1.5 text-zinc-400">
                  <button
                    type="button"
                    className="text-cyan-400 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      onGoToBuild(s.build_id)
                    }}
                  >
                    {s.build?.project ?? s.build_id}
                  </button>
                </td>
                <td className="px-3 py-1.5">
                  <FBadge state={s.build?.state ?? s.build_state ?? undefined} />
                </td>
                <td className="px-3 py-1.5 text-zinc-500">{fmtRel(s.created_at)}</td>
              </tr>
            ))}
            {list.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-zinc-600">
                  no sessions — create one from any build
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* detail drawer */}
      <Sheet open={openId != null} onOpenChange={(o) => setOpenId(o ? openId : null)}>
        <SheetContent side="right" className="w-full border-zinc-800 bg-zinc-950 p-0 text-zinc-200 sm:max-w-md" style={TERMINAL_VARS}>
          <SheetHeader className="border-b border-zinc-800 px-4 py-3">
            <SheetTitle className="font-mono text-sm text-zinc-100">{openId ?? '—'}</SheetTitle>
          </SheetHeader>
          {openId ? <SessionDrawerBody key={openId} sessionId={openId} /> : null}
        </SheetContent>
      </Sheet>

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-200 sm:max-w-sm" style={TERMINAL_VARS}>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-zinc-100">create session</DialogTitle>
            <DialogDescription className="font-mono text-[11px] text-zinc-500">
              POST /api/sessions — pin a replay session to a build&apos;s journal
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">build</label>
              <Select value={newBuild} onValueChange={setNewBuild}>
                <SelectTrigger className="h-8 border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Build for session">
                  <SelectValue placeholder="select build" />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
                  {builds.slice(0, 40).map((b) => (
                    <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                      {b.build_id} · {b.state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">label (optional)</label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. post-mortem · compile failure"
                className="h-8 border-zinc-700 bg-zinc-950 font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} className="font-mono text-xs text-zinc-400">
              cancel
            </Button>
            <Button onClick={create} disabled={busy} className="bg-amber-500 font-mono text-xs text-zinc-950 hover:bg-amber-400">
              {busy ? 'creating…' : 'create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Replay tab ──────────────────────────────────────────────────────────────

function ReplayTab({ builds, selectedBuildId }: { builds: BuildRow[]; selectedBuildId: string | null }) {
  const [picked, setPicked] = useState<string | null>(null)
  // derived: the global pick flows in until the user chooses a build here;
  // the key on the body remounts it per build so replay state resets
  const buildId = picked ?? selectedBuildId ?? ''
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Select value={buildId} onValueChange={setPicked}>
          <SelectTrigger className="h-8 w-[280px] max-w-full border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Replay build">
            <SelectValue placeholder={builds.length === 0 ? 'no builds' : 'select build'} />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
            {builds.map((b) => (
              <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                {b.build_id} · {b.state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          GET /api/timeline/:buildId · ~4 events/s at 1×
        </span>
      </div>
      {buildId ? (
        <ReplayBody key={buildId} buildId={buildId} />
      ) : (
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-zinc-600">
          select a build to replay its journal
        </div>
      )}
    </div>
  )
}

function ReplayBody({ buildId }: { buildId: string }) {
  const [events, setEvents] = useState<Fev[]>([])
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(250)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void festerApi<{ events: Fev[] }>(`/api/timeline/${encodeURIComponent(buildId)}`).then((res) => {
      if (cancelled) return
      setLoading(false)
      setEvents(res.data?.events ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [buildId])

  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => {
      setCursor((c) => {
        if (c >= events.length - 1) {
          setPlaying(false)
          return c
        }
        return c + 1
      })
    }, speed)
    return () => window.clearInterval(t)
  }, [playing, speed, events.length])

  // Incremental replay fold: a forward step folds only the newly covered
  // events onto the running map (O(delta + nodes)); a backward move,
  // scrub, or new journal refolds. The running fold is keyed by the
  // immutable events array (WeakMap — an old journal's state GCs with
  // it), no ref is touched during render, and the returned Map is
  // always a fresh object so downstream memos recompute.
  const frame = useMemo(() => {
    let fold = replayFolds.get(events)
    if (!fold || cursor < fold.cursor) {
      const map = foldEvents(events.slice(0, cursor + 1))
      replayFolds.set(events, { cursor, map })
      return map
    }
    for (let i = fold.cursor + 1; i <= cursor; i++) foldEvent(fold.map, events[i]!)
    fold.cursor = cursor
    return new Map(fold.map)
  }, [events, cursor])
  const upTo = useMemo(() => events.slice(0, cursor + 1), [events, cursor])
  const current = events[cursor]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-zinc-700 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={() => setCursor((c) => Math.max(0, c - 1))}
            aria-label="Step back one event"
            disabled={cursor <= 0}
          >
            ⏮
          </Button>
          <Button
            size="sm"
            className="h-7 bg-amber-500 px-3 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
            onClick={() => {
              if (cursor >= events.length - 1) setCursor(0)
              setPlaying((p) => !p)
            }}
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            disabled={events.length === 0}
          >
            {playing ? '⏸ pause' : '▶ play'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-zinc-700 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={() => setCursor((c) => Math.min(events.length - 1, c + 1))}
            aria-label="Step forward one event"
            disabled={cursor >= events.length - 1}
          >
            ⏭
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-zinc-700 bg-transparent px-2 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={() => {
              setPlaying(false)
              setCursor(events.length - 1)
            }}
            aria-label="Jump to end"
            disabled={events.length === 0}
          >
            end
          </Button>
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px]">
          {[600, 250, 100].map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => setSpeed(s)}
              className={cn(
                'rounded border px-1.5 py-0.5',
                speed === s ? 'border-teal-600/60 bg-teal-500/10 text-teal-300' : 'border-zinc-700 text-zinc-500',
              )}
            >
              {['0.5×', '1×', '2.5×'][i]}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          {loading ? 'loading…' : `${cursor + 1} / ${events.length}`} · {current?.type ?? '—'}
        </span>
      </div>

      {/* scrubber */}
      <div className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-2">
        <input
          type="range"
          min={0}
          max={Math.max(0, events.length - 1)}
          value={cursor}
          step={1}
          onChange={(e) => {
            setPlaying(false)
            setCursor(Number(e.target.value))
          }}
          aria-label="Replay scrubber — event index"
          className="h-1.5 w-full cursor-pointer accent-amber-500"
          disabled={events.length === 0}
        />
      </div>

      {/* graph + log */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div
          className="relative min-h-[280px] border-b border-zinc-800 lg:border-b-0 lg:border-r"
          style={{
            backgroundColor: '#0b0b0d',
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
          <div className="h-full p-2">
            <DagSvg actions={frame} compact activeName={current?.action} ariaLabel="Replay DAG snapshot at cursor" />
          </div>
        </div>
        <div className="min-h-0">
          <EventLog events={upTo} maxRows={500} ariaLabel="Replay event log up to cursor" />
        </div>
      </div>
    </div>
  )
}

// ── Timeline tab ────────────────────────────────────────────────────────────

function TimelineTab({ builds, selectedBuildId }: { builds: BuildRow[]; selectedBuildId: string | null }) {
  const [types, setTypes] = useState<Set<string>>(new Set(ALL_TYPES))
  // derived: the global pick flows in until the user filters locally —
  // 'all' keeps the full journal view
  const [picked, setPicked] = useState<string | null>(null)
  const buildId = picked ?? selectedBuildId ?? 'all'

  const events = usePoll(
    async () => {
      const path = buildId === 'all' ? '/api/timeline' : `/api/timeline/${encodeURIComponent(buildId)}`
      const res = await festerApi<{ events: Fev[] }>(path)
      return res.ok ? (res.data?.events ?? []) : []
    },
    [buildId],
    10000,
  )

  const list = (events ?? []).filter((e) => types.has(e.type))
  const toggle = (t: string) => {
    setTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Select value={buildId} onValueChange={setPicked}>
          <SelectTrigger className="h-8 w-[240px] max-w-full border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Timeline build filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
            <SelectItem value="all" className="font-mono text-xs">
              all builds
            </SelectItem>
            {builds.slice(0, 30).map((b) => (
              <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                {b.build_id} · {b.state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-1">
          {ALL_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={types.has(t)}
              onClick={() => toggle(t)}
              className={cn(
                'rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                types.has(t)
                  ? 'border-zinc-600 bg-zinc-800 text-zinc-200'
                  : 'border-zinc-800 bg-transparent text-zinc-600 line-through',
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">{list.length} events</span>
      </div>

      <DataTable
        rows={list.slice(-500).reverse()}
        headers={['id', 'ts', 'type', 'build', 'action', 'state', 'node', 'score']}
        keyOf={(e) => String(e.id ?? e.seq ?? '')}
        renderRow={(e) => (
          <>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-500">{e.id ?? '—'}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-500">{fmtClock(evTs(e))}</td>
            <td className="px-3 py-1.5 font-mono text-[11px]">
              <span className={typeCls(e.type)}>{e.type}</span>
            </td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-400">{e.build_id ?? '—'}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-300">{e.action ? shortAction(e.action) : '—'}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-400">{e.state ?? '—'}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-400">{e.node ?? '—'}</td>
            <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-400">{e.score != null ? e.score.toFixed(1) : '—'}</td>
          </>
        )}
        empty="no events for this filter"
        maxH="100%"
      />
    </div>
  )
}

// ── Cause graph tab ─────────────────────────────────────────────────────────

const KIND_COLOR: Record<CauseNode['kind'], string> = {
  decision: '#f59e0b',
  task: '#2dd4bf',
  failure: '#ef4444',
  cache: '#22d3ee',
  policy: '#a1a1aa',
  stamp: '#10b981',
}

const KIND_SHAPE: Record<CauseNode['kind'], string> = {
  decision: 'diamond',
  task: 'rect',
  failure: 'rect',
  cache: 'octagon',
  policy: 'pill',
  stamp: 'rect',
}

function layoutCause(nodes: CauseNode[], edges: CauseEdge[]) {
  const NW = 186
  const NH = 52
  const COLW = 260
  const ROWH = 76
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const getDepth = (id: string): number => {
    const d = depth.get(id)
    if (d !== undefined) return d
    if (visiting.has(id)) return 0
    visiting.add(id)
    let dd = 0
    for (const e of edges) if (e.to === id) dd = Math.max(dd, getDepth(e.from) + 1)
    visiting.delete(id)
    depth.set(id, dd)
    return dd
  }
  for (const n of nodes) getDepth(n.id)

  const cols: string[][] = []
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    while (cols.length <= d) cols.push([])
    cols[d].push(n.id)
  }
  const pos = new Map<string, { x: number; y: number }>()
  cols.forEach((col, d) =>
    col.forEach((id, i) => pos.set(id, { x: 16 + d * COLW, y: 16 + i * ROWH })),
  )
  const maxCol = Math.max(1, ...cols.map((c) => c.length))
  return {
    pos,
    NW,
    NH,
    width: 16 * 2 + Math.max(1, cols.length) * COLW - (COLW - NW),
    height: 16 * 2 + maxCol * NH + Math.max(0, maxCol - 1) * (ROWH - NH),
  }
}

function CauseSvg({
  graph,
  hovered,
  onHover,
}: {
  graph: { nodes: CauseNode[]; edges: CauseEdge[] }
  hovered: CauseNode | null
  onHover: (n: CauseNode | null) => void
}) {
  const laid = useMemo(() => layoutCause(graph.nodes, graph.edges), [graph])
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph])
  if (graph.nodes.length === 0) {
    return <div className="flex h-full items-center justify-center font-mono text-xs text-zinc-600">no causal events for this build</div>
  }

  return (
    <svg
      width={Math.max(laid.width, 480)}
      height={laid.height}
      viewBox={`0 0 ${laid.width} ${laid.height}`}
      className="max-w-none"
      role="img"
      aria-label="Causal graph of scheduler decisions"
    >
      <defs>
        <marker id="fc-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.edge} />
        </marker>
      </defs>
      {graph.edges.map((e) => {
        const from = laid.pos.get(e.from)
        const to = laid.pos.get(e.to)
        const fn = byId.get(e.from)
        if (!from || !to || !fn) return null
        const x1 = from.x + laid.NW
        const y1 = from.y + laid.NH / 2
        const x2 = to.x
        const y2 = to.y + laid.NH / 2
        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2 - 4
        const causal = fn.kind === 'failure'
        return (
          <g key={`${e.from}->${e.to}`}>
            <path
              d={`M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={causal ? C.failed : '#3f3f46'}
              strokeWidth={causal ? 1.8 : 1.2}
              markerEnd="url(#fc-a)"
            />
            {e.label ? (
              <text x={midX} y={midY} textAnchor="middle" fontSize={9} fill="#71717a" fontFamily="var(--font-geist-mono, monospace)">
                {e.label}
              </text>
            ) : null}
          </g>
        )
      })}
      {graph.nodes.map((n) => {
        const p = laid.pos.get(n.id)
        if (!p) return null
        const color = n.kind === 'failure' ? C.failed : KIND_COLOR[n.kind] ?? C.pending
        const shape = KIND_SHAPE[n.kind] ?? 'rect'
        const isHover = hovered?.id === n.id
        const w = laid.NW
        const h = laid.NH
        const cx = p.x + w / 2
        const cy = p.y + h / 2
        return (
          <g
            key={n.id}
            tabIndex={0}
            role="button"
            aria-label={`${n.kind} ${n.label}`}
            onMouseEnter={() => onHover(n)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(n)}
            onBlur={() => onHover(null)}
            className="cursor-help"
          >
            <title>{`${n.label}${n.detail ? ` — ${n.detail}` : ''}`}</title>
            {shape === 'diamond' ? (
              <polygon
                points={`${cx},${p.y + 2} ${p.x + w - 2},${cy} ${cx},${p.y + h - 2} ${p.x + 2},${cy}`}
                fill={`${color}14`}
                stroke={color}
                strokeWidth={isHover ? 2 : 1.2}
              />
            ) : shape === 'octagon' ? (
              <polygon
                points={`${p.x + 14},${p.y + 1} ${p.x + w - 14},${p.y + 1} ${p.x + w - 1},${cy} ${p.x + w - 14},${p.y + h - 1} ${p.x + 14},${p.y + h - 1} ${p.x + 1},${cy}`}
                fill={`${color}14`}
                stroke={color}
                strokeWidth={isHover ? 2 : 1.2}
              />
            ) : (
              <rect
                x={p.x}
                y={p.y}
                width={w}
                height={h}
                rx={shape === 'pill' ? h / 2 : 6}
                fill={`${color}14`}
                stroke={color}
                strokeWidth={isHover ? 2 : 1.2}
              />
            )}
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize={10} fill={color} fontFamily="var(--font-geist-mono, monospace)">
              {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
            </text>
            {n.detail ? (
              <text x={cx} y={cy + 11} textAnchor="middle" fontSize={8.5} fill="#71717a" fontFamily="var(--font-geist-mono, monospace)">
                {n.detail.length > 30 ? `${n.detail.slice(0, 29)}…` : n.detail}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

function CauseTab({ builds, selectedBuildId, selectBuild }: { builds: BuildRow[]; selectedBuildId: string | null; selectBuild: (id: string) => void }) {
  const [hovered, setHovered] = useState<CauseNode | null>(null)
  // build-centric view always tracks the global selection (its own selector
  // writes the global pick, like the reference cause.html)
  const buildId = selectedBuildId ?? ''

  const graph = usePoll(
    async () => {
      if (!buildId) return null
      const res = await festerApi<{ cause: { nodes: CauseNode[]; edges: CauseEdge[] } }>(
        `/api/cause/${encodeURIComponent(buildId)}`,
      )
      return res.ok ? (res.data?.cause ?? null) : null
    },
    [buildId],
    0,
  )

  const kindCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const n of graph?.nodes ?? []) m[n.kind] = (m[n.kind] ?? 0) + 1
    return m
  }, [graph])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Select value={buildId} onValueChange={(v) => { selectBuild(v) }}>
          <SelectTrigger className="h-8 w-[280px] max-w-full border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Cause graph build">
            <SelectValue placeholder={builds.length === 0 ? 'no builds' : 'select build'} />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
            {builds.slice(0, 30).map((b) => (
              <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                {b.build_id} · {b.state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="font-mono text-[10px] text-zinc-500">
          {graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : '—'}
        </span>
        <div className="ml-auto flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
          {Object.entries(kindCount).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm border" style={{ borderColor: KIND_COLOR[k as CauseNode['kind']] ?? C.pending }} />
              {k} {v}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          className="min-h-0 flex-1 overflow-auto p-2"
          style={{
            backgroundColor: '#0b0b0d',
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
          {graph ? <CauseSvg graph={graph} hovered={hovered} onHover={setHovered} /> : <p className="p-6 font-mono text-xs text-zinc-600">select a build with failures or cache events…</p>}
        </div>
        <div className="w-full shrink-0 border-t border-zinc-800 p-3 lg:w-72 lg:border-l lg:border-t-0">
          <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">inspector</p>
          {hovered ? (
            <div className="mt-2 space-y-1 font-mono text-[11px]">
              <p className="text-sm" style={{ color: KIND_COLOR[hovered.kind] }}>
                {hovered.label}
              </p>
              <p className="text-zinc-500">kind: {hovered.kind}</p>
              <p className="text-zinc-400">{hovered.detail ?? '—'}</p>
              <p className="break-all text-zinc-600">{hovered.id}</p>
            </div>
          ) : (
            <p className="mt-2 font-mono text-[11px] text-zinc-600">hover or focus a node to inspect why it happened</p>
          )}
          <div className="mt-4 space-y-1 font-mono text-[10px] text-zinc-600">
            <p>· decision — weighted scheduler choice</p>
            <p>· task — DAG action</p>
            <p>· failure — rc≠0 terminal</p>
            <p>· cache — CAS hit skip</p>
            <p>· policy — node load/temp state</p>
            <p>· stamp — BTC verification</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Debugger tab ────────────────────────────────────────────────────────────

function DebuggerTab({
  stream,
  builds,
  buildId,
  onPick,
  onGoToDag,
}: {
  stream: FesterStream
  builds: BuildRow[]
  /** effective build to debug — derived by the shell (keeps the WS
   *  subscription in sync with what this tab is debugging) */
  buildId: string | null
  onPick: (id: string) => void
  onGoToDag: () => void
}) {
  const running = builds.filter((b) => b.state === 'running' || b.state === 'queued')

  const dbg = usePoll(
    async () => {
      if (!buildId) return null
      const res = await festerApi<{ debugger: { paused?: boolean; step_mode?: boolean; state?: string; actions?: number } }>(
        `/api/debugger/${encodeURIComponent(buildId)}`,
      )
      return res.ok ? (res.data?.debugger ?? null) : null
    },
    [buildId],
    2000,
    buildId != null,
  )

  const detail = useBuildDetail(buildId, 2000)

  const cmd = (command: 'pause' | 'resume' | 'step') => {
    if (!buildId) return
    const sent = stream.sendDebugger(buildId, command)
    if (sent) toast.info(`debugger: ${command} → ${buildId}`)
    else toast.error('not connected — WS is offline')
  }

  // derived per flush — cheap filter over the ≤2000-event buffer (no memo:
  // buildId is a derived value the compiler cannot treat as a stable dep)
  const log = stream.events
    .filter((e) => (e.type === 'debugger-ack' || e.type === 'debug') && (e.build_id ?? e.buildId) === buildId)
    .slice(-60)

  const actions = detail?.actions ?? []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        {running.length > 0 ? (
          <Select value={buildId ?? ''} onValueChange={onPick}>
            <SelectTrigger className="h-8 w-[280px] max-w-full border-zinc-700 bg-zinc-950 font-mono text-xs" aria-label="Debug build">
              <SelectValue placeholder="running build" />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200" style={TERMINAL_VARS}>
              {running.map((b) => (
                <SelectItem key={b.build_id} value={b.build_id} className="font-mono text-xs">
                  ● {b.build_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-mono text-[11px] text-zinc-500">no running build</span>
        )}
        {buildId ? (
          <>
            <FBadge state={dbg?.paused ? 'paused' : (dbg?.state ?? 'running')} />
            <span className="font-mono text-[10px] text-zinc-600">
              step_mode {dbg?.step_mode ? 'on' : 'off'} · {dbg?.actions ?? '—'} actions
            </span>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            disabled={!buildId}
            onClick={() => cmd('pause')}
            className="h-7 bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
          >
            ⏸ pause
          </Button>
          <Button
            size="sm"
            disabled={!buildId}
            onClick={() => cmd('resume')}
            className="h-7 bg-emerald-600 font-mono text-[11px] text-zinc-100 hover:bg-emerald-500"
          >
            ▶ resume
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!buildId}
            onClick={() => cmd('step')}
            className="h-7 border-zinc-700 bg-transparent font-mono text-[11px] text-zinc-200 hover:bg-zinc-800"
          >
            ⏭ step
          </Button>
        </div>
      </div>

      {running.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-sm rounded border border-zinc-800 bg-zinc-900/70 p-6 text-center">
            <p className="font-mono text-sm text-zinc-300">no running build to debug</p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">
              the debugger gates the engine between actions — pause, step one action at a time, then resume
            </p>
            <Button
              size="sm"
              onClick={onGoToDag}
              className="mt-4 bg-amber-500 font-mono text-[11px] text-zinc-950 hover:bg-amber-400"
            >
              → start one from Live DAG
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-0 overflow-auto p-3 sd-scroll">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">live action grid</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
              {actions.map((a) => {
                const color = stateColor(a.state)
                return (
                  <div key={a.name} className="rounded border px-2 py-1.5" style={{ borderColor: color, background: `${color}10` }}>
                    <p className="truncate font-mono text-[11px]" style={{ color }}>
                      {shortAction(a.name)}
                    </p>
                    <p className="truncate font-mono text-[9px] text-zinc-500">
                      {a.state} {a.node ? `@ ${a.node}` : ''}
                    </p>
                  </div>
                )
              })}
              {actions.length === 0 ? <p className="font-mono text-[11px] text-zinc-600">loading actions…</p> : null}
            </div>
          </div>
          <div className="flex min-h-0 flex-col border-t border-zinc-800 lg:border-l lg:border-t-0">
            <p className="px-3 pt-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500">debug events</p>
            <div className="min-h-0 flex-1">
              <EventLog events={log} maxRows={80} ariaLabel="Debugger event log" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Metrics tab ─────────────────────────────────────────────────────────────

function MetricsTab({ metrics }: { metrics: FesterMetrics | null }) {
  const mb = metrics?.builds ?? {}
  const ma = metrics?.actions ?? {}
  const util = metrics?.utilization ?? []
  const nodes = metrics?.nodes ?? []
  const donePct = ma.total ? ((ma.done ?? 0) / ma.total) * 100 : 0
  const failedPct = ma.total ? ((ma.failed ?? 0) / ma.total) * 100 : 0

  return (
    <div className="h-full overflow-auto p-3 sd-scroll">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="builds" value={mb.total ?? '—'} />
        <StatCard label="running" value={mb.running ?? 0} tone="warn" />
        <StatCard label="succeeded" value={mb.succeeded ?? 0} tone="good" />
        <StatCard label="failed" value={mb.failed ?? 0} tone="bad" />
        <StatCard label="cancelled" value={mb.cancelled ?? 0} />
        <StatCard label="cache hit" value={ma.cache_hit_rate ?? '—'} unit="%" hint={`${ma.cache_hits ?? 0} of ${ma.total ?? 0} actions`} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-900/40">
          <CardHeader className="border-b border-zinc-800 py-2.5">
            <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">action totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 p-3">
            <div className="flex h-2.5 overflow-hidden rounded-sm bg-zinc-800">
              <div className="h-full bg-emerald-500" style={{ width: `${donePct}%` }} />
              <div className="h-full bg-red-500" style={{ width: `${failedPct}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
              <span className="text-emerald-400">done {ma.done ?? 0}</span>
              <span className="text-red-500">failed {ma.failed ?? 0}</span>
              <span className="text-zinc-400">total {ma.total ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-900/40">
          <CardHeader className="border-b border-zinc-800 py-2.5">
            <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">per-node utilization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 p-3">
            {util.map((u) => (
              <div key={u.node} className="flex items-center gap-3 font-mono text-[11px]">
                <span className="w-24 shrink-0 truncate text-zinc-300">{u.node}</span>
                <HeatBar pct={u.pct} color={heatColor(u.pct)} height={8} />
                <span className="w-10 shrink-0 text-right tabular-nums text-zinc-400">{u.pct.toFixed(0)}%</span>
              </div>
            ))}
            {util.length === 0 ? <p className="font-mono text-[11px] text-zinc-600">no utilization data</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-3 border-zinc-800 bg-zinc-900/40">
        <CardHeader className="border-b border-zinc-800 py-2.5">
          <CardTitle className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">cluster nodes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full font-mono text-[11px]">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="px-3 py-1.5 font-medium">node</th>
                <th className="px-3 py-1.5 font-medium">state</th>
                <th className="px-3 py-1.5 font-medium">cpu</th>
                <th className="px-3 py-1.5 font-medium">temp</th>
                <th className="px-3 py-1.5 font-medium">jobs</th>
                <th className="px-3 py-1.5 font-medium">cpu bar</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.name} className="border-t border-zinc-800/60">
                  <td className="px-3 py-1.5 text-zinc-200">{n.name}</td>
                  <td className="px-3 py-1.5">
                    <FBadge state={n.state} />
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-400">{Math.round(n.cpu_load ?? 0)}%</td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-400">{Math.round(n.temp ?? 0)}°</td>
                  <td className="px-3 py-1.5 tabular-nums text-zinc-400">
                    {n.active_jobs ?? 0}/{n.max_jobs ?? '?'}
                  </td>
                  <td className="w-40 px-3 py-1.5">
                    <HeatBar pct={n.cpu_load ?? 0} color={heatColor(n.cpu_load ?? 0)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

// ── the sub-app shell ───────────────────────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: 'dashboard', label: 'dashboard' },
  { id: 'dag', label: 'live dag' },
  { id: 'replay', label: 'replay' },
  { id: 'sessions', label: 'sessions' },
  { id: 'timeline', label: 'timeline' },
  { id: 'cause', label: 'cause graph' },
  { id: 'debugger', label: 'debugger' },
  { id: 'metrics', label: 'metrics' },
]

function FesterApp() {
  const stream = useFesterStream()
  const [tab, setTab] = useState<TabId>('dashboard')
  const [manualPick, setManualPick] = useState<string | null>(null)
  const [debugPick, setDebugPick] = useState<string | null>(null)
  const [openStart, setOpenStart] = useState(false)

  // REST polls (through the server-side proxy only)
  const buildsData = usePoll(
    async () => {
      const res = await festerApi<{ builds: BuildRow[]; history: BuildRow[] }>('/api/builds')
      return res.ok
        ? { builds: (res.data?.builds ?? []).map(normalizeRow), history: (res.data?.history ?? []).map(normalizeRow) }
        : null
    },
    [],
    5000,
  )
  const metrics = usePoll(
    async () => {
      const res = await festerApi<FesterMetrics>('/api/metrics')
      return res.ok ? (res.data ?? null) : null
    },
    [],
    5000,
  )
  const health = usePoll(
    async () => {
      const res = await festerApi<{ version?: string; nodes?: number; uptime_s?: number }>('/api/health')
      return res.ok ? res.data : null
    },
    [],
    8000,
  )
  const projectsData = usePoll(
    async () => {
      const res = await festerApi<{ projects: FesterProject[] }>('/api/targets')
      return res.ok ? (res.data?.projects ?? []) : []
    },
    [],
    60000,
  )

  // seed + periodically refresh node states from REST (WS keeps them live)
  const nodesLoadedRef = useRef(false)
  useEffect(() => {
    const load = async () => {
      const res = await festerApi<{ nodes: FesterNode[] }>('/api/nodes')
      if (res.ok && res.data?.nodes) stream.seedNodes(res.data.nodes)
    }
    if (!nodesLoadedRef.current) {
      nodesLoadedRef.current = true
      void load()
    }
    const t = window.setInterval(load, 15000)
    return () => window.clearInterval(t)
  }, [stream.seedNodes])

  // builds known from the WS stream — instant detection of new/running
  // builds (the REST poll lags up to 5s); buffer order means the latest
  // pipeline_update per build wins
  const wsBuilds = useMemo(() => {
    const m = new Map<string, BuildRow>()
    for (const e of stream.events) {
      if (e.type !== 'pipeline_update' || !e.build_id) continue
      const prev = m.get(e.build_id)
      m.set(e.build_id, {
        build_id: e.build_id,
        project: (e.target as string) ?? prev?.project,
        targets: Array.isArray(e.meta?.targets) ? (e.meta?.targets as string[]) : (prev?.targets ?? []),
        state: (e.state as string) ?? 'queued',
        started_at: prev?.started_at ?? evTs(e),
      })
    }
    return m
  }, [stream.events])

  const allBuilds = useMemo(() => {
    const live = buildsData?.builds ?? []
    const history = buildsData?.history ?? []
    const seen = new Set<string>()
    const merged: BuildRow[] = []
    for (const b of [...live, ...history]) {
      if (seen.has(b.build_id)) continue
      seen.add(b.build_id)
      merged.push(b)
    }
    // overlay fresher WS-known states onto the REST rows
    for (let i = 0; i < merged.length; i++) {
      const ws = wsBuilds.get(merged[i].build_id)
      if (ws) merged[i] = { ...merged[i], state: ws.state }
    }
    // running builds the REST poll has not seen yet
    for (const [id, row] of wsBuilds) {
      if (seen.has(id)) continue
      if (row.state === 'running' || row.state === 'queued') {
        seen.add(id)
        merged.push(row)
      }
    }
    merged.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    return merged
  }, [buildsData, wsBuilds])

  // auto-pick: newest running build, else newest build — derived, so it
  // tracks every builds refresh; a manual pick always wins
  const autoTarget = allBuilds.find((b) => b.state === 'running' || b.state === 'queued') ?? allBuilds[0]
  const selectedBuildId = manualPick ?? autoTarget?.build_id ?? null

  const selectBuild = useCallback((id: string) => {
    setManualPick(id)
  }, [])

  // debugger: its own effective build — the pick sticks while that build is
  // still running, otherwise the globally selected build, then the first
  // running one (kept here so the WS subscription below follows it exactly)
  const runningBuilds = allBuilds.filter((b) => b.state === 'running' || b.state === 'queued')
  const debuggerBuildId =
    debugPick != null && runningBuilds.some((b) => b.build_id === debugPick)
      ? debugPick
      : runningBuilds.length > 0
        ? (runningBuilds.find((b) => b.build_id === selectedBuildId) ?? runningBuilds[0]).build_id
        : null

  // subscribe to the focused build while a build-centric tab is active
  const focusBuildId = tab === 'debugger' ? debuggerBuildId : tab === 'dag' ? selectedBuildId : null
  useEffect(() => {
    stream.setSubscription(focusBuildId)
  }, [focusBuildId, stream.setSubscription])

  const gotoBuild = useCallback(
    (id: string) => {
      selectBuild(id)
      setTab('dag')
    },
    [selectBuild],
  )

  const pillCls =
    stream.status === 'online'
      ? 'border-emerald-500/40 text-emerald-400'
      : stream.status === 'connecting'
        ? 'border-amber-500/40 text-amber-400'
        : 'border-red-500/40 text-red-400'
  const dotCls =
    stream.status === 'online' ? 'bg-emerald-500' : stream.status === 'connecting' ? 'bg-amber-500 sd-live-dot' : 'bg-red-500'

  return (
    <div
      // bleed into the whole panel area (negative of the shell's main padding)
      className="-mx-4 -my-5 flex h-[calc(100vh-5.5rem)] min-h-[540px] flex-col overflow-hidden bg-zinc-950 text-zinc-200 sm:-mx-6"
      style={TERMINAL_VARS}
    >
      {/* sub-app top bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-amber-500 font-mono text-[13px] font-black text-zinc-950">
            F
          </span>
          <div>
            <p className="font-mono text-sm font-bold tracking-[0.35em] text-amber-400">FESTER</p>
            <p className="font-mono text-[10px] text-zinc-500">distributed DAG build orchestration</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400" title="Fester license">
            AGPL-3.0
          </span>
          {health ? (
            <span className="hidden items-center gap-1.5 sm:flex">
              <span className="text-emerald-400">●</span> v{health.version} · {health.nodes} nodes · up {fmtUp(health.uptime_s)}
            </span>
          ) : (
            <span className="hidden items-center gap-1.5 sm:flex">
              <span className="text-red-400">●</span> service unreachable
            </span>
          )}
          <span
            role="status"
            aria-label={`Fester WebSocket connection: ${stream.status}`}
            title={`WebSocket ${stream.status}${stream.subscribed ? ` · subscribed to ${stream.subscribed}` : ''}`}
            className={cn('flex items-center gap-1.5 rounded border px-2 py-0.5 uppercase tracking-wider', pillCls)}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', dotCls)} aria-hidden />
            ws {stream.status}
          </span>
        </div>
      </div>

      {/* tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="h-10 w-full shrink-0 justify-start gap-0.5 overflow-x-auto rounded-none border-b border-zinc-800 bg-zinc-900/50 p-1">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="shrink-0 rounded-sm px-3 font-mono text-[11px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 data-[state=active]:bg-zinc-800 data-[state=active]:text-amber-400"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="dashboard" className="mt-0 min-h-0 flex-1">
          <DashboardTab
            stream={stream}
            live={allBuilds}
            history={[]}
            metrics={metrics}
            onGoToBuild={gotoBuild}
            onStartBuild={() => setOpenStart(true)}
          />
        </TabsContent>

        <TabsContent value="dag" className="mt-0 min-h-0 flex-1">
          <DagTab
            stream={stream}
            builds={allBuilds}
            selectedBuildId={selectedBuildId}
            selectBuild={selectBuild}
            projects={projectsData ?? []}
            openStart={openStart}
            setOpenStart={setOpenStart}
          />
        </TabsContent>

        <TabsContent value="replay" className="mt-0 min-h-0 flex-1">
          <ReplayTab builds={allBuilds} selectedBuildId={selectedBuildId} />
        </TabsContent>

        <TabsContent value="sessions" className="mt-0 min-h-0 flex-1">
          <SessionsTab builds={allBuilds} onGoToBuild={gotoBuild} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-0 min-h-0 flex-1">
          <TimelineTab builds={allBuilds} selectedBuildId={selectedBuildId} />
        </TabsContent>

        <TabsContent value="cause" className="mt-0 min-h-0 flex-1">
          <CauseTab builds={allBuilds} selectedBuildId={selectedBuildId} selectBuild={selectBuild} />
        </TabsContent>

        <TabsContent value="debugger" className="mt-0 min-h-0 flex-1">
          <DebuggerTab
            stream={stream}
            builds={allBuilds}
            buildId={debuggerBuildId}
            onPick={setDebugPick}
            onGoToDag={() => setTab('dag')}
          />
        </TabsContent>

        <TabsContent value="metrics" className="mt-0 min-h-0 flex-1">
          <MetricsTab metrics={metrics} />
        </TabsContent>
      </Tabs>

      {/* shared start-build dialog (also reachable from dashboard) */}
      {tab !== 'dag' ? (
        <StartBuildDialog
          open={openStart}
          onOpenChange={setOpenStart}
          projects={projectsData ?? []}
          onStarted={(id) => {
            selectBuild(id)
            setTab('dag')
          }}
        />
      ) : null}
    </div>
  )
}

export default function FesterPanel() {
  return <FesterApp />
}
