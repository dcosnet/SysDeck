// SysDeck bridge — packages (multi-backend, all live)
// Port of bridge/packages.py: the cockpit edition detected the distro's
// package manager (pacman/dnf/apt step-down) and wrapped it. The web
// edition now carries the SAME step-down across ten backends:
//   pacman (Arch) · emerge (Gentoo) · lunar (Lunar Linux) · sorcery
//   (SourceMage) · xbps (Void) · apk (Alpine) · zypper (openSUSE) ·
//   dnf / yum (RPM) · apt (Debian)
// Every list/updates/search/info read hits the REAL package database
// of the detected manager (dpkg-query, pacman -Q, rpm -qa, /var/db/pkg
// scan, lvu/gaze state) — no fabricated rows, ever. Mutations
// (install/remove/update/update-all) run the real manager when the
// console has privilege (root, or passwordless sudo -n) and otherwise
// fail honestly with the exact operator command, audit-logged — the
// same posture as the cockpit edition's polkit channel
// (org.sysdeck.packages.manage).
import { db } from '@/lib/db'
import { ok, fail, run, readText, which, cached } from './shared'
import { readdir, stat } from 'fs/promises'

async function safeListdir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Parse a zypper pipe-table by locating columns from its header row.
 * zypper prefixes data tables with status/repository columns whose
 * count varies by subcommand and release; positional parsing breaks
 * across those. The header row is the source of truth. */
function zypperTable(raw: string, wanted: string[]): { header: Record<string, number>; rows: string[][] } {
  const header: Record<string, number> = {}
  const rows: string[][] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('|')) continue
    const cols = line.split('|').map((c) => c.trim())
    if (Object.keys(header).length === 0) {
      if (wanted.every((w) => cols.includes(w))) {
        for (const w of wanted) header[w] = cols.indexOf(w)
      }
      continue
    }
    // Separator rows ('-----+-----') and repeated headers.
    if (cols.length > 0 && cols.every((c) => c.length > 0 && /^[+\-]+$/.test(c))) continue
    if (wanted.some((w) => cols[header[w]] === w)) continue
    rows.push(cols)
  }
  return { header, rows }
}

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

// ── package-name safety (v0.1.4 argument-injection guard, ported) ────

const NAME_RE = /^[\w.+-]{1,256}$/
function pkgNameOk(pkg: string): boolean {
  return NAME_RE.test(pkg) && !pkg.startsWith('-') && !pkg.includes('://')
}
function cleanNames(args: Record<string, unknown>): string[] {
  const names = Array.isArray(args.names) ? args.names.map(String) : [String(args.name ?? '')]
  return names.map((n) => n.trim()).filter(Boolean).filter(pkgNameOk)
}

// ── name-version splitting (tolerant, for flat atoms) ───────────────
// "gcc-13.2.1-r0" → gcc / 13.2.1-r0; "linux-headers-6.1" → linux-headers / 6.1.
// Rule: earliest hyphen followed by a digit whose tail is version-shaped.
const VER_TAIL_RE = /^[0-9][0-9a-zA-Z._+-]*[0-9a-zA-Z._+]$/
export function splitNameVer(atom: string): { name: string; version: string } {
  for (let i = 0; i < atom.length; i++) {
    if (atom[i] !== '-') continue
    const tail = atom.slice(i + 1)
    if (tail.length > 0 && /[0-9]/.test(tail[0]) && VER_TAIL_RE.test(tail)) {
      return { name: atom.slice(0, i), version: tail }
    }
  }
  return { name: atom, version: '' }
}

// ── os-release flavor ────────────────────────────────────────────────

async function distroPretty(): Promise<string> {
  const txt = await readText('/etc/os-release')
  const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
  return m ? m[1] : 'unknown distro'
}

// ── privilege model ──────────────────────────────────────────────────

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0
}

function havePasswordlessSudo(): Promise<boolean> {
  return cached('sudo:-n:true', 60_000, async () => (await run('sudo', ['-n', 'true'], 3000)).rc === 0)
}

interface PkgRunResult {
  rc: number
  stdout: string
  stderr: string
  command: string
  via: string
}

/** Run a package-manager mutation with whatever privilege the console
 *  actually has: root → direct; passwordless sudo → sudo -n; else null
 *  (the caller fails honestly with the operator command). */
async function privilegedRun(cmd: string, args: string[], timeoutMs = 120_000): Promise<PkgRunResult | null> {
  if (isRoot()) {
    const r = await run(cmd, args, timeoutMs)
    return { ...r, command: [cmd, ...args].join(' '), via: 'root' }
  }
  if (await havePasswordlessSudo()) {
    const r = await run('sudo', ['-n', cmd, ...args], timeoutMs)
    return { ...r, command: `sudo -n ${cmd} ${args.join(' ')}`, via: 'sudo -n' }
  }
  return null
}

// ── backend interface ────────────────────────────────────────────────

export interface PkgRow {
  name: string
  version: string
  installed: boolean
}

