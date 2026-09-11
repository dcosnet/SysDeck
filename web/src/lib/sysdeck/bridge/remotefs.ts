// SysDeck bridge — remotefs (demo distributed-filesystem inventory)
// Port of bridge/remotefs.py semantics: the cockpit edition auto-detected
// installed backends (BACKEND_REGISTRY: ceph, glusterfs, moosefs, beegfs,
// orangefs) and surfaced per-backend cluster status; nfs/amanda were
// excluded by design. None of the daemons exist in this sandbox, so the
// web edition keeps the same surface over a seeded RemoteFs inventory
// with mount/heal state transitions, all audited.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'ceph/glusterfs/moosefs/beegfs/orangefs daemons not present in sandbox — demo cluster inventory'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'remotefs', action, detail } })
}

// ── lazy seed ───────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.remoteFs.count()
  if (count > 0) return
  await db.remoteFs.createMany({
    data: [
      {
        name: 'ceph-prod',
        backend: 'ceph',
        state: 'healthy',
        sizeGb: 200000,
        usedGb: 137000,
        mounts: 45,
        bricks: 12,
        note: 'Ceph Reef 18.2.4 — 12 OSDs across 3 nodes, 3 replicas, mon/quorum healthy',
      },
      {
        name: 'glance-share',
        backend: 'glusterfs',
        state: 'degraded',
        sizeGb: 48000,
        usedGb: 31200,
        mounts: 18,
        bricks: 2,
        note: 'GlusterFS 11 — 2 of 3 bricks up (brick gv2 down — node replacement pending)',
      },
      {
        name: 'moose-archive',
        backend: 'moosefs',
        state: 'healthy',
        sizeGb: 500000,
        usedGb: 214000,
        mounts: 9,
        bricks: 8,
        note: 'MooseFS 3.0.118 — 4 chunk servers, goal=2, cold archive tier',
      },
      {
        name: 'beegfs-scratch',
        backend: 'beegfs',
        state: 'healthy',
        sizeGb: 96000,
        usedGb: 21000,
        mounts: 32,
        bricks: 6,
        note: 'BeeGFS 7.4 — 6 storage targets, RDMA over InfiniBand, HPC scratch',
      },
      {
        name: 'orange-hpc',
        backend: 'orangefs',
        state: 'offline',
        sizeGb: 128000,
        usedGb: 0,
        mounts: 0,
        bricks: 4,
        note: 'OrangeFS 2.9.8 — pvfs2-server down since last maintenance reboot',
      },
    ],
  })
  await audit('seed', 'seeded demo inventory: 5 distributed filesystems (ceph, glusterfs, moosefs, beegfs, orangefs)')
}

/** Resting state for a backend once it has mounts (glusterfs stays
 *  degraded until healed). */
function restingState(backend: string): string {
  return backend === 'glusterfs' ? 'degraded' : 'healthy'
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rows = await db.remoteFs.findMany()
    const healthy = rows.filter((r) => r.state === 'healthy').length
    const capacityGb = rows.reduce((sum, r) => sum + r.sizeGb, 0)
    const usedGb = rows.reduce((sum, r) => sum + r.usedGb, 0)
    return ok(
      {
        filesystems: rows.length,
        healthy,
        degraded: rows.filter((r) => r.state === 'degraded').length,
        offline: rows.filter((r) => r.state === 'offline').length,
        capacityGb,
        usedGb,
        mounts: rows.reduce((sum, r) => sum + r.mounts, 0),
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rows = await db.remoteFs.findMany({ orderBy: { name: 'asc' } })
    return ok({ filesystems: rows, count: rows.length }, SOURCE, NOTE)
  },

  mount: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const fs = await db.remoteFs.findUnique({ where: { id } })
    if (!fs) return failE('filesystem not found')
    if (fs.state === 'offline') {
      // mounting wakes an offline backend only if it's just unmounted
      // (mounts === 0); a down server stays offline
      return failE(`${fs.name} is offline (${fs.note ?? 'server down'}) — start the backend first`)
    }
    const row = await db.remoteFs.update({
      where: { id },
      data: { mounts: fs.mounts + 1, state: restingState(fs.backend) },
    })
    await audit('mount', `${fs.name} (${fs.backend}) → ${row.mounts} mounts, state ${row.state}`)
    return ok({ filesystem: row, mounts: row.mounts, state: row.state }, SOURCE, `${fs.name} mounted — demo state transition`)
  },

  unmount: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const fs = await db.remoteFs.findUnique({ where: { id } })
    if (!fs) return failE('filesystem not found')
    if (fs.mounts <= 0) return failE(`${fs.name} has no active mounts`)
    const mounts = fs.mounts - 1
    const row = await db.remoteFs.update({
      where: { id },
      data: { mounts, state: mounts === 0 ? 'offline' : fs.state },
    })
    await audit('unmount', `${fs.name} (${fs.backend}) → ${mounts} mounts, state ${row.state}`)
    return ok(
      { filesystem: row, mounts: row.mounts, state: row.state },
      SOURCE,
      `${fs.name} unmounted${mounts === 0 ? ' — no mounts left, marked offline' : ''}`,
    )
  },

  heal: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const fs = await db.remoteFs.findUnique({ where: { id } })
    if (!fs) return failE('filesystem not found')
    if (fs.state === 'healthy') return failE(`${fs.name} is already healthy`)
    if (fs.state === 'offline') return failE(`${fs.name} is offline — heal applies to degraded clusters (replace-brick / rebalance)`)
    const row = await db.remoteFs.update({
      where: { id },
      data: {
        state: 'healthy',
        bricks: fs.backend === 'glusterfs' ? 3 : fs.bricks,
        note:
          fs.backend === 'glusterfs'
            ? 'GlusterFS 11 — brick gv2 replaced, 3 of 3 bricks up, rebalance complete'
            : (fs.note ?? 'healed'),
      },
    })
    await audit('heal', `${fs.name} (${fs.backend}) degraded → healthy (bricks ${fs.bricks} → ${row.bricks})`)
    return ok({ filesystem: row, state: 'healthy' }, SOURCE, `${fs.name} healed — demo state transition`)
  },
}
