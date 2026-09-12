'use client'

// Netsec panel — network security monitor (iptraf-ng-style socket view +
// fail2ban-style ban layer + real localhost port sweeps).
// Connections/surface/scan are LIVE (decoded from /proc/net/tcp{,6}, the
// sweep connect-tests every listening port). Bans are production: the
// registry is the operator's workspace (never seeded), fail2ban's live
// ban list is merged when it runs, and ban/unban enforce for real via
// nftables (table sysdeck, set blacklist) or an iptables DROP rule.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Activity, Ban, Eye, Gavel, Network, Radar, ShieldAlert, Trash2, Wifi } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  HintCard,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
} from '@/components/sysdeck/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface ConnRow {
  local: string
  remote: string
  state: string
  proto: string
}

interface ConnectionsData {
  total: number
  stateCounts: Record<string, number>
  established: ConnRow[]
  establishedCount: number
}

interface ListenerRow {
  port: number
  proto: string
  addr: string
}

interface SurfaceData {
  listening: number
  uniquePorts: number[]
  uniqueCount: number
  listeners: ListenerRow[]
}

interface BanRow {
  id: string
  ip: string
  service: string
  jail: string
  reason: string
  strikes: number
  bannedAt: string
  expiresAt: string | null
  source?: 'registry' | 'fail2ban'
}

interface ScanPortResult {
  port: number
  open: boolean
}

interface ScanResult {
  id: string
  target: string
  scanned: number
  open: number
  ports: ScanPortResult[]
}

interface NetsecSummary {
  established: number
  listening: number
  timeWait: number
  totalSockets: number
  bans: number
  scans: number
}

