// SysDeck bridge — glances (live cross-domain system monitor)
// Port relationship: the cockpit edition's bridge/glances.py shells out to
// the Glances CLI (`glances --time 1 --export json --once`) for its
// snapshot. The web edition re-implements the same collectors natively
// from /proc + `df` so there is no Python/glances dependency:
//   /proc/stat     → cpu pct + per-core pct (deltas vs previous snapshot)
//   /proc/meminfo  → mem/swap totals (glances "used" = total-free-buffers-cached)
//   /proc/loadavg  → load 1/5/15
//   /proc/net/dev  → per-interface rx/tx bytes + rates (deltas, lo skipped)
//   df -kP         → per-mount disk usage (tmpfs/devtmpfs excluded)
//   /proc/*/stat   → top processes by cpu (utime+stime jiffies delta,
//                    rss field 24, comm, state; cmdline + uid enriched
//                    for the top rows only)
// The glances webserver management (start-web/stop-web/web-status) does
// not apply to the web edition; the panel gets the same data via
// summary/processes/history instead.
import os from 'os'
import { readFileSync, readdirSync } from 'fs'
import { run, ok, cached } from './shared'

const CLK_TCK = 100 // USER_HZ on Linux
const PAGE = 4096 // x86_64 page size (rss is reported in pages)

// ── snapshot state (module-level, survives across requests) ──────────

interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  iowait: number
  irq: number
  softirq: number
  steal: number
  total: number
}

interface IfaceBytes {
  rx: number
  tx: number
}

interface ProcJiffies {
  pid: number
  comm: string
  state: string
  utime: number
  stime: number
  rss: number
}

interface Sample {
  t: number
  cpu: CpuTimes
  cores: CpuTimes[]
  net: Record<string, IfaceBytes>
  procs: ProcJiffies[]
}

let prev: Sample | null = null
const history: { t: number; cpuPct: number; memPct: number }[] = []
// ── /proc parsers ────────────────────────────────────────────────────

function parseCpuLine(line: string): CpuTimes {
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts
  const total = user + nice + sys + idle + iowait + irq + softirq + steal
  return { user, nice, sys, idle, iowait, irq, softirq, steal, total }
}

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const txt = readFileSync('/proc/meminfo', 'utf-8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/)
      if (m) out[m[1]] = Number(m[2])
    }
  } catch {
    /* degrade to zeros */
  }
  return out
}

function netDev(): Record<string, IfaceBytes> {
  const out: Record<string, IfaceBytes> = {}
  try {
    const txt = readFileSync('/proc/net/dev', 'utf-8')
    for (const line of txt.split('\n').slice(2)) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const ifn = line.slice(0, idx).trim()
      if (!ifn || ifn === 'lo') continue
      const cols = line
        .slice(idx + 1)
        .trim()
        .split(/\s+/)
        .map(Number)
      out[ifn] = { rx: cols[0] ?? 0, tx: cols[8] ?? 0 }
    }
  } catch {
    /* degrade to {} */
  }
  return out
}

function procJiffies(): ProcJiffies[] {
  const out: ProcJiffies[] = []
  try {
    const pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
    for (const pid of pids) {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8')
        const open = raw.indexOf('(')
        const close = raw.lastIndexOf(')')
        if (open < 0 || close < 0) continue
        const rest = raw.slice(close + 2).split(/\s+/)
        out.push({
          pid: Number(raw.slice(0, open).trim()),
          comm: raw.slice(open + 1, close),
          state: rest[0] ?? '?',
          utime: Number(rest[11] ?? 0),
          stime: Number(rest[12] ?? 0),
          rss: Number(rest[21] ?? 0),
        })
      } catch {
        /* process exited between readdir and read — skip */
      }
    }
  } catch {
    /* degrade to [] */
  }
  return out
}

function readStat(): { cpu: CpuTimes; cores: CpuTimes[] } {
  let cpu = { user: 0, nice: 0, sys: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 0 }
  const cores: CpuTimes[] = []
  try {
    const txt = readFileSync('/proc/stat', 'utf-8')
    for (const line of txt.split('\n')) {
      if (line.startsWith('cpu ')) cpu = parseCpuLine(line)
      else if (/^cpu\d+/.test(line)) cores.push(parseCpuLine(line))
    }
  } catch {
    /* degrade */
  }
  return { cpu, cores }
}

