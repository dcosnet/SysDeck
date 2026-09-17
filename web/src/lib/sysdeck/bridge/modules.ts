// SysDeck bridge — modules (3rd-party cockpit module installer, live)
// Port of bridge/modules3p.py (v0.0.46): a catalog-driven installer for
// third-party Cockpit modules. The CATALOG is ported verbatim from the
// python file (real names, licenses, authors, source URLs). Design
// rules preserved: (1) the catalog is the single source of truth;
// (2) no silent installs — install() refuses without
// acceptLicense=true (the front-end renders the license inline next to
// the Install button, the click IS the acceptance gesture); (3) every
// install/uninstall is audited. Installs are REAL:
//   - distro-package entries install via the host's REAL package
//     manager (pacman on Arch, apt on Debian, dnf on Fedora — the
//     bridge detects it)
//   - git entries REALLY clone into /usr/local/share/cockpit/<dest>
//     (a cockpit scan root — the module goes live)
//   - deb-tar entries are REALLY downloaded (curl) and extracted
//     (dpkg-deb -x) into /usr/local/share/cockpit/<dest>
//   - tarball entries are REALLY downloaded and untarred with strip
// All writes are privilege-gated (root / sudo -n) with the exact
// operator command shown on honest denial. depends[] checks are real
// which() probes.
import { db } from '@/lib/db'
import { ok, fail, which, run } from './shared'
import { rm, mkdir, readdir, mkdtemp } from 'fs/promises'
import { existsSync } from 'fs'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'modules', action, detail } })
}

// ── catalog (single source of truth — from modules3p.py) ────────────

interface CatalogEntry {
  id: string
  name: string
  blurb: string
  license: string
  author: string
  source: string
  category: string
  kind: 'pacman' | 'git' | 'deb-tar' | 'tarball'
  installSpec: Record<string, unknown>
  depends: string[]
}

