// SysDeck bridge — services (listening sockets + SERVICES_REGISTRY)
// Port of bridge/firewall.py's service/port editor subcommands (v0.0.38+):
// `services` ran `ss -tlnp` (with a /proc/net/tcp fallback) and
// cross-referined the static SERVICES_REGISTRY to build the inventory;
// `set-service-port` edited the config file. The web edition parses
// /proc/net/tcp + /proc/net/tcp6 directly (the kernel source of truth,
// same as the python fallback path), maps inodes to processes via
// /proc/<pid>/fd readlinks (works for this user's processes; others →
// null — honest), and cross-references the ServicePort table (seeded
// from the same 9 services). setPort records the change but does NOT
// write config files — that requires the cockpit bridge on a managed
// host. restartService fails honestly (no systemd in this container)
// but records the attempt in the audit log.
import { readFileSync, readdirSync, readlinkSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'hybrid') {
  return { ...fail(error), source }
}

// ── SERVICES_REGISTRY seed (mirrors firewall.py's static allowlist) ──

const SERVICES_SEED = [
  { service: 'ssh', label: 'SSH (sshd)', port: 22, configPath: '/etc/ssh/sshd_config', configKey: 'Port' },
  { service: 'cockpit', label: 'Cockpit web UI', port: 9090, configPath: '/etc/cockpit/cockpit.conf', configKey: 'ListenStream' },
  { service: 'caddy', label: 'Caddy web server (80/443 → 8080)', port: 443, configPath: '/etc/caddy/Caddyfile', configKey: ':443' },
  { service: 'varnish', label: 'Varnish cache', port: 80, configPath: '/etc/varnish/default.vcl', configKey: 'VARNISH_LISTEN_PORT' },
  { service: 'mariadb', label: 'MariaDB / MySQL', port: 3306, configPath: '/etc/my.cnf', configKey: 'port' },
  { service: 'ollama', label: 'Ollama LLM server', port: 11434, configPath: '/etc/systemd/system/ollama.service', configKey: 'OLLAMA_HOST' },
  { service: 'openwebui', label: 'OpenWebUI', port: 3000, configPath: '/etc/systemd/system/open-webui.service', configKey: 'PORT' },
  { service: 'hermes', label: 'Hermes (function-calling gateway)', port: 8765, configPath: '/etc/hermes/config.yaml', configKey: 'port' },
  { service: 'odysseus', label: 'Odysseus (companion UI / agent runtime)', port: 5000, configPath: '/etc/odysseus/config.toml', configKey: 'port' },
]

async function ensureSeeded(): Promise<void> {
  const count = await db.servicePort.count()
  if (count > 0) return
  await db.servicePort.createMany({ data: SERVICES_SEED })
}

// ── /proc/net/tcp{,6} parsing ────────────────────────────────────────

interface Listener {
  port: number
  proto: 'tcp' | 'tcp6'
  addr: string
  inode: string
}

function decodeHexAddr(hex: string): string {
  if (hex.length === 8) {
    // IPv4, little-endian 32-bit word
    const n = parseInt(hex, 16)
    return `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >>> 24) & 0xff}`
  }
  if (hex.length === 32) {
    // IPv6, four 32-bit words each in host (little-endian) byte order:
    // swap bytes inside every 4-hex group, join with colons.
    const groups: string[] = []
    for (let i = 0; i < 32; i += 4) {
      const g = hex.slice(i, i + 4)
      groups.push(`${g[2]}${g[3]}${g[0]}${g[1]}`)
    }
    return groups.join(':')
  }
  return hex
}

function parseListeners(): Listener[] {
  const out: Listener[] = []
  for (const [file, proto] of [
    ['/proc/net/tcp', 'tcp'],
    ['/proc/net/tcp6', 'tcp6'],
  ] as const) {
    try {
      const lines = readFileSync(file, 'utf-8').split('\n').slice(1)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 10) continue
        if (parts[3] !== '0A') continue // LISTEN only
        const [ipHex, portHex] = (parts[1] ?? '').split(':')
        out.push({
          port: parseInt(portHex ?? '0', 16),
          proto,
          addr: decodeHexAddr(ipHex ?? ''),
          inode: parts[9] ?? '',
        })
      }
    } catch {
      /* file unreadable — skip */
    }
  }
  return out.sort((a, b) => a.port - b.port)
}