/** services.list cross-ref rows (same /proc source, + pid/process/service) */
interface ServicesListener {
  port: number
  proto: string
  addr: string
  pid: number | null
  process: string | null
  service: { service: string; label: string; configuredPort: number } | null
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtUtc(iso: string | null): string {
  if (!iso) return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function connStateCls(state: string): string {
  if (state === 'ESTABLISHED') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  if (state === 'TIME_WAIT') return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
  if (state === 'LISTEN') return 'bg-teal-500/15 text-teal-400 border-teal-500/30'
  if (state.startsWith('CLOSE') || state.startsWith('FIN') || state.startsWith('LAST')) {
    return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
  }
  return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
}

function stateBadge(state: string) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${connStateCls(state)}`}>
      {state}
    </span>
  )
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

// ── ban dialog ───────────────────────────────────────────────────────

function BanDialog({ onBan }: { onBan: (args: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [ip, setIp] = useState('')
  const [service, setService] = useState('sshd')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = IPV4_RE.test(ip)

  async function submit() {
    setBusy(true)
    try {
      await onBan({ ip, service, reason: reason || undefined })
      setOpen(false)
      setIp('')
      setReason('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 font-mono text-xs">
          <Gavel className="h-3.5 w-3.5" aria-hidden />
          ban address
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Ban an address</DialogTitle>
          <DialogDescription>
            Records the address in the sysdeck jail registry AND enforces it for real — an nftables element in the
            sysdeck blacklist set (30d timeout) on nft hosts, an iptables INPUT DROP rule otherwise. Privilege-gated
            (root / sudo -n); unprivileged consoles save the registry row and say so.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ns-ip">IP address</Label>
              <Input
                id="ns-ip"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="203.0.113.9"
                className={`font-mono text-xs ${valid || ip === '' ? '' : 'border-red-500'}`}
                aria-invalid={!valid && ip !== ''}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ns-svc">Service</Label>
              <Input
                id="ns-svc"
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="sshd / nginx"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ns-reason">Reason (optional)</Label>
            <Input
              id="ns-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="ssh brute force"
              className="text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'banning…' : 'Ban'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

interface ScanRecord extends ScanResult {
  at: string
}

export default function NetsecPanel() {
  const summaryQ = useBridgeQuery<NetsecSummary>('netsec', 'summary', undefined, { refetchInterval: 4000 })
  const connsQ = useBridgeQuery<ConnectionsData>('netsec', 'connections', undefined, { refetchInterval: 4000 })
  const surfaceQ = useBridgeQuery<SurfaceData>('netsec', 'surface', undefined, { refetchInterval: 6000 })
  const bansQ = useBridgeQuery<{ bans: BanRow[]; count: number }>('netsec', 'bans', undefined, { refetchInterval: 8000 })
  // cross-reference listeners with the services registry (same /proc source)
  const servicesQ = useBridgeQuery<{ listeners: ServicesListener[] }>('services', 'list', undefined, {
    refetchInterval: 10000,
  })
  const action = useBridgeAction()
  const [scans, setScans] = useState<ScanRecord[]>([])
  const [sweeping, setSweeping] = useState(false)

  const summary = summaryQ.data?.data
  const conns = connsQ.data?.data
  const surface = surfaceQ.data?.data
  const bans = useMemo(() => bansQ.data?.data?.bans ?? [], [bansQ.data])

  const serviceByPort = useMemo(() => {
    const map = new Map<string, ServicesListener>()
    for (const l of servicesQ.data?.data?.listeners ?? []) map.set(`${l.port}-${l.proto}`, l)
    return map
  }, [servicesQ.data])

  async function ban(args: Record<string, unknown>) {
    const res = await action('netsec', 'ban', args)
    if (res.ok) {
      const d = res.data as { enforced?: boolean; via?: string; command?: string } | undefined
      toast.success(`${String(args.ip)} banned`, {
        description: d?.enforced
          ? `enforced for real — ${d.command ?? d.via ?? 'nftables/iptables'}`
          : (res.note ?? 'recorded in the registry — kernel enforcement unavailable on this host'),
        duration: 9000,
      })
    } else {
      toast.error('ban failed', { description: res.error })
    }
  }

  async function unban(row: BanRow) {
    const res = await action('netsec', 'unban', { id: row.id })
    if (res.ok) {
      toast.success(`${row.ip} unbanned`, { description: `removed from the ${row.service} jail` })
    } else {
      toast.error('unban failed', { description: res.error })
    }
  }

  async function runSweep() {
    setSweeping(true)
    try {
      const res = await action('netsec', 'scan', { target: '127.0.0.1' })
      if (res.ok) {
        const d = res.data as ScanResult
        setScans((prev) => [{ ...d, at: new Date().toISOString() }, ...prev].slice(0, 20))
        toast.success('sweep complete', {
          description: `${d.open} of ${d.scanned} listening ports open on ${d.target} (connect-tested on 127.0.0.1 and ::1)`,
        })
      } else {
        toast.error('sweep failed', { description: res.error })
      }
    } finally {
      setSweeping(false)
    }
  }

  if (summaryQ.isLoading && !summaryQ.data) return <PanelSkeleton lines={4} />
  if (summaryQ.data && !summaryQ.data.ok) return <ErrorCard error={summaryQ.data.error ?? 'netsec.summary failed'} />

  const latest = scans[0]

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Network Security"
        subtitle="live socket census, listening surface, ban registry and localhost port sweeps — the iptraf-ng view the cockpit edition had"
        source={summaryQ.data?.source ?? 'live'}
        actions={
          <Button size="sm" className="gap-1.5 font-mono text-xs" disabled={sweeping} onClick={() => void runSweep()}>
            <Radar className="h-3.5 w-3.5" aria-hidden />
            {sweeping ? 'sweeping…' : 'run sweep'}
          </Button>
        }
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Established"
          value={summary?.established ?? '—'}
          tone="good"
          icon={<Activity className="h-4 w-4" aria-hidden />}
          hint={`${summary?.totalSockets ?? '—'} sockets total`}
        />
        <StatCard
          label="Listening"
          value={summary?.listening ?? '—'}
          icon={<Wifi className="h-4 w-4" aria-hidden />}
          hint={`${surface?.uniqueCount ?? '—'} unique ports`}
        />
        <StatCard label="TIME_WAIT" value={summary?.timeWait ?? '—'} hint="sockets closing down" />
        <StatCard
          label="Active bans"
          value={summary?.bans ?? '—'}
          tone={summary?.bans ? 'bad' : 'default'}
          icon={<Ban className="h-4 w-4" aria-hidden />}
          hint="addresses in the jail registry"
        />
      </div>

      <Tabs defaultValue="connections">
        <TabsList className="flex-wrap">
          <TabsTrigger value="connections">connections</TabsTrigger>
          <TabsTrigger value="surface">listening surface</TabsTrigger>
          <TabsTrigger value="bans">bans</TabsTrigger>
          <TabsTrigger value="scans">scans</TabsTrigger>
        </TabsList>

        {/* ── connections ── */}
        <TabsContent value="connections" className="mt-4 space-y-4">
          <PanelCard
            title="Socket census"
            actions={<Mono>{'poll 4s · /proc/net/tcp{,6}'}</Mono>}
          >
            {conns ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {Object.entries(conns.stateCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([state, n]) => (
                <span
                  key={state}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${connStateCls(state)}`}
                >
                  {state}
                  <span className="tabular-nums text-foreground/70">{n}</span>
                </span>
              ))}
              </div>
            ) : null}
            <DataTable
              rows={conns?.established ?? []}
              headers={['Local', 'Remote', 'Proto', 'State']}
              keyOf={(c, i) => `${c.local}-${c.remote}-${i}`}
              maxH="26rem"
              empty="no established connections with a real peer"
              renderRow={(c) => (
                <>
                  <TableCell className="font-mono text-xs">{c.local}</TableCell>
                  <TableCell className="font-mono text-xs">{c.remote}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.proto}</TableCell>
                  <TableCell>{stateBadge(c.state)}</TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              top {conns?.established.length ?? 0} of {conns?.establishedCount ?? 0} established · wildcard-peer rows skipped
            </p>
          </PanelCard>
        </TabsContent>

        {/* ── listening surface ── */}
        <TabsContent value="surface" className="mt-4 space-y-4">
          <PanelCard
            title="Listening surface"
            actions={<Mono>{surface?.uniqueCount ?? '—'} unique ports · cross-ref services registry</Mono>}
          >
            <DataTable
              rows={surface?.listeners ?? []}
              headers={['Port', 'Proto', 'Address', 'Process', 'Registered service']}
              keyOf={(l, i) => `${l.port}-${l.proto}-${i}`}
              maxH="26rem"
              empty="nothing is listening"
              renderRow={(l) => {
                const svc = serviceByPort.get(`${l.port}-${l.proto}`)
                return (
                  <>
                    <TableCell className="font-mono text-xs tabular-nums">{l.port}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{l.proto}</TableCell>
                    <TableCell className="font-mono text-xs">{l.addr}</TableCell>
                    <TableCell className="text-xs">
                      {svc?.process ? (
                        <span className="font-mono text-xs">
                          {svc.process}
                          {svc.pid ? <span className="text-muted-foreground"> (pid {svc.pid})</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{svc ? 'pid unreadable (root)' : '—'}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {svc?.service ? (
                        <Badge variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-400">
                          {svc.service.service}:{svc.service.configuredPort}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500/30 font-mono text-[10px] text-amber-500">
                          unregistered
                        </Badge>
                      )}
                    </TableCell>
                  </>
                )
              }}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              LISTEN (st=0A) rows decoded live; process/service cross-referenced against the services registry.
            </p>
          </PanelCard>
        </TabsContent>

        {/* ── bans ── */}
        <TabsContent value="bans" className="mt-4 space-y-4">
          <PanelCard
            title="Ban registry"
            actions={<BanDialog onBan={ban} />}
          >
            <DataTable
              rows={bans}
              headers={['IP', 'Service', 'Jail', 'Origin', 'Reason', 'Strikes', 'Banned at', '']}
              keyOf={(b) => b.id}
              maxH="26rem"
              empty="no banned addresses — the registry is the operator's workspace (never seeded); fail2ban rows appear here when it runs"
              renderRow={(b) => (
                <>
                  <TableCell className="font-mono text-xs font-semibold">{b.ip}</TableCell>
                  <TableCell className="font-mono text-xs">{b.service}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{b.jail}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        b.source === 'fail2ban'
                          ? 'bg-teal-500/15 text-teal-400 border-teal-500/30'
                          : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                      }`}
                      title={b.source === 'fail2ban' ? 'live fail2ban-client ban list — unban runs fail2ban-client set <jail> unbanip' : 'sysdeck registry — unban lifts the nftables/iptables entry'}
                    >
                      {b.source ?? 'registry'}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-44 truncate text-xs text-muted-foreground" title={b.reason}>
                    {b.reason}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{b.strikes}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtUtc(b.bannedAt)}</TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-red-500"
                          aria-label={`Unban ${b.ip}`}
                          title="unban"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="font-mono">unban {b.ip}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Removes the address from the {b.service} jail ({b.strikes} strikes recorded). It can reach
                            the services again immediately.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep the ban</AlertDialogCancel>
                          <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => void unban(b)}>
                            Unban
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              the registry is the operator&apos;s workspace (never seeded); fail2ban rows appear live when it runs — and
              ban/unban enforce for real through nft/iptables from this console (root / sudo -n).
            </p>
          </PanelCard>
        </TabsContent>

        {/* ── scans ── */}
        <TabsContent value="scans" className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <PanelCard
              title="Latest sweep"
              actions={
                <Button size="sm" variant="outline" className="gap-1.5 font-mono text-xs" disabled={sweeping} onClick={() => void runSweep()}>
                  <Radar className="h-3.5 w-3.5" aria-hidden />
                  {sweeping ? 'sweeping…' : 'run sweep'}
                </Button>
              }
            >
              {latest ? (
                <>
                  <div className="mb-3">
                    <KV k="target" v={latest.target} />
                    <KV k="scanned" v={`${latest.scanned} ports`} />
                    <KV k="open" v={`${latest.open} ports`} />
                  </div>
                  <DataTable
                    rows={latest.ports}
                    headers={['Port', 'Result']}
                    keyOf={(p) => `${latest.id}-${p.port}`}
                    maxH="18rem"
                    renderRow={(p) => (
                      <>
                        <TableCell className="font-mono text-xs tabular-nums">{p.port}</TableCell>
                        <TableCell>
                          {p.open ? (
                            <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                              open
                            </span>
                          ) : (
                            <span className="rounded border border-zinc-500/30 bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                              closed
                            </span>
                          )}
                        </TableCell>
                      </>
                    )}
                  />
                </>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  no sweep yet this session — run one (connect-tests every listening port on 127.0.0.1 and ::1)
                </p>
              )}
            </PanelCard>

            <div className="space-y-4">
              <PanelCard title="Sweep history (this session)">
                <DataTable
                  rows={scans}
                  headers={['When', 'Target', 'Open', 'Scanned']}
                  keyOf={(s) => s.id}
                  maxH="18rem"
                  empty="run a sweep to start the history"
                  renderRow={(s) => (
                    <>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtUtc(s.at)}</TableCell>
                      <TableCell className="font-mono text-xs">{s.target}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">
                        <span className={s.open > 0 ? 'text-amber-500' : 'text-foreground'}>{s.open}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{s.scanned}</TableCell>
                    </>
                  )}
                />
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  {summary?.scans ?? 0} sweeps recorded in the registry overall — each run is audited and persisted
                  server-side.
                </p>
              </PanelCard>

              <HintCard title="How the sweep works">
                <p className="flex items-start gap-2">
                  <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  Listening ports come from <Mono>/proc/net/tcp{'{,6}'}</Mono>; every port is then connect-tested on
                  127.0.0.1 and ::1 with a 300ms timeout (no nmap needed). Only this host can be swept from the web
                  edition.
                </p>
                <p className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
                  Bans and sweeps are registry state; the numbers here are real for THIS container.
                </p>
              </HintCard>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        <Network className="h-3 w-3" aria-hidden />
        source HYBRID — socket counts live from /proc/net/tcp{'{,6}'}; bans/scans count the registry
      </p>
    </div>
  )
}