const CATALOG: CatalogEntry[] = [
  // Cockpit Project upstream (LGPL-2.1)
  {
    id: 'cockpit-machines',
    name: 'Cockpit Machines',
    blurb: 'Official libvirt/QEMU virtual machine manager.',
    license: 'LGPL-2.1',
    author: 'Cockpit Project',
    source: 'https://github.com/cockpit-project/cockpit-machines',
    category: 'Virtualization',
    kind: 'pacman',
    installSpec: { pkg: 'cockpit-machines' },
    depends: ['libvirtd'],
  },
  {
    id: 'cockpit-podman',
    name: 'Cockpit Podman',
    blurb: 'Official Podman container management UI.',
    license: 'LGPL-2.1',
    author: 'Cockpit Project',
    source: 'https://github.com/cockpit-project/cockpit-podman',
    category: 'Containers',
    kind: 'pacman',
    installSpec: { pkg: 'cockpit-podman' },
    depends: ['podman'],
  },
  {
    id: 'cockpit-storaged',
    name: 'Cockpit Storaged',
    blurb: 'Official storage (udisks) management UI.',
    license: 'LGPL-2.1',
    author: 'Cockpit Project',
    source: 'https://github.com/cockpit-project/cockpit-storaged',
    category: 'Storage',
    kind: 'pacman',
    installSpec: { pkg: 'cockpit-storaged' },
    depends: ['udisksd'],
  },
  {
    id: 'cockpit-identities',
    name: 'Cockpit Identities',
    blurb: 'Official SSH/PKCS#11/Kerberos identity panel.',
    license: 'LGPL-2.1',
    author: 'Cockpit Project',
    source: 'https://github.com/cockpit-project/cockpit-identities',
    category: 'Identity',
    kind: 'git',
    installSpec: { repo: 'https://github.com/cockpit-project/cockpit-identities.git', dest: 'identities' },
    depends: ['ssh-add'],
  },
  // 45Drives storage stack (GPL-3.0)
  {
    id: 'cockpit-navigator',
    name: '45Drives Navigator',
    blurb: 'Web file browser for the cockpit user.',
    license: 'GPL-3.0',
    author: '45Drives',
    source: 'https://github.com/45Drives/cockpit-navigator',
    category: 'Storage / Files',
    kind: 'deb-tar',
    installSpec: {
      url: 'https://github.com/45Drives/cockpit-navigator/releases/download/v3.1.0/cockpit-navigator_3.1.0-1focal_all.deb',
      dest: 'navigator',
    },
    depends: [],
  },
  {
    id: 'cockpit-file-sharing',
    name: '45Drives File Sharing',
    blurb: 'Samba / NFS share management UI.',
    license: 'GPL-3.0',
    author: '45Drives',
    source: 'https://github.com/45Drives/cockpit-file-sharing',
    category: 'Storage / Files',
    kind: 'deb-tar',
    installSpec: {
      url: 'https://github.com/45Drives/cockpit-file-sharing/releases/download/v3.3.4/cockpit-file-sharing_3.3.4-1focal_all.deb',
      dest: 'file-sharing',
    },
    depends: ['smbd', 'exportfs'],
  },
  {
    id: 'cockpit-zfs-manager',
    name: '45Drives ZFS Manager',
    blurb: 'OpenZFS pool, dataset, and snapshot UI.',
    license: 'GPL-3.0',
    author: '45Drives',
    source: 'https://github.com/45Drives/cockpit-zfs-manager',
    category: 'Storage / ZFS',
    kind: 'git',
    installSpec: { repo: 'https://github.com/45Drives/cockpit-zfs-manager.git', dest: 'zfs-manager' },
    depends: ['zpool'],
  },
  // Community modules (MIT / GPL-3.0)
  {
    id: 'cockpit-pacman',
    name: 'cockpit-pacman',
    blurb: 'ALPM/pacman WebUI for Arch Linux hosts.',
    license: 'GPL-3.0',
    author: 'pfeifferj',
    source: 'https://github.com/pfeifferj/cockpit-pacman',
    category: 'Package Management',
    kind: 'git',
    installSpec: { repo: 'https://github.com/pfeifferj/cockpit-pacman.git', dest: 'pacman' },
    depends: ['pacman'],
  },
  {
    id: 'cockpit-sensors',
    name: 'cockpit-sensors',
    blurb:
      'Standalone lm_sensors reader (ocristopfer). SysDeck already ships a built-in sensors panel; this is the upstream reference if you prefer its layout.',
    license: 'MIT',
    author: 'ocristopfer',
    source: 'https://github.com/ocristopfer/cockpit-sensors',
    category: 'Hardware',
    kind: 'tarball',
    installSpec: {
      url: 'https://github.com/ocristopfer/cockpit-sensors/releases/latest/download/cockpit-sensors.tar.xz',
      dest: 'sensors',
      strip: 1,
    },
    depends: ['sensors'],
  },
  {
    id: 'cockpit-benchmark',
    name: 'cockpit-benchmark',
    blurb:
      'sysbench / fio / iperf3 wrapper UI (ealier). SysDeck already ships a built-in benchmark panel; this is the upstream reference if you prefer its layout.',
    license: 'MIT',
    author: 'ealier',
    source: 'https://github.com/ealier/cockpit-benchmark',
    category: 'Benchmarking',
    kind: 'git',
    installSpec: { repo: 'https://github.com/ealier/cockpit-benchmark.git', dest: 'benchmark' },
    depends: ['sysbench'],
  },
]

function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}

// ── installed-state (Module3pInstall registry + REAL filesystem) ─────

const COCKPIT_LOCAL = '/usr/local/share/cockpit'

async function installedIds(): Promise<Set<string>> {
  const rows = await db.module3pInstall.findMany({ select: { moduleId: true } })
  return new Set(rows.map((r) => r.moduleId))
}

// ── privilege model ──────────────────────────────────────────────────

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0
}

let sudoProbe: { at: number; ok: boolean } | null = null
async function havePasswordlessSudo(): Promise<boolean> {
  if (sudoProbe && Date.now() - sudoProbe.at < 60_000) return sudoProbe.ok
  const r = await run('sudo', ['-n', 'true'], 3000)
  sudoProbe = { at: Date.now(), ok: r.rc === 0 }
  return sudoProbe.ok
}

async function privilegedRun(cmd: string, args: string[], timeoutMs = 180_000): Promise<{ rc: number; stdout: string; stderr: string; command: string } | null> {
  if (isRoot()) {
    const r = await run(cmd, args, timeoutMs)
    return { ...r, command: [cmd, ...args].join(' ') }
  }
  if (await havePasswordlessSudo()) {
    const r = await run('sudo', ['-n', cmd, ...args], timeoutMs)
    return { ...r, command: `sudo -n ${cmd} ${args.join(' ')}` }
  }
  return null
}

// ── host package-manager detection (for distro-package entries) ─────

