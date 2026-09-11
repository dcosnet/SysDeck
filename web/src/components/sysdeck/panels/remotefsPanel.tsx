'use client'

// Remote filesystems panel — ceph / glusterfs / moosefs / beegfs / orangefs
// cluster inventory. The daemons are absent in this sandbox, so the bridge
// keeps a demo cluster (972 TB capacity, 5 filesystems, one degraded
// gluster + one offline orangefs). mount/unmount/heal mutate the demo
// registry: unmount to 0 marks offline, heal replaces the degraded brick.

import { useState } from 'react'
import { toast } from 'sonner'
import { Database, HardDrive, HardDriveDownload, HeartPulse, Unplug } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  Bar,
  ErrorCard,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
  StateBadge,
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'

// ── bridge shapes ────────────────────────────────────────────────────

interface RfSummary {
  filesystems: number
  healthy: number
  degraded: number
  offline: number
  capacityGb: number
  usedGb: number
  mounts: number
}

interface Rfs {
  id: string
  name: string
  backend: 'ceph' | 'glusterfs' | 'moosefs' | 'beegfs' | 'orangefs'
  state: 'healthy' | 'degraded' | 'offline'
  sizeGb: number
  usedGb: number
  mounts: number
  bricks: number
  note: string
}

// ── helpers ──────────────────────────────────────────────────────────

const BACKEND_CLS: Record<string, string> = {
  ceph: 'border-sky-500/30 bg-sky-500/15 text-sky-400',
  glusterfs: 'border-amber-500/30 bg-amber-500/15 text-amber-500',
  moosefs: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  beegfs: 'border-teal-500/30 bg-teal-500/15 text-teal-400',
  orangefs: 'border-orange-500/30 bg-orange-500/15 text-orange-400',
}

function backendBadge(backend: string) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
        BACKEND_CLS[backend] ?? 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      {backend}
    </span>
  )
}

function fmtTb(gb: number): string {
  return `${(gb / 1000).toFixed(0)} TB`
}

// ── panel ────────────────────────────────────────────────────────────

export default function RemotefsPanel() {
  const summary = useBridgeQuery<RfSummary>('remotefs', 'summary', {}, { refetchInterval: 8000 })
  const list = useBridgeQuery<{ filesystems: Rfs[]; count: number }>('remotefs', 'list', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function mutate(command: 'mount' | 'unmount' | 'heal', fs: Rfs) {
    setBusyId(fs.id)
    try {
      const res = await action('remotefs', command, { id: fs.id })
      if (res.ok) {
        const d = res.data as { mounts?: number; state?: string }
        toast.success(`${command}: ${fs.name}`, {
          description: `${d.mounts ?? fs.mounts} mounts · state → ${d.state ?? fs.state}`,
        })
      } else {
        toast.error(`${command}: ${fs.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Remote FS" subtitle="distributed storage — ceph · glusterfs · moosefs · beegfs · orangefs" source="demo" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Remote FS" subtitle="distributed storage — ceph · glusterfs · moosefs · beegfs · orangefs" source="demo" />
        <ErrorCard error={summary.data?.error ?? 'remotefs.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const rows = list.data?.data?.filesystems ?? []
  const usedPct = s.capacityGb > 0 ? (s.usedGb / s.capacityGb) * 100 : 0

  return (
    <div>
      <PanelHeader
        title="Remote FS"
        subtitle="distributed storage — ceph · glusterfs · moosefs · beegfs · orangefs · 8s poll"
        source="demo"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="filesystems" value={s.filesystems} icon={<Database className="h-4 w-4" aria-hidden />} hint={`${s.healthy} healthy · ${s.degraded} degraded · ${s.offline} offline`} />
        <StatCard label="healthy" value={s.healthy} tone="good" icon={<HardDrive className="h-4 w-4" aria-hidden />} />
        <StatCard label="capacity" value={fmtTb(s.capacityGb)} hint={`${fmtTb(s.usedGb)} used (${usedPct.toFixed(0)}%)`} icon={<HardDrive className="h-4 w-4" aria-hidden />} />
        <StatCard label="active mounts" value={s.mounts} icon={<HardDriveDownload className="h-4 w-4" aria-hidden />} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {rows.map((fs) => {
          const usagePct = fs.sizeGb > 0 ? (fs.usedGb / fs.sizeGb) * 100 : 0
          const tone = fs.state === 'offline' ? 'bad' : usagePct > 85 ? 'warn' : 'good'
          return (
            <PanelCard
              key={fs.id}
              title={
                <span className="flex items-center gap-2 normal-case">
                  <span className="font-mono text-sm font-semibold text-foreground">{fs.name}</span>
                  {backendBadge(fs.backend)}
                  <StateBadge state={fs.state} />
                </span>
              }
              actions={<Mono>{fs.bricks} bricks · {fs.mounts} mounts</Mono>}
              contentClassName="space-y-3"
            >
              <div className="space-y-1">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted-foreground">usage</span>
                  <span className="font-mono tabular-nums text-foreground">
                    {fs.usedGb > 0 ? `${(fs.usedGb / 1000).toFixed(1)} TB / ${(fs.sizeGb / 1000).toFixed(0)} TB` : '— / ' + `${(fs.sizeGb / 1000).toFixed(0)} TB`}
                  </span>
                </div>
                <Bar pct={usagePct} tone={tone} />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground" title={fs.note}>
                {fs.note}
              </p>
              <div className="flex items-center gap-2 border-t border-border/50 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 font-mono text-[11px]"
                  disabled={busyId === fs.id}
                  onClick={() => void mutate('mount', fs)}
                  aria-label={`mount ${fs.name}`}
                  title="adds one mount (refused while the backend is down)"
                >
                  <HardDriveDownload className="h-3 w-3" aria-hidden /> mount
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 font-mono text-[11px]"
                  disabled={busyId === fs.id || fs.mounts === 0}
                  onClick={() => void mutate('unmount', fs)}
                  aria-label={`unmount ${fs.name}`}
                  title="removes one mount — reaching 0 marks the filesystem offline"
                >
                  <Unplug className="h-3 w-3" aria-hidden /> unmount
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 gap-1 px-2 font-mono text-[11px] text-teal-400 hover:text-teal-300"
                  disabled={busyId === fs.id || fs.state !== 'degraded'}
                  onClick={() => void mutate('heal', fs)}
                  aria-label={`heal ${fs.name}`}
                  title={fs.state === 'degraded' ? 'replace-brick / rebalance the degraded cluster' : 'heal applies to degraded clusters only'}
                >
                  <HeartPulse className="h-3 w-3" aria-hidden /> heal
                </Button>
              </div>
              <div className="border-t border-border/50 pt-1">
                <KV k="size" v={`${fs.sizeGb.toLocaleString('en-US')} GB`} />
                <KV k="used" v={`${fs.usedGb.toLocaleString('en-US')} GB (${usagePct.toFixed(0)}%)`} />
                <KV k="bricks / targets" v={fs.bricks} />
              </div>
            </PanelCard>
          )
        })}
      </div>

      <p className="mt-4 pb-2 text-xs text-muted-foreground">
        no ceph/glusterfs/moosefs/beegfs/orangefs daemons in this sandbox — the cluster above is the bridge&apos;s demo
        inventory (glance-share degraded with brick gv2 down; orange-hpc offline since the last maintenance). unmount
        reaching zero marks a filesystem offline; heal restores the degraded gluster (bricks 2→3).
      </p>
    </div>
  )
}
