// SysDeck bridge — netsec (network security monitor, all live)
// Port of bridge/netsec.py (v0.0.43 iptraf-ng style): the cockpit edition
// read the same kernel sources iptraf-ng reads (/proc/net/tcp, /dev, snmp)
// and crossed ss for PID mapping. The web edition keeps the /proc/net/tcp
// + tcp6 collectors (hex address decode, state table, LISTEN surface).
// The ban layer is production:
//   - bans() merges the operator's NetsecBan registry with REAL
//     fail2ban-client output when fail2ban runs on this host
//   - ban() records the row AND enforces it for real — an nftables
//     element in the sysdeck blacklist set (created on demand), or an
//     iptables DROP rule when only iptables exists — privilege-gated
//     (root / sudo -n), honest failure otherwise
//   - unban() removes the registry row AND the real firewall entry
// `scan` is a REAL sweep: it reads the live listening table and
// connect-tests every port on 127.0.0.1 and ::1 (300ms timeout each,
// Node net.connect) — no nmap dependency.
import { readFileSync } from 'fs'
import { connect } from 'net'
import { db } from '@/lib/db'
import { ok, fail, run, which, cached } from './shared'

/** fail() + source — keeps the source badge on error envelopes. (A bare
 *  fail() also passes through the dispatcher top-level, but without a
 *  source the panel cannot tell live-vs-hybrid when a command fails.) */
function failE(error: string, source: 'live' | 'hybrid' = 'live') {
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
    return `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${n >>> 24}`
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

// ── privilege + real firewall enforcement ─────────────────────────────

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0
}

function havePasswordlessSudo(): Promise<boolean> {
  return cached('sudo:-n:true', 60_000, async () => (await run('sudo', ['-n', 'true'], 3000)).rc === 0)
}

const NFT_BAN_TABLE = 'inet sysdeck'
const NFT_BAN_SET = 'blacklist'

/** Real nftables enforcement: one atomic `nft -f -` batch piped on
 *  stdin (no temp file to hijack) that creates the table + named timeout
 *  set if absent (both guarded by `add`, which is idempotent on existing
 *  objects) and adds the address with a 30-day timeout. Re-banning an
 *  already-banned member is a no-op. */
