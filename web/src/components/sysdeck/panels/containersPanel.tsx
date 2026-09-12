'use client'

// Containers panel — incus / libvirt / podman / firecracker inventory.
// The bridge aggregates EVERY runtime actually present on the host
// (podman ps -a --format json, docker, incus list, lxc-list, virsh list
// --all, firecracker sockets) — no seeded rows. start/stop/freeze/delete
// run the runtime's real command; exec runs the runtime's real exec and
// streams its actual output.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Boxes, Cpu, MemoryStick, Play, Snowflake, Square, TerminalSquare, Trash2 } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import type { BridgeResponse } from '@/lib/sysdeck/types'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface Ctr {
  id: string
  name: string
  driver: string
  kind: 'container' | 'vm'
  image: string
  state: 'running' | 'stopped' | 'frozen'
  cpuPct: number
  memMb: number
  uptimeS: number
  ports: string | null
  createdAt: string
}

interface SummaryData {
  total: number
  running: number
  stopped: number
  vms: number
  containers: number
  drivers: { name: string; count: number }[]
}

interface ExecResult {
  id: string
  name: string
  command: string
  rc: number
  lines: string[]
}

// ── helpers ──────────────────────────────────────────────────────────

const DRIVER_CLS: Record<string, string> = {
  incus: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
  libvirt: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  podman: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  firecracker: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
}

function driverBadge(driver: string) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
        DRIVER_CLS[driver] ?? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
      }`}
    >
      {driver}
    </span>
  )
}

function kindBadge(kind: string) {
  return kind === 'vm' ? (
    <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-violet-300">vm</span>
  ) : (
    <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-sky-400">ct</span>
  )
}

function fmtUptime(s: number): string {
  if (s <= 0) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtMem(mb: number): string {
  if (mb <= 0) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`
  return `${mb} MiB`
}

// ── exec dialog ──────────────────────────────────────────────────────

