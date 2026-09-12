// SysDeck bridge — mining (real XMRig daemon bridge, all live)
// Port of bridge/mining.py semantics: the cockpit edition talked to the
// local XMRig daemon's HTTP API (/1/summary: live hashrate, pool,
// threads; /1/config for pool-config-set) and the xmrig.service state.
// The web edition does exactly that: the daemon is probed at
// SYSDECK_XMRIG_URL (default http://127.0.0.1:18088) with a short
// timeout, per-thread hashrates map the rig's compute units, GPU
// temperature/fan/power come from nvidia-smi when a GPU is present, and
// start/stop run the real `systemctl start/stop xmrig` (privilege-gated
// like every other mutation). No daemon → honest "not detected" — never
// a seeded rig fleet.
import { ok, fail, run, which, cached, invalidateCache } from './shared'
import { db } from '@/lib/db'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'mining', action, detail } })
}

const XMRIG_URL = process.env.SYSDECK_XMRIG_URL ?? 'http://127.0.0.1:18088'
const HINT = `no XMRig daemon answered at ${XMRIG_URL} — start one with --http-host 127.0.0.1 --http-port 18088 (or point SYSDECK_XMRIG_URL at it)`

interface XmrThread {
  hashrate: number | null
}

interface XmrSummary {
  id?: string
  worker_id?: string
  version?: string
  ua?: string
  paused?: boolean
  cpu?: { brand?: string; aes?: boolean; threads?: number }
  hashrate?: {
    total?: (number | null)[]
    highest?: (number | null)[]
    threads?: XmrThread[][]
  }
  results?: { dispatched?: number; accepted?: number; rejected?: number }
  connection?: { pool?: string; uptime?: number; error?: string }
}

