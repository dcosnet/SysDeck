// SysDeck bridge — packages (dpkg/apt, real)
// Port of bridge/packages.py: the cockpit edition detected the distro's
// package manager (pacman/dnf/apt step-down) and wrapped it. This
// environment is Debian with dpkg/apt, so the web edition implements
// the apt backend directly (the python `_apt_*` functions): dpkg-query
// -W for the installed list, apt list --upgradable for updates,
// dpkg-query -s for info. install/remove fail honestly — the web
// edition runs unprivileged (the python bridge relied on cockpit's
// polkit superuser channel, which doesn't exist here) — and record the
// attempt in the audit log, mirroring the polkit action id the cockpit
// edition shipped (org.sysdeck.packages.manage).
import { db } from '@/lib/db'
import { ok, fail, run, readText } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

interface PkgRow {
  name: string
  version: string
  installed: boolean
}

interface PkgCache {
  ts: number
  rows: PkgRow[]
}

let listCache: PkgCache | null = null
const LIST_CACHE_TTL_MS = 60_000

async function loadList(): Promise<PkgRow[]> {
  if (listCache && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) return listCache.rows
  const r = await run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Status}\n'], 10_000)
  const rows: PkgRow[] = []
  for (const line of r.stdout.split('\n')) {
    const [name, version, status] = line.split('\t')
    if (!name) continue
    rows.push({ name, version: version ?? '', installed: (status ?? '').includes('installed') })
  }
  listCache = { ts: Date.now(), rows }
  return rows
}

interface UpdateRow {
  name: string
  current: string
  candidate: string
}

async function parseUpgradable(): Promise<UpdateRow[] | null> {
  const r = await run('apt', ['list', '--upgradable'], 15_000)
  if (r.rc !== 0 && !r.stdout) return null
  const out: UpdateRow[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line || line.startsWith('Listing')) continue
    // Format: "pkg/repo version arch [upgradable from: old]"
    const m = line.match(/^(\S+)\/(\S+)\s+(\S+)(?:.*\[upgradable from:\s*(\S+)\])?/)
    if (!m) continue
    out.push({ name: m[1], current: m[4] ?? '', candidate: m[3] ?? '' })
  }
  return out
}

async function lastInstallFromLog(): Promise<string | null> {
  // /var/log/dpkg.log lines: "2026-08-26 07:25:23 install pkg ...".
  // Read the tail only — the log can be long.
  const txt = await readText('/var/log/dpkg.log')
  if (!txt) return null
  const lines = txt.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]?.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (install|upgrade) (\S+)/)
    if (m) return `${m[1]} ${m[2]} ${m[3]}`
  }
  return null
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const rows = await loadList()
    const installed = rows.filter((r) => r.installed).length
    const updates = await parseUpgradable()
    let sizeKb: number | null = null
    const du = await run('du', ['-sk', '/var/lib/dpkg'], 5000)
    const duMatch = du.stdout.match(/^(\d+)/)
    if (du.rc === 0 && duMatch) sizeKb = Number(duMatch[1])

    const auditLast = await db.auditLog.findFirst({
      where: { module: 'packages', action: { in: ['install', 'remove'] } },
      orderBy: { ts: 'desc' },
    })

    return ok(
      {
        manager: 'apt',
        installed,
        upgradable: updates === null ? null : updates.length,
        lastInstall: auditLast
          ? `${auditLast.ts.toISOString()} ${auditLast.action} (audit log)`
          : ((await lastInstallFromLog()) ?? null),
        dpkgDbSizeKb: sizeKb,
      },
      'live',
      updates === null ? 'apt list --upgradable unavailable (timed out or no cache)' : undefined,
    )
  },

  list: async (args: Record<string, unknown>) => {
    const query = String(args.query ?? '').toLowerCase()
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 50))
    const offset = Math.max(0, Number(args.offset) || 0)
    const rows = await loadList()
    const filtered = query ? rows.filter((r) => r.name.toLowerCase().includes(query)) : rows
    return ok(
      {
        total: filtered.length,
        offset,
        limit,
        packages: filtered.slice(offset, offset + limit),
      },
      'live',
      'dpkg-query -W output cached 60s in module state',
    )
  },

  info: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    const r = await run('dpkg-query', ['-s', name], 10_000)
    if (r.rc !== 0) return failE(`package not found: ${name}`)
    const info: Record<string, string> = {}
    let lastKey = ''
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith(' ')) {
        // continuation line (multi-line Description)
        if (lastKey) info[lastKey] += `\n${line.trim()}`
        continue
      }
      const idx = line.indexOf(':')
      if (idx < 0) continue
      lastKey = line.slice(0, idx).trim().toLowerCase()
      info[lastKey] = line.slice(idx + 1).trim()
    }
    return ok(
      {
        name,
        version: info['version'] ?? '',
        status: info['status'] ?? '',
        depends: info['depends'] ?? '',
        description: info['description'] ?? '',
        maintainer: info['maintainer'] ?? '',
      },
      'live',
    )
  },

  updates: async () => {
    const updates = await parseUpgradable()
    if (updates === null) return failE('apt list --upgradable failed — try apt update first')
    return ok({ updates, count: updates.length }, 'live')
  },

  install: async (args: Record<string, unknown>) => {
    const names = Array.isArray(args.names) ? args.names.map(String) : [String(args.name ?? '')]
    const clean = names.map((n) => n.trim()).filter(Boolean)
    if (!clean.length) return failE('no package name provided')
    await db.auditLog.create({
      data: { module: 'packages', action: 'install', detail: `attempted: ${clean.join(', ')}` },
    })
    return failE('polkit: org.sysdeck.packages.manage — not authorized in web edition sandbox (unprivileged; no root in container)', 'hybrid')
  },

  remove: async (args: Record<string, unknown>) => {
    const names = Array.isArray(args.names) ? args.names.map(String) : [String(args.name ?? '')]
    const clean = names.map((n) => n.trim()).filter(Boolean)
    if (!clean.length) return failE('no package name provided')
    await db.auditLog.create({
      data: { module: 'packages', action: 'remove', detail: `attempted: ${clean.join(', ')}` },
    })
    return failE('polkit: org.sysdeck.packages.manage — not authorized in web edition sandbox (unprivileged; no root in container)', 'hybrid')
  },
}