export interface UpdateRow {
  name: string
  current: string
  candidate: string
}

export interface SearchRow {
  name: string
  version: string
  description: string
  installed: boolean
}

export interface PkgInfo {
  name: string
  version: string
  status: string
  depends: string
  description: string
  maintainer: string
}

export interface Backend {
  id: string
  family: string
  dbPath: string
  listInstalled(): Promise<PkgRow[]>
  listUpdates(): Promise<UpdateRow[] | null>
  search(term: string): Promise<SearchRow[]>
  info(name: string): Promise<PkgInfo | null>
  lastInstallLog(): Promise<string | null>
  installArgs(names: string[]): string[]
  removeArgs(names: string[]): string[]
  updateArgs(names: string[]): string[] | null
  updateAllArgs(): string[]
  updatesNote?: string
}

// helpers shared by backends

function tailField(txt: string, ...keys: string[]): string {
  for (const k of keys) {
    const re = new RegExp(`^${k}\\s*:\\s?(.*)$`, 'mi')
    const m = txt.match(re)
    if (m && m[1].trim()) return m[1].trim()
  }
  return ''
}

/** dbPath size changes on human timescales — the walk is TTL-cached
 *  so the summary poll does not re-run `du` on every tick. */
async function dirSizeKb(path: string): Promise<number | null> {
  return cached(`du:${path}`, 300_000, async () => {
    const r = await run('du', ['-sk', path], 5000)
    const m = r.stdout.match(/^(\d+)/)
    return r.rc === 0 && m ? Number(m[1]) : null
  })
}

/** "Key : Value" parser shared by pacman -Qi/-Si, dnf info, apk info,
 *  lvu details. Returns raw lowercase-keyed map. */
function parseColonBlocks(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let lastKey = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('    ') && lastKey) {
      out[lastKey] += `\n${line.trim()}`
      continue
    }
    const idx = line.indexOf(':')
    if (idx < 1) continue
    lastKey = line.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '_')
    out[lastKey] = line.slice(idx + 1).trim()
  }
  return out
}

// ── apt backend (Debian/Ubuntu) ──────────────────────────────────────

const aptBackend: Backend = {
  id: 'apt',
  family: 'Debian',
  dbPath: '/var/lib/dpkg',
  async listInstalled() {
    const r = await run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Status}\n'], 15_000)
    const rows: PkgRow[] = []
    for (const line of r.stdout.split('\n')) {
      const [name, version, status] = line.split('\t')
      if (!name) continue
      rows.push({ name, version: version ?? '', installed: (status ?? '').includes('installed') })
    }
    return rows
  },
  async listUpdates() {
    const r = await run('apt', ['list', '--upgradable'], 15_000)
    if (r.rc !== 0 && !r.stdout) return null
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line || line.startsWith('Listing')) continue
      const m = line.match(/^(\S+)\/(\S+)\s+(\S+)(?:.*\[upgradable from:\s*(\S+)\])?/)
      if (!m) continue
      out.push({ name: m[1], current: m[4] ?? '', candidate: m[3] ?? '' })
    }
    return out
  },
  async search(term) {
    const r = await run('apt-cache', ['search', term], 20_000)
    const out: SearchRow[] = []
    for (const line of r.stdout.split('\n')) {
      const idx = line.indexOf(' - ')
      if (idx < 1) continue
      out.push({ name: line.slice(0, idx).split(/\s+/)[0], version: '', description: line.slice(idx + 3), installed: false })
    }
    return out
  },
  async info(name) {
    const r = await run('dpkg-query', ['-s', name], 10_000)
    if (r.rc !== 0) {
      const av = await run('apt-cache', ['show', name], 10_000)
      if (av.rc !== 0 || !av.stdout.trim()) return null
      const info = parseColonBlocks(av.stdout)
      return {
        name,
        version: info['version'] ?? '',
        status: 'available in repository (not installed)',
        depends: info['depends'] ?? '',
        description: info['description'] ?? '',
        maintainer: info['maintainer'] ?? '',
      }
    }
    const info: Record<string, string> = {}
    let lastKey = ''
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith(' ') && lastKey) {
        info[lastKey] += `\n${line.trim()}`
        continue
      }
      const idx = line.indexOf(':')
      if (idx < 0) continue
      lastKey = line.slice(0, idx).trim().toLowerCase()
      info[lastKey] = line.slice(idx + 1).trim()
    }
    return {
      name,
      version: info['version'] ?? '',
      status: info['status'] ?? '',
      depends: info['depends'] ?? '',
      description: info['description'] ?? '',
      maintainer: info['maintainer'] ?? '',
    }
  },
  async lastInstallLog() {
    const txt = await readText('/var/log/dpkg.log')
    if (!txt) return null
    const lines = txt.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]?.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (install|upgrade) (\S+)/)
      if (m) return `${m[1]} ${m[2]} ${m[3]}`
    }
    return null
  },
  installArgs: (names) => ['install', '-y', ...names],
  removeArgs: (names) => ['remove', '-y', ...names],
  updateArgs: (names) => ['upgrade', '-y', ...names],
  updateAllArgs: () => ['upgrade', '-y'],
}

