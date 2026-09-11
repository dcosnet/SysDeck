// SysDeck bridge — containers (demo inventory)
// Port of bridge/containers.py semantics: the cockpit edition aggregated
// `podman ps -a --format json` enriched with systemd scope units
// (libpod-<id>.scope). This sandbox has no incus/podman/libvirt/
// firecracker, so the web edition keeps the SAME surface (list of
// containers/VMs with state, image, cpu, mem, uptime, ports + lifecycle
// transitions) over a seeded Prisma inventory. Mutations are recorded
// in AuditLog; exec() returns simulated shell output.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'incus/podman/libvirt not present in sandbox — demo inventory'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope (1-b's failE pattern). */
function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'containers', action, detail } })
}

// ── lazy seed ───────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.container.count()
  if (count > 0) return
  await db.container.createMany({
    data: [
      // incus system containers
      { name: 'web-frontend', driver: 'incus', kind: 'container', image: 'nginx:alpine', state: 'running', cpuPct: 0.8, memMb: 84, uptimeS: 764301, ports: '0.0.0.0:8081 -> 80/tcp' },
      { name: 'api-gateway', driver: 'incus', kind: 'container', image: 'images:debian/12', state: 'running', cpuPct: 3.2, memMb: 412, uptimeS: 764298, ports: '0.0.0.0:8080 -> 8080/tcp' },
      { name: 'redis-cache', driver: 'incus', kind: 'container', image: 'images:alpine/3.20', state: 'running', cpuPct: 1.1, memMb: 96, uptimeS: 512340, ports: '10.10.0.1:6379' },
      { name: 'postgres-main', driver: 'incus', kind: 'container', image: 'images:debian/12', state: 'running', cpuPct: 5.4, memMb: 1284, uptimeS: 512338, ports: '10.10.0.1:5432' },
      { name: 'worker-queue', driver: 'incus', kind: 'container', image: 'images:debian/12', state: 'stopped', cpuPct: 0, memMb: 0, uptimeS: 0, ports: null },
      { name: 'ci-runner', driver: 'incus', kind: 'container', image: 'images:archlinux/current', state: 'running', cpuPct: 12.6, memMb: 890, uptimeS: 44610, ports: null },
      { name: 'grafana-agent', driver: 'incus', kind: 'container', image: 'images:alpine/3.20', state: 'running', cpuPct: 1.4, memMb: 62, uptimeS: 512301, ports: '127.0.0.1:9090 -> 9090/tcp' },
      // libvirt VMs
      { name: 'win11-dev', driver: 'libvirt', kind: 'vm', image: 'win11-dev.qcow2', state: 'running', cpuPct: 8.9, memMb: 8192, uptimeS: 1903742, ports: '192.168.122.51:3389, 5900' },
      { name: 'arch-test', driver: 'libvirt', kind: 'vm', image: 'arch-test.qcow2', state: 'stopped', cpuPct: 0, memMb: 0, uptimeS: 0, ports: null },
      { name: 'pfsense-fw', driver: 'libvirt', kind: 'vm', image: 'pfSense-2.7.2.qcow2', state: 'running', cpuPct: 2.1, memMb: 512, uptimeS: 2367421, ports: '192.168.122.1:443' },
      // podman containers
      { name: 'ollama-inference', driver: 'podman', kind: 'container', image: 'docker.io/ollama/ollama:0.3.12', state: 'running', cpuPct: 45.2, memMb: 9216, uptimeS: 384620, ports: '0.0.0.0:11434 -> 11434/tcp' },
      { name: 'openwebui', driver: 'podman', kind: 'container', image: 'ghcr.io/open-webui/open-webui:v0.3.32', state: 'running', cpuPct: 4.8, memMb: 512, uptimeS: 384615, ports: '0.0.0.0:3000 -> 8080/tcp' },
      { name: 'homebridge', driver: 'podman', kind: 'container', image: 'docker.io/homebridge/homebridge:1.8.4', state: 'stopped', cpuPct: 0, memMb: 0, uptimeS: 0, ports: null },
      // firecracker microVMs
      { name: 'fc-build-1', driver: 'firecracker', kind: 'vm', image: 'vmlinux-6.1.fc (rootfs: ext4)', state: 'running', cpuPct: 88.0, memMb: 2048, uptimeS: 5410, ports: null },
      { name: 'fc-build-2', driver: 'firecracker', kind: 'vm', image: 'vmlinux-6.1.fc (rootfs: ext4)', state: 'stopped', cpuPct: 0, memMb: 0, uptimeS: 0, ports: null },
    ],
  })
  await db.auditLog.create({
    data: { module: 'containers', action: 'seed', detail: 'seeded demo inventory: 15 containers/VMs (incus 7, libvirt 3, podman 3, firecracker 2)' },
  })
}

// ── helpers ─────────────────────────────────────────────────────────

async function getContainer(id: string) {
  return db.container.findUnique({ where: { id } })
}

