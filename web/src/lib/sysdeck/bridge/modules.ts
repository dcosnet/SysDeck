// SysDeck bridge — modules (3rd-party cockpit module installer)
// Port of bridge/modules3p.py (v0.0.46): a catalog-driven installer for
// third-party Cockpit modules. The CATALOG below is ported verbatim
// from the python file (real names, licenses, authors, source URLs).
// Design rules preserved: (1) the catalog is the single source of
// truth; (2) no silent installs — install() refuses without
// acceptLicense=true (the front-end renders the license inline next to
// the Install button, the click IS the acceptance gesture); (3) every
// install/uninstall is audited. The cockpit-modules registry itself is
// only reachable on a managed host, so pulls are simulated; dependency
// checks (depends[]) are REAL which() probes.
import { db } from '@/lib/db'
import { ok, fail, which } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'catalog ported verbatim from bridge/modules3p.py; installs are simulated pulls (registry reachable only on a managed host); depends[] checks are real which() probes'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
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

// ── installed-state (Module3pInstall registry) ──────────────────────

async function installedIds(): Promise<Set<string>> {
  const rows = await db.module3pInstall.findMany({ select: { moduleId: true } })
  return new Set(rows.map((r) => r.moduleId))
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
      SOURCE,
      NOTE,
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
    return ok(
      {
        ...entry,
        installed: installed.has(id),
        missingDeps,
        installRecord: installRow ?? null,
      },
      SOURCE,
      NOTE,
    )
  },

  install: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const entry = findEntry(id)
    if (!entry) return failE(`unknown module id: ${id}`)
    const installed = await installedIds()
    if (installed.has(id)) {
      return ok(
        { id: entry.id, status: 'already-installed', message: `${entry.name} is already installed` },
        SOURCE,
      )
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
    // simulated pull: the cockpit-modules registry is only reachable on
    // a managed host — the install record + audit row are written here.
    await db.module3pInstall.create({
      data: { moduleId: entry.id, action: 'install', license: entry.license },
    })
    await audit(
      'install-ok',
      `${entry.id} (${entry.name}, ${entry.license}, author ${entry.author}) installed${missingDeps.length ? ` — missing deps on this host: ${missingDeps.join(', ')}` : ''}`,
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
      },
      SOURCE,
      'simulated pull: the cockpit-modules registry is only reachable on a managed host',
    )
  },

  uninstall: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const entry = findEntry(id)
    if (!entry) return failE(`unknown module id: ${id}`)
    const installed = await installedIds()
    if (!installed.has(id)) {
      return ok({ id: entry.id, status: 'not-installed' }, SOURCE)
    }
    await db.module3pInstall.delete({ where: { moduleId: entry.id } })
    await audit('uninstall-ok', `${entry.id} (${entry.name}) removed`)
    return ok({ id: entry.id, status: 'removed' }, SOURCE)
  },
}