function inodeToPidMap(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      const fdDir = `/proc/${pid}/fd`
      let fds: string[] = []
      try {
        fds = readdirSync(fdDir)
      } catch {
        continue // not our process — honest null mapping
      }
      for (const fd of fds) {
        try {
          const link = readlinkSync(`${fdDir}/${fd}`)
          const m = link.match(/^socket:\[(\d+)\]$/)
          if (m && !map.has(m[1])) map.set(m[1], Number(pid))
        } catch {
          /* fd closed — skip */
        }
      }
    }
  } catch {
    /* degrade */
  }
  return map
}

interface ProcMeta {
  pid: number
  comm: string
}

function pidMeta(pid: number): ProcMeta | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    if (open < 0 || close < 0) return null
    return { pid, comm: stat.slice(open + 1, close) }
  } catch {
    return null
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  list: async () => {
    await ensureSeeded()
    const registry = await db.servicePort.findMany({ orderBy: { service: 'asc' } })
    const listeners = parseListeners()
    const pidMap = inodeToPidMap()
    const byPort = new Map<number, (typeof registry)[number]>()
    for (const row of registry) byPort.set(row.updatedPort ?? row.port, row)

    const enriched = listeners.map((l) => {
      const pid = pidMap.get(l.inode)
      const meta = pid !== undefined ? pidMeta(pid) : null
      const svc = byPort.get(l.port) ?? null
      return {
        port: l.port,
        proto: l.proto,
        addr: l.addr,
        inode: l.inode,
        pid: pid ?? null,
        process: meta?.comm ?? null,
        service: svc ? { service: svc.service, label: svc.label, configuredPort: svc.updatedPort ?? svc.port } : null,
      }
    })

    const listeningPorts = new Set(enriched.map((l) => l.port))
    const registryOut = registry.map((r) => ({
      ...r,
      running: listeningPorts.has(r.updatedPort ?? r.port),
    }))

    return ok(
      {
        listeners: enriched,
        registry: registryOut,
        listening: enriched.length,
        registered: registry.length,
      },
      'live',
      'sockets from /proc/net/tcp{,6}; inode→pid works only for this user\'s processes; registry seeded from the cockpit SERVICES_REGISTRY',
    )
  },

  setPort: async (args: Record<string, unknown>) => {
    const service = String(args.service ?? '').trim()
    const port = Number(args.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return failE('port must be an integer between 1 and 65535')
    }
    await ensureSeeded()
    const row = await db.servicePort.findUnique({ where: { service } })
    if (!row) return failE(`unknown service: ${service}`)
    const oldPort = row.updatedPort ?? row.port
    await db.servicePort.update({ where: { service }, data: { updatedPort: port } })
    await db.auditLog.create({
      data: {
        module: 'services',
        action: 'setPort',
        detail: `${service}: ${oldPort} → ${port} (${row.configPath})`,
      },
    })
    return ok(
      {
        service,
        oldPort,
        newPort: port,
        configPath: row.configPath,
        configKey: row.configKey,
        appliedToConfig: false,
      },
      'hybrid',
      'web edition records the port; the config file write requires the cockpit bridge on a managed host',
    )
  },

  resetPort: async (args: Record<string, unknown>) => {
    const service = String(args.service ?? '').trim()
    await ensureSeeded()
    const row = await db.servicePort.findUnique({ where: { service } })
    if (!row) return failE(`unknown service: ${service}`)
    await db.servicePort.update({ where: { service }, data: { updatedPort: null } })
    await db.auditLog.create({
      data: { module: 'services', action: 'resetPort', detail: `${service} back to ${row.port}` },
    })
    return ok({ service, port: row.port }, 'hybrid')
  },

  restartService: async (args: Record<string, unknown>) => {
    const service = String(args.service ?? '').trim()
    await ensureSeeded()
    const row = await db.servicePort.findUnique({ where: { service } })
    if (!row) return failE(`unknown service: ${service}`)
    await db.auditLog.create({
      data: { module: 'services', action: 'restartService', detail: `attempted restart of ${service} (systemd unit ${service}.service)` },
    })
    return failE('systemd not available in this environment (PID 1 is tini) — restart attempt recorded to the audit log')
  },
}
