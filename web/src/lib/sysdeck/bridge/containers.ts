// SysDeck bridge — containers (real multi-runtime aggregation, all live)
// Port of bridge/containers.py semantics: the cockpit edition aggregated
// `podman ps -a --format json`. The web edition aggregates EVERY runtime
// actually present on the host:
//   podman · docker · incus · lxc · libvirt (virsh) · firecracker sockets
// Each driver is probed with its real CLI and the inventories are merged
// per call — no seeded rows, no simulated state transitions. Lifecycle
// actions (start/stop/freeze/delete/exec) run the runtime's real command;
// failures surface the runtime's own error verbatim (e.g. rootless
// runtimes, the libvirt system daemon socket, or absent binaries).
import { ok, fail, run, which, cached, invalidateCache } from './shared'
import { db } from '@/lib/db'
import { readdir } from 'fs/promises'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'containers', action, detail } })
}

// ── unified row shape (panel contract) ───────────────────────────────

export interface CtrRow {
  id: string
  name: string
  driver: string
  kind: 'container' | 'vm'
  image: string
  state: 'running' | 'stopped' | 'frozen'
  cpuPct: number
  memMb: number
  uptimeS: number
  ports: string | null
  createdAt: string
}

// ── driver probes (each returns [] when the runtime is absent) ───────

async function listPodman(): Promise<CtrRow[]> {
  if (!(await which('podman'))) return []
  const r = await run('podman', ['ps', '-a', '--format', 'json'], 20_000)
  if (r.rc !== 0 || !r.stdout.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(r.stdout)
  } catch {
    return []
  }
  const items = Array.isArray(raw) ? raw : []
  const rows: CtrRow[] = []
  for (const it of items as Record<string, unknown>[]) {
    const state = String(it.State ?? '').toLowerCase()
    const names = Array.isArray(it.Names) ? (it.Names as string[]) : []
    const created = Number(it.CreatedAt ?? 0) || Number(it.Created ?? 0)
    const ports = formatPodmanPorts(it.Ports)
    rows.push({
      id: String(it.Id ?? '').slice(0, 12) || (names[0] ?? ''),
      name: names[0] ?? String(it.Id ?? '').slice(0, 12),
      driver: 'podman',
      kind: 'container',
      image: String(it.Image ?? ''),
      state: state === 'running' ? 'running' : state === 'paused' ? 'frozen' : 'stopped',
      cpuPct: 0,
      memMb: 0,
      uptimeS: created ? Math.max(0, Math.floor(Date.now() / 1000) - created) : 0,
      ports: ports ?? null,
      createdAt: created ? new Date(created * 1000).toISOString() : '',
    })
  }
  // live cpu/mem for running containers (best-effort, one shot)
  await decoratePodmanStats(rows)
  return rows
}

function formatPodmanPorts(p: unknown): string | null {
  // podman Ports field: array of {hostPort, containerPort, protocol, hostIP}
  if (!Array.isArray(p) || !p.length) return null
  const parts: string[] = []
  for (const e of p as Record<string, unknown>[]) {
    const host = String(e.hostIP ?? '0.0.0.0')
    const hp = String(e.hostPort ?? '')
    const cp = String(e.containerPort ?? '')
    const proto = String(e.protocol ?? 'tcp')
    if (hp && cp) parts.push(`${host}:${hp} -> ${cp}/${proto}`)
  }
  return parts.length ? parts.join(', ') : null
}

async function decoratePodmanStats(rows: CtrRow[]): Promise<void> {
  const running = rows.filter((r) => r.state === 'running')
  if (!running.length) return
  const r = await run('podman', ['stats', '--no-stream', '--format', 'json'], 20_000)
  if (r.rc !== 0 || !r.stdout.trim()) return
  try {
    const stats = JSON.parse(r.stdout) as Record<string, unknown>[]
    const byName = new Map<string, Record<string, unknown>>()
    for (const s of stats) byName.set(String(s.Name ?? ''), s)
    for (const row of running) {
      const s = byName.get(row.name)
      if (!s) continue
      row.cpuPct = parseCpuPct(String(s.CPU ?? s.CPUPerc ?? ''))
      row.memMb = parseMemMb(String(s.MemUsage ?? ''))
    }
  } catch {
    // stats output varies across podman versions — leave zeros
  }
}

function parseCpuPct(v: string): number {
  const m = v.match(/([\d.]+)/)
  return m ? Math.round(Number(m[1]) * 10) / 10 : 0
}