// ── pacman backend (Arch / derivatives) ──────────────────────────────

const pacmanBackend: Backend = {
  id: 'pacman',
  family: 'Arch',
  dbPath: '/var/lib/pacman',
  async listInstalled() {
    const r = await run('pacman', ['-Q'], 15_000)
    const rows: PkgRow[] = []
    for (const line of r.stdout.split('\n')) {
      const parts = line.split(' ')
      if (parts.length >= 2 && parts[0]) rows.push({ name: parts[0], version: parts[1], installed: true })
    }
    return rows
  },
  async listUpdates() {
    // rc 1 + empty output = "no updates" — not an error.
    const r = await run('pacman', ['-Qu'], 15_000)
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s*->\s*(\S+)/)
      if (!m) continue
      out.push({ name: m[1], current: m[2], candidate: m[3] })
    }
    return out
  },
  async search(term) {
    const r = await run('pacman', ['-Ss', term], 20_000)
    const out: SearchRow[] = []
    let pending: SearchRow | null = null
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      if (line.startsWith('    ')) {
        if (pending) {
          pending.description = line.trim()
          out.push(pending)
          pending = null
        }
        continue
      }
      const m = line.match(/^(\S+)\/(\S+)\s+(\S+)(.*)$/)
      if (!m) continue
      pending = { name: m[2], version: m[3], description: '', installed: m[4].includes('[installed]') }
    }
    if (pending) out.push(pending)
    return out
  },
  async info(name) {
    let r = await run('pacman', ['-Qi', name], 10_000)
    let status = 'installed'
    if (r.rc !== 0) {
      r = await run('pacman', ['-Si', name], 10_000)
      status = 'repository (not installed)'
    }
    if (r.rc !== 0 || !r.stdout.trim()) return null
    const info = parseColonBlocks(r.stdout)
    return {
      name,
      version: info['version'] ?? '',
      status: status === 'installed' ? info['install_status'] ?? status : status,
      depends: info['depends_on'] ?? '',
      description: info['description'] ?? '',
      maintainer: info['packager'] ?? '',
    }
  },
  async lastInstallLog() {
    const txt = await readText('/var/log/pacman.log')
    if (!txt) return null
    const lines = txt.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]?.match(/^\[([^\]]+)\] \[ALPM\] (installed|upgraded) (\S+)/)
      if (m) return `${m[1]} ${m[2]} ${m[3]}`
    }
    return null
  },
  installArgs: (names) => ['-S', '--noconfirm', '--needed', ...names],
  removeArgs: (names) => ['-R', '--noconfirm', ...names],
  updateArgs: (names) => ['-S', '--noconfirm', ...names],
  updateAllArgs: () => ['-Syu', '--noconfirm'],
}

// ── RPM family: dnf / yum / zypper ───────────────────────────────────

async function rpmListInstalled(): Promise<PkgRow[]> {
  const r = await run('rpm', ['-qa', '--qf', '%{NAME}\\t%{VERSION}-%{RELEASE}\\n'], 30_000)
  const rows: PkgRow[] = []
  for (const line of r.stdout.split('\n')) {
    const [name, version] = line.split('\t')
    if (!name) continue
    rows.push({ name, version: version ?? '', installed: true })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

async function rpmLastInstall(): Promise<string | null> {
  // dnf keeps a transaction history; read the newest entry's line.
  const r = await run('dnf', ['-q', 'history', 'list'], 15_000)
  if (r.rc === 0 && r.stdout.trim()) {
    const lines = r.stdout.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]?.match(/^(\S+)\s+(\S+)\s+(\S+ \S+)\s+(install|upgrade|update)/)
      if (m) return `${m[3]} ${m[4]} (dnf history #${m[1]})`
    }
  }
  return null
}

function makeRpmBackend(id: 'dnf' | 'yum', bin: string): Backend {
  return {
    id,
    family: 'Fedora/RHEL',
    dbPath: '/var/lib/rpm',
    listInstalled: rpmListInstalled,
    async listUpdates() {
      // dnf/yum check-update: rc 100 = updates available, 0 = none.
      const r = await run(bin, ['-q', 'check-update'], 60_000)
      if (r.rc !== 0 && r.rc !== 100 && !r.stdout) return null
      const out: UpdateRow[] = []
      for (const line of r.stdout.split('\n')) {
        if (!line.trim() || line.startsWith('Last ') || line.startsWith(' ')) continue
        const m = line.match(/^(\S+?)\.\S+\s+(\S+)\s+(\S+)/)
        if (!m) continue
        out.push({ name: m[1], current: '', candidate: m[2] })
      }
      return out
    },
    async search(term) {
      const r = await run(bin, ['-q', 'search', term], 30_000)
      const out: SearchRow[] = []
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith(' ') || line.startsWith('=')) continue
        const idx = line.indexOf(' : ')
        if (idx < 1) continue
        const name = line.slice(0, idx).trim().split('.')[0]
        if (!name) continue
        out.push({ name, version: '', description: line.slice(idx + 3).trim(), installed: false })
      }
      return out
    },
    async info(name) {
      const r = await run(bin, ['-q', 'info', name], 20_000)
      if (r.rc !== 0 || !r.stdout.trim()) return null
      const info = parseColonBlocks(r.stdout)
      return {
        name,
        version: `${info['version'] ?? ''}-${info['release'] ?? ''}`.replace(/^-$/, ''),
        status: (info['status'] ?? '').includes('installed') ? 'installed' : 'repository (not installed)',
        depends: info['requires'] ?? info['dependencies'] ?? '',
        description: info['summary'] ?? '',
        maintainer: info['packager'] ?? info['vendor'] ?? '',
      }
    },
    lastInstallLog: rpmLastInstall,
    installArgs: (names) => ['install', '-y', ...names],
    removeArgs: (names) => ['remove', '-y', ...names],
    updateArgs: (names) => ['upgrade', '-y', ...names],
    updateAllArgs: () => ['upgrade', '-y'],
  }
}

