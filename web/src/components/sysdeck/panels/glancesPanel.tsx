'use client'

// Glances panel — live cross-domain monitor.
// The cockpit edition shelled out to the Glances CLI; the web edition
// re-implements the same collectors natively in the bridge, so this panel
// gets identical data through glances.summary / processes / history.
// One custom query drives quicklook + network: each summary call also
// appends a total rx/tx rate sample to a module-level ring, so the
// network chart has real history without client-side state gymnastics.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, Gauge, HardDrive, MemoryStick, Network, RefreshCw } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { bridgeCall, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  Bar,
  DataTable,
  ErrorCard,
  KV,
  MeterRow,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
} from '@/components/sysdeck/ui'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface NetIface {
  iface: string
  rxBytes: number
  txBytes: number
  rxRate: number
  txRate: number
}

interface DiskRow {
  mount: string
  fs: string
  totalGb: number
  usedGb: number
  pct: number
}

interface TopProc {
  pid: number
  name: string
  cpuPct: number
  memPct: number
  user: string
  state: string
  cmd: string
}

interface GlancesSummary {
  cpu: { pct: number; perCore: { core: number; pct: number }[]; user: number; sys: number; iowait: number }
  mem: { totalMb: number; usedMb: number; cachedMb: number; buffersMb: number; swapTotalMb: number; swapUsedMb: number }
  load: { 1: number; 5: number; 15: number }
  net: NetIface[]
  disks: DiskRow[]
  uptimeS: number
  host: { hostname: string; kernel: string; arch: string }
  procs: number
  topProcs: TopProc[]
  history: { t: number; cpuPct: number; memPct: number }[]
}

// ── network rate history (module-level ring, fed by the summary query) ──

interface NetPoint {
  t: number
  rx: number
  tx: number
}

const NET_HIST_MAX = 120
const netHist: NetPoint[] = []
let lastNetSec = 0

function totalRates(net: NetIface[]): { rx: number; tx: number } {
  return net.reduce((a, n) => ({ rx: a.rx + n.rxRate, tx: a.tx + n.txRate }), { rx: 0, tx: 0 })
}

/** QueryFn: one glances.summary call → latest snapshot + net history. */
async function fetchSnapshot(): Promise<{ summary: GlancesSummary; netHist: NetPoint[] }> {
  const res = await bridgeCall<GlancesSummary>('glances', 'summary')
  if (!res.ok || !res.data) throw new Error(res.error ?? 'glances.summary failed')
  const sec = Math.floor(Date.now() / 1000)
  if (sec !== lastNetSec) {
    lastNetSec = sec
    const { rx, tx } = totalRates(res.data.net)
    netHist.push({ t: sec, rx, tx })
    while (netHist.length > NET_HIST_MAX) netHist.shift()
  }
  return { summary: res.data, netHist: netHist.slice() }
}

// ── formatting ───────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KiB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MiB`
  return `${(b / 1024 ** 3).toFixed(2)} GiB`
}

function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps} B/s`
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KiB/s`
  return `${(bps / 1024 ** 2).toFixed(2)} MiB/s`
}

function fmtClock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false })
}

function fmtDiskGb(gb: number): string {
  // FUSE stub mounts (ossfs etc.) report overflowed df totals — the root
  // row is the meaningful one; clamp absurd values honestly.
  if (gb > 1024) return '>1 TiB'
  return `${gb.toFixed(1)} GB`
}

function statTone(pct: number): 'default' | 'warn' | 'bad' {
  if (pct > 90) return 'bad'
  if (pct > 70) return 'warn'
  return 'default'
}

function meterTone(pct: number): 'good' | 'warn' | 'bad' {
  if (pct > 90) return 'bad'
  if (pct > 70) return 'warn'
  return 'good'
}

const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--popover-foreground)',
}

// ── panel ────────────────────────────────────────────────────────────

