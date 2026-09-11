'use client'

// Fleet panel — node registry + live localhost host.
// The localhost entry is REAL (live /proc metrics on every poll); the
// helios/theia/selene/ares peers are a seeded demo registry whose
// metrics random-walk server-side. addNode/removeNode run through the
// bridge with audit rows (useBridgeAction + toasts).

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Cpu, HardDrive, MapPin, Plus, Server, Trash2 } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  Bar,
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface NodeMetrics {
  cpuPct: number
  memPct: number
  load1: number
}

interface FleetNode {
  id: string
  name: string
  host: string
  role: string
  arch: string
  state: string
  cpuModel: string | null
  cores: number
  memGb: number
  local: boolean
  metrics: NodeMetrics | null
}

interface FleetSummary {
  uptimeS: number
  load: { 1: number; 5: number; 15: number }
  host: { hostname: string; kernel: string; arch: string; cpuModel: string; cores: number; memGb: number }
  fleetNodes: FleetNode[]
  counts: { total: number; online: number; degraded: number; offline: number }
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function metricTone(pct: number): 'good' | 'warn' | 'bad' {
  if (pct > 90) return 'bad'
  if (pct > 70) return 'warn'
  return 'good'
}

// ── add-node dialog ──────────────────────────────────────────────────

function AddNodeDialog({ onAdd }: { onAdd: (args: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [role, setRole] = useState('compute')
  const [cores, setCores] = useState('8')
  const [memGb, setMemGb] = useState('32')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await onAdd({ name, host, role, cores: Number(cores), memGb: Number(memGb) })
      setOpen(false)
      setName('')
      setHost('')
    } finally {
      setBusy(false)
    }
  }

  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && host.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 font-mono text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          add node
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Register fleet node</DialogTitle>
          <DialogDescription>
            Records the peer in the FleetNode registry. Reachability requires the cockpit bridge on a managed host — new nodes start offline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fn-name">Name</Label>
              <Input id="fn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="helios-03" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-host">Address</Label>
              <Input id="fn-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.10.13" className="font-mono" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger aria-label="Node role" className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compute">compute</SelectItem>
                  <SelectItem value="storage">storage</SelectItem>
                  <SelectItem value="edge">edge</SelectItem>
                  <SelectItem value="control">control</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-cores">Cores</Label>
              <Input id="fn-cores" value={cores} onChange={(e) => setCores(e.target.value)} inputMode="numeric" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-mem">Memory GB</Label>
              <Input id="fn-mem" value={memGb} onChange={(e) => setMemGb(e.target.value)} inputMode="numeric" className="font-mono" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()} className="gap-2">
            {busy ? 'registering…' : 'Register node'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function FleetPanel() {
  const summary = useBridgeQuery<FleetSummary>('fleet', 'summary', undefined, { refetchInterval: 5000 })
  const action = useBridgeAction()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const data = summary.data?.data
  const nodes = useMemo(() => data?.fleetNodes ?? [], [data])
  const localNode = useMemo(() => nodes.find((n) => n.local) ?? null, [nodes])
  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? localNode ?? nodes[0] ?? null,
    [nodes, selectedId, localNode],
  )

  async function addNode(args: Record<string, unknown>) {
    const res = await action('fleet', 'addNode', args)
    if (res.ok) {
      toast.success(`node ${String(args.name)} registered`, {
        description: 'recorded offline — metrics flow once a managed host reports in',
      })
    } else {
      toast.error('addNode failed', { description: res.error })
    }
  }

  async function removeNode(node: FleetNode) {
    const res = await action('fleet', 'removeNode', { id: node.id })
    if (res.ok) {
      toast.success(`node ${node.name} removed from the registry`)
      if (selectedId === node.id) setSelectedId(null)
    } else {
      toast.error('removeNode failed', { description: res.error })
    }
  }

  if (summary.isLoading && !summary.data) return <PanelSkeleton lines={3} />
  if (summary.data && !summary.data.ok) return <ErrorCard error={summary.data.error ?? 'fleet.summary failed'} />

  const counts = data?.counts

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Fleet"
        subtitle="node registry and live host metrics — a fleet-of-one live; peers are a demo registry with drifting metrics"
        source="hybrid"
        actions={<AddNodeDialog onAdd={addNode} />}
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Nodes" value={counts?.total ?? '—'} icon={<Server className="h-4 w-4" aria-hidden />} hint="registered in the fleet" />
        <StatCard label="Online" value={counts?.online ?? '—'} tone="good" hint="reachable + healthy" />
        <StatCard label="Degraded" value={counts?.degraded ?? '—'} tone={counts?.degraded ? 'warn' : 'default'} hint="running with warnings" />
        <StatCard label="Offline" value={counts?.offline ?? '—'} tone={counts?.offline ? 'bad' : 'default'} hint="unreachable" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* node table */}
        <PanelCard title="Node registry" className="lg:col-span-2" actions={<Mono>click a row to inspect</Mono>}>
          <DataTable
            rows={nodes}
            headers={['Node', 'Host', 'Role', 'Arch', 'Cores', 'Mem', 'CPU %', 'MEM %', 'State', '']}
            keyOf={(n) => n.id}
            maxH="30rem"
            empty="no nodes registered"
            renderRow={(n) => (
              <>
                <TableCell className="font-medium">
                  <button
                    className="max-w-44 truncate text-left hover:text-primary"
                    onClick={() => setSelectedId(n.id)}
                    title={n.name}
                  >
                    {n.name}
                    {n.local ? (
                      <Badge variant="outline" className="ml-2 border-primary/40 font-mono text-[9px] text-primary">
                        THIS HOST
                      </Badge>
                    ) : null}
                  </button>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{n.host}</TableCell>
                <TableCell className="text-xs">{n.role}</TableCell>
                <TableCell className="font-mono text-xs">{n.arch}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{n.cores}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{n.memGb}G</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {n.metrics ? (
                    <span className={n.metrics.cpuPct > 70 ? 'text-amber-500' : 'text-foreground'}>{n.metrics.cpuPct.toFixed(1)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {n.metrics ? (
                    <span className={n.metrics.memPct > 70 ? 'text-amber-500' : 'text-foreground'}>{n.metrics.memPct.toFixed(1)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <StateBadge state={n.state} />
                </TableCell>
                <TableCell className="text-right">
                  {n.local ? null : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-red-500"
                      aria-label={`Remove node ${n.name}`}
                      title={`remove ${n.name} from the registry`}
                      onClick={() => void removeNode(n)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </TableCell>
              </>
            )}
          />
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            localhost metrics are live /proc per poll; demo peers random-walk server-side; offline nodes report null metrics.
          </p>
        </PanelCard>

        {/* inspector */}
        <div className="space-y-4">
          <PanelCard
            title={
              <span className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary" aria-hidden />
                {selected ? selected.name : 'Inspector'}
              </span>
            }
            actions={selected ? <StateBadge state={selected.state} /> : null}
          >
            {selected ? (
              <div>
                <KV k="host" v={selected.host} />
                <KV k="role" v={selected.role} />
                <KV k="arch" v={selected.arch} />
                <KV k="cpu model" v={<span className="break-all">{selected.cpuModel ?? 'unknown'}</span>} />
                <KV k="cores" v={selected.cores} />
                <KV k="memory" v={`${selected.memGb} GB`} />
                <KV k="node id" v={<span className="break-all text-[11px]">{selected.id}</span>} />
                <div className="mt-3 border-t border-border/50 pt-2">
                  <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">live metrics</p>
                  {selected.metrics ? (
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-muted-foreground">cpu</span>
                          <span className="font-mono tabular-nums">{selected.metrics.cpuPct.toFixed(1)}%</span>
                        </div>
                        <Bar pct={selected.metrics.cpuPct} tone={metricTone(selected.metrics.cpuPct)} />
                      </div>
                      <div>
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-muted-foreground">memory</span>
                          <span className="font-mono tabular-nums">{selected.metrics.memPct.toFixed(1)}%</span>
                        </div>
                        <Bar pct={selected.metrics.memPct} tone={metricTone(selected.metrics.memPct)} />
                      </div>
                      <KV k="load1" v={selected.metrics.load1.toFixed(2)} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">node offline — no metrics reported</p>
                  )}
                </div>
                {selected.local && data ? (
                  <div className="mt-3 border-t border-border/50 pt-2">
                    <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">localhost extras</p>
                    <KV k="kernel" v={<span className="break-all">{data.host.kernel}</span>} />
                    <KV k="hostname" v={data.host.hostname} />
                    <KV k="load 5/15" v={`${data.load[5].toFixed(2)} / ${data.load[15].toFixed(2)}`} />
                    <KV k="uptime" v={fmtUptime(data.uptimeS)} />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">select a node row to inspect it</p>
            )}
          </PanelCard>

          <PanelCard title="Local host">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
                <Cpu className="h-4.5 w-4.5 text-primary" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm font-semibold">{data?.host.hostname ?? '—'}</p>
                <p className="truncate text-xs text-muted-foreground">{data?.host.cpuModel ?? '—'}</p>
              </div>
            </div>
            <div className="mt-2">
              <KV k="cores / mem" v={`${data?.host.cores ?? '—'} / ${data?.host.memGb ?? '—'} GB`} />
              <KV k="uptime" v={fmtUptime(data?.uptimeS ?? 0)} />
              <KV k="role" v="control (this host)" />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5" aria-hidden />
              fleet-of-one live — peers are seeded demo rows
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  )
}