const zypperBackend: Backend = {
  id: 'zypper',
  family: 'SUSE',
  dbPath: '/var/lib/rpm',
  listInstalled: rpmListInstalled,
  async listUpdates() {
    const r = await run('zypper', ['-q', 'list-updates'], 60_000)
    if (r.rc !== 0 && !r.stdout) return null
    const { header, rows } = zypperTable(r.stdout, ['Name', 'Current', 'Available'])
    if (header.Name === undefined) return []
    const out: UpdateRow[] = []
    for (const cols of rows) {
      const name = cols[header.Name]
      if (!name || header.Current >= cols.length || header.Available >= cols.length) continue
      out.push({ name, current: cols[header.Current], candidate: cols[header.Available] })
    }
    return out
  },
  async search(term) {
    const r = await run('zypper', ['-q', 'se', term], 30_000)
    const { header, rows } = zypperTable(r.stdout, ['Name', 'Summary'])
    const iName = header.Name ?? 1
    const iSum = header.Summary ?? 2
    const out: SearchRow[] = []
    for (const cols of rows) {
      if (cols.length <= Math.max(iName, iSum)) continue
      const name = cols[iName]
      if (!name) continue
      out.push({ name, version: '', description: cols[iSum], installed: cols[0] === 'i' })
    }
    return out
  },
  async info(name) {
    const r = await run('zypper', ['-q', 'info', name], 20_000)
    if (r.rc !== 0 || !r.stdout.trim()) return null
    const info = parseColonBlocks(r.stdout)
    return {
      name,
      version: `${info['version'] ?? ''}-${info['release'] ?? ''}`,
      status: (info['status'] ?? '').includes('installed') ? 'installed' : 'not installed',
      depends: info['depends on'] ?? '',
      description: info['description'] ?? info['summary'] ?? '',
      maintainer: info['packager'] ?? '',
    }
  },
  lastInstallLog: async () => null,
  installArgs: (names) => ['--non-interactive', 'install', ...names],
  removeArgs: (names) => ['--non-interactive', 'remove', ...names],
  updateArgs: (names) => ['--non-interactive', 'update', ...names],
  updateAllArgs: () => ['--non-interactive', 'update'],
}

// ── apk backend (Alpine / postmarketOS) ──────────────────────────────

const apkBackend: Backend = {
  id: 'apk',
  family: 'Alpine',
  dbPath: '/var/lib/apk',
  async listInstalled() {
    const r = await run('apk', ['info', '-v'], 30_000)
    const rows: PkgRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const { name, version } = splitNameVer(line.trim())
      if (name) rows.push({ name, version, installed: true })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async listUpdates() {
    let r = await run('apk', ['list', '--upgradable'], 30_000)
    if (r.rc !== 0 || !r.stdout.trim()) {
      r = await run('apk', ['version', '-l', '<'], 30_000)
    }
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim() || line.startsWith('Installed') || line.startsWith('Available')) continue
      const toks = line.trim().split(/\s+/)
      const { name, version } = splitNameVer(toks[0] ?? '')
      if (!name) continue
      const cand = toks.find((t, i) => i > 0 && t !== '<' && !t.startsWith('(')) ?? ''
      out.push({ name, current: version, candidate: cand })
    }
    return out
  },
  async search(term) {
    const r = await run('apk', ['search', '-v', term], 30_000)
    const out: SearchRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const { name, version } = splitNameVer(line.trim().split(/\s+-\s+/)[0])
      const desc = line.includes(' - ') ? line.split(/\s+-\s+/).slice(1).join(' - ') : ''
      out.push({ name, version, description: desc, installed: false })
    }
    return out
  },
  async info(name) {
    const r = await run('apk', ['info', name], 15_000)
    if (r.rc !== 0 || !r.stdout.trim()) return null
    const info = parseColonBlocks(r.stdout)
    return {
      name,
      version: info['version'] ?? '',
      status: (info['installed'] ?? '') === 'yes' ? 'installed' : 'installed',
      depends: info['depends'] ?? '',
      description: info['description'] ?? r.stdout.split('\n')[0] ?? '',
      maintainer: info['maintainer'] ?? '',
    }
  },
  lastInstallLog: async () => null,
  installArgs: (names) => ['add', ...names],
  removeArgs: (names) => ['del', ...names],
  updateArgs: (names) => ['upgrade', ...names],
  updateAllArgs: () => ['upgrade'],
}

