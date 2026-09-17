// SysDeck bridge — remotefs (real distributed-filesystem registry, live)
// Port of bridge/remotefs.py semantics: the cockpit edition
// auto-detected installed backends (BACKEND_REGISTRY: ceph, glusterfs,
// moosefs, beegfs, orangefs; nfs/amanda excluded by design) and
// surfaced per-backend cluster status. The web edition ports the
// registry verbatim and probes each installed backend with its REAL
// cluster command (ceph fs status / gluster volume status / beegfs-ctl
// --getstate / moosefs-cli / pvfs2-client), parsing what the backend
// reports. mount/unmount run the real mount(8); heal runs the backend's
// real heal command. Absent → honest empty inventory.
import { ok, fail, run, which } from './shared'
import { db } from '@/lib/db'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'remotefs', action, detail } })
}

// ── backend registry (ported verbatim from bridge/remotefs.py) ───────

interface FsDef {
  id: 'ceph' | 'glusterfs' | 'moosefs' | 'beegfs' | 'orangefs'
  name: string
  family: string
  port: number
  unit: string
  cli: string
  config: string[]
  license: string
  homepage: string
  installHint: string
}

const BACKENDS: FsDef[] = [
  {
    id: 'ceph', name: 'Ceph', family: 'object-storage', port: 6789,
    unit: 'ceph.target', cli: 'ceph', config: ['/etc/ceph/ceph.conf'],
    license: 'LGPL-2.1', homepage: 'https://ceph.io/',
    installHint: 'Arch: pacman -S ceph  ·  Debian: apt install ceph  ·  Fedora: dnf install ceph',
  },
  {
    id: 'glusterfs', name: 'GlusterFS', family: 'scale-out-fs', port: 24007,
    unit: 'glusterd.service', cli: 'gluster', config: ['/etc/glusterfs/glusterd.vol'],
    license: 'GPL-2.0', homepage: 'https://www.gluster.org/',
    installHint: 'Arch: pacman -S glusterfs  ·  Debian: apt install glusterfs-server  ·  Fedora: dnf install glusterfs-server',
  },
  {
    id: 'moosefs', name: 'MooseFS', family: 'distributed-fs', port: 9420,
    unit: 'moosefs-master.service', cli: 'moosefs-cli', config: ['/etc/mfs/mfsmaster.cfg'],
    license: 'GPL-2.0', homepage: 'https://moosefs.com/',
    installHint: 'Arch: pacman -S moosefs  ·  Debian: apt install moosefs-master  ·  Fedora: dnf install moosefs-master',
  },
  {
    id: 'beegfs', name: 'BeeGFS', family: 'parallel-fs', port: 8008,
    unit: 'beegfs-meta.service', cli: 'beegfs-ctl', config: ['/etc/beegfs/beegfs-meta.conf'],
    license: 'BeeGFS EULA (free)', homepage: 'https://www.beegfs.io/',
    installHint: 'Arch: yay -S beegfs  ·  Debian: apt install beegfs-meta  ·  Fedora: see beegfs.io docs',
  },
  {
    id: 'orangefs', name: 'OrangeFS', family: 'parallel-fs', port: 3334,
    unit: 'pvfs2-server.service', cli: 'pvfs2-server', config: ['/etc/orangefs/orangefs-server.conf'],
    license: 'OpenSource (BSD-3)', homepage: 'http://www.orangefs.org/',
    installHint: 'Arch: yay -S orangefs  ·  Debian: apt install orangefs-server  ·  Fedora: dnf install orangefs-server',
  },
]

// ── real per-backend cluster status ──────────────────────────────────

interface FsRow {
  id: string
  name: string
  backend: FsDef['id']
  state: 'healthy' | 'degraded' | 'offline'
  sizeGb: number
  usedGb: number
  mounts: number
  bricks: number
  note: string
}

async function unitActive(unit: string): Promise<boolean> {
  const r = await run('systemctl', ['is-active', unit], 5000)
  return r.rc === 0
}

