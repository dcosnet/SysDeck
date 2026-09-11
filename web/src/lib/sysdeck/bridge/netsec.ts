// SysDeck bridge — netsec (network security monitor)
// Port of bridge/netsec.py (v0.0.43 iptraf-ng style): the cockpit edition
// read the same kernel sources iptraf-ng reads (/proc/net/tcp, /dev, snmp)
// and crossed ss for PID mapping. The web edition keeps the /proc/net/tcp
// + tcp6 collectors (hex address decode, state table, LISTEN surface)
// and adds a persistence layer the python edition kept in fail2ban-like
// state: NetsecBan (seeded with the classic hostile-actor rows) and
// NetsecScan (each scan writes a row). `scan` is a REAL sweep: it reads
// the live listening table and connect-tests every port on 127.0.0.1
// (300ms timeout each, Node net.connect) — no nmap dependency.
import { readFileSync } from 'fs'
import { connect } from 'net'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'hybrid') {
  return { ...fail(error), source }
}

// ── /proc/net/tcp{,6} parsing ─────────────────────────────────────────

const TCP_STATES: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
}

interface TcpRow {
  proto: 'tcp' | 'tcp6'
  localIp: string
  localPort: number
  remoteIp: string
  remotePort: number
  stateHex: string
  state: string
}

function decodeHexIp(hex: string): string {
  if (hex.length === 8) {
    // IPv4: one 32-bit word, little-endian
    const n = parseInt(hex, 16)
    return `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >>> 24) & 0xff}`
  }
  if (hex.length === 32) {
    // IPv6: four 32-bit words, each little-endian within the word
    const groups: string[] = []
    for (let i = 0; i < 32; i += 4) {
      const g = hex.slice(i, i + 4)
      groups.push(`${g[2]}${g[3]}${g[0]}${g[1]}`)
    }
    return groups.join(':')
  }
  return hex
}

function parseTcp(file: string, proto: 'tcp' | 'tcp6'): TcpRow[] {
  const out: TcpRow[] = []
  try {
    const lines = readFileSync(file, 'utf-8').split('\n').slice(1)
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) continue
      const [localHex, remoteHex] = [parts[1] ?? '', parts[2] ?? '']
      const [localIpHex, localPortHex] = localHex.split(':')
      const [remoteIpHex, remotePortHex] = remoteHex.split(':')
      const stateHex = parts[3] ?? ''
      if (!localPortHex || !remotePortHex || !stateHex) continue
      out.push({
        proto,
        localIp: decodeHexIp(localIpHex ?? ''),
        localPort: parseInt(localPortHex, 16),
        remoteIp: decodeHexIp(remoteIpHex ?? ''),
        remotePort: parseInt(remotePortHex, 16),
        stateHex,
        state: TCP_STATES[stateHex] ?? `UNKNOWN(${stateHex})`,
      })
    }
  } catch {
    /* file unreadable — skip */
  }
  return out
}

function allTcp(): TcpRow[] {
  return [...parseTcp('/proc/net/tcp', 'tcp'), ...parseTcp('/proc/net/tcp6', 'tcp6')]
}

// ── bans (NetsecBan registry, seeded) ────────────────────────────────

async function ensureBansSeeded(): Promise<void> {
  const count = await db.netsecBan.count()
  if (count > 0) return
  await db.netsecBan.createMany({
    data: [
      {
        ip: '185.220.101.34',
        service: 'sshd',
        jail: 'sysdeck',
        reason: 'ssh brute force',
        strikes: 12,
      },
      {
        ip: '45.155.205.233',
        service: 'sshd',
        jail: 'sysdeck',
        reason: 'credential stuffing',
        strikes: 8,
      },
      {
        ip: '103.208.220.11',
        service: 'nginx',
        jail: 'sysdeck',
        reason: 'wp-scan',
        strikes: 3,
      },
    ],
  })
}

// ── port sweep (REAL localhost connect tests) ────────────────────────

function probePort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const sock = connect({ host, port })
      sock.setTimeout(timeoutMs)
      sock.on('connect', () => {
        sock.destroy()
        finish(true)
      })
      sock.on('timeout', () => {
        sock.destroy()
        finish(false)
      })
      sock.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