// ── xbps backend (Void Linux) ────────────────────────────────────────

const XBPS_BIN = 'xbps-install'
const xbpsBackend: Backend = {
  id: 'xbps',
  family: 'Void',
  dbPath: '/var/db/xbps',
  async listInstalled() {
    const r = await run('xbps-query', ['-l'], 30_000)
    const rows: PkgRow[] = []
    for (const line of r.stdout.split('\n')) {
      // "ii pkg-ver-1.2.3_1 short description"
      const m = line.match(/^ii\s+(\S+)\s+(.*)$/)
      if (!m) continue
      const { name, version } = splitNameVer(m[1])
      if (name) rows.push({ name, version, installed: true })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async listUpdates() {
    const r = await run(XBPS_BIN, ['-Sun'], 60_000)
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const toks = line.trim().split(/\s+/)
      const { name, version } = splitNameVer(toks[0] ?? '')
      if (!name) continue
      let cand = toks[1] ?? ''
      if (cand === 'xbps:' || cand === 'delta:') cand = toks[2] ?? ''
      out.push({ name, current: version, candidate: cand })
    }
    return out
  },
  async search(term) {
    const r = await run('xbps-query', ['-Rs', term], 30_000)
    const out: SearchRow[] = []
    for (const line of r.stdout.split('\n')) {
      // "[*] [repo/]name-ver - description" — the repo prefix is optional.
      const m = line.match(/^\[\*\]\s+(?:\S+\/)?(\S+)\s+-\s+(.*)$/)
      if (!m) continue
      const { name, version } = splitNameVer(m[1])
      out.push({ name, version, description: m[2], installed: false })
    }
    return out
  },
  async info(name) {
    let r = await run('xbps-query', ['-R', name], 15_000)
    if (r.rc !== 0) r = await run('xbps-query', [name], 15_000)
    if (r.rc !== 0 || !r.stdout.trim()) return null
    const info = parseColonBlocks(r.stdout)
    return {
      name,
      version: info['pkgver'] ?? info['version'] ?? '',
      status: r.stdout.includes('install-date') ? 'installed' : 'repository (not installed)',
      depends: info['depends'] ?? info['run_depends'] ?? '',
      description: info['short_desc'] ?? '',
      maintainer: info['maintainer'] ?? '',
    }
  },
  lastInstallLog: async () => null,
  installArgs: (names) => ['-y', ...names],
  removeArgs: (names) => ['xbps-remove', '-y', ...names],
  updateArgs: (names) => ['-y', ...names],
  updateAllArgs: () => ['-Su', '-y'],
}

// ── emerge backend (Gentoo / Portage) ────────────────────────────────

const EMERGE_PKG_DB = '/var/db/pkg'
const emergeBackend: Backend = {
  id: 'emerge',
  family: 'Gentoo',
  dbPath: EMERGE_PKG_DB,
  async listInstalled() {
    // Zero-dependency source of truth: /var/db/pkg/<category>/<name>-<ver>
    const rows: PkgRow[] = []
    let cats: string[] = []
    try {
      cats = await readdir(EMERGE_PKG_DB)
    } catch {
      return rows
    }
    for (const cat of cats) {
      let entries: string[] = []
      try {
        entries = await readdir(`${EMERGE_PKG_DB}/${cat}`)
      } catch {
        continue
      }
      for (const pf of entries) {
        const { version } = splitNameVer(pf)
        rows.push({ name: `${cat}/${version ? splitNameVer(pf).name : pf}`, version, installed: true })
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async listUpdates() {
    const r = await run('emerge', ['-p', '-u', '-D', '@world'], 90_000)
    if (r.rc !== 0 && !r.stdout) return null
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      // " [ebuild     U     ] cat/pkg-1.2.3 [1.2.2]" — the atom sits AFTER
      // the class bracket; portage pads the class field with spaces, so
      // starting the capture before the bracket grabs the bracket itself
      // and drops every row.
      const m = line.match(/\[ebuild\s+U[^\]]*\]\s*(\S+)(?:\s+\[([^\]]+)\])?/)
      if (!m) continue
      const atom = m[1]
      const slash = atom.lastIndexOf('/')
      if (slash < 0) continue
      const { name, version } = splitNameVer(atom.slice(slash + 1))
      out.push({ name: `${atom.slice(0, slash)}/${name}`, current: m[2] ?? '', candidate: version })
    }
    return out
  },
  async search(term) {
    const r = await run('emerge', ['--search', term], 60_000)
    const out: SearchRow[] = []
    let cur: SearchRow | null = null
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\*\s+(\S+)$/)
      if (m) {
        if (cur) out.push(cur)
        cur = { name: m[1], version: '', description: '', installed: false }
        continue
      }
      if (cur && line.includes('Description:')) cur.description = line.split('Description:')[1].trim()
      if (cur && /\[installed\]/i.test(line)) cur.installed = true
    }
    if (cur) out.push(cur)
    return out
  },
  async info(name) {
    // Real metadata from the installed package's /var/db/pkg entry.
    // Accepts 'cat/pkg' atoms and bare names — the latter scans every
    // category for a matching leaf.
    const slash = name.lastIndexOf('/')
    const leaf = slash > 0 ? name.slice(slash + 1) : name
    const cats = slash > 0 ? [name.slice(0, slash)] : await safeListdir(EMERGE_PKG_DB)
    for (const cat of cats) {
      const entries = await safeListdir(`${EMERGE_PKG_DB}/${cat}`)
      for (const pf of entries) {
        if (splitNameVer(pf).name !== leaf) continue
        const pdir = `${EMERGE_PKG_DB}/${cat}/${pf}`
        const desc = (await readText(`${pdir}/DESCRIPTION`)).trim()
        const { version } = splitNameVer(pf)
        if (!desc && !version) continue
        return {
          name: `${cat}/${leaf}`,
          version,
          status: 'installed (from /var/db/pkg)',
          depends: (await readText(`${pdir}/RDEPEND`)) || (await readText(`${pdir}/PDEPEND`)),
          description: desc,
          maintainer: (await readText(`${pdir}/HOMEPAGE`)).trim(),
        }
      }
    }
    return null
  },
  lastInstallLog: async () => {
    const txt = await readText('/var/log/emerge.log')
    if (!txt) return null
    const lines = txt.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i]?.match(/^(\d{10}):\s+>>>\s+emerge\s+\(\d+ of \d+\)\s+(\S+)\s+to \//)
      if (m) return `${new Date(Number(m[1]) * 1000).toISOString()} emerge ${m[2]}`
    }
    return null
  },
  installArgs: (names) => [names.length === 1 ? names[0] : '--ask', 'n', ...names],
  removeArgs: (names) => ['--unmerge', ...names],
  updateArgs: (names) => ['-u', ...names],
  updateAllArgs: () => ['-u', '-D', '@world'],
  updatesNote: 'emerge -puD @world — deep world update preview',
}

