// SysDeck bridge — cockpit module detection (v0.4.1).
//
// The 100%-compatibility piece for the Next.js-only side: scan the host
// the same way the cockpit shell does — /usr/share/cockpit/<pkg>/
// manifest.json — and load every detected module (distro modules like
// cockpit-machines and cockpit-podman, addons, anything with a menu
// entry) into this console's navigation. Detection is pure filesystem:
// it works with cockpit stopped, absent, or on a box where only the
// packages are installed.
//
//   list        → all detected modules + backend presence probes
//   info        → one module's full manifest + shipped files (+ backend
//                 version probe when the binary is present)
//
// Excluded from the list: sysdeck-* (this console already ships native
// panels for those) and manifest entries without a `menu` block (base1,
// shell — chrome, not pages). Demo fallback: when no cockpit tree is
// found, a clearly-badged typical-distro set is returned so the surface
// is still explorable; SYSDECK_COCKPIT_SCAN adds extra scan roots
// (colon-separated) for staged/DESTDIR trees.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { ok } from './shared'
import { which } from './shared'
import type { CockpitModuleInfo, CockpitModuleList } from '../types'

// Known distro/addon modules → package name, backend binary, and the
// native web-console module that already covers the domain.
const KNOWN: Record<
  string,
  { pkg: string; bin?: string; native?: string; description: string }
> = {
  machines: { pkg: 'cockpit-machines', bin: 'virsh', native: 'containers', description: 'Manage libvirt virtual machines — define, start, stop, migrate, console access.' },
  podman: { pkg: 'cockpit-podman', bin: 'podman', native: 'containers', description: 'Manage Podman containers, images and volumes.' },
  networkmanager: { pkg: 'cockpit-networkmanager', bin: 'nmcli', native: 'netsec', description: 'Network interfaces, bonds, bridges, VLANs and routes.' },
  storage: { pkg: 'cockpit-storaged', bin: 'lsblk', native: 'overview', description: 'Storage devices, mounts, RAID, LVM, NFS and drive health.' },
  users: { pkg: 'cockpit-system', description: 'User accounts, groups and locked/expired state.' },
  systemd: { pkg: 'cockpit-system', description: 'The system overview: services, logs, timers and shutdown.' },
  packagekit: { pkg: 'cockpit-packagekit', bin: 'pkcon', native: 'packages', description: 'Software updates and packagekit package operations.' },
  selinux: { pkg: 'cockpit-selinux', bin: 'getenforce', native: 'integrity', description: 'SELinux policy status, setroubleshoot entries and toggles.' },
  metrics: { pkg: 'cockpit-pcp', bin: 'pmrep', native: 'monitoring', description: 'Performance metrics via PCP — CPU, memory, disk, network history.' },
  kdump: { pkg: 'cockpit-kdump', bin: 'kdumpctl', description: 'Kernel crash dump configuration and test triggers.' },
  tuned: { pkg: 'cockpit-tuned', bin: 'tuned-adm', description: 'Tuned performance profiles per role.' },
  sosreport: { pkg: 'cockpit-sosreport', bin: 'sos', description: 'Generate and download sosreport diagnostics bundles.' },
  certificates: { pkg: 'cockpit-certificates', bin: 'certtool', description: 'Trust certificates, CSRs and letsencrypt issuance.' },
  odir: { pkg: 'cockpit-389-ds', description: '389 Directory Server administration.' },
  play: { pkg: 'cockpit-playground', description: 'Cockpit development playground (sample pages).' },
}

const SCAN_ROOTS = ['/usr/share/cockpit', '/usr/local/share/cockpit']

function extraScanRoots(): string[] {
  const raw = process.env.SYSDECK_COCKPIT_SCAN
  if (!raw) return []
  return raw.split(':').filter((p) => p.length > 0)
}

interface ParsedManifest {
  label: string
  description: string
  order: number
  apiVersion: string | null
  hasMenu: boolean
}

function parseManifest(dir: string): ParsedManifest | null {
  const file = path.join(dir, 'manifest.json')
  if (!existsSync(file)) return null
  try {
    const m = JSON.parse(readFileSync(file, 'utf-8')) as {
      menu?: { index?: { label?: string; order?: number; docs?: { label?: string; url?: string } } }
      description?: string
      requires?: { cockpit?: string }
    }
    // no menu block → chrome (base1, shell), not a page module
    const menu = m.menu?.index
    if (!menu) return null
    return {
      label: menu.label ?? '',
      description: m.description ?? '',
      order: typeof menu.order === 'number' ? menu.order : 50,
      apiVersion: m.requires?.cockpit ?? null,
      hasMenu: true,
    }
  } catch {
    return null
  }
}

function fileCountOf(dir: string): number {
  try {
    let n = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += fileCountOf(path.join(dir, entry.name))
      else n += 1
    }
    return n
  } catch {
    return 0
  }
}

async function probeBackend(bin: string): Promise<boolean> {
  return await which(bin)
}