function parseMemMb(v: string): number {
  const m = v.match(/([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)/)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2]
  const mult: Record<string, number> = { B: 1 / 1048576, kB: 1 / 1024, KiB: 1 / 1024, MB: 1, MiB: 1, GB: 1024, GiB: 1024 }
  return Math.round(n * (mult[unit] ?? 1))
}

async function listDocker(): Promise<CtrRow[]> {
  if (!(await which('docker'))) return []
  // docker ps --format '{{json .}}' emits ONE json object per line
  const r = await run('docker', ['ps', '-a', '--format', '{{json .}}'], 20_000)
  if (r.rc !== 0 || !r.stdout.trim()) return []
  const rows: CtrRow[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const it = JSON.parse(line) as Record<string, string>
      const state = (it.State ?? '').toLowerCase()
      rows.push({
        id: (it.ID ?? '').slice(0, 12),
        name: (it.Names ?? '').split(',')[0] ?? it.ID ?? '',
        driver: 'docker',
        kind: 'container',
        image: it.Image ?? '',
        state: state === 'running' ? 'running' : state === 'paused' ? 'frozen' : 'stopped',
        cpuPct: 0,
        memMb: 0,
        uptimeS: 0,
        ports: it.Ports ? it.Ports.split(', ').filter(Boolean).join(', ') : null,
        createdAt: it.CreatedAt ?? '',
      })
    } catch {
      continue
    }
  }
  return rows
}

async function listIncus(): Promise<CtrRow[]> {
  const bin = (await which('incus')) ? 'incus' : (await which('lxc')) ? 'lxc' : null
  if (!bin) return []
  const r = await run(bin, ['list', '--format', 'json'], 30_000)
  if (r.rc !== 0 || !r.stdout.trim()) return []
  try {
    const items = JSON.parse(r.stdout) as Record<string, unknown>[]
    const rows: CtrRow[] = []
    for (const it of items) {
      const status = String(it.status ?? '').toLowerCase()
      const st = (it.state ?? {}) as Record<string, unknown>
      const mem = ((st.memory ?? {}) as Record<string, unknown>).usage_bytes
      const cpu = (st.cpu ?? {}) as Record<string, unknown>
      const createdAt = String(it.created_at ?? '')
      const typ = String(it.type ?? 'container') === 'virtual-machine' ? 'vm' : 'container'
      rows.push({
        id: String(it.name ?? ''),
        name: String(it.name ?? ''),
        driver: bin,
        kind: typ,
        image: String(((it.config ?? {}) as Record<string, string>)['image.description'] ?? ''),
        state: status === 'running' ? 'running' : status.includes('frozen') ? 'frozen' : 'stopped',
        cpuPct: cpu.usage ? Math.round(Number(cpu.usage) / 100) / 10 : 0,
        memMb: mem ? Math.round(Number(mem) / 1048576) : 0,
        uptimeS: createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000)) : 0,
        ports: null,
        createdAt,
      })
    }
    return rows
  } catch {
    return []
  }
}

async function listLibvirt(): Promise<CtrRow[]> {
  if (!(await which('virsh'))) return []
  const r = await run('virsh', ['list', '--all'], 20_000)
  if (r.rc !== 0) return []
  const rows: CtrRow[] = []
  for (const line of r.stdout.split('\n').slice(2)) {
    if (!line.trim() || line.startsWith(' ')) continue
    // " -   win11-dev    shut off" / " 1   arch-test   running"
    const m = line.trim().match(/^(-|\d+)\s+(\S+)(?:\s+(.*))?$/)
    if (!m) continue
    const stateStr = (m[3] ?? '').toLowerCase()
    rows.push({
      id: m[2],
      name: m[2],
      driver: 'libvirt',
      kind: 'vm',
      image: '',
      state: stateStr.includes('running') ? 'running' : stateStr.includes('paused') ? 'frozen' : 'stopped',
      cpuPct: 0,
      memMb: 0,
      uptimeS: 0,
      ports: null,
      createdAt: '',
    })
  }
  return rows
}

async function listFirecracker(): Promise<CtrRow[]> {
  // firecracker keeps one API socket per microVM under /run/firecracker/
  if (!(await which('firecracker'))) return []
  const roots = ['/run/firecracker', '/var/run/firecracker']
  for (const root of roots) {
    try {
      const entries = await readdir(root)
      const socks = entries.filter((e) => e.endsWith('.sock'))
      return socks.map((s) => ({
        id: s.replace(/\.sock$/, ''),
        name: s.replace(/\.sock$/, ''),
        driver: 'firecracker',
        kind: 'vm' as const,
        image: '',
        state: 'running' as const, // an active API socket is a live microVM
        cpuPct: 0,
        memMb: 0,
        uptimeS: 0,
        ports: null,
        createdAt: '',
      }))
    } catch {
      continue
    }
  }
  return []
}