async function cephRows(active: boolean): Promise<FsRow[]> {
  const r = await run('ceph', ['fs', 'status'], 15_000)
  if (r.rc !== 0) {
    return [{
      id: 'ceph', name: 'CephFS', backend: 'ceph', state: active ? 'degraded' : 'offline',
      sizeGb: 0, usedGb: 0, mounts: 0, bricks: 0,
      note: `ceph fs status rc=${r.rc} — ${r.stderr.trim().split('\n')[0] ?? 'cluster unreachable'}`,
    }]
  }
  const lines = r.stdout.split('\n')
  const fsLine = lines.find((l) => l.includes('cephfs')) ?? ''
  const rankLines = lines.filter((l) => /standby|active/i.test(l) && !l.startsWith(''))
  const df = await run('ceph', ['df'], 15_000)
  let sizeGb = 0
  let usedGb = 0
  const m = df.stdout.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (m) {
    sizeGb = Math.round(Number(m[1]) * 1024)
    usedGb = Math.round(Number(m[2]) * 1024)
  }
  return [{
    id: 'ceph', name: 'CephFS', backend: 'ceph', state: 'healthy',
    sizeGb, usedGb, mounts: rankLines.length, bricks: rankLines.length,
    note: fsLine.trim() || 'ceph fs status OK',
  }]
}

async function glusterRows(active: boolean): Promise<FsRow[]> {
  const info = await run('gluster', ['volume', 'info'], 15_000)
  if (info.rc !== 0) {
    return [{
      id: 'glusterfs', name: 'GlusterFS', backend: 'glusterfs', state: active ? 'degraded' : 'offline',
      sizeGb: 0, usedGb: 0, mounts: 0, bricks: 0,
      note: `gluster volume info rc=${info.rc} — ${info.stderr.trim().split('\n')[0] ?? 'daemon unreachable'}`,
    }]
  }
  const rows: FsRow[] = []
  const vols = info.stdout.split('Volume Name:').slice(1)
  for (const v of vols) {
    const name = v.trim().split('\n')[0].trim()
    const bricks = (v.match(/Brick\d+:/g) ?? []).length
    const status = (v.match(/Status:\s*(\S+)/) ?? [])[1] ?? 'unknown'
    const started = status === 'Started'
    const statusOut = await run('gluster', ['volume', 'status', name], 15_000)
    let sizeGb = 0
    for (const line of statusOut.stdout.split('\n')) {
      if (line.includes('/')) {
        const cols = line.trim().split(/\s+/)
        const sz = cols[3] ?? ''
        const unit = cols[4] ?? ''
        if (/^\d+$/.test(sz)) sizeGb = unit === 'TB' ? Number(sz) * 1024 : Number(sz)
      }
    }
    rows.push({
      id: `glusterfs:${name}`, name, backend: 'glusterfs',
      state: started ? 'healthy' : 'degraded',
      sizeGb, usedGb: 0, mounts: bricks, bricks,
      note: `volume ${status} (${bricks} bricks)`,
    })
  }
  return rows
}

async function moosefsRows(active: boolean): Promise<FsRow[]> {
  const r = await run('moosefs-cli', ['--master', 'mfsmaster', 'info'], 15_000)
  return [{
    id: 'moosefs', name: 'MooseFS', backend: 'moosefs',
    state: r.rc === 0 ? 'healthy' : active ? 'degraded' : 'offline',
    sizeGb: 0, usedGb: 0, mounts: 0, bricks: 0,
    note: r.rc === 0 ? r.stdout.trim().split('\n').slice(0, 3).join(' · ') : 'moosefs-cli unreachable',
  }]
}

async function beegfsRows(active: boolean): Promise<FsRow[]> {
  const r = await run('beegfs-ctl', ['--getstate'], 15_000)
  return [{
    id: 'beegfs', name: 'BeeGFS', backend: 'beegfs',
    state: r.rc === 0 ? 'healthy' : active ? 'degraded' : 'offline',
    sizeGb: 0, usedGb: 0, mounts: 0, bricks: 0,
    note: r.rc === 0 ? r.stdout.trim().split('\n').slice(0, 3).join(' · ') : 'beegfs-ctl unreachable',
  }]
}

async function orangefsRows(active: boolean): Promise<FsRow[]> {
  const r = await run('pvfs2-client', ['-p', '/etc/orangefs/orangefs-server.conf'], 15_000)
  return [{
    id: 'orangefs', name: 'OrangeFS', backend: 'orangefs',
    state: r.rc === 0 ? 'healthy' : active ? 'degraded' : 'offline',
    sizeGb: 0, usedGb: 0, mounts: 0, bricks: 0,
    note: r.rc === 0 ? 'pvfs2-client connected' : 'pvfs2-client unreachable',
  }]
}