function demoSet(): CockpitModuleInfo[] {
  const names = ['machines', 'podman', 'networkmanager', 'storage', 'systemd', 'users', 'packagekit', 'selinux', 'metrics', 'kdump', 'tuned']
  return names.map((name) => {
    const k = KNOWN[name]
    return {
      name,
      label: demoLabel(name),
      description: k?.description ?? '',
      order: 50,
      path: `/usr/share/cockpit/${name}`,
      fileCount: 0,
      apiVersion: null,
      pkg: k?.pkg ?? null,
      source: 'demo' as const,
      backend: k?.bin ? { bin: k.bin, present: false } : null,
      nativeModule: k?.native ?? null,
    }
  })
}

function demoLabel(name: string): string {
  const labels: Record<string, string> = {
    machines: 'Virtual Machines',
    podman: 'Podman Containers',
    networkmanager: 'Networking',
    storage: 'Storage',
    systemd: 'System',
    users: 'Accounts',
    packagekit: 'Software Updates',
    selinux: 'SELinux',
    metrics: 'Performance Metrics',
    kdump: 'Kernel Dump',
    tuned: 'Tuning',
  }
  return labels[name] ?? name
}

async function buildList(): Promise<CockpitModuleList> {
  const roots = [...SCAN_ROOTS, ...extraScanRoots()]
  const scanned = roots.filter((r) => existsSync(r))
  if (scanned.length === 0) {
    // no cockpit tree — demo set, but backend probes are still REAL:
    // the binaries themselves may well be installed on this host
    const modules = demoSet()
    await Promise.all(
      modules.map(async (m) => {
        if (m.backend) m.backend.present = await probeBackend(m.backend.bin)
      }),
    )
    return { cockpitDetected: false, scanned: roots, modules }
  }

  const modules: CockpitModuleInfo[] = []
  const seen = new Set<string>()
  for (const root of scanned) {
    let entries: string[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      if (seen.has(name)) continue
      if (name.startsWith('sysdeck-')) continue // native panels exist for these
      const dir = path.join(root, name)
      const parsed = parseManifest(dir)
      if (!parsed) continue
      seen.add(name)
      const k = KNOWN[name]
      modules.push({
        name,
        label: parsed.label || name,
        description: parsed.description || k?.description || '',
        order: parsed.order,
        path: dir,
        fileCount: fileCountOf(dir),
        apiVersion: parsed.apiVersion,
        pkg: k?.pkg ?? null,
        source: 'live',
        backend: k?.bin ? { bin: k.bin, present: false } : null,
        nativeModule: k?.native ?? null,
      })
    }
  }

  // backend presence probes for the known set (cheap which() calls)
  await Promise.all(
    modules.map(async (m) => {
      if (m.backend && m.source === 'live') m.backend.present = await probeBackend(m.backend.bin)
    }),
  )

  modules.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return { cockpitDetected: true, scanned, modules }
}

export const commands = {
  list: async () => {
    const data = await buildList()
    if (!data.cockpitDetected) {
      return ok<CockpitModuleList>(data, 'demo', 'no cockpit tree on this host — showing a typical distro install (badged DEMO); install cockpit-* packages or point SYSDECK_COCKPIT_SCAN at a staged tree for live detection')
    }
    return ok<CockpitModuleList>(data, 'live')
  },

  info: async (args: Record<string, unknown>) => {
    const name = typeof args.name === 'string' ? args.name : ''
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return ok({ error: 'invalid module name' }, 'live')

    // live tree first
    for (const root of [...SCAN_ROOTS, ...extraScanRoots()]) {
      const dir = path.join(root, name)
      if (!existsSync(path.join(dir, 'manifest.json'))) continue
      const files: { name: string; sizeBytes: number }[] = []
      const walk = (d: string, prefix: string) => {
        try {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(d, entry.name), `${prefix}${entry.name}/`)
            else files.push({ name: `${prefix}${entry.name}`, sizeBytes: statSync(path.join(d, entry.name)).size })
          }
        } catch {
          /* unreadable subtree — skip */
        }
      }
      walk(dir, '')
      files.sort((a, b) => a.name.localeCompare(b.name))

      // backend version probe (on-demand only — list stays cheap)
      let backendVersion: string | null = null
      const k = KNOWN[name]
      if (k?.bin && (await which(k.bin))) {
        const { run } = await import('./shared')
        const r = await run(k.bin, ['--version'], 4000)
        if (r.rc === 0) backendVersion = r.stdout.trim().split('\n')[0] ?? null
      }

      let manifest: unknown = null
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      } catch {
        /* manifest listed but unparsable — files table still renders */
      }
      return ok(
        { name, path: dir, files, fileCount: files.length, manifest, backendVersion, source: 'live' as const },
        'live',
      )
    }

    // demo entry (same names the demo list shows)
    const k = KNOWN[name]
    if (k || demoSet().some((m) => m.name === name)) {
      const stub = ['index.html', 'manifest.json', `${name}.js`, `${name}-dialogs.js`, 'po/']
      return ok(
        {
          name,
          path: `/usr/share/cockpit/${name}`,
          files: stub.map((f) => ({ name: f, sizeBytes: 0 })),
          fileCount: stub.length,
          manifest: { name, menu: { index: { label: demoLabel(name), order: 50 } } },
          backendVersion: null,
          source: 'demo' as const,
        },
        'demo',
        'typical distro entry — no cockpit tree on this host',
      )
    }
    return ok({ error: `module not found: ${name}` }, 'live')
  },
}