const LOCAL_TARGETS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  connections: async () => {
    const rows = allTcp()
    const stateCounts: Record<string, number> = {}
    for (const r of rows) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1
    const established = rows
      .filter((r) => r.state === 'ESTABLISHED' && r.remotePort !== 0 && r.localPort !== 0)
      .slice(0, 50)
      .map((r) => ({
        local: `${r.localIp}:${r.localPort}`,
        remote: `${r.remoteIp}:${r.remotePort}`,
        state: r.state,
        proto: r.proto,
      }))
    return ok(
      {
        total: rows.length,
        stateCounts,
        established,
        establishedCount: stateCounts['ESTABLISHED'] ?? 0,
      },
      'live',
      'decoded from /proc/net/tcp + /proc/net/tcp6 (rows with a 0.0.0.0:0-style wildcard peer are skipped)',
    )
  },

  surface: async () => {
    const rows = allTcp().filter((r) => r.stateHex === '0A')
    const uniquePorts = [...new Set(rows.map((r) => r.localPort))].sort((a, b) => a - b)
    const listeners = rows.map((r) => ({
      port: r.localPort,
      proto: r.proto,
      addr: `${r.localIp}:${r.localPort}`,
    }))
    return ok(
      {
        listening: rows.length,
        uniquePorts,
        uniqueCount: uniquePorts.length,
        listeners,
      },
      'live',
      'LISTEN (st=0A) rows from /proc/net/tcp + /proc/net/tcp6',
    )
  },

  bans: async () => {
    await ensureBansSeeded()
    const bans = await db.netsecBan.findMany({ orderBy: { bannedAt: 'desc' } })
    return ok(
      { bans, count: bans.length },
      'hybrid',
      'seeded ban registry (classic hostile-actor rows) — live enforcement requires the cockpit bridge on a managed host',
    )
  },

  ban: async (args: Record<string, unknown>) => {
    const ip = String(args.ip ?? '').trim()
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[0-9a-fA-F:]+$/.test(ip)) {
      return failE('a valid ip is required')
    }
    const service = String(args.service ?? 'sshd').trim() || 'sshd'
    const reason = String(args.reason ?? 'manual ban via web UI').trim()
    const strikes = Math.max(1, Math.min(100000, Number(args.strikes) || 1))
    const row = await db.netsecBan.create({
      data: { ip, service, reason, strikes, jail: 'sysdeck' },
    })
    await db.auditLog.create({
      data: { module: 'netsec', action: 'ban', detail: `${ip} (${service}) — ${reason}` },
    })
    return ok(
      { ban: row },
      'hybrid',
      'ban recorded in the registry — live nftables/firewall enforcement requires the cockpit bridge on a managed host',
    )
  },

  unban: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    try {
      const row = await db.netsecBan.delete({ where: { id } })
      await db.auditLog.create({
        data: { module: 'netsec', action: 'unban', detail: `${row.ip} (${row.service})` },
      })
      return ok({ removed: { ip: row.ip, service: row.service } }, 'hybrid')
    } catch {
      return failE('ban not found')
    }
  },

  scan: async (args: Record<string, unknown>) => {
    const target = String(args.target ?? 'localhost').trim()
    if (!LOCAL_TARGETS.has(target)) {
      return failE('the web edition sweeps only this host (localhost / 127.0.0.1 / ::1)', 'live')
    }
    const rows = allTcp().filter((r) => r.stateHex === '0A')
    const uniquePorts = [...new Set(rows.map((r) => r.localPort))].sort((a, b) => a - b)
    // connect-test each unique port on both loopbacks; a port counts as
    // open when either 127.0.0.1 or ::1 accepts the connection.
    const results = await Promise.all(
      uniquePorts.map(async (port) => {
        const [v4, v6] = await Promise.all([probePort('127.0.0.1', port), probePort('::1', port)])
        return { port, open: v4 || v6 }
      }),
    )
    const openPorts = results.filter((r) => r.open).map((r) => r.port)
    const row = await db.netsecScan.create({
      data: {
        target: 'localhost',
        kind: 'port-sweep',
        ports: openPorts.join(','),
        result: 'done',
      },
    })
    await db.auditLog.create({
      data: {
        module: 'netsec',
        action: 'scan',
        detail: `localhost sweep: ${results.length} ports, ${openPorts.length} open`,
      },
    })
    return ok(
      {
        id: row.id,
        target: 'localhost',
        scanned: results.length,
        open: openPorts.length,
        ports: results,
      },
      'live',
      'listening ports from /proc/net/tcp{,6}; each connect-tested on 127.0.0.1 and ::1 (300ms timeout)',
    )
  },

  summary: async () => {
    await ensureBansSeeded()
    const rows = allTcp()
    const stateCounts: Record<string, number> = {}
    for (const r of rows) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1
    const [bans, scans] = await Promise.all([db.netsecBan.count(), db.netsecScan.count()])
    return ok(
      {
        established: stateCounts['ESTABLISHED'] ?? 0,
        listening: stateCounts['LISTEN'] ?? 0,
        timeWait: stateCounts['TIME_WAIT'] ?? 0,
        totalSockets: rows.length,
        bans,
        scans,
      },
      'hybrid',
      'socket counts are live from /proc/net/tcp{,6}; bans/scans count the registry',
    )
  },
}
