// SysDeck bridge — monitoring (Prometheus + Grafana probes + native ring)
// Port of bridge/prometheus.py + bridge/grafana.py: the cockpit edition
// talked to Prometheus's HTTP API (moved to port 9095 because cockpit-ws
// owns 9090) and Grafana's admin API on 3000. Neither service runs in
// this container, so the probes honestly report installed:false with
// the install hint — EXCEPT the Grafana probe, which hits
// 127.0.0.1:3000/api/health where THIS Next.js app answers; a real
// Grafana identifies itself there with JSON "database"/"version" keys,
// our app does not, so the probe reports the responder it found.
// nativeMetrics is a REAL ring buffer (own /proc parsing, no overview
// imports): cpu/mem pct + per-interval net rates, last 120 samples.
import { readFileSync } from 'fs'
import {} from 'net'
import { ok } from './shared'

// ── real /proc collectors (module-local, no overview internals) ───────

interface CpuSnap {
  idle: number
  total: number
}

const cpuState = { prev: null as CpuSnap | null, value: 0 }

function cpuPct(): number {
  try {
    const line = readFileSync('/proc/stat', 'utf-8').split('\n')[0] ?? ''
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts
    const snap: CpuSnap = {
      idle: idle + iowait,
      total: user + nice + sys + idle + iowait + irq + softirq + steal,
    }
    if (cpuState.prev && snap.total > cpuState.prev.total) {
      const dT = snap.total - cpuState.prev.total
      const dI = snap.idle - cpuState.prev.idle
      cpuState.value = Math.max(0, Math.min(100, (1 - dI / dT) * 100))
    }
    cpuState.prev = snap
  } catch {
    /* degrade */
  }
  return Math.round(cpuState.value * 10) / 10
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

function netBytes(): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  try {
    const txt = readFileSync('/proc/net/dev', 'utf-8')
    for (const line of txt.split('\n').slice(2)) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      if (line.slice(0, idx).trim() === 'lo') continue
      const cols = line.slice(idx + 1).trim().split(/\s+/).map(Number)
      rx += cols[0] ?? 0
      tx += cols[8] ?? 0
    }
  } catch {
    /* degrade */
  }
  return { rx, tx }
}

// ── native metrics ring buffer (last 120 samples) ─────────────────────

export interface NativeSample {
  t: number // epoch seconds
  cpuPct: number
  memPct: number
  netRxKb: number // KB/s since previous sample (0 on the first)
  netTxKb: number
}

const nativeState = {
  samples: [] as NativeSample[],
  prevNet: null as { rx: number; tx: number; t: number } | null,
}

function pushNativeSample(): NativeSample {
  const now = Date.now()
  const cpu = cpuPct()
  const mem = memPct()
  const cur = netBytes()
  let rxKb = 0
  let txKb = 0
  if (nativeState.prevNet) {
    const elapsedS = Math.max(0.5, (now - nativeState.prevNet.t) / 1000)
    rxKb = Math.max(0, Math.round((cur.rx - nativeState.prevNet.rx) / 1024 / elapsedS))
    txKb = Math.max(0, Math.round((cur.tx - nativeState.prevNet.tx) / 1024 / elapsedS))
  }
  nativeState.prevNet = { rx: cur.rx, tx: cur.tx, t: now }
  const sample: NativeSample = {
    t: Math.round(now / 1000),
    cpuPct: cpu,
    memPct: mem,
    netRxKb: rxKb,
    netTxKb: txKb,
  }
  nativeState.samples.push(sample)
  while (nativeState.samples.length > 120) nativeState.samples.shift()
  return sample
}

// ── service probes ────────────────────────────────────────────────────

const PROM_HEALTH_URL = 'http://127.0.0.1:9095/-/healthy'
const GRAFANA_HEALTH_URL = 'http://127.0.0.1:3000/api/health'

interface PromSummary {
  installed: boolean
  url: string
  hint?: string
}

async function prometheusSummaryData(): Promise<PromSummary> {
  try {
    const res = await fetch(PROM_HEALTH_URL, { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      return { installed: true, url: PROM_HEALTH_URL }
    }
  } catch {
    /* connection refused — the honest answer below */
  }
  return {
    installed: false,
    url: PROM_HEALTH_URL,
    hint: 'cockpit-ws owns port 9090 — run Prometheus on 9095 (PROM_API_URL=http://localhost:9095)',
  }
}

interface GrafanaSummary {
  installed: boolean
  url: string
  responder?: string
}

async function grafanaSummaryData(): Promise<GrafanaSummary> {
  try {
    const res = await fetch(GRAFANA_HEALTH_URL, { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (body && ('database' in body || 'version' in body)) {
        return {
          installed: true,
          url: GRAFANA_HEALTH_URL,
          responder: `Grafana ${String(body['version'] ?? '')}`.trim(),
        }
      }
      // Something answers on 3000 but it is not Grafana — here that is
      // the SysDeck Next.js app itself.
      return {
        installed: false,
        url: GRAFANA_HEALTH_URL,
        responder: `HTTP ${res.status} from 127.0.0.1:3000/api/health — a web app answers, but the JSON has no Grafana database/version keys: this is the SysDeck web edition itself, not Grafana`,
      }
    }
    return {
      installed: false,
      url: GRAFANA_HEALTH_URL,
      responder: `HTTP ${res.status} from 127.0.0.1:3000/api/health — port 3000 is owned by the SysDeck web edition, not Grafana`,
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    return {
      installed: false,
      url: GRAFANA_HEALTH_URL,
      responder: timedOut
        ? 'no response within the 1.5s probe timeout on port 3000'
        : 'connection refused — nothing answered on port 3000',
    }
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  prometheusSummary: async () =>
    ok(await prometheusSummaryData(), 'live', 'real 1.5s probe of 127.0.0.1:9095/-/healthy'),

  grafanaSummary: async () =>
    ok(await grafanaSummaryData(), 'live', 'real 1.5s probe of 127.0.0.1:3000/api/health — Grafana is detected by its JSON database/version keys'),

  nativeMetrics: async () => {
    pushNativeSample()
    return ok(
      {
        samples: [...nativeState.samples],
        count: nativeState.samples.length,
        max: 120,
      },
      'live',
      'ring buffer — one real /proc sample per call (cpu/mem pct + net KB/s since previous sample)',
    )
  },

  summary: async () => {
    const [prometheus, grafana] = await Promise.all([prometheusSummaryData(), grafanaSummaryData()])
    pushNativeSample()
    return ok(
      {
        prometheus,
        grafana,
        native: { available: true, samples: nativeState.samples.length, max: 120 },
      },
      'live',
      'native metrics are always available (real /proc ring buffer); Prometheus/Grafana are live probes',
    )
  },
}
