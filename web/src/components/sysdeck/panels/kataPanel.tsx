'use client'

// Kata panel — kata-containers sandbox inventory (kata-qemu + kata-clh
// runtimes). kata-runtime/kata-monitor are absent in this sandbox, so the
// bridge keeps a demo inventory: 5 sandboxes (confidential guests, vfio
// passthrough, attested jobs, a plain test sandbox).

import { useState } from 'react'
import { toast } from 'sonner'
import { Boxes, Play, ShieldCheck, Square } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
  StateBadge,
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface KataSummary {
  pods: number
  running: number
  stopped: number
  vmm: string
}

interface KataPod {
  id: string
  name: string
  runtime: 'kata-qemu' | 'kata-clh'
  sandbox: string
  state: 'running' | 'stopped'
  vmm: string
  memMb: number
  cpuPct: number
  pods: number
}

// ── helpers ──────────────────────────────────────────────────────────

function runtimeBadge(runtime: string) {
  return runtime === 'kata-qemu' ? (
    <span className="rounded border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-sky-400">kata-qemu</span>
  ) : (
    <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-emerald-400">kata-clh</span>
  )
}

function fmtMem(mb: number): string {
  if (mb <= 0) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(0)} GiB`
  return `${mb} MiB`
}

// ── panel ────────────────────────────────────────────────────────────

export default function KataPanel() {
  const summary = useBridgeQuery<KataSummary>('kata', 'summary', {}, { refetchInterval: 6000 })
  const list = useBridgeQuery<{ pods: KataPod[]; count: number }>('kata', 'list', {}, { refetchInterval: 6000 })
  const action = useBridgeAction()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function mutate(command: 'start' | 'stop', p: KataPod) {
    setBusyId(p.id)
    try {
      const res = await action('kata', command, { id: p.id })
      if (res.ok) {
        toast.success(`${command}: ${p.name}`, { description: `sandbox state → ${(res.data as { state?: string })?.state ?? 'ok'}` })
      } else {
        toast.error(`${command}: ${p.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Kata" subtitle="kata-containers — isolated VM sandboxes" source="demo" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Kata" subtitle="kata-containers — isolated VM sandboxes" source="demo" />
        <ErrorCard error={summary.data?.error ?? 'kata.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const pods = list.data?.data?.pods ?? []

  return (
    <div>
      <PanelHeader
        title="Kata"
        subtitle="kata-containers — hardware-isolated VM sandboxes · 6s poll"
        source="demo"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="pods" value={s.pods} icon={<Boxes className="h-4 w-4" aria-hidden />} hint={`${s.stopped} stopped`} />
        <StatCard label="running" value={s.running} tone="good" icon={<ShieldCheck className="h-4 w-4" aria-hidden />} />
        <StatCard
          label="vmm"
          value={s.vmm.split('+')[0].trim()}
          hint={s.vmm}
          icon={<Boxes className="h-4 w-4" aria-hidden />}
        />
      </div>

      <div className="mt-4 space-y-4">
        <PanelCard title="Sandboxes" actions={<Mono>kata-monitor /sandboxes</Mono>}>
          <DataTable
            rows={pods}
            headers={['Name', 'Runtime', 'Sandbox', 'VMM', 'State', 'Memory', 'CPU', 'Pods', '']}
            keyOf={(p) => p.id}
            maxH="26rem"
            renderRow={(p) => (
              <>
                <TableCell className="font-mono text-xs font-medium">{p.name}</TableCell>
                <TableCell>{runtimeBadge(p.runtime)}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{p.sandbox}</TableCell>
                <TableCell className="max-w-64 truncate font-mono text-[11px] text-muted-foreground" title={p.vmm}>
                  {p.vmm}
                </TableCell>
                <TableCell>
                  <StateBadge state={p.state} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{fmtMem(p.memMb)}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {p.cpuPct > 0 ? `${p.cpuPct.toFixed(1)}%` : '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{p.pods}</TableCell>
                <TableCell className="text-right">
                  {p.state === 'running' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 font-mono text-[11px]"
                      disabled={busyId === p.id}
                      onClick={() => void mutate('stop', p)}
                      aria-label={`stop ${p.name}`}
                    >
                      <Square className="h-3 w-3" aria-hidden /> stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 font-mono text-[11px]"
                      disabled={busyId === p.id}
                      onClick={() => void mutate('start', p)}
                      aria-label={`start ${p.name}`}
                    >
                      <Play className="h-3 w-3" aria-hidden /> start
                    </Button>
                  )}
                </TableCell>
              </>
            )}
          />
        </PanelCard>

        <p className="pb-2 text-xs text-muted-foreground">
          kata-runtime / kata-monitor are not present in this sandbox — the sandboxes above are the bridge&apos;s demo
          inventory (kata-qemu with confidential guests + vfio passthrough, kata-clh with measured boot attestation).
          start/stop mutate the registry and are audited.
        </p>
      </div>
    </div>
  )
}
