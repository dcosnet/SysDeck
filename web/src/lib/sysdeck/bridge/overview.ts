// SysDeck bridge — overview (landing host vitals)
// REAL collectors: /proc/stat, /proc/meminfo, /proc/loadavg, /proc/uptime,
// os.cpus, df, /proc/net/dev, /proc directory scan. No mock numbers here.
import os from 'os'
import { readFileSync, statfsSync, readdirSync } from 'fs'
import { ok, run, cached } from './shared'
import { readText } from './shared'
import type { HostTicker } from '../types'

/** /etc/os-release PRETTY_NAME — the display name of the running distro.
 *  Static for the host's lifetime; cached long. */
async function distroPretty(): Promise<string> {
  return cached('overview:distro', 3_600_000, async () => {
    const t = await readText('/etc/os-release')
    const m = t.match(/^PRETTY_NAME=?"?([^"\n]+)"?/m)
    return m?.[1] ?? os.type()
  })
}

/** Logged-in user sessions (utmp via `who`) — one row per session. */
async function loginSessions(): Promise<number> {
  const r = await run('who', [], 3000)
  if (r.rc !== 0) return 0
  return r.stdout.split('\n').filter((l) => l.trim().length > 0).length
}

interface CpuSnapshot {
  idle: number
  total: number
}

function parseCpuLine(line: string): CpuSnapshot {
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const user = parts[0] ?? 0
  const nice = parts[1] ?? 0
  const system = parts[2] ?? 0
  const idle = parts[3] ?? 0
  const iowait = parts[4] ?? 0
  const irq = parts[5] ?? 0
  const softirq = parts[6] ?? 0
  const steal = parts[7] ?? 0
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal }
}

const cpuCache = { prev: null as CpuSnapshot | null, value: 0 }

function cpuPct(): number {
  const stat = readFileSync('/proc/stat', 'utf-8') as string
  const line = stat.split('\n')[0] ?? ''
  const snap = parseCpuLine(line)
  if (cpuCache.prev) {
    const dTotal = snap.total - cpuCache.prev.total
    const dIdle = snap.idle - cpuCache.prev.idle
    if (dTotal > 0) cpuCache.value = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))
  }
  cpuCache.prev = snap
  return Math.round(cpuCache.value * 10) / 10
}

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {}
  const txt = readFileSync('/proc/meminfo', 'utf-8') as string
  for (const line of txt.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

function dfRoot(): { totalGb: number; usedGb: number; pct: number } {
  try {
    const stat = statfsSync('/') as { blocks: number; bsize: number; bavail: number; bfree: number }
    const total = stat.blocks * stat.bsize
    // bavail = available to unprivileged; bfree = free including reserved
    const avail = stat.bavail * stat.bsize
    const used = total - avail
    return {
      totalGb: Math.round((total / 1024 ** 3) * 10) / 10,
      usedGb: Math.round((used / 1024 ** 3) * 10) / 10,
      pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    }
  } catch {
    return { totalGb: 0, usedGb: 0, pct: 0 }
  }
}

function netDev(): { rxMb: number; txMb: number; ifaces: string[] } {
  const txt = readFileSync('/proc/net/dev', 'utf-8') as string
  let rx = 0
  let tx = 0
  const ifaces: string[] = []
  for (const line of txt.split('\n').slice(2)) {
    const [name, rest] = line.split(':')
    if (!rest) continue
    const cols = rest.trim().split(/\s+/).map(Number)
    const ifn = (name ?? '').trim()
    if (ifn === 'lo') continue
    ifaces.push(ifn)
    rx += cols[0] ?? 0
    tx += cols[8] ?? 0
  }
  return { rxMb: Math.round((rx / 1024 ** 2) * 10) / 10, txMb: Math.round((tx / 1024 ** 2) * 10) / 10, ifaces }
}

async function festerOnline(): Promise<boolean> {
  try {
    // server-to-server hop: mint the short-lived session cookie (fester
    // verifies the same HMAC token the web console issues)
    const { mintServerCookie } = await import('../session')
    const res = await fetch('http://127.0.0.1:3010/api/health', {
      headers: { Cookie: await mintServerCookie() },
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

export const commands = {
  ticker: async () => {
    const mi = meminfo()
    const totalMb = Math.round((mi['MemTotal'] ?? 0) / 1024)
    const availMb = Math.round((mi['MemAvailable'] ?? 0) / 1024)
    const load = (await readText('/proc/loadavg')).split(' ').map(Number)
    const uptimeS = Number((await readText('/proc/uptime')).split(' ')[0] ?? 0)
    let procs = 0
    try {
      procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length
    } catch {
      /* ignore */
    }
    const t: HostTicker = {
      hostname: os.hostname(),
      cpuPct: cpuPct(),
      memPct: totalMb > 0 ? Math.round(((totalMb - availMb) / totalMb) * 1000) / 10 : 0,
      memUsedMb: totalMb - availMb,
      memTotalMb: totalMb,
      load1: load[0] ?? 0,
      load5: load[1] ?? 0,
      load15: load[2] ?? 0,
      uptimeS: Math.round(uptimeS),
      procs,
      fester: (await festerOnline()) ? 'online' : 'offline',
    }
    return ok(t, 'live')
  },

  summary: async () => {
    const mi = meminfo()
    const cpus = os.cpus()
    const load = (await readText('/proc/loadavg')).split(' ').map(Number)
    const uptimeS = Number((await readText('/proc/uptime')).split(' ')[0] ?? 0)
    const disk = dfRoot()
    const net = netDev()
    const swapTotal = Math.round((mi['SwapTotal'] ?? 0) / 1024)
    const swapFree = Math.round((mi['SwapFree'] ?? 0) / 1024)
    return ok(
      {
        host: {
          hostname: os.hostname(),
          kernel: os.release(),
          arch: os.arch(),
          distro: await distroPretty(),
          cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
          cores: cpus.length,
          uptimeS: Math.round(uptimeS),
          bootUsers: await loginSessions(),
        },
        cpu: { pct: cpuPct(), load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0 },
        memory: {
          totalMb: Math.round((mi['MemTotal'] ?? 0) / 1024),
          usedMb: Math.round(((mi['MemTotal'] ?? 0) - (mi['MemAvailable'] ?? 0)) / 1024),
          cachedMb: Math.round((mi['Cached'] ?? 0) / 1024),
          swapTotalMb: swapTotal,
          swapUsedMb: swapTotal - swapFree,
        },
        disk: { ...disk, mount: '/' },
        network: { ...net },
        fester: (await festerOnline()) ? 'online' : 'offline',
      },
      'live',
    )
  },
}
