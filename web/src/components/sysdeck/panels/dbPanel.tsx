'use client'

// DB panel — database instance fleet. LIVE: every row is a real
// instance probed on this host — the sqlite row is the sysdeck state
// store (db/custom.db, size + row counts live), and mariadb/postgres/
// redis appear when their daemons actually run (systemd + readiness
// probes). start/stop run real systemctl actions; stopping sqlite is
// refused by the bridge ('cannot stop the sysdeck state store') — the
// toast surfaces it.

import { useState } from 'react'
import { toast } from 'sonner'
import { Database, Play, ServerCog, Square, Table2, Wifi } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface DbSummary {
  instances: number
  running: number
  stopped: number
  engines: string[]
  totalSizeMb: number
  totalConns: number
}

interface DbInstance {
  id: string
  name: string
  engine: string
  host: string
  port: number
  status: 'running' | 'stopped'
  sizeMb: number
  conns: number
  version: string
  note: string
  real?: boolean
  tableCounts?: Record<string, number>
  path?: string
}

interface BackupRecord {
  instance: string
  engine: string
  path: string
  sizeBytes: number
  sizeHuman: string
  ts: string
}

// ── helpers ──────────────────────────────────────────────────────────

const ENGINE_CLS: Record<string, string> = {
  sqlite: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  mariadb: 'border-amber-500/30 bg-amber-500/15 text-amber-500',
  postgres: 'border-sky-500/30 bg-sky-500/15 text-sky-400',
  redis: 'border-red-500/30 bg-red-500/15 text-red-400',
}

function engineBadge(engine: string) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
        ENGINE_CLS[engine] ?? 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      {engine}
    </span>
  )
}

function fmtSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`
  return `${mb.toFixed(1)} MB`
}

// ── panel ────────────────────────────────────────────────────────────

export default function DbPanel() {
  const summary = useBridgeQuery<DbSummary>('db', 'summary', {}, { refetchInterval: 8000 })
  const list = useBridgeQuery<{ instances: DbInstance[]; count: number }>('db', 'list', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()

  const [busyId, setBusyId] = useState<string | null>(null)
  const [backup, setBackup] = useState<BackupRecord | null>(null)
  const [backupBusy, setBackupBusy] = useState<string | null>(null)

  async function mutate(command: 'start' | 'stop', inst: DbInstance) {
    setBusyId(inst.id)
    try {
      const res = await action('db', command, { id: inst.id })
      if (res.ok) {
        toast.success(`${command}: ${inst.name}`, {
          description: `status → ${(res.data as { status?: string })?.status ?? 'ok'}`,
        })
      } else {
        // sqlite stop refusal is EXPECTED — surface it honestly
        toast.error(`${command}: ${inst.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  async function doBackup(inst: DbInstance) {
    setBackupBusy(inst.id)
    try {
      const res = await action('db', 'backup', { id: inst.id })
      if (res.ok && res.data) {
        setBackup(res.data as BackupRecord)
        toast.success(`backup: ${inst.name}`, { description: (res.data as BackupRecord).sizeHuman })
      } else {
        toast.error(`backup: ${inst.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBackupBusy(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Databases" subtitle="instance fleet — sqlite · mariadb · postgres · redis" source="hybrid" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Databases" subtitle="instance fleet — sqlite · mariadb · postgres · redis" source="hybrid" />
        <ErrorCard error={summary.data?.error ?? 'db.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const rows = list.data?.data?.instances ?? []
  const sqlite = rows.find((r) => r.real)

  return (
    <div>
      <PanelHeader
        title="Databases"
        subtitle="instance fleet — the sqlite row is the REAL sysdeck state store · 8s poll"
        source="hybrid"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="instances" value={s.instances} icon={<Database className="h-4 w-4" aria-hidden />} hint={s.engines.join(' · ')} />
        <StatCard label="running" value={s.running} tone="good" icon={<ServerCog className="h-4 w-4" aria-hidden />} hint={`${s.stopped} stopped`} />
        <StatCard label="connections" value={s.totalConns} icon={<Wifi className="h-4 w-4" aria-hidden />} hint={`total size ${fmtSize(s.totalSizeMb)}`} />
      </div>

      <div className="mt-4 space-y-4">
        <PanelCard title="Instances" actions={<Mono>db list</Mono>}>
          <DataTable
            rows={rows}
            headers={['Name', 'Engine', 'Host', 'Status', 'Size', 'Conns', 'Version', '']}
            keyOf={(r) => r.id}
            maxH="26rem"
            renderRow={(r) => (
              <>
                <TableCell className="font-mono text-xs font-medium">
                  {r.name}
                  {r.real ? (
                    <span className="ml-2 rounded border border-emerald-500/30 bg-emerald-500/15 px-1 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-emerald-400">
                      REAL
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{engineBadge(r.engine)}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {r.port > 0 ? `${r.host}:${r.port}` : r.host}
                </TableCell>
                <TableCell>
                  <StateBadge state={r.status} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{fmtSize(r.sizeMb)}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{r.conns}</TableCell>
                <TableCell className="max-w-52 truncate font-mono text-[11px] text-muted-foreground" title={r.version}>
                  {r.version}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {r.status === 'running' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyId === r.id}
                        onClick={() => void mutate('stop', r)}
                        aria-label={`stop ${r.name}`}
                        title={r.real ? 'the bridge refuses stopping the state store' : 'stop the instance'}
                      >
                        <Square className="h-3 w-3" aria-hidden /> stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyId === r.id}
                        onClick={() => void mutate('start', r)}
                        aria-label={`start ${r.name}`}
                      >
                        <Play className="h-3 w-3" aria-hidden /> start
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 font-mono text-[11px]"
                      disabled={backupBusy === r.id || r.status !== 'running'}
                      onClick={() => void doBackup(r)}
                      aria-label={`backup ${r.name}`}
                      title={r.status !== 'running' ? 'backup is refused while stopped' : 'dump + gzip record'}
                    >
                      backup
                    </Button>
                  </div>
                </TableCell>
              </>
            )}
          />
        </PanelCard>

        {sqlite ? (
          <PanelCard
            title={
              <span className="flex items-center gap-2 normal-case">
                <Table2 className="h-4 w-4" aria-hidden />
                <span className="font-mono text-sm font-semibold text-foreground">sysdeck state store — live row counts</span>
              </span>
            }
            actions={<Mono>{sqlite.path}</Mono>}
          >
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div>
                <KV k="file" v={sqlite.path ?? 'db/custom.db'} />
                <KV k="size on disk" v={fmtSize(sqlite.sizeMb)} />
                <KV k="version" v={sqlite.version} />
              </div>
              <div>
                {Object.entries(sqlite.tableCounts ?? {}).map(([t, n]) => (
                  <KV key={t} k={`rows · ${t}`} v={n.toLocaleString('en-US')} />
                ))}
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{sqlite.note}</p>
          </PanelCard>
        ) : null}

        <p className="pb-2 text-xs text-muted-foreground">
          LIVE: the sqlite row is the real state store behind this panel (size via fs.stat, row counts live); the
          mariadb/postgres/redis rows appear only when those daemons actually run on this host (real systemd +
          readiness probes — never seeded). Stopping sqlite is refused by the bridge; backups are real dumps of the
          sqlite store.
        </p>
      </div>

      <Dialog open={backup !== null} onOpenChange={(o) => !o && setBackup(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">
              backup record — <span className="text-muted-foreground">{backup?.instance}</span>
            </DialogTitle>
            <DialogDescription>real dump piped through gzip into /var/backups — recorded in the audit log</DialogDescription>
          </DialogHeader>
          {backup ? (
            <div className="rounded border border-border bg-zinc-950/80 p-3">
              <div className="space-y-0">
                <KV k="instance" v={backup.instance} />
                <KV k="engine" v={backup.engine} />
                <KV k="path" v={backup.path} />
                <KV k="size" v={`${backup.sizeHuman} (${backup.sizeBytes.toLocaleString('en-US')} B)`} />
                <KV k="created" v={backup.ts} />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setBackup(null)}>
              close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
