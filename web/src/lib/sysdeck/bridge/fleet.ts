// SysDeck bridge — fleet (node registry + live localhost host)
// Port of bridge/fleet.py: the cockpit edition aggregates the local host
// (hostname/uptime/load) plus cockpit peer machines from
// /etc/cockpit/machines.d/*.json. The web edition has no cockpit
// machines.d — instead the fleet lives in the FleetNode table: the
// localhost entry is REAL (live /proc metrics each call) and the
// demo datacenter nodes (helios/theia/selene/ares) drift via a
// module-level random walk so panels show plausible movement.
// The python bridge's `peers` command maps to `nodes` here.
import os from 'os'
import { readFileSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'hybrid') {
  return { ...fail(error), source }
}

interface CpuSnapshot {
  idle: number
  total: number
}

let cpuPrev: CpuSnapshot | null = null
let cpuValue = 0

function cpuPct(): number {
  try {
    const line = readFileSync('/proc/stat', 'utf-8').split('\n')[0] ?? ''
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts
    const snap: CpuSnapshot = { idle: idle + iowait, total: user + nice + sys + idle + iowait + irq + softirq + steal }
    if (cpuPrev && snap.total > cpuPrev.total) {
      const dTotal = snap.total - cpuPrev.total
      const dIdle = snap.idle - cpuPrev.idle
      cpuValue = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))
    }
    cpuPrev = snap
  } catch {
    /* degrade */
  }
  return Math.round(cpuValue * 10) / 10
}

function memPct(): number {
  try {
    const txt = readFileSync('/proc/meminfo', 'utf-8')
    const total = Number(txt.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0)
    const avail = Number(txt.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0)
    return total > 0 ? Math.round(((total - avail) / total) * 1000) / 10 : 0
  } catch {
    return 0
  }
}

function load(): number[] {
  try {
    return readFileSync('/proc/loadavg', 'utf-8')
      .split(' ')
      .slice(0, 3)
      .map(Number)
  } catch {
    return [0, 0, 0]
  }
}

function uptimeS(): number {
  try {
    return Math.round(Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]))
  } catch {
    return 0
  }
}

// ── demo node random walk (module state) ─────────────────────────────

interface NodeMetrics {
  cpuPct: number
  memPct: number
  load1: number
}

const demoState = new Map<string, NodeMetrics>()

function initDemoState(name: string): NodeMetrics {
  const seeds: Record<string, NodeMetrics> = {
    'helios-01': { cpuPct: 34, memPct: 61, load1: 5.4 },
    'helios-02': { cpuPct: 78, memPct: 83, load1: 12.7 },
    theia: { cpuPct: 12, memPct: 44, load1: 0.9 },
    ares: { cpuPct: 55, memPct: 72, load1: 17.2 },
  }
  return seeds[name] ?? { cpuPct: 20, memPct: 40, load1: 1 }
}

function walk(name: string, online: boolean): NodeMetrics | null {
  if (!online) return null
  let cur = demoState.get(name)
  if (!cur) {
    cur = initDemoState(name)
    demoState.set(name, cur)
  }
  const drift = (v: number, amp: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round((v + (Math.random() - 0.5) * amp) * 10) / 10))
  cur.cpuPct = drift(cur.cpuPct, 6, 2, 97)
  cur.memPct = drift(cur.memPct, 3, 15, 95)
  cur.load1 = drift(cur.load1, 1.2, 0.1, 32)
  return { ...cur }
}

// ── seeding ──────────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.fleetNode.count()
  if (count > 0) return
  const cpus = os.cpus()
  await db.fleetNode.createMany({
    data: [
      {
        name: os.hostname(),
        host: '127.0.0.1',
        role: 'control',
        arch: os.arch() === 'x64' ? 'x86_64' : os.arch(),
        state: 'online',
        cpuModel: cpus[0]?.model?.trim() ?? null,
        cores: cpus.length,
        memGb: Math.round(os.totalmem() / 1024 ** 3),
        local: true,
      },
      { name: 'helios-01', host: '192.168.10.11', role: 'compute', arch: 'x86_64', state: 'online', cores: 16, memGb: 64 },
      { name: 'helios-02', host: '192.168.10.12', role: 'compute', arch: 'x86_64', state: 'degraded', cores: 16, memGb: 64 },
      { name: 'theia', host: '192.168.10.20', role: 'storage', arch: 'x86_64', state: 'online', cores: 8, memGb: 32 },
      { name: 'selene', host: '192.168.10.30', role: 'edge', arch: 'arm64', state: 'offline', cores: 4, memGb: 8 },
      { name: 'ares', host: '192.168.10.40', role: 'compute', arch: 'x86_64', state: 'online', cores: 32, memGb: 128 },
    ],
  })
}