// ── aggregate ────────────────────────────────────────────────────────

interface RuntimeStatus {
  available: string[]
  absent: string[]
}

const ALL_RUNTIMES = ['podman', 'docker', 'incus', 'lxc', 'virsh', 'firecracker'] as const

async function runtimeStatus(): Promise<RuntimeStatus> {
  const available: string[] = []
  const absent: string[] = []
  for (const rt of ALL_RUNTIMES) {
    if (rt === 'incus' || rt === 'lxc') continue // represented by whichever exists
    if (await which(rt)) available.push(rt)
    else absent.push(rt)
  }
  if (await which('incus')) available.push('incus')
  else if (await which('lxc')) available.push('lxc')
  else absent.push('incus/lxc')
  return { available, absent }
}

/** One inventory pass over every runtime, TTL-cached and single-flight:
 *  the summary and list polls share one sweep (~14 spawns → one), and
 *  mutations invalidate the entry so the next read is fresh. */
async function aggregate(): Promise<{ rows: CtrRow[]; status: RuntimeStatus }> {
  return cached('containers:aggregate', 3_000, async () => {
    const status = await runtimeStatus()
    const parts = await Promise.all([listPodman(), listDocker(), listIncus(), listLibvirt(), listFirecracker()])
    const rows = parts.flat().sort((a, b) => a.driver.localeCompare(b.driver) || a.name.localeCompare(b.name))
    return { rows, status }
  })
}

async function findInstance(id: string): Promise<CtrRow | null> {
  const { rows } = await aggregate()
  return rows.find((r) => r.id === id || r.name === id) ?? null
}

// ── lifecycle dispatch (real commands per driver) ────────────────────

async function driverAction(
  row: CtrRow,
  action: 'start' | 'stop' | 'freeze' | 'delete',
): Promise<{ rc: number; stderr: string; command: string }> {
  let cmd: string
  let args: string[]
  switch (row.driver) {
    case 'podman':
      cmd = 'podman'
      args = action === 'start' ? ['start', row.name] : action === 'stop' ? ['stop', row.name] : action === 'freeze' ? ['pause', row.name] : ['rm', '-f', row.name]
      break
    case 'docker':
      cmd = 'docker'
      args = action === 'start' ? ['start', row.name] : action === 'stop' ? ['stop', row.name] : action === 'freeze' ? ['pause', row.name] : ['rm', '-f', row.name]
      break
    case 'incus':
    case 'lxc':
      cmd = row.driver
      args = action === 'start' ? ['start', row.name] : action === 'stop' ? ['stop', row.name] : action === 'freeze' ? ['pause', row.name] : ['delete', '--force', row.name]
      break
    case 'libvirt':
      cmd = 'virsh'
      args = action === 'start' ? ['start', row.name] : action === 'stop' ? ['shutdown', row.name] : action === 'freeze' ? ['suspend', row.name] : ['undefine', row.name]
      break
    default:
      // firecracker: real API call over the microVM's unix socket
      return firecrackerAction(row, action)
  }
  const r = await run(cmd, args, 60_000)
  if (r.rc === 0) invalidateCache('containers:aggregate') // next read sees the new state
  return { rc: r.rc, stderr: r.stderr, command: [cmd, ...args].join(' ') }
}

