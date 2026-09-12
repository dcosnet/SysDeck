// SysDeck bridge — fleet (node registry with real probes, all live)
// Port of bridge/fleet.py: the cockpit edition aggregates the local host
// (hostname/uptime/load) plus cockpit peer machines from
// /etc/cockpit/machines.d/*.json. The web edition does exactly that:
//   - the localhost entry is REAL (live /proc metrics each call)
//   - cockpit peers are discovered from /etc/cockpit/machines.d/*.json
//     when present (same source the cockpit edition reads)
//   - operator-added nodes live in the FleetNode table (never seeded);
//     each remote gets a REAL TCP reachability probe (port 22) with
//     measured latency on every poll — no fabricated metrics, no random
//     walk. Remote cpu/mem stay null (honest) unless a node runs an
//     agent the bridge can query.
// The python bridge's `peers` command maps to `nodes` here.
import os from 'os'
import { readFileSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail, cached } from './shared'
import { readdir, readFile } from 'fs/promises'
import net from 'net'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

// ── real localhost metrics (/proc) ───────────────────────────────────

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

// ── cockpit machines.d peers (real when present) ─────────────────────

interface MachinePeer {
  name: string
  host: string
}

async function cockpitPeers(): Promise<MachinePeer[]> {
  const out: MachinePeer[] = []
  for (const dir of ['/etc/cockpit/machines.d', '/etc/cockpit/machines.d.d']) {
    try {
      const entries = await readdir(dir)
      for (const e of entries) {
        if (!e.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(await readFile(`${dir}/${e}`, 'utf-8')) as Record<string, { visible?: boolean; address?: string }>
          for (const [name, cfg] of Object.entries(parsed)) {
            if (cfg?.visible === false) continue
            out.push({ name, host: cfg?.address ?? name })
          }
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
  return out
}

// ── real TCP reachability probe ──────────────────────────────────────

function tcpProbe(host: string, port = 22, timeoutMs = 1200): Promise<{ reachable: boolean; latencyMs: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = net.connect({ host, port })
    const done = (reachable: boolean) => {
      const latencyMs = reachable ? Date.now() - t0 : null
      sock.removeAllListeners()
      sock.destroy()
      resolve({ reachable, latencyMs })
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// ── localhost row (real) ─────────────────────────────────────────────

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

async function ensureLocalNode(): Promise<void> {
  const local = await db.fleetNode.findFirst({ where: { local: true } })
  if (local) return
  const cpus = os.cpus()
  await db.fleetNode.create({
    data: {
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
  })
}

/** One-shot registry migration: rows imported from the pre-0.4.2
 *  catalogs (helios/theia/selene/ares) are not operator entries — the
 *  registry admits only nodes added from this panel or discovered from
 *  cockpit machines.d. Runs once per process. */
let migrationDone = false
async function purgeLegacyCatalogRows(): Promise<void> {
  if (migrationDone) return
  migrationDone = true
  const legacyNames = ['helios-01', 'helios-02', 'theia', 'selene', 'ares']
  try {
    await db.fleetNode.deleteMany({ where: { name: { in: legacyNames }, local: false } })
  } catch {
    /* best effort */
  }
}

/** Node inventory: registry rows + cockpit peers. Every remote gets
 *  its own TCP probe and the probes run in parallel (wall time = one
 *  probe timeout, not N × it); the whole inventory is TTL-cached so the
 *  5 s poll does not re-open sockets per tick. Remote cpu/mem stay
 *  null without an agent on the node — never fabricated. */
async function nodesWithMetrics(): Promise<
  (FleetRow & { metrics: { cpuPct: number; memPct: number; load1: number } | null; latencyMs: number | null; source: string })[]
> {
  return cached('fleet:nodes', 10_000, async () => {
    await ensureLocalNode()
    await purgeLegacyCatalogRows()
    const rows = (await db.fleetNode.findMany({ orderBy: { name: 'asc' } })) as FleetRow[]
    const cpu = cpuPct()
    const mem = memPct()
    const l = load()
    const remotes = rows.filter((r) => !r.local)
    const probes = await Promise.all(remotes.map((r) => tcpProbe(r.host)))
    const out: (FleetRow & { metrics: { cpuPct: number; memPct: number; load1: number } | null; latencyMs: number | null; source: string })[] = []
    for (const r of rows) {
      if (r.local) {
        out.push({ ...r, state: 'online', metrics: { cpuPct: cpu, memPct: mem, load1: l[0] ?? 0 }, latencyMs: 0, source: '/proc' })
        continue
      }
      const probe = probes[remotes.indexOf(r)]!
      out.push({
        ...r,
        state: probe.reachable ? 'online' : 'offline',
        metrics: null,
        latencyMs: probe.latencyMs,
        source: 'tcp-probe :22',
      })
    }
    // cockpit peers (real discovery) — surfaced alongside the registry
    const peers = await cockpitPeers()
    const knownHosts = new Set(out.map((n) => n.host))
    const newPeers = peers.filter((p) => !knownHosts.has(p.host))
    const peerProbes = await Promise.all(newPeers.map((p) => tcpProbe(p.host)))
    newPeers.forEach((p, i) => {
      const probe = peerProbes[i]!
      out.push({
        id: `cockpit:${p.name}`,
        name: p.name,
        host: p.host,
        role: 'cockpit-peer',
        arch: 'unknown',
        state: probe.reachable ? 'online' : 'offline',
        cpuModel: null,
        cores: 0,
        memGb: 0,
        local: false,
        metrics: null,
        latencyMs: probe.latencyMs,
        source: 'cockpit machines.d',
      })
    })
    return out
  })
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
          degraded: 0,
          offline: fleetNodes.filter((n) => n.state === 'offline').length,
        },
      },
      'live',
      'localhost metrics from /proc; remote nodes probed with real TCP connects (port 22) — remote cpu/mem stay null without an agent (nothing fabricated)',
    )
  },

  nodes: async () => ok({ nodes: await nodesWithMetrics() }, 'live', 'real /proc for localhost + real TCP probes for remotes'),

  addNode: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    const host = String(args.host ?? '').trim()
    if (!name || !host) return failE('name and host are required')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return failE('invalid node name')
    const role = ['compute', 'storage', 'edge', 'control'].includes(String(args.role))
      ? String(args.role)
      : 'compute'
    // real probe right away so the node lands with its true state
    const probe = await tcpProbe(host)
    try {
      const row = await db.fleetNode.create({
        data: {
          name,
          host,
          role,
          arch: String(args.arch ?? 'x86_64'),
          state: probe.reachable ? 'online' : 'offline',
          cores: Math.max(1, Math.min(1024, Number(args.cores) || 4)),
          memGb: Math.max(1, Math.min(4096, Number(args.memGb) || 8)),
          local: false,
        },
      })
      await db.auditLog.create({
        data: { module: 'fleet', action: 'addNode', detail: `${name} (${host}) role=${role} — TCP probe ${probe.reachable ? `reachable ${probe.latencyMs}ms` : 'unreachable'}` },
      })
      return ok(
        { node: row, reachable: probe.reachable, latencyMs: probe.latencyMs },
        'live',
        `real TCP probe of ${host}:22 → ${probe.reachable ? `reachable (${probe.latencyMs}ms)` : 'unreachable'}`,
      )
    } catch (err) {
      return failE(`could not create node: ${err instanceof Error ? err.message : String(err)}`)
    }
  },

  removeNode: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return fail('id is required')
    if (id.startsWith('cockpit:')) return failE('cockpit peers come from /etc/cockpit/machines.d — remove them there')
    try {
      const row = await db.fleetNode.delete({ where: { id } })
      await db.auditLog.create({
        data: { module: 'fleet', action: 'removeNode', detail: row.name },
      })
      return ok({ removed: row.name }, 'live')
    } catch {
      return failE('node not found')
    }
  },
}