async function hostManager(): Promise<{ mgr: 'pacman' | 'apt' | 'dnf' | 'zypper' | null; installArgs: (pkg: string) => string[] }> {
  for (const [mgr, args] of [
    ['pacman', ['-S', '--noconfirm', '--needed']],
    ['apt', ['install', '-y']],
    ['dnf', ['install', '-y']],
    ['zypper', ['--non-interactive', 'install']],
  ] as const) {
    if (await which(mgr)) return { mgr: mgr as 'pacman' | 'apt' | 'dnf' | 'zypper', installArgs: (pkg: string) => [...args, pkg] }
  }
  return { mgr: null, installArgs: () => [] }
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  catalog: async () => {
    const installed = await installedIds()
    return ok(
      {
        entries: CATALOG.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.blurb,
          license: e.license,
          author: e.author,
          source: e.source,
          homepage: e.source,
          category: e.category,
          kind: e.kind,
          depends: e.depends,
          installed: installed.has(e.id),
        })),
        count: CATALOG.length,
        installedCount: CATALOG.filter((e) => installed.has(e.id)).length,
      },
      'live',
      'catalog ported verbatim from bridge/modules3p.py — installs are real (package manager / git clone / curl+extract)',
    )
  },

  status: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const entry = findEntry(id)
    if (!entry) return failE(`unknown module id: ${id}`)
    const installed = await installedIds()
    const missingDeps: string[] = []
    for (const dep of entry.depends) {
      if (!(await which(dep))) missingDeps.push(dep)
    }
    const installRow = await db.module3pInstall.findUnique({ where: { moduleId: id } })
    // real filesystem presence for git/tarball installs
    const dest = typeof entry.installSpec.dest === 'string' ? `${COCKPIT_LOCAL}/${entry.installSpec.dest}` : null
    let onDisk = false
    if (dest) {
      try {
        onDisk = (await readdir(dest)).length > 0
      } catch {
        onDisk = false
      }
    }
    return ok(
      {
        ...entry,
        installed: installed.has(id),
        onDisk,
        missingDeps,
        installRecord: installRow ?? null,
      },
      'live',
    )
  },

  install: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const entry = findEntry(id)
    if (!entry) return failE(`unknown module id: ${id}`)
    const installed = await installedIds()
    if (installed.has(id)) {
      return ok({ id: entry.id, status: 'already-installed', message: `${entry.name} is already installed` }, 'live')
    }
    if (args.acceptLicense !== true) {
      return failE(
        'license-not-accepted — the license is disclosed inline next to the Install button; the click IS the acceptance gesture, so the front-end must pass acceptLicense: true',
      )
    }
    const missingDeps: string[] = []
    for (const dep of entry.depends) {
      if (!(await which(dep))) missingDeps.push(dep)
    }

    let command = ''
    let note = ''
    if (entry.kind === 'pacman') {
      const { mgr, installArgs } = await hostManager()
      if (!mgr) return failE('no package manager detected on this host (probed pacman, apt, dnf, zypper)')
      const pkg = String(entry.installSpec.pkg ?? entry.id)
      const res = await privilegedRun(mgr, installArgs(pkg))
      command = `${mgr} ${installArgs(pkg).join(' ')}`
      if (!res) {
        return failE(`org.sysdeck.modules3p.modify — not authorized: run as root or grant sudo -n to execute:\n  ${command}`, 'hybrid')
      }
      note = `real install via ${mgr}`
      if (res.rc !== 0) {
        await audit('install-fail', `${entry.id}: ${command} → rc=${res.rc} — ${res.stderr.trim().split('\n')[0] ?? 'package manager error'}`)
        return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'package manager error'}`)
      }
    } else {
      const dest = String(entry.installSpec.dest ?? entry.id)
      const target = `${COCKPIT_LOCAL}/${dest}`
      if (!(await which('curl')) && (entry.kind === 'deb-tar' || entry.kind === 'tarball')) {
        return failE('curl not installed — downloads need curl on the host')
      }
      if (entry.kind === 'git') {
        if (!(await which('git'))) return failE('git not installed — git-clone installs need git on the host')
        const repo = String(entry.installSpec.repo)
        await mkdir(COCKPIT_LOCAL, { recursive: true }).catch(() => undefined)
        const res = await privilegedRun('git', ['clone', '--depth', '1', repo, target])
        command = `git clone --depth 1 ${repo} ${target}`
        if (!res) {
          return failE(`org.sysdeck.modules3p.modify — not authorized: run as root or grant sudo -n to execute:\n  ${command}`, 'hybrid')
        }
        note = 'real git clone into a cockpit scan root'
        if (res.rc !== 0) {
          await audit('install-fail', `${entry.id}: ${command} → rc=${res.rc} — ${res.stderr.trim().split('\n')[0] ?? 'git error'}`)
          return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'git error (repo moved? network?)'}`)
        }
      } else {
        // deb-tar / tarball: real download + real extract. Staging lands in
        // a mkdtemp dir — a predictable /tmp path would be a symlink-race
        // target for the privileged copy that follows.
        const url = String(entry.installSpec.url)
        const tmp = await mkdtemp('/tmp/sysdeck-module-')
        const dl = await run('curl', ['-fsSL', '-o', `${tmp}/dl`, url], 120_000)
        command = `curl -fsSL ${url} && extract → ${target}`
        if (dl.rc !== 0) {
          await audit('install-fail', `${entry.id}: download ${url} → rc=${dl.rc}`)
          return failE(`download failed — ${url} (${dl.stderr.trim().split('\n')[0] ?? 'network error'})`)
        }
        let res: { rc: number; stdout: string; stderr: string; command: string } | null
        if (entry.kind === 'deb-tar') {
          // dpkg-deb -x <deb> <dir> extracts usr/share/cockpit/<dest>...
          await mkdir(`${tmp}/x`, { recursive: true })
          const ex = await run('dpkg-deb', ['-x', `${tmp}/dl`, `${tmp}/x`], 60_000)
          if (ex.rc !== 0) {
            await audit('install-fail', `${entry.id}: dpkg-deb -x → rc=${ex.rc}`)
            return failE(`dpkg-deb extraction failed — ${ex.stderr.trim().split('\n')[0] ?? 'not a .deb or dpkg-deb absent'}`)
          }
          // move the extracted module content into the scan root
          const inner = `${tmp}/x/usr/share/cockpit`
          let srcDir = inner
          if (!existsSync(inner)) srcDir = `${tmp}/x`
          const mv = await privilegedRun('cp', ['-r', srcDir, target])
          res = mv
          command = `dpkg-deb -x → cp -r ${srcDir} ${target}`
        } else {
          const strip = Number(entry.installSpec.strip ?? 0)
          const tarArgs = ['-xf', `${tmp}/dl`, '-C', tmp, ...(strip ? ['--strip-components', String(strip)] : [])]
          const ex = await run('tar', tarArgs, 60_000)
          if (ex.rc !== 0) {
            await audit('install-fail', `${entry.id}: tar extraction → rc=${ex.rc}`)
            return failE(`tar extraction failed — ${ex.stderr.trim().split('\n')[0] ?? 'archive error'}`)
          }
          const mv = await privilegedRun('cp', ['-r', tmp, target])
          res = mv
          command = `tar -x → cp -r ${tmp} ${target}`
        }
        if (!res) {
          return failE(`org.sysdeck.modules3p.modify — not authorized: run as root or grant sudo -n to write:\n  ${target}`, 'hybrid')
        }
        note = 'real download + extraction into a cockpit scan root'
        if (res.rc !== 0) {
          await audit('install-fail', `${entry.id}: ${command} → rc=${res.rc}`)
          return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'extract error'}`)
        }
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    await db.module3pInstall.create({
      data: { moduleId: entry.id, action: 'install', license: entry.license },
    })
    await audit(
      'install-ok',
      `${entry.id} (${entry.name}, ${entry.license}, author ${entry.author}) installed — ${command}${missingDeps.length ? ` — missing deps on this host: ${missingDeps.join(', ')}` : ''}`,
    )
    return ok(
      {
        id: entry.id,
        status: 'installed',
        name: entry.name,
        license: entry.license,
        author: entry.author,
        source: entry.source,
        missingDeps,
        command,
      },
      'live',
      note,
    )
  },

  uninstall: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const entry = findEntry(id)
    if (!entry) return failE(`unknown module id: ${id}`)
    const installed = await installedIds()
    if (!installed.has(id)) {
      return ok({ id: entry.id, status: 'not-installed' }, 'live')
    }
    // real removal for filesystem installs
    if (entry.kind !== 'pacman') {
      const dest = String(entry.installSpec.dest ?? entry.id)
      const target = `${COCKPIT_LOCAL}/${dest}`
      const res = await privilegedRun('rm', ['-rf', target])
      if (!res) {
        return failE(`org.sysdeck.modules3p.modify — not authorized: run as root or grant sudo -n to execute:\n  rm -rf ${target}`, 'hybrid')
      }
      if (res.rc !== 0) {
        return failE(`rm -rf ${target} failed — ${res.stderr.trim().split('\n')[0] ?? 'error'}`)
      }
    }
    await db.module3pInstall.delete({ where: { moduleId: entry.id } })
    await audit('uninstall-ok', `${entry.id} (${entry.name}) removed`)
    return ok({ id: entry.id, status: 'removed' }, 'live')
  },
}