async function allRows(): Promise<{ rows: FsRow[]; installed: FsDef[] }> {
  const installed: FsDef[] = []
  const rows: FsRow[] = []
  for (const b of BACKENDS) {
    if (!(await which(b.cli))) continue
    installed.push(b)
    const active = await unitActive(b.unit)
    switch (b.id) {
      case 'ceph':
        rows.push(...(await cephRows(active)))
        break
      case 'glusterfs':
        rows.push(...(await glusterRows(active)))
        break
      case 'moosefs':
        rows.push(...(await moosefsRows(active)))
        break
      case 'beegfs':
        rows.push(...(await beegfsRows(active)))
        break
      case 'orangefs':
        rows.push(...(await orangefsRows(active)))
        break
    }
  }
  return { rows, installed }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const { rows, installed } = await allRows()
    if (!installed.length) {
      return ok(
        { filesystems: 0, healthy: 0, degraded: 0, offline: 0, capacityGb: 0, usedGb: 0, mounts: 0 },
        'live',
        `no distributed-filesystem backend detected (probed: ${BACKENDS.map((b) => b.name).join(', ')}; nfs/amanda excluded by design) — install one and its real cluster status appears here`,
      )
    }
    return ok(
      {
        filesystems: rows.length,
        healthy: rows.filter((r) => r.state === 'healthy').length,
        degraded: rows.filter((r) => r.state === 'degraded').length,
        offline: rows.filter((r) => r.state === 'offline').length,
        capacityGb: rows.reduce((a, r) => a + r.sizeGb, 0),
        usedGb: rows.reduce((a, r) => a + r.usedGb, 0),
        mounts: rows.reduce((a, r) => a + r.mounts, 0),
        backends: installed.map((b) => ({ id: b.id, name: b.name, status: 'installed' })),
      },
      'live',
      'real backend detection + live cluster commands (nothing seeded)',
    )
  },

  list: async () => {
    const { rows, installed } = await allRows()
    if (!installed.length) {
      return ok(
        { filesystems: [], count: 0 },
        'live',
        `no distributed-filesystem backend detected (probed: ${BACKENDS.map((b) => b.name).join(', ')}) — honest empty`,
      )
    }
    return ok({ filesystems: rows, count: rows.length }, 'live', 'live cluster status per installed backend')
  },

  mount: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const path = String(args.path ?? '')
    if (!id) return failE('id is required')
    if (!path) return failE('mount is a real mount(8) call — pass the mount point path')
    const r = await run('mount', [path], 30_000)
    await audit('mount', `mount ${path} → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`mount ${path} failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root / fstab entry'}`)
    return ok({ id, mounts: 1, state: 'healthy' }, 'live', `real mount(8) of ${path}`)
  },

  unmount: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const path = String(args.path ?? '')
    if (!id) return failE('id is required')
    if (!path) return failE('unmount is a real umount(8) call — pass the mount point path')
    const r = await run('umount', [path], 30_000)
    await audit('unmount', `umount ${path} → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`umount ${path} failed — ${r.stderr.trim().split('\n')[0] ?? 'target busy or needs root'}`)
    return ok({ id, mounts: 0, state: 'healthy' }, 'live', `real umount(8) of ${path}`)
  },

  heal: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const backend = id.split(':')[0]
    let r: { rc: number; stdout: string; stderr: string }
    if (backend === 'ceph') r = await run('ceph', ['fs', 'heal', 'cephfs', '--yes'], 60_000)
    else if (backend === 'glusterfs') {
      const vol = id.split(':')[1] ?? ''
      if (!vol) return failE('gluster heal needs the volume name (id format glusterfs:<vol>)')
      r = await run('gluster', ['volume', 'heal', vol, 'full'], 60_000)
    } else {
      return failE(`the ${backend} backend has no sysdeck-wired heal command — run its native maintenance tooling`)
    }
    await audit('heal', `${id} → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`heal failed — ${r.stderr.trim().split('\n')[0] ?? 'backend error'}`)
    return ok({ id, state: 'healthy', output: r.stdout.trim().split('\n').slice(-3).join('\n') }, 'live')
  },
}