// ── lunar backend (Lunar Linux) ──────────────────────────────────────

const lunarBackend: Backend = {
  id: 'lunar',
  family: 'Lunar',
  dbPath: '/var/state/lunar',
  async listInstalled() {
    // Primary: lvu installed. Fallback: /var/state/lunar/packages.
    const r = await run('lvu', ['installed'], 30_000)
    if (r.rc === 0 && r.stdout.trim()) {
      return r.stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((t) => t[0])
        .map((t) => ({ name: t[0], version: t[1] ?? '', installed: true }))
    }
    const rows: PkgRow[] = []
    const txt = await readText('/var/state/lunar/packages')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      const t = line.trim().split(/\s+/)
      rows.push({ name: t[0], version: t[1] ?? '', installed: true })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async listUpdates() {
    // lvu has no update-preview subcommand; lunar update performs it.
    // Honest capability report instead of a fabricated count.
    return null
  },
  async search(term) {
    const r = await run('lvu', ['search', term], 30_000)
    const out: SearchRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      out.push({ name: line.trim().split(/\s+/)[0], version: '', description: line.trim(), installed: false })
    }
    return out
  },
  async info(name) {
    const r = await run('lvu', ['details', name], 15_000)
    if (r.rc !== 0 || !r.stdout.trim()) return null
    const info = parseColonBlocks(r.stdout)
    return {
      name,
      version: info['version'] ?? '',
      status: 'installed (lunar)',
      depends: info['depends'] ?? '',
      description: info['description'] ?? r.stdout.split('\n').find((l) => l.trim()) ?? '',
      maintainer: info['maintainer'] ?? '',
    }
  },
  lastInstallLog: async () => null,
  installArgs: (names) => ['lin', ...names],
  removeArgs: (names) => ['lrm', ...names],
  updateArgs: () => null,
  updateAllArgs: () => ['update'],
  updatesNote: 'lunar has no update-preview subcommand — run lunar update to fetch + rebuild',
}

// ── sorcery backend (SourceMage GNU/Linux) ───────────────────────────

