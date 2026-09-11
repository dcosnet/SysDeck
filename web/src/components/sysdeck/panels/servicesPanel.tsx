'use client'

// Service / Ports panel — every listening socket from /proc/net/tcp{,6}
// (inode→pid where readable) cross-referenced with the ServicePort
// registry. setPort/resetPort run through the bridge (audit rows);
// config-file writes honestly require the cockpit bridge on a managed
// host, so the response's appliedToConfig:false is surfaced in the toast.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ListChecks, Network, RefreshCw, RotateCcw, Search, Settings2 } from 'lucide-react'
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface Listener {
  port: number
  proto: string
  addr: string
  inode: string
  pid: number | null
  process: string | null
  service: { service: string; label: string; configuredPort: number } | null
}

interface RegistryRow {
  id: string
  service: string
  label: string
  port: number
  configPath: string
  configKey: string
  running: boolean
  updatedPort: number | null
}

interface ServicesList {
  listeners: Listener[]
  registry: RegistryRow[]
  listening: number
  registered: number
}

// ── set-port dialog ──────────────────────────────────────────────────

function SetPortDialog({
  row,
  onSet,
}: {
  row: RegistryRow
  onSet: (service: string, port: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)

  const effective = row.updatedPort ?? row.port
  const parsed = Number(port)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535

  async function submit() {
    setBusy(true)
    try {
      await onSet(row.service, parsed)
      setOpen(false)
      setPort('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPort('') }}>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label={`Set port for ${row.service}`}
      >
        <Settings2 className="h-3 w-3" aria-hidden />
        set port
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono">Set port — {row.label}</DialogTitle>
          <DialogDescription>
            Records the new listen port in the registry. The config file ({row.configPath}, key <span className="font-mono">{row.configKey}</span>) is written by the cockpit bridge on a managed host, not from the web edition.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sp-port">New port (1–65535)</Label>
            <Input
              id="sp-port"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              placeholder={String(effective)}
              inputMode="numeric"
              className="font-mono"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            current effective port <Mono>{effective}</Mono>
            {row.updatedPort !== null ? (
              <>
                {' '}· registry default <Mono>{row.port}</Mono>
              </>
            ) : null}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'applying…' : 'Set port'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function ServicesPanel() {
  const q = useBridgeQuery<ServicesList>('services', 'list')
  const action = useBridgeAction()
  const [search, setSearch] = useState('')

  const data = q.data?.data

  const regFiltered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const rows = data?.registry ?? []
    if (!s) return rows
    return rows.filter(
      (r) => r.service.includes(s) || r.label.toLowerCase().includes(s) || String(r.updatedPort ?? r.port).includes(s),
    )
  }, [data, search])

  const lisFiltered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const rows = data?.listeners ?? []
    if (!s) return rows
    return rows.filter(
      (l) =>
        String(l.port).includes(s) ||
        l.proto.includes(s) ||
        (l.process ?? '').toLowerCase().includes(s) ||
        (l.service?.label ?? 'unregistered').toLowerCase().includes(s),
    )
  }, [data, search])

  const unregistered = (data?.listeners ?? []).filter((l) => !l.service).length
  const runningCount = (data?.registry ?? []).filter((r) => r.running).length

  async function setPort(service: string, port: number) {
    const res = await action('services', 'setPort', { service, port })
    if (res.ok) {
      const d = res.data as { oldPort: number; newPort: number; configPath: string } | undefined
      toast.success(`${service}: port ${d?.oldPort} → ${d?.newPort}`, {
        description: `${d?.configPath} will be applied by the cockpit bridge on a managed host`,
      })
    } else {
      toast.error('setPort failed', { description: res.error })
    }
  }

  async function resetPort(service: string) {
    const res = await action('services', 'resetPort', { service })
    if (res.ok) {
      const d = res.data as { port: number } | undefined
      toast.success(`${service} port reset to registry default (${d?.port})`)
    } else {
      toast.error('resetPort failed', { description: res.error })
    }
  }

  if (q.isLoading && !q.data) return <PanelSkeleton lines={3} />
  if (q.data && !q.data.ok) return <ErrorCard error={q.data.error ?? 'services.list failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Service / Ports"
        subtitle="every listening socket cross-referenced with the SERVICES_REGISTRY — atomically editable ports"
        source="live"
        actions={
          <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" onClick={() => q.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            refresh
          </Button>
        }
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Listening sockets" value={data?.listening ?? '—'} icon={<Network className="h-4 w-4" aria-hidden />} hint="LISTEN entries in /proc/net/tcp{,6}" />
        <StatCard label="Registered services" value={data?.registered ?? '—'} icon={<ListChecks className="h-4 w-4" aria-hidden />} hint="ServicePort registry rows" />
        <StatCard label="Registry running" value={runningCount} tone="good" hint="registry entries whose port is listening" />
        <StatCard label="Unregistered listeners" value={unregistered} tone={unregistered > 0 ? 'warn' : 'default'} hint="sockets with no registry match" />
      </div>

      {/* search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter by service, process, port…"
          className="pl-8 font-mono text-xs"
          aria-label="Filter services and listeners"
        />
      </div>

      {/* registry */}
      <PanelCard title="SERVICES_REGISTRY" actions={<Mono>{regFiltered.length} rows</Mono>}>
        <DataTable
          rows={regFiltered}
          headers={['Service', 'Label', 'Port', 'Config', 'Status', '']}
          keyOf={(r) => r.id}
          maxH="26rem"
          empty={search ? 'no registry match' : 'registry empty'}
          renderRow={(r) => (
            <>
              <TableCell className="font-mono text-xs font-semibold">{r.service}</TableCell>
              <TableCell className="text-sm">{r.label}</TableCell>
              <TableCell className="font-mono text-xs tabular-nums">
                <span className="font-semibold">{r.updatedPort ?? r.port}</span>
                {r.updatedPort !== null ? (
                  <span className="ml-1.5 text-muted-foreground line-through">{r.port}</span>
                ) : null}
              </TableCell>
              <TableCell className="max-w-64 truncate font-mono text-[11px] text-muted-foreground" title={`${r.configPath} (${r.configKey})`}>
                {r.configPath}
              </TableCell>
              <TableCell>
                <StateBadge state={r.running ? 'running' : 'stopped'} />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <SetPortDialog row={r} onSet={setPort} />
                  {r.updatedPort !== null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => void resetPort(r.service)}
                      aria-label={`Reset port for ${r.service}`}
                      title={`reset to registry default ${r.port}`}
                    >
                      <RotateCcw className="h-3 w-3" aria-hidden />
                      reset
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </>
          )}
        />
      </PanelCard>

      {/* listeners */}
      <PanelCard title="Listening sockets" actions={<Mono>{lisFiltered.length} sockets · inode→pid for this user's processes</Mono>}>
        <DataTable
          rows={lisFiltered}
          headers={['Port', 'Proto', 'Address', 'Process', 'Registry match']}
          keyOf={(l, i) => `${l.proto}-${l.port}-${l.inode}-${i}`}
          maxH="26rem"
          empty={search ? 'no socket match' : 'no listeners'}
          renderRow={(l) => (
            <>
              <TableCell className="font-mono text-xs font-semibold tabular-nums">{l.port}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{l.proto}</TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">{l.addr || '*'}</TableCell>
              <TableCell className="font-mono text-xs">
                {l.process ? (
                  <span>
                    {l.process}
                    {l.pid ? <span className="ml-1.5 text-muted-foreground">[{l.pid}]</span> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground" title="root-owned process — /proc fd not readable for this user">
                    pid {l.pid ?? '—'} (root)
                  </span>
                )}
              </TableCell>
              <TableCell>
                {l.service ? (
                  <Badge variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-400">
                    {l.service.service}
                    <span className="ml-1 font-normal text-muted-foreground">:{l.service.configuredPort}</span>
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-500/30 font-mono text-[10px] text-amber-500">
                    unregistered
                  </Badge>
                )}
              </TableCell>
            </>
          )}
        />
      </PanelCard>
    </div>
  )
}