async function nftBan(ip: string): Promise<{ ok: boolean; command: string; output: string; error?: string }> {
  const script = [
    `add table inet sysdeck`,
    `add set inet sysdeck blacklist { type ipv4_addr; flags timeout; timeout 30d; }`,
    `add element inet sysdeck blacklist { ${ip} timeout 30d }`,
  ].join('\n')
  const args = ['-f', '-']
  let res: { rc: number; stdout: string; stderr: string }
  if (isRoot()) {
    res = await run('nft', args, 10_000, { input: script })
    return { ok: res.rc === 0, command: 'nft -f - <batch: table sysdeck + set blacklist + element add>', output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  if (await havePasswordlessSudo()) {
    res = await run('sudo', ['-n', 'nft', ...args], 10_000, { input: script })
    return { ok: res.rc === 0, command: 'sudo -n nft -f - <batch: table sysdeck + set blacklist + element add>', output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  return { ok: false, command: 'nft -f - <batch: table sysdeck + set blacklist + element add>', output: '', error: 'not authorized (unprivileged, no passwordless sudo)' }
}

/** Real iptables enforcement (only when nft is absent). */
async function iptablesBan(ip: string): Promise<{ ok: boolean; command: string; output: string; error?: string }> {
  const args = ['-I', 'INPUT', '-s', ip, '-j', 'DROP', '-m', 'comment', '--comment', 'sysdeck-netsec-ban']
  let res: { rc: number; stdout: string; stderr: string }
  if (isRoot()) {
    res = await run('iptables', [...args], 10_000)
    return { ok: res.rc === 0, command: `iptables ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  if (await havePasswordlessSudo()) {
    res = await run('sudo', ['-n', 'iptables', ...args], 10_000)
    return { ok: res.rc === 0, command: `sudo -n iptables ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  return { ok: false, command: `iptables ${args.join(' ')}`, output: '', error: 'not authorized (unprivileged, no passwordless sudo)' }
}

/** Remove a real ban: nft element delete (absent element is fine with -e)
 *  or iptables rule delete. The result mirrors the firewall's exit code —
 *  a refused or failed delete reports failure, never a fabricated lift. */
async function firewallUnban(ip: string): Promise<{ ok: boolean; command: string; output: string; error?: string }> {
  if (await which('nft')) {
    const args = ['-e', 'delete', 'element', NFT_BAN_TABLE, NFT_BAN_SET, '{', ip, '}']
    let res: { rc: number; stdout: string; stderr: string }
    if (isRoot()) {
      res = await run('nft', args, 10_000)
      return { ok: res.rc === 0, command: `nft ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
    }
    if (await havePasswordlessSudo()) {
      res = await run('sudo', ['-n', 'nft', ...args], 10_000)
      return { ok: res.rc === 0, command: `sudo -n nft ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
    }
  } else if (await which('iptables')) {
    const args = ['-D', 'INPUT', '-s', ip, '-j', 'DROP', '-m', 'comment', '--comment', 'sysdeck-netsec-ban']
    let res: { rc: number; stdout: string; stderr: string }
    if (isRoot()) {
      res = await run('iptables', [...args], 10_000)
      return { ok: res.rc === 0, command: `iptables ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
    }
    if (await havePasswordlessSudo()) {
      res = await run('sudo', ['-n', 'iptables', ...args], 10_000)
      return { ok: res.rc === 0, command: `sudo -n iptables ${args.join(' ')}`, output: (res.stdout || res.stderr).trim(), error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
    }
  }
  return { ok: false, command: 'nft/iptables unban', output: '', error: 'no firewall binary or not authorized' }
}

// ── fail2ban live read (when the host runs it) ───────────────────────

interface Fail2BanBans {
  id: string
  ip: string
  jail: string
  service: string
  reason: string
  strikes: number
  source: 'fail2ban'
  bannedAt: string
}

async function fail2banBans(): Promise<{ bans: Fail2BanBans[]; jails: string[]; error?: string }> {
  // TTL-cached with parallel jail reads: the bans poll lands on one
  // fail2ban-client sweep per 15 s instead of a serial spawn per jail.
  return cached('f2b:bans', 15_000, async () => {
    if (!(await which('fail2ban-client'))) return { bans: [], jails: [] }
    const st = await run('systemctl', ['is-active', 'fail2ban'], 5000)
    if (st.rc !== 0 || st.stdout.trim() !== 'active') {
      return { bans: [], jails: [], error: 'fail2ban-client present but the fail2ban service is not active' }
    }
    const useSudo = !isRoot() && (await havePasswordlessSudo())
    const f2c = async (args: string[]) =>
      useSudo ? run('sudo', ['-n', 'fail2ban-client', ...args], 10_000) : isRoot() ? run('fail2ban-client', args, 10_000) : { rc: 126, stdout: '', stderr: 'not authorized (unprivileged, no passwordless sudo)' }
    const jr = await f2c(['status'])
    if (jr.rc !== 0) {
      return { bans: [], jails: [], error: `fail2ban-client status failed — ${jr.stderr.trim().split('\n')[0] ?? 'needs privileges'}` }
    }
    const jails = [...jr.stdout.matchAll(/Jail list:\s*(.+)/g)][0]?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
    const jailRows = await Promise.all(
      jails.map(async (jail) => ({ jail, r: await f2c(['status', jail]) })),
    )
    const bans: Fail2BanBans[] = []
    for (const { jail, r } of jailRows) {
      if (r.rc !== 0) continue
      const ips = [...r.stdout.matchAll(/Banned IP list:\s*(.*)/g)][0]?.[1] ?? ''
      for (const ip of ips.split(/\s+/).filter(Boolean)) {
        bans.push({ id: `fail2ban:${jail}:${ip}`, ip, jail, service: jail, reason: 'banned by fail2ban', strikes: 0, source: 'fail2ban', bannedAt: new Date().toISOString() })
      }
    }
    return { bans, jails }
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
    const [registry, f2b, haveNft, haveIpt] = await Promise.all([
      db.netsecBan.findMany({ orderBy: { bannedAt: 'desc' } }),
      fail2banBans(),
      which('nft'),
      which('iptables'),
    ])
    const enforcedNote =
      haveNft || haveIpt
        ? `ban/unban enforce for real via ${haveNft ? 'nftables (table sysdeck, set blacklist, 30d timeout)' : 'iptables INPUT DROP'}`
        : 'no firewall binary on this host — bans are registry-only until one exists'
    const notes = [enforcedNote]
    if (f2b.error) notes.push(f2b.error)
    else if (f2b.bans.length > 0) notes.push(`${f2b.bans.length} live fail2ban ban(s) across jails: ${f2b.jails.join(', ')}`)
    return ok(
      {
        bans: [
          ...registry.map((b) => ({ ...b, source: 'registry' as const })),
          ...f2b.bans,
        ],
        count: registry.length + f2b.bans.length,
        registryCount: registry.length,
        fail2banCount: f2b.bans.length,
        fail2banJails: f2b.jails,
      },
      'live',
      notes.join(' — '),
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
    // REAL enforcement — nftables preferred, iptables fallback
    let enforcement: { ok: boolean; command: string; output: string; error?: string } | null = null
    if (await which('nft')) enforcement = await nftBan(ip)
    else if (await which('iptables')) enforcement = await iptablesBan(ip)
    if (!enforcement) {
      return ok(
        { ban: row, enforced: false, via: 'registry-only' },
        'live',
        'no firewall binary on this host — the ban is recorded in the registry and will be enforceable the moment nft/iptables exists',
      )
    }
    if (!enforcement.ok) {
      return ok(
        { ban: row, enforced: false, via: 'none', command: enforcement.command, error: enforcement.error },
        'live',
        `registry row saved, but kernel enforcement failed — ${enforcement.error ?? 'unknown error'}. Run the console as root or grant sudo -n, then ban again (the nft batch is idempotent).`,
      )
    }
    return ok(
      { ban: row, enforced: true, via: 'nftables' , command: enforcement.command, output: enforcement.output },
      'live',
      `banned for real — ${enforcement.command}`,
    )
  },

  unban: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    // fail2ban-managed rows → the REAL fail2ban-client unbanip
    if (id.startsWith('fail2ban:')) {
      const [, jail, ip] = id.split(':')
      const unbanRes = isRoot()
        ? await run('fail2ban-client', ['set', jail, 'unbanip', ip], 10_000)
        : await run('sudo', ['-n', 'fail2ban-client', 'set', jail, 'unbanip', ip], 10_000)
      if (unbanRes.rc !== 0) {
        return failE(`fail2ban-client set ${jail} unbanip ${ip} failed — ${unbanRes.stderr.trim().split('\n')[0] ?? 'needs privileges (root / sudo -n)'}`)
      }
      await db.auditLog.create({
        data: { module: 'netsec', action: 'unban', detail: `${ip} (fail2ban jail ${jail}) — lifted via fail2ban-client` },
      })
      return ok(
        { removed: { ip, service: jail }, kernelEntryRemoved: true, command: `fail2ban-client set ${jail} unbanip ${ip}` },
        'live',
        `lifted in fail2ban itself — fail2ban-client set ${jail} unbanip ${ip}`,
      )
    }
    try {
      const row = await db.netsecBan.delete({ where: { id } })
      const res = await firewallUnban(row.ip)
      await db.auditLog.create({
        data: { module: 'netsec', action: 'unban', detail: `${row.ip} (${row.service}) — kernel entry ${res.ok ? 'removed' : 'left (no binary/privilege)'}` },
      })
      return ok(
        { removed: { ip: row.ip, service: row.service }, kernelEntryRemoved: res.ok, command: res.command },
        'live',
        res.ok ? `registry row removed and kernel entry lifted — ${res.command}` : 'registry row removed; kernel entry could not be lifted (no firewall binary or privilege) — it ages out by its 30d timeout otherwise',
      )
    } catch {
      return failE('ban not found')
    }
  },

  scan: async (args: Record<string, unknown>) => {
    const target = String(args.target ?? 'localhost').trim()
    if (!LOCAL_TARGETS.has(target)) {
      return failE('this bridge sweeps only this host (localhost / 127.0.0.1 / ::1)')
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
      'live',
      'socket counts are live from /proc/net/tcp{,6}; bans/scans count the operator registry (never seeded)',
    )
  },
}