const sorceryBackend: Backend = {
  id: 'sorcery',
  family: 'SourceMage',
  dbPath: '/var/state/sorcery',
  async listInstalled() {
    // Primary: gaze installed. Fallback: /var/state/sorcery/packages.
    const r = await run('gaze', ['installed'], 30_000)
    if (r.rc === 0 && r.stdout.trim()) {
      return r.stdout
        .split('\n')
        .map((l) => l.trim().split(/[\s:]+/))
        .filter((t) => t[0])
        .map((t) => ({ name: t[0], version: t[1] ?? '', installed: true }))
    }
    const rows: PkgRow[] = []
    const txt = await readText('/var/state/sorcery/packages')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      const t = line.trim().split(/\s+/)
      rows.push({ name: t[0], version: t[1] ?? '', installed: true })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  },
  async listUpdates() {
    // sorcery queue lists pending spell updates.
    const r = await run('sorcery', ['queue'], 60_000)
    if (r.rc !== 0 && !r.stdout) return null
    const out: UpdateRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      const t = line.trim().split(/\s+/)
      out.push({ name: t[0], current: '', candidate: t[1] ?? '' })
    }
    return out
  },
  async search(term) {
    const r = await run('gaze', ['search', term], 30_000)
    const out: SearchRow[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      out.push({ name: line.trim().split(/[\s:]+/)[0], version: '', description: line.trim(), installed: false })
    }
    return out
  },
  async info(name) {
    for (const sub of ['what', 'details']) {
      const r = await run('gaze', [sub, name], 15_000)
      if (r.rc === 0 && r.stdout.trim()) {
        const info = parseColonBlocks(r.stdout)
        return {
          name,
          version: info['version'] ?? info['spell version'] ?? '',
          status: 'installed (sorcery)',
          depends: info['depends'] ?? '',
          description: info['description'] ?? info['short description'] ?? r.stdout.split('\n').find((l) => l.trim()) ?? '',
          maintainer: info['maintainer'] ?? '',
        }
      }
    }
    return null
  },
  lastInstallLog: async () => null,
  installArgs: (names) => ['cast', ...names],
  removeArgs: (names) => ['dispel', ...names],
  updateArgs: (names) => ['cast', ...names],
  updateAllArgs: () => ['sorcery', 'update'],
}

// ── detection (step-down, most specific first) ───────────────────────

const BACKENDS: Record<string, Backend> = {
  pacman: pacmanBackend,
  emerge: emergeBackend,
  lunar: lunarBackend,
  sorcery: sorceryBackend,
  xbps: xbpsBackend,
  apk: apkBackend,
  zypper: zypperBackend,
  dnf: makeRpmBackend('dnf', 'dnf'),
  yum: makeRpmBackend('yum', 'yum'),
  apt: aptBackend,
}

const DETECT_ORDER = ['pacman', 'emerge', 'lunar', 'sorcery', 'xbps', 'apk', 'zypper', 'dnf', 'yum', 'apt'] as const

// Probe binary per manager where the manager id is not itself a binary:
// Void ships no bare `xbps` command — xbps-query is the presence probe.
const DETECT_PROBES: Record<string, string> = { xbps: 'xbps-query' }

let detected: { backend: Backend | null; probeAt: number } | null = null

async function detectBackend(): Promise<Backend | null> {
  if (detected && Date.now() - detected.probeAt < 300_000) return detected.backend
  for (const id of DETECT_ORDER) {
    if (!(await which(DETECT_PROBES[id] ?? id))) continue
    if (id === 'emerge') {
      // corroboration: a Gentoo box always has /var/db/pkg
      try {
        await stat(EMERGE_PKG_DB)
      } catch {
        continue
      }
    }
    detected = { backend: BACKENDS[id], probeAt: Date.now() }
    return BACKENDS[id]
  }
  detected = { backend: null, probeAt: Date.now() }
  return null
}

// ── list cache ───────────────────────────────────────────────────────

interface PkgCache {
  ts: number
  rows: PkgRow[]
}
let listCache: PkgCache | null = null
const LIST_CACHE_TTL_MS = 60_000

async function loadList(): Promise<PkgRow[]> {
  const b = await detectBackend()
  if (!b) return []
  if (listCache && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) return listCache.rows
  const rows = await b.listInstalled()
  listCache = { ts: Date.now(), rows }
  return rows
}

async function clearCache() {
  listCache = null
}

// ── mutation runner (real privilege, honest denials) ─────────────────