export default function GlancesPanel() {
  const snap = useQuery({
    queryKey: ['bridge', 'glances', 'summary+net'],
    queryFn: fetchSnapshot,
    refetchInterval: 4000,
    staleTime: 2000,
  })
  const procs = useBridgeQuery<{ procs: TopProc[] }>('glances', 'processes', undefined, { refetchInterval: 3000 })

  const s = snap.data?.summary
  const hist = useMemo(() => s?.history ?? [], [s])
  const netPoints = useMemo(() => snap.data?.netHist ?? [], [snap.data])

  if (snap.isLoading && !snap.data) return <PanelSkeleton lines={4} />
  if (snap.isError || (snap.data && !s)) {
    return <ErrorCard error={snap.error instanceof Error ? snap.error.message : 'glances.summary failed'} />
  }

  const swapPct = s && s.mem.swapTotalMb > 0 ? (s.mem.swapUsedMb / s.mem.swapTotalMb) * 100 : 0

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Glances"
        subtitle="live cross-domain monitor — this console ships its own webui (native /proc collectors, no Python dependency)"
        source="live"
        actions={
          <Button
            variant="outline"
            size="sm"
            className="gap-2 font-mono text-xs"
            onClick={() => {
              snap.refetch()
              procs.refetch()
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            refresh
          </Button>
        }
      />

      <Tabs defaultValue="quicklook">
        <TabsList className="flex-wrap">
          <TabsTrigger value="quicklook">quicklook</TabsTrigger>
          <TabsTrigger value="processes">processes</TabsTrigger>
          <TabsTrigger value="network">network</TabsTrigger>
          <TabsTrigger value="disks">disks</TabsTrigger>
        </TabsList>

        {/* ── quicklook ─────────────────────────────────────────────── */}
        <TabsContent value="quicklook" className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="CPU"
              value={(s?.cpu.pct ?? 0).toFixed(1)}
              unit="%"
              icon={<Cpu className="h-4 w-4" aria-hidden />}
              tone={statTone(s?.cpu.pct ?? 0)}
              hint={`user ${(s?.cpu.user ?? 0).toFixed(1)} · sys ${(s?.cpu.sys ?? 0).toFixed(1)} · iowait ${(s?.cpu.iowait ?? 0).toFixed(1)}`}
            />
            <StatCard
              label="Memory"
              value={s ? (s.mem.usedMb / 1024).toFixed(2) : '—'}
              unit={`/ ${s ? (s.mem.totalMb / 1024).toFixed(1) : '—'} GB`}
              icon={<MemoryStick className="h-4 w-4" aria-hidden />}
              tone={statTone(s && s.mem.totalMb > 0 ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0)}
              hint={`cached ${s?.mem.cachedMb ?? 0} MB · buffers ${s?.mem.buffersMb ?? 0} MB`}
            />
            <StatCard
              label="Swap"
              value={s ? (s.mem.swapUsedMb / 1024).toFixed(2) : '—'}
              unit={`/ ${s ? (s.mem.swapTotalMb / 1024).toFixed(1) : '—'} GB`}
              icon={<HardDrive className="h-4 w-4" aria-hidden />}
              tone={swapPct > 70 ? 'warn' : 'default'}
              hint={s && s.mem.swapTotalMb === 0 ? 'no swap configured' : `${swapPct.toFixed(1)}% used`}
            />
            <StatCard
              label="Load avg"
              value={(s?.load[1] ?? 0).toFixed(2)}
              icon={<Gauge className="h-4 w-4" aria-hidden />}
              hint={`1/5/15 — ${(s?.load[1] ?? 0).toFixed(2)} · ${(s?.load[5] ?? 0).toFixed(2)} · ${(s?.load[15] ?? 0).toFixed(2)}`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <PanelCard title="Meters">
              <div className="space-y-4">
                <MeterRow
                  label="cpu"
                  pct={s?.cpu.pct ?? 0}
                  display={`${(s?.cpu.pct ?? 0).toFixed(1)}%`}
                  tone={meterTone(s?.cpu.pct ?? 0)}
                />
                <MeterRow
                  label="mem"
                  pct={s && s.mem.totalMb > 0 ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0}
                  display={`${s?.mem.usedMb ?? 0} / ${s?.mem.totalMb ?? 0} MB`}
                  tone={meterTone(s && s.mem.totalMb > 0 ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0)}
                />
                <MeterRow
                  label="swap"
                  pct={swapPct}
                  display={`${s?.mem.swapUsedMb ?? 0} / ${s?.mem.swapTotalMb ?? 0} MB`}
                  tone={meterTone(swapPct)}
                />
                <div className="border-t border-border/50 pt-2">
                  <p className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">per-core</p>
                  <div className="space-y-1.5">
                    {(s?.cpu.perCore ?? []).map((c) => (
                      <div key={c.core} className="flex items-center gap-2">
                        <Mono>cpu{c.core}</Mono>
                        <div className="min-w-0 flex-1">
                          <Bar pct={c.pct} tone={c.pct > 90 ? 'bad' : c.pct > 70 ? 'warn' : 'default'} />
                        </div>
                        <span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                          {c.pct.toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border-t border-border/50 pt-2">
                  <KV k="uptime" v={fmtUptime(s?.uptimeS ?? 0)} />
                  <KV k="procs" v={s?.procs ?? '—'} />
                  <KV k="host" v={s?.host.hostname ?? '—'} />
                </div>
              </div>
            </PanelCard>

            <PanelCard
              title="CPU + memory history"
              className="lg:col-span-2"
              actions={
                <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-1" aria-hidden /> cpu %
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-2" aria-hidden /> mem %
                  </span>
                  <Mono>{hist.length}/60</Mono>
                </span>
              }
            >
              <div className="h-56" role="img" aria-label="CPU and memory percentage history">
                {hist.length < 2 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    collecting snapshot samples…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={hist} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="glCpu" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="glMem" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.25} />
                          <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="t" tickFormatter={fmtClock} stroke="var(--muted-foreground)" fontSize={10} tickLine={false} minTickGap={44} />
                      <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={10} tickLine={false} />
                      <Tooltip
                        labelFormatter={(l) => fmtClock(Number(l))}
                        formatter={(v: number | string, n) => [`${Number(v).toFixed(1)}%`, n === 'cpuPct' ? 'cpu' : 'mem']}
                        contentStyle={tooltipStyle}
                      />
                      <Area type="monotone" dataKey="cpuPct" stroke="var(--chart-1)" strokeWidth={1.5} fill="url(#glCpu)" isAnimationActive={false} />
                      <Area type="monotone" dataKey="memPct" stroke="var(--chart-2)" strokeWidth={1.5} fill="url(#glMem)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </PanelCard>
          </div>

          <PanelCard title="Network rates" actions={<Mono>bytes/s since previous snapshot</Mono>}>
            <DataTable
              rows={s?.net ?? []}
              headers={['Interface', 'RX rate', 'TX rate', 'RX total', 'TX total']}
              keyOf={(n) => n.iface}
              maxH="14rem"
              empty="no interfaces"
              renderRow={(n) => (
                <>
                  <TableCell className="font-mono text-xs">{n.iface}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    <span className="text-emerald-400">↓ {fmtRate(n.rxRate)}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    <span className="text-sky-400">↑ {fmtRate(n.txRate)}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{fmtBytes(n.rxBytes)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{fmtBytes(n.txBytes)}</TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        {/* ── processes ─────────────────────────────────────────────── */}
        <TabsContent value="processes" className="mt-4">
          <PanelCard title="Top processes" actions={<Mono>top 30 by cpu · 3s poll · /proc/*/stat jiffies</Mono>}>
            <DataTable
              rows={procs.data?.data?.procs ?? []}
              headers={['PID', 'Name', 'User', 'CPU %', 'MEM %', 'State', 'Command']}
              keyOf={(p) => String(p.pid)}
              maxH="32rem"
              empty={procs.isLoading ? 'loading…' : 'no process rows'}
              renderRow={(p) => (
                <>
                  <TableCell className="font-mono text-xs tabular-nums">{p.pid}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-xs">{p.user}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    <span className={p.cpuPct > 50 ? 'text-amber-500' : 'text-foreground'}>{p.cpuPct.toFixed(1)}</span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{p.memPct.toFixed(1)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.state}</TableCell>
                  <TableCell className="max-w-96 truncate font-mono text-[11px] text-muted-foreground" title={p.cmd}>
                    {p.cmd}
                  </TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        {/* ── network ───────────────────────────────────────────────── */}
        <TabsContent value="network" className="mt-4 space-y-4">
          <PanelCard
            title="Total throughput"
            actions={
              <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-chart-1" aria-hidden /> rx
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-chart-2" aria-hidden /> tx
                </span>
              </span>
            }
          >
            <div className="h-48" role="img" aria-label="Network receive and transmit rate history">
              {netPoints.length < 2 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  collecting rate samples…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={netPoints} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="t" tickFormatter={fmtClock} stroke="var(--muted-foreground)" fontSize={10} tickLine={false} minTickGap={44} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} tickFormatter={(v: number) => `${Math.round(v / 1024)}K`} />
                    <Tooltip
                      labelFormatter={(l) => fmtClock(Number(l))}
                      formatter={(v: number | string, n) => [fmtRate(Number(v)), n === 'rx' ? 'rx' : 'tx']}
                      contentStyle={tooltipStyle}
                    />
                    <Line type="monotone" dataKey="rx" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="tx" stroke="var(--chart-2)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </PanelCard>

          <PanelCard title="Interfaces" actions={<Mono>rx/tx counters from /proc/net/dev (lo skipped)</Mono>}>
            <DataTable
              rows={s?.net ?? []}
              headers={[
                <span key="i" className="flex items-center gap-1.5"><Network className="h-3 w-3" aria-hidden /> Interface</span>,
                'RX bytes',
                'RX rate',
                'TX bytes',
                'TX rate',
              ]}
              keyOf={(n) => n.iface}
              maxH="20rem"
              empty="no interfaces"
              renderRow={(n) => (
                <>
                  <TableCell className="font-mono text-xs">{n.iface}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{fmtBytes(n.rxBytes)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-emerald-400">{fmtRate(n.rxRate)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{fmtBytes(n.txBytes)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-sky-400">{fmtRate(n.txRate)}</TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        {/* ── disks ─────────────────────────────────────────────────── */}
        <TabsContent value="disks" className="mt-4 space-y-4">
          <PanelCard title="Mount usage" actions={<Mono>df -kP (tmpfs/devtmpfs excluded)</Mono>}>
            <div className="space-y-4">
              {(s?.disks ?? []).map((d) => (
                <div key={`${d.fs}-${d.mount}`}>
                  <MeterRow
                    label={`${d.mount}`}
                    pct={d.pct}
                    display={`${fmtDiskGb(d.usedGb)} / ${fmtDiskGb(d.totalGb)}`}
                    tone={meterTone(d.pct)}
                  />
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {d.fs} · {d.pct.toFixed(1)}%
                  </p>
                </div>
              ))}
              {(s?.disks ?? []).length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">no mounts reported</p>
              ) : null}
            </div>
          </PanelCard>

          <PanelCard title="Filesystems">
            <DataTable
              rows={s?.disks ?? []}
              headers={['Mount', 'Filesystem', 'Total', 'Used', 'Free', 'Usage']}
              keyOf={(d) => `${d.fs}-${d.mount}`}
              maxH="24rem"
              empty="no mounts"
              renderRow={(d) => (
                <>
                  <TableCell className="font-mono text-xs">{d.mount}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={d.fs}>
                    {d.fs}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{fmtDiskGb(d.totalGb)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{fmtDiskGb(d.usedGb)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    {fmtDiskGb(Math.max(0, d.totalGb - d.usedGb))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    <span className={d.pct > 90 ? 'text-red-500' : d.pct > 70 ? 'text-amber-500' : 'text-foreground'}>
                      {d.pct.toFixed(1)}%
                    </span>
                  </TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              note: FUSE stub mounts (ossfs) report overflowed totals from df — the root row is the meaningful one.
            </p>
          </PanelCard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