function sample(): Sample {
  const { cpu, cores } = readStat()
  return { t: Date.now(), cpu, cores, net: netDev(), procs: procJiffies() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── /etc/passwd uid → name ─────────────────────────────────────────────────

let uidMap: Map<number, string> | null = null
function userName(uid: number): string {
  if (!uidMap) {
    try {
      uidMap = new Map(
        readFileSync('/etc/passwd', 'utf-8')
          .split('\n')
          .filter((l) => l.includes(':'))
          .map((l) => {
            const f = l.split(':')
            return [Number(f[2] ?? -1), f[0] ?? '?'] as const
          }),
      )
    } catch {
      uidMap = new Map()
    }
  }
  return uidMap.get(uid) ?? String(uid)
}

function procUid(pid: number): number {
  try {
    const txt = readFileSync(`/proc/${pid}/status`, 'utf-8')
    const m = txt.match(/^Uid:\s+(\d+)/m)
    if (m) return Number(m[1])
  } catch {
    /* gone or unreadable */
  }
  return -1
}

function procCmdline(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    const cmd = raw.split('\0').join(' ').trim()
    return cmd
  } catch {
    return ''
  }
}

const STATE_NAMES: Record<string, string> = {
  R: 'running',
  S: 'sleeping',
  D: 'disk-wait',
  Z: 'zombie',
  T: 'stopped',
  t: 'tracing',
  W: 'paging',
  I: 'idle',
}

// ── top procs with cpu% from jiffies deltas ──────────────────────────

interface TopProc {
  pid: number
  name: string
  cpuPct: number
  memPct: number
  user: string
  state: string
  cmd: string
}

function topProcs(a: Sample, b: Sample, memTotalKb: number, count: number): TopProc[] {
  const elapsedS = Math.max(0.001, (b.t - a.t) / 1000)
  const prevMap = new Map(a.procs.map((p) => [p.pid, p]))
  const rows = b.procs.map((p) => {
    const before = prevMap.get(p.pid)
    const dj = (p.utime + p.stime - (before ? before.utime + before.stime : p.utime + p.stime)) / CLK_TCK
    const cpuPct = Math.max(0, Math.round((dj / elapsedS) * 1000) / 10)
    const memPct =
      memTotalKb > 0 ? Math.round(((p.rss * PAGE) / 1024 / memTotalKb) * 1000) / 10 : 0
    return { raw: p, cpuPct, memPct }
  })
  rows.sort((x, y) => y.cpuPct - x.cpuPct)
  return rows.slice(0, count).map(({ raw, cpuPct, memPct }) => ({
    pid: raw.pid,
    name: raw.comm,
    cpuPct,
    memPct,
    user: userName(procUid(raw.pid)),
    state: STATE_NAMES[raw.state] ?? raw.state,
    cmd: procCmdline(raw.pid) || `[${raw.comm}]`,
  }))
}

// ── disks via df ─────────────────────────────────────────────────────

interface DiskRow {
  mount: string
  fs: string
  totalGb: number
  usedGb: number
  pct: number
}

async function disks(): Promise<DiskRow[]> {
  const r = await run('df', ['-kP', '-x', 'tmpfs', '-x', 'devtmpfs'], 5000)
  const rows: DiskRow[] = []
  for (const line of r.stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const blocks = Number(parts[1])
    const used = Number(parts[2])
    const pct = Number(String(parts[4] ?? '0').replace('%', ''))
    const mount = parts.slice(5).join(' ')
    if (!mount || !Number.isFinite(blocks) || blocks <= 0) continue
    rows.push({
      mount,
      fs: parts[0],
      totalGb: Math.round(((blocks * 1024) / 1024 ** 3) * 10) / 10,
      usedGb: Math.round(((used * 1024) / 1024 ** 3) * 10) / 10,
      pct: Number.isFinite(pct) ? pct : 0,
    })
  }
  return rows
}

// ── glances hwmon quick temps (real; usually empty in this container) ─

function quickTemps(): { label: string; value: number; unit: string }[] {
  const out: { label: string; value: number; unit: string }[] = []
  try {
    const hwmons = readdirSync('/sys/class/hwmon')
    for (const h of hwmons) {
      const base = `/sys/class/hwmon/${h}`
      const files = readdirSync(base)
      for (const f of files) {
        if (!/^temp\d+_input$/.test(f)) continue
        const raw = Number(readFileSync(`${base}/${f}`, 'utf-8'))
        if (!Number.isFinite(raw)) continue
        const labelFile = f.replace('_input', '_label')
        let label = f.replace('_input', '')
        try {
          label = readFileSync(`${base}/${labelFile}`, 'utf-8').trim() || label
        } catch {
          /* no label file */
        }
        out.push({ label, value: Math.round(raw / 100) / 10, unit: '°C' })
      }
    }
  } catch {
    /* /sys/class/hwmon absent — honest empty */
  }
  return out
}

// ── commands ─────────────────────────────────────────────────────────

async function fullSnapshot(topCount: number) {
  const mi = meminfo()
  const memTotalKb = mi['MemTotal'] ?? 0

  // Delta base: previous request's sample, or a 300ms double-sample on
  // the first call so even a single-shot render shows real rates.
  const first = sample()
  let a: Sample | null = prev
  let b = first
  if (!prev) {
    await sleep(300)
    b = sample()
    a = first
  }
  prev = b
  if (!a) {
    // unreachable (prev-or-double-sample above always yields a base) —
    // kept for the type system; fall back to self-delta (zero rates)
    a = b
  }

  const dTotal = b.cpu.total - a.cpu.total
  const dIdle = b.cpu.idle + b.cpu.iowait - (a.cpu.idle + a.cpu.iowait)
  const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0
  const pctOf = (delta: number) => (dTotal > 0 ? (delta / dTotal) * 100 : 0)

  const perCore = b.cores.map((core, i) => {
    const before = a.cores[i]
    if (!before) return { core: i, pct: 0 }
    const dT = core.total - before.total
    const dI = core.idle + core.iowait - (before.idle + before.iowait)
    return { core: i, pct: dT > 0 ? Math.round(((dT - dI) / dT) * 1000) / 10 : 0 }
  })

  const elapsedS = Math.max(0.001, (b.t - a.t) / 1000)
  const net = Object.entries(b.net).map(([iface, cur]) => {
    const before = a.net[iface]
    return {
      iface,
      rxBytes: cur.rx,
      txBytes: cur.tx,
      rxRate: before ? Math.max(0, Math.round((cur.rx - before.rx) / elapsedS)) : 0,
      txRate: before ? Math.max(0, Math.round((cur.tx - before.tx) / elapsedS)) : 0,
    }
  })

  let load: number[] = [0, 0, 0]
  try {
    load = readFileSync('/proc/loadavg', 'utf-8')
      .split(' ')
      .slice(0, 3)
      .map(Number)
  } catch {
    /* degrade */
  }

  let uptimeS = 0
  try {
    uptimeS = Math.round(Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]))
  } catch {
    /* degrade */
  }

  const usedMb = Math.round(
    (memTotalKb - (mi['MemFree'] ?? 0) - (mi['Buffers'] ?? 0) - (mi['Cached'] ?? 0)) / 1024,
  )
  const memPct = memTotalKb > 0 ? Math.round((usedMb / (memTotalKb / 1024)) * 1000) / 10 : 0

  const diskRows = await disks()

  history.push({ t: Math.round(Date.now() / 1000), cpuPct: Math.round(cpuPct * 10) / 10, memPct })
  while (history.length > 60) history.shift()

  return {
    cpu: {
      pct: Math.round(cpuPct * 10) / 10,
      perCore,
      user: Math.round(pctOf(b.cpu.user - a.cpu.user) * 10) / 10,
      sys: Math.round(pctOf(b.cpu.sys - a.cpu.sys) * 10) / 10,
      iowait: Math.round(pctOf(b.cpu.iowait - a.cpu.iowait) * 10) / 10,
    },
    mem: {
      totalMb: Math.round(memTotalKb / 1024),
      usedMb,
      cachedMb: Math.round((mi['Cached'] ?? 0) / 1024),
      buffersMb: Math.round((mi['Buffers'] ?? 0) / 1024),
      swapTotalMb: Math.round((mi['SwapTotal'] ?? 0) / 1024),
      swapUsedMb: Math.round(((mi['SwapTotal'] ?? 0) - (mi['SwapFree'] ?? 0)) / 1024),
    },
    load: { 1: load[0] ?? 0, 5: load[1] ?? 0, 15: load[2] ?? 0 },
    net,
    disks: diskRows,
    uptimeS,
    host: { hostname: os.hostname(), kernel: os.release(), arch: os.arch() },
    procs: b.procs.length,
    topProcs: topProcs(a, b, memTotalKb, topCount),
    history: [...history],
  }
}

/** One shared sweep: the summary (4 s), processes (3 s) and history
 *  polls land on a single TTL-cached fullSnapshot instead of running
 *  the whole pass (df spawn, /proc scan, history push) per command. */
async function snapshotCore() {
  return cached('glances:snapshot', 2500, async () => fullSnapshot(30))
}

export const commands = {
  summary: async () => {
    const s = await snapshotCore()
    return ok({ ...s, topProcs: s.topProcs.slice(0, 12) }, 'live')
  },

  processes: async () => ok({ procs: (await snapshotCore()).topProcs }, 'live'),

  history: async () => ok({ samples: [...history] }, 'live', 'ring buffer of the last 60 summary calls'),

  sensors: async () => ok({ temps: quickTemps() }, 'live'),
}