function ExecDialog({
  ctr,
  onExec,
}: {
  ctr: Ctr | null
  onExec: (id: string, command: string) => Promise<BridgeResponse<unknown>>
}) {
  const [open, setOpen] = useState(false)
  const [command, setCommand] = useState('uname -a')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExecResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (!ctr || !command.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await onExec(ctr.id, command.trim())
      if (res.ok && res.data) {
        const r = res.data as ExecResult
        setResult(r)
        if (r.rc !== 0) {
          toast.warning(`exec on ${ctr.name}: rc ${r.rc}`, { description: r.lines.at(-1) })
        } else {
          toast.success(`exec on ${ctr.name}: rc 0`, { description: r.lines.at(-1)?.slice(0, 80) })
        }
      } else {
        setError(res.error ?? 'exec failed')
        toast.error(`exec on ${ctr.name} failed`, { description: res.error })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setResult(null)
          setError(null)
        }
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 font-mono text-xs"
        disabled={ctr?.state !== 'running'}
        title={ctr?.state === 'running' ? 'open an exec shell' : 'only running instances accept exec'}
        onClick={() => {
          setResult(null)
          setError(null)
          setOpen(true)
        }}
      >
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
        exec
      </Button>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            exec — <span className="text-muted-foreground">{ctr?.name}</span>
          </DialogTitle>
          <DialogDescription>
            real exec through the instance&apos;s runtime — the command runs inside the container/VM and the output below
            is exactly what it answered
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void run()
            }}
            placeholder="command to run"
            className="font-mono text-xs"
            aria-label="command"
          />
          <Button size="sm" onClick={() => void run()} disabled={busy || !command.trim()} className="gap-1.5 font-mono text-xs">
            {busy ? 'running…' : 'run'}
          </Button>
        </div>
        {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
        {result ? (
          <ScrollArea className="h-56 rounded border border-border bg-zinc-950/80">
            <pre className="p-3 font-mono text-xs leading-relaxed text-zinc-300">
              {result.lines.join('\n')}
              {'\n'}[rc {result.rc}]
            </pre>
          </ScrollArea>
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">no output yet — run a command above</p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function ContainersPanel() {
  const summary = useBridgeQuery<SummaryData>('containers', 'summary', {}, { refetchInterval: 6000 })
  const list = useBridgeQuery<{ containers: Ctr[]; total: number }>('containers', 'list', {}, { refetchInterval: 6000 })
  const action = useBridgeAction()

  const [driverFilter, setDriverFilter] = useState<string>('all')
  const [stateFilter, setStateFilter] = useState<string>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Ctr | null>(null)

  const rows = list.data?.data?.containers ?? []
  const drivers = summary.data?.data?.drivers ?? []

  const filtered = useMemo(
    () =>
      rows.filter(
        (c) => (driverFilter === 'all' || c.driver === driverFilter) && (stateFilter === 'all' || c.state === stateFilter),
      ),
    [rows, driverFilter, stateFilter],
  )

  async function mutate(command: 'start' | 'stop' | 'freeze', c: Ctr) {
    setBusyId(c.id)
    try {
      const res = await action('containers', command, { id: c.id })
      if (res.ok) {
        toast.success(`${command}: ${c.name}`, { description: `state → ${(res.data as { state?: string })?.state ?? 'ok'}` })
      } else {
        toast.error(`${command}: ${c.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  async function doDelete() {
    const c = deleteTarget
    if (!c) return
    setDeleteTarget(null)
    setBusyId(c.id)
    try {
      const res = await action('containers', 'delete', { id: c.id })
      if (res.ok) {
        toast.success(`deleted ${c.name}`, { description: `${c.driver} ${c.kind} removed from the registry` })
      } else {
        toast.error(`delete ${c.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Containers" subtitle="incus · libvirt · podman · firecracker — unified fleet" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Containers" subtitle="incus · libvirt · podman · firecracker — unified fleet" />
        <ErrorCard error={summary.data?.error ?? 'containers.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data

  return (
    <div>
      <PanelHeader
        title="Containers"
        subtitle="incus · libvirt · podman · firecracker — unified fleet · 6s poll"
        source={summary.data?.source ?? 'live'}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="instances" value={s.total} icon={<Boxes className="h-4 w-4" aria-hidden />} hint={`${s.containers} containers · ${s.vms} vms`} />
        <StatCard label="running" value={s.running} tone="good" icon={<Play className="h-4 w-4" aria-hidden />} />
        <StatCard label="stopped" value={s.stopped} tone="warn" icon={<Square className="h-4 w-4" aria-hidden />} />
        <StatCard label="vms" value={s.vms} icon={<Cpu className="h-4 w-4" aria-hidden />} />
      </div>

      <div className="mt-4 space-y-4">
        <PanelCard
          title="Fleet inventory"
          actions={<Mono>{filtered.length} of {rows.length} shown</Mono>}
          contentClassName="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {['all', ...drivers.map((d) => d.name)].map((d) => {
              const count = d === 'all' ? rows.length : drivers.find((x) => x.name === d)?.count ?? 0
              const active = driverFilter === d
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDriverFilter(d)}
                  className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                    active
                      ? 'border-teal-500/40 bg-teal-500/15 text-teal-300'
                      : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {d} · {count}
                </button>
              )
            })}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {['all', 'running', 'stopped', 'frozen'].map((st) => {
              const active = stateFilter === st
              return (
                <button
                  key={st}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStateFilter(st)}
                  className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                    active
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                      : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {st}
                </button>
              )
            })}
          </div>

          <DataTable
            rows={filtered}
            headers={['Name', 'Driver', 'Kind', 'Image', 'State', 'CPU', 'Memory', 'Uptime', 'Ports', '']}
            keyOf={(c) => c.id}
            maxH="30rem"
            empty={filtered.length === 0 ? 'no instances match the filters' : 'loading…'}
            renderRow={(c) => (
              <>
                <TableCell className="font-mono text-xs font-medium">{c.name}</TableCell>
                <TableCell>{driverBadge(c.driver)}</TableCell>
                <TableCell>{kindBadge(c.kind)}</TableCell>
                <TableCell className="max-w-52 truncate font-mono text-[11px] text-muted-foreground" title={c.image}>
                  {c.image}
                </TableCell>
                <TableCell>
                  <span className={c.state === 'running' ? '' : c.state === 'frozen' ? 'inline-block animate-pulse' : ''}>
                    <StateBadge state={c.state} />
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  <span className={c.cpuPct > 50 ? 'text-amber-500' : ''}>{c.cpuPct > 0 ? `${c.cpuPct.toFixed(1)}%` : '—'}</span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{fmtMem(c.memMb)}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{fmtUptime(c.uptimeS)}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-[11px] text-muted-foreground" title={c.ports ?? ''}>
                  {c.ports ?? '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {c.state === 'stopped' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyId === c.id}
                        onClick={() => void mutate('start', c)}
                        aria-label={`start ${c.name}`}
                      >
                        <Play className="h-3 w-3" aria-hidden /> start
                      </Button>
                    ) : null}
                    {c.state === 'running' ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 font-mono text-[11px]"
                          disabled={busyId === c.id}
                          onClick={() => void mutate('freeze', c)}
                          aria-label={`freeze ${c.name}`}
                          title={c.kind === 'vm' ? 'freezing VMs is refused (CRIU)' : 'checkpoint-freeze the instance'}
                        >
                          <Snowflake className="h-3 w-3" aria-hidden /> freeze
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 font-mono text-[11px]"
                          disabled={busyId === c.id}
                          onClick={() => void mutate('stop', c)}
                          aria-label={`stop ${c.name}`}
                        >
                          <Square className="h-3 w-3" aria-hidden /> stop
                        </Button>
                      </>
                    ) : null}
                    {c.state === 'frozen' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyId === c.id}
                        onClick={() => void mutate('start', c)}
                        aria-label={`resume ${c.name}`}
                      >
                        <Play className="h-3 w-3" aria-hidden /> resume
                      </Button>
                    ) : null}
                    <ExecDialog ctr={c} onExec={(id, cmd) => action('containers', 'exec', { id, command: cmd })} />
                    {c.state === 'stopped' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px] text-red-400 hover:text-red-300"
                        disabled={busyId === c.id}
                        onClick={() => setDeleteTarget(c)}
                        aria-label={`delete ${c.name}`}
                        title="delete the instance (refused while running)"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </>
            )}
          />
        </PanelCard>

        <p className="pb-2 text-xs text-muted-foreground">
          no container runtimes are installed on this host (probed: podman, docker, incus, lxc, virsh, firecracker) — the
          fleet is empty, nothing is fabricated. Install any of them and instances appear here live on the next poll;
          start/stop/freeze/delete/exec run the runtime&apos;s own commands (freeze applies to containers only — the bridge
          refuses VMs).
        </p>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the {deleteTarget?.driver} {deleteTarget?.kind} via the runtime&apos;s real delete command. The bridge refuses deletes
              while an instance is running — stop it first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-500"
              onClick={() => void doDelete()}
            >
              delete instance
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