interface FleetRow {
  id: string
  name: string
  host: string
  role: string
  arch: string
  state: string
  cpuModel: string | null
  cores: number
  memGb: number
  local: boolean
}

async function nodesWithMetrics(): Promise<(FleetRow & { metrics: NodeMetrics | null })[]> {
  await ensureSeeded()
  const rows = (await db.fleetNode.findMany({ orderBy: { name: 'asc' } })) as FleetRow[]
  const cpu = cpuPct()
  const mem = memPct()
  const l = load()
  return rows.map((r) =>
    r.local
      ? { ...r, metrics: { cpuPct: cpu, memPct: mem, load1: l[0] ?? 0 } }
      : { ...r, metrics: walk(r.name, r.state !== 'offline') },
  )
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const fleetNodes = await nodesWithMetrics()
    const cpus = os.cpus()
    return ok(
      {
        uptimeS: uptimeS(),
        load: { 1: load()[0] ?? 0, 5: load()[1] ?? 0, 15: load()[2] ?? 0 },
        host: {
          hostname: os.hostname(),
          kernel: os.release(),
          arch: os.arch() === 'x64' ? 'x86_64' : os.arch(),
          cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
          cores: cpus.length,
          memGb: Math.round(os.totalmem() / 1024 ** 3),
        },
        fleetNodes,
        counts: {
          total: fleetNodes.length,
          online: fleetNodes.filter((n) => n.state === 'online').length,
          degraded: fleetNodes.filter((n) => n.state === 'degraded').length,
          offline: fleetNodes.filter((n) => n.state === 'offline').length,
        },
      },
      'hybrid',
      'localhost is live (/proc); helios/theia/selene/ares are seeded demo nodes with drifting metrics',
    )
  },

  nodes: async () => ok({ nodes: await nodesWithMetrics() }, 'hybrid'),

  drift: async () => {
    // Advance the demo random walk explicitly (summary does this
    // implicitly on every call) and return the resulting metrics.
    await ensureSeeded()
    const rows = (await db.fleetNode.findMany({ orderBy: { name: 'asc' } })) as FleetRow[]
    return ok(
      {
        drifted: rows
          .filter((r) => !r.local && r.state !== 'offline')
          .map((r) => ({ name: r.name, metrics: walk(r.name, true) })),
      },
      'demo',
      'random-walk state for demo fleet nodes',
    )
  },

  addNode: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    const host = String(args.host ?? '').trim()
    if (!name || !host) return failE('name and host are required')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return failE('invalid node name')
    const role = ['compute', 'storage', 'edge', 'control'].includes(String(args.role))
      ? String(args.role)
      : 'compute'
    try {
      const row = await db.fleetNode.create({
        data: {
          name,
          host,
          role,
          arch: String(args.arch ?? 'x86_64'),
          state: 'offline',
          cores: Math.max(1, Math.min(1024, Number(args.cores) || 4)),
          memGb: Math.max(1, Math.min(4096, Number(args.memGb) || 8)),
          local: false,
        },
      })
      await db.auditLog.create({
        data: { module: 'fleet', action: 'addNode', detail: `${name} (${host}) role=${role}` },
      })
      return ok({ node: row }, 'hybrid', 'node recorded; reachability requires the cockpit bridge on a managed host')
    } catch (err) {
      return failE(`could not create node: ${err instanceof Error ? err.message : String(err)}`)
    }
  },

  removeNode: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return fail('id is required')
    try {
      const row = await db.fleetNode.delete({ where: { id } })
      await db.auditLog.create({
        data: { module: 'fleet', action: 'removeNode', detail: row.name },
      })
      return ok({ removed: row.name }, 'hybrid')
    } catch {
      return failE('node not found')
    }
  },
}