function jitter(base: number, pct = 0.25): number {
  return Math.round(base * (1 + (Math.random() - 0.5) * 2 * pct) * 10) / 10
}

// Simulated exec output for the demo containers (cmd echo style).
function execOutput(name: string, command: string): { rc: number; lines: string[] } {
  const prompt = `root@${name}:~# ${command}`
  const cmd = command.trim()
  const known: Record<string, string[]> = {
    'uname -a': [`Linux ${name} 6.8.9-sysdeck #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`],
    'uptime -p': ['up 8 days, 20 hours, 18 minutes'],
    whoami: ['root'],
    'df -h': ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/sda1        58G   21G   35G  38% /'],
    'ps aux': ['USER  PID %CPU %MEM COMMAND', 'root    1  0.0  0.1 systemd', 'root   42  0.8  0.3 nginx: master process'],
    'cat /etc/os-release': ['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'VERSION_ID="12"'],
    'free -m': ['               total   used   free', 'Mem:           1024    312    712'],
  }
  if (known[cmd]) return { rc: 0, lines: [prompt, ...known[cmd]] }
  if (cmd.startsWith('echo ')) return { rc: 0, lines: [prompt, cmd.slice(5)] }
  if (cmd.startsWith('ls')) return { rc: 0, lines: [prompt, 'bin  boot  dev  etc  home  root  tmp  usr  var'] }
  return { rc: 127, lines: [prompt, `sh: 1: ${cmd.split(' ')[0]}: not found`] }
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rows = await db.container.findMany()
    const running = rows.filter((c) => c.state === 'running').length
    const stopped = rows.filter((c) => ['stopped', 'frozen'].includes(c.state)).length
    const drivers = [...new Set(rows.map((c) => c.driver))].map((name) => ({
      name,
      count: rows.filter((c) => c.driver === name).length,
    }))
    return ok(
      {
        total: rows.length,
        running,
        stopped,
        vms: rows.filter((c) => c.kind === 'vm').length,
        containers: rows.filter((c) => c.kind === 'container').length,
        drivers,
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rows = await db.container.findMany({ orderBy: [{ driver: 'asc' }, { name: 'asc' }] })
    return ok({ containers: rows, total: rows.length }, SOURCE, NOTE)
  },

  start: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const c = await getContainer(id)
    if (!c) return failE('container not found')
    if (c.state === 'running') return failE(`${c.name} is already running`)
    const row = await db.container.update({
      where: { id },
      data: {
        state: 'running',
        cpuPct: jitter(3.5),
        memMb: c.memMb && c.memMb > 64 ? c.memMb : jitter(320),
        uptimeS: 1,
      },
    })
    await audit('start', `${c.name} (${c.driver} ${c.kind}) → running`)
    return ok({ container: row, state: 'running' }, SOURCE, `${c.name} started — demo state transition`)
  },

  stop: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const c = await getContainer(id)
    if (!c) return failE('container not found')
    if (c.state === 'stopped') return failE(`${c.name} is already stopped`)
    const row = await db.container.update({
      where: { id },
      data: { state: 'stopped', cpuPct: 0, memMb: 0, uptimeS: 0 },
    })
    await audit('stop', `${c.name} (${c.driver} ${c.kind}) → stopped (cpu/mem/uptime zeroed)`)
    return ok({ container: row, state: 'stopped' }, SOURCE, `${c.name} stopped — demo state transition`)
  },

  freeze: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const c = await getContainer(id)
    if (!c) return failE('container not found')
    if (c.kind !== 'container') return failE(`${c.name} is a VM — only system containers can be frozen (CRIU checkpoint)`)
    if (c.state !== 'running') return failE(`${c.name} is ${c.state} — only running containers can be frozen`)
    const row = await db.container.update({ where: { id }, data: { state: 'frozen', cpuPct: 0 } })
    await audit('freeze', `${c.name} → frozen (memory preserved, cpu zeroed)`)
    return ok({ container: row, state: 'frozen' }, SOURCE, `${c.name} frozen — demo state transition`)
  },

  delete: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const c = await getContainer(id)
    if (!c) return failE('container not found')
    if (c.state === 'running') return failE(`${c.name} is running — stop it first`)
    await db.container.delete({ where: { id } })
    await audit('delete', `${c.name} (${c.driver} ${c.kind}) deleted`)
    return ok({ deleted: { id, name: c.name, driver: c.driver } }, SOURCE)
  },

  exec: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    const command = String(args.command ?? '')
    if (!id) return failE('id is required')
    if (!command.trim()) return failE('command is required')
    const c = await getContainer(id)
    if (!c) return failE('container not found')
    if (c.state === 'stopped') return failE(`${c.name} is stopped — exec requires a running instance`)
    const out = execOutput(c.name, command)
    await audit('exec', `${c.name}: ${command} (rc=${out.rc})`)
    return ok(
      { id, name: c.name, command, rc: out.rc, lines: out.lines },
      SOURCE,
      'simulated shell output — no real exec in the demo inventory',
    )
  },
}