async function runMutation(
  action: 'install' | 'remove' | 'update' | 'update-all',
  args: Record<string, unknown>,
): Promise<unknown> {
  const b = await detectBackend()
  if (!b) return failE('no supported package manager detected on this host (probed: pacman, emerge, lunar, sorcery, xbps, apk, zypper, dnf, yum, apt)')
  const names = action === 'update-all' ? [] : cleanNames(args)
  if (action !== 'update-all' && !names.length) return failE('no valid package name provided')

  const argFn =
    action === 'install' ? b.installArgs : action === 'remove' ? b.removeArgs : action === 'update' ? b.updateArgs : null
  let mgrArgs: string[]
  let bin: string
  if (action === 'update-all') {
    if (b.id === 'xbps') {
      bin = XBPS_BIN
      mgrArgs = b.updateAllArgs()
    } else if (b.id === 'lunar' || b.id === 'sorcery') {
      // lunar update / sorcery update are the manager entry points
      bin = b.id
      mgrArgs = b.updateAllArgs()
    } else {
      bin = b.id
      mgrArgs = b.updateAllArgs()
    }
  } else {
    if (!argFn) return failE(`the ${b.id} backend does not support single-package updates`)
    const a = argFn(names)
    if (a === null) return failE(`the ${b.id} backend does not support single-package updates`)
    // xbps remove runs a different binary
    bin = b.id === 'xbps' && action === 'remove' ? 'xbps-remove' : b.id === 'xbps' ? XBPS_BIN : b.id
    // lunar/sorcery wrap subcommands (lin/lrm/cast/dispel) as argv[0]
    if (b.id === 'lunar' || b.id === 'sorcery') {
      if (a.length && ['lin', 'lrm', 'cast', 'dispel', 'update'].includes(a[0])) {
        bin = a[0] === 'update' ? b.id : a[0]
        mgrArgs = a.slice(1)
      } else {
        bin = b.id
        mgrArgs = a
      }
    } else {
      mgrArgs = a
    }
  }

  const command = [bin, ...mgrArgs].join(' ')
  await db.auditLog.create({
    data: { module: 'packages', action, detail: `attempted: ${command}` },
  })

  const res = await privilegedRun(bin, mgrArgs)
  if (!res) {
    return failE(
      `org.sysdeck.packages.manage — not authorized: this console process is unprivileged and has no passwordless sudo. Run as root (or grant sudo -n) to execute:\n  ${command}`,
      'hybrid',
    )
  }

  await db.auditLog.create({
    data: {
      module: 'packages',
      action,
      detail: `${res.rc === 0 ? 'ok' : 'failed'} (${res.via}): ${command}`,
    },
  })
  if (res.rc !== 0) {
    return failE(`${command} failed (rc=${res.rc}, via ${res.via}) — ${res.stderr.trim().split('\n')[0] ?? 'see console log'}`)
  }
  await clearCache()
  return ok(
    {
      action,
      manager: b.id,
      command: res.command,
      via: res.via,
      rc: res.rc,
      outputTail: res.stdout.trimEnd().split('\n').slice(-12).join('\n'),
    },
    'live',
    `executed via ${res.via}`,
  )
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const b = await detectBackend()
    if (!b) {
      return failE(
        'no supported package manager detected on this host (probed: pacman, emerge, lunar, sorcery, xbps, apk, zypper, dnf, yum, apt)',
      )
    }
    const rows = await loadList()
    const installed = rows.filter((r) => r.installed).length
    const updates = await b.listUpdates()
    const sizeKb = await dirSizeKb(b.dbPath)

    const auditLast = await db.auditLog.findFirst({
      where: { module: 'packages', action: { in: ['install', 'remove', 'update', 'update-all'] } },
      orderBy: { ts: 'desc' },
    })
    const logLast = await b.lastInstallLog()

    return ok(
      {
        manager: b.id,
        family: b.family,
        distro: await distroPretty(),
        installed,
        upgradable: updates === null ? null : updates.length,
        lastInstall: auditLast
          ? `${auditLast.ts.toISOString()} ${auditLast.action} (audit log)`
          : (logLast ?? null),
        dbSizeKb: sizeKb,
        dbPath: b.dbPath,
        privileged: isRoot() || (await havePasswordlessSudo()),
      },
      'live',
      updates === null ? (b.updatesNote ?? `${b.id}: update preview unavailable on this backend`) : undefined,
    )
  },

  list: async (args: Record<string, unknown>) => {
    const b = await detectBackend()
    if (!b) return failE('no supported package manager detected on this host')
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
      `${b.id} installed-list cached 60s in module state`,
    )
  },

  info: async (args: Record<string, unknown>) => {
    const b = await detectBackend()
    if (!b) return failE('no supported package manager detected on this host')
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    if (!pkgNameOk(name)) return failE(`invalid package name: ${name}`)
    const info = await b.info(name)
    if (!info) return failE(`package not found: ${name}`)
    return ok(info, 'live')
  },

  search: async (args: Record<string, unknown>) => {
    const b = await detectBackend()
    if (!b) return failE('no supported package manager detected on this host')
    const term = String(args.term ?? args.query ?? '').trim()
    if (!term) return failE('term is required')
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50))
    const results = await b.search(term)
    return ok(
      { results: results.slice(0, limit), count: results.length, manager: b.id },
      'live',
      `repository search via ${b.id}`,
    )
  },

  updates: async () => {
    const b = await detectBackend()
    if (!b) return failE('no supported package manager detected on this host')
    const updates = await b.listUpdates()
    if (updates === null) {
      return failE(
        b.updatesNote ?? `${b.id}: update preview is not supported by this backend — run the system update instead`,
      )
    }
    return ok({ updates, count: updates.length }, 'live')
  },

  install: (args: Record<string, unknown>) => runMutation('install', args),
  remove: (args: Record<string, unknown>) => runMutation('remove', args),
  update: (args: Record<string, unknown>) => runMutation('update', args),
  updateAll: () => runMutation('update-all', {}),
}