async function httpGet(path: string, timeoutMs = 3000): Promise<unknown | null> {
  try {
    const res = await fetch(`${XMRIG_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function serviceState(): Promise<string> {
  const r = await run('systemctl', ['is-active', 'xmrig.service'], 5000)
  return r.rc === 0 ? r.stdout.trim() : 'inactive'
}

// ── nvidia-smi live GPU telemetry (when a GPU exists) ────────────────

interface GpuTele {
  index: string
  name: string
  tempC: number
  fanPct: number
  powerW: number
}

async function gpuTelemetry(): Promise<GpuTele[]> {
  if (!(await which('nvidia-smi'))) return []
  const r = await run(
    'nvidia-smi',
    ['--query-gpu=index,name,temperature.gpu,fan.speed,power.draw', '--format=csv,noheader,nounits'],
    10_000,
  )
  if (r.rc !== 0) return []
  const out: GpuTele[] = []
  for (const line of r.stdout.split('\n')) {
    const cols = line.split(',').map((c) => c.trim())
    if (cols.length < 5) continue
    out.push({
      index: cols[0],
      name: cols[1],
      tempC: Number(cols[2]) || 0,
      fanPct: Number(cols[3]) || 0,
      powerW: Number(cols[4]) || 0,
    })
  }
  return out
}

// ── rig assembly (real data only) ────────────────────────────────────

/** One rig probe (XMRig HTTP + nvidia-smi + unit state), TTL-cached and
 *  single-flight: the summary and refresh polls share one sweep, and
 *  start/stop invalidate so the next read reflects the daemon. */
async function buildRig(): Promise<null | {
  rig: {
    id: string
    name: string
    host: string
    coins: string
    status: 'online' | 'idle' | 'offline'
    hashrate: number
    powerW: number
    tempC: number
    pool: string
    updatedAt: string
    gpus: { id: string; model: string; hashrate: number; tempC: number; fanPct: number }[]
  }
  summary: XmrSummary
  service: string
}> {
  return cached('mining:rig', 3_000, async () => {
  const summary = (await httpGet('/1/summary')) as XmrSummary | null
  if (!summary) return null
  const gpus = await gpuTelemetry()
  const threads = summary.hashrate?.threads ?? []
  const totalHs = summary.hashrate?.total?.[0] ?? 0
  const paused = summary.paused === true
  const pool = summary.connection?.pool ?? ''

  // per-thread hashrates joined with GPU telemetry by device order
  const flat: { hashrate: number }[] = []
  for (const t of threads) {
    for (const th of t ?? []) flat.push({ hashrate: th.hashrate ?? 0 })
  }
  const units = gpus.length
    ? gpus.map((g, i) => ({
        id: `gpu-${g.index}`,
        model: g.name,
        hashrate: flat[i]?.hashrate ?? 0,
        tempC: g.tempC,
        fanPct: g.fanPct,
      }))
    : // CPU mining: one unit per hardware thread group (real XMRig thread rows)
      flat.map((f, i) => ({
        id: `thread-${i}`,
        model: `thread ${i}`,
        hashrate: f.hashrate,
        tempC: 0,
        fanPct: 0,
      }))

  return {
    rig: {
      id: 'local',
      name: summary.worker_id || summary.id || 'xmrig@localhost',
      host: XMRIG_URL.replace(/^https?:\/\//, ''),
      coins: 'Monero (RandomX)',
      status: paused ? 'idle' : 'online',
      hashrate: totalHs ?? 0,
      powerW: gpus.reduce((acc, g) => acc + g.powerW, 0),
      tempC: gpus.length ? Math.max(...gpus.map((g) => g.tempC)) : 0,
      pool,
      updatedAt: new Date().toISOString(),
      gpus: units,
    },
    summary,
    service: await serviceState(),
  }
  })
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const data = await buildRig()
    if (!data) {
      const svc = await serviceState()
      return ok(
        { rigs: 0, online: 0, idle: 0, offline: 0, totalHashrate: 0, totalPower: 0, avgTemp: 0, service: svc },
        'live',
        HINT,
      )
    }
    const { rig, service } = data
    return ok(
      {
        rigs: 1,
        online: rig.status === 'online' ? 1 : 0,
        idle: rig.status === 'idle' ? 1 : 0,
        offline: 0,
        totalHashrate: rig.hashrate,
        totalPower: rig.powerW,
        avgTemp: rig.gpus.length ? Math.round(rig.gpus.reduce((a, g) => a + g.tempC, 0) / rig.gpus.length) : 0,
        service,
      },
      'live',
      `live probe of ${XMRIG_URL}/1/summary + nvidia-smi`,
    )
  },

  refresh: async () => {
    const data = await buildRig()
    if (!data) return ok({ rigs: [], count: 0 }, 'live', HINT)
    return ok({ rigs: [data.rig], count: 1 }, 'live', `live probe of ${XMRIG_URL}/1/summary`)
  },

  start: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const r = await run('systemctl', ['start', 'xmrig.service'], 30_000)
    await audit('start', `systemctl start xmrig.service → rc=${r.rc}`)
    if (r.rc === 0) invalidateCache('mining:rig') // next read reflects the running daemon
    if (r.rc !== 0) {
      return failE(`systemctl start xmrig failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit (org.sysdeck.services.manage)'}`)
    }
    return ok({ id, status: 'online', command: 'systemctl start xmrig.service' }, 'live')
  },

  stop: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const r = await run('systemctl', ['stop', 'xmrig.service'], 30_000)
    await audit('stop', `systemctl stop xmrig.service → rc=${r.rc}`)
    if (r.rc === 0) invalidateCache('mining:rig') // next read reflects the stopped daemon
    if (r.rc !== 0) {
      return failE(`systemctl stop xmrig failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit (org.sysdeck.services.manage)'}`)
    }
    return ok({ id, status: 'offline', command: 'systemctl stop xmrig.service' }, 'live')
  },

  poolConfig: async (args: Record<string, unknown>) => {
    // real PUT /1/config — the daemon applies it live (XMRig >= 6.x)
    const url = String(args.url ?? '').trim()
    if (!url || !/^[\w.+-]+:\d+/.test(url)) return failE('a pool url host:port is required')
    try {
      const res = await fetch(`${XMRIG_URL}/1/config/pool`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return failE(`XMRig rejected the pool config (HTTP ${res.status})`)
    } catch {
      return failE(`no XMRig daemon at ${XMRIG_URL} to configure`)
    }
    await audit('pool-config', `PUT /1/config/pool url=${url}`)
    return ok({ url }, 'live', 'daemon applied the new pool URL')
  },
}