async function firecrackerAction(
  row: CtrRow,
  action: 'start' | 'stop' | 'freeze' | 'delete',
): Promise<{ rc: number; stderr: string; command: string }> {
  if (action === 'start') {
    return { rc: 1, stderr: 'firecracker microVMs boot from a kernel+rootfs spec, not from a stopped state — start it via the machine config', command: 'firecracker api' }
  }
  const command = `curl --unix-socket /run/firecracker/${row.id}.sock -X PUT http://localhost/actions`
  const r = await run(
    'curl',
    ['--unix-socket', `/run/firecracker/${row.id}.sock`, '-X', 'PUT', 'http://localhost/actions', '-H', 'Content-Type: application/json', '-d', '{"action_type":"InstanceStop"}'],
    15_000,
  )
  if (r.rc === 0) invalidateCache('containers:aggregate') // next read sees the new state
  return { rc: r.rc, stderr: r.stderr || r.stdout, command }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const { rows, status } = await aggregate()
    const running = rows.filter((c) => c.state === 'running').length
    const stopped = rows.filter((c) => c.state !== 'running').length
    const drivers = [...new Set(rows.map((c) => c.driver))].map((name) => ({
      name,
      count: rows.filter((c) => c.driver === name).length,
    }))
    const note = status.available.length
      ? `live inventory — runtimes detected: ${status.available.join(', ')}`
      : `no container/VM runtime detected on this host (probed: ${ALL_RUNTIMES.join(', ')}) — install one and it appears here automatically`
    return ok(
      {
        total: rows.length,
        running,
        stopped,
        vms: rows.filter((c) => c.kind === 'vm').length,
        containers: rows.filter((c) => c.kind === 'container').length,
        drivers,
        runtimes: status.available,
      },
      'live',
      note,
    )
  },

  list: async () => {
    const { rows, status } = await aggregate()
    const note = status.available.length
      ? `live inventory via ${status.available.join(', ')}`
      : `no container/VM runtime detected (probed: ${ALL_RUNTIMES.join(', ')})`
    return ok({ containers: rows, total: rows.length }, 'live', note)
  },

  start: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const row = await findInstance(id)
    if (!row) return failE(`instance '${id}' not found in the live runtime inventory`)
    if (row.state === 'running') return failE(`${row.name} is already running`)
    const res = await driverAction(row, 'start')
    await audit('start', `${res.command} → rc=${res.rc}`)
    if (res.rc !== 0) return failE(`${res.command} failed — ${res.stderr.trim().split('\n')[0] ?? 'runtime error'}`)
    return ok({ name: row.name, state: 'running', command: res.command }, 'live', res.command)
  },

  stop: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const row = await findInstance(id)
    if (!row) return failE(`instance '${id}' not found in the live runtime inventory`)
    if (row.state === 'stopped') return failE(`${row.name} is already stopped`)
    const res = await driverAction(row, 'stop')
    await audit('stop', `${res.command} → rc=${res.rc}`)
    if (res.rc !== 0) return failE(`${res.command} failed — ${res.stderr.trim().split('\n')[0] ?? 'runtime error'}`)
    return ok({ name: row.name, state: 'stopped', command: res.command }, 'live', res.command)
  },

  freeze: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const row = await findInstance(id)
    if (!row) return failE(`instance '${id}' not found in the live runtime inventory`)
    if (row.kind !== 'container') return failE(`${row.name} is a VM — pause/suspend support depends on the driver (${row.driver})`)
    if (row.state !== 'running') return failE(`${row.name} is ${row.state} — only running containers can be frozen`)
    const res = await driverAction(row, 'freeze')
    await audit('freeze', `${res.command} → rc=${res.rc}`)
    if (res.rc !== 0) return failE(`${res.command} failed — ${res.stderr.trim().split('\n')[0] ?? 'runtime error'}`)
    return ok({ name: row.name, state: 'frozen', command: res.command }, 'live', res.command)
  },

  delete: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const row = await findInstance(id)
    if (!row) return failE(`instance '${id}' not found in the live runtime inventory`)
    if (row.state === 'running') return failE(`${row.name} is running — stop it first`)
    const res = await driverAction(row, 'delete')
    await audit('delete', `${res.command} → rc=${res.rc}`)
    if (res.rc !== 0) return failE(`${res.command} failed — ${res.stderr.trim().split('\n')[0] ?? 'runtime error'}`)
    return ok({ deleted: { id: row.id, name: row.name, driver: row.driver }, command: res.command }, 'live', res.command)
  },

  exec: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const command = String(args.command ?? '')
    if (!id) return failE('id is required')
    if (!command.trim()) return failE('command is required')
    const row = await findInstance(id)
    if (!row) return failE(`instance '${id}' not found in the live runtime inventory`)
    if (row.state !== 'running') return failE(`${row.name} is ${row.state} — exec requires a running instance`)
    let r: { rc: number; stdout: string; stderr: string }
    switch (row.driver) {
      case 'podman':
      case 'docker':
        r = await run(row.driver, ['exec', row.name, 'sh', '-c', command], 30_000)
        break
      case 'incus':
      case 'lxc':
        r = await run(row.driver, ['exec', row.name, '--', 'sh', '-c', command], 30_000)
        break
      case 'libvirt':
        r = await run('virsh', ['qemu-agent-command', row.name, JSON.stringify({ execute: 'guest-exec', arguments: { path: '/bin/sh', arg: ['-c', command], 'capture-output': true } })], 30_000)
        break
      default:
        return failE(`exec is not supported for the ${row.driver} driver`)
    }
    const lines = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trimEnd().split('\n').filter((l) => l.length > 0)
    await audit('exec', `${row.name}: ${command} (rc=${r.rc})`)
    return ok({ id, name: row.name, command, rc: r.rc, lines: lines.length ? lines : ['(no output)'] }, 'live')
  },
}
