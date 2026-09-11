'use client'

// Overview panel — the SysDeck landing view.
// Host identity + live vitals from the overview bridge (ticker 5s /
// summary 10s), CPU & memory history charted from the glances bridge's
// server-side ring buffer (grown by this panel's glances processes poll),
// top processes from the glances bridge, Fester service status from the
// fester bridge, suite health (modules count + active theme from the
// themes bridge).

import { useMemo } from 'react'
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Palette,
  Server,
  Terminal,
  Waves,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useQuery } from '@tanstack/react-query'
import { useBridgeQuery } from '@/lib/sysdeck/client'
import type { HostTicker } from '@/lib/sysdeck/types'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes (subset this panel uses) ───────────────────────────

interface OverviewSummary {
  host: {
    hostname: string
    kernel: string
    arch: string
    distro: string
    cpuModel: string
    cores: number
    uptimeS: number
    bootUsers: number
  }
  cpu: { pct: number; load1: number; load5: number; load15: number }
  memory: { totalMb: number; usedMb: number; cachedMb: number; swapTotalMb: number; swapUsedMb: number }
  disk: { totalGb: number; usedGb: number; pct: number; mount: string }
  network: { rxMb: number; txMb: number; ifaces: string[] }
  fester: 'online' | 'offline'
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

interface FesterStatus {
  service: string
  version: string
  nodes: number
  uptime_s: number
  port: number
  transport: string
}

interface FesterSummary {
  metrics: {
    builds?: { total?: number; running?: number; succeeded?: number; failed?: number; cancelled?: number }
    nodes?: { name: string; state?: string }[]
  }
}

interface ReleaseInfo {
  version: string
  file: string
  url: string
  sizeBytes: number
  sha256: string
  builtAt: string
  fester?: { version: string }
}

// ── formatting helpers ───────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtBytes(n?: number): string {
  if (n === undefined) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtClock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false })
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

// ── panel ────────────────────────────────────────────────────────────

export default function OverviewPanel() {
  const ticker = useBridgeQuery<HostTicker>('overview', 'ticker', undefined, { refetchInterval: 5000 })
  const summary = useBridgeQuery<OverviewSummary>('overview', 'summary', undefined, { refetchInterval: 10000 })
  const procs = useBridgeQuery<{ procs: TopProc[] }>('glances', 'processes', undefined, { refetchInterval: 5000 })
  // the glances bridge appends one history sample per snapshot call — the
  // processes poll above feeds it, so this chart fills as the panel is open
  const glancesHist = useBridgeQuery<{ samples: { t: number; cpuPct: number; memPct: number }[] }>(
    'glances',
    'history',
    undefined,
    { refetchInterval: 5000 },
  )
  const festerStatus = useBridgeQuery<FesterStatus>('fester', 'status', undefined, { refetchInterval: 15000 })
  const festerSummary = useBridgeQuery<FesterSummary>('fester', 'summary', undefined, { refetchInterval: 15000 })
  const activeTheme = useBridgeQuery<string>('themes', 'getActive')

  // master tarball release metadata (served by /api/release)
  const release = useQuery<ReleaseInfo>({
    queryKey: ['release'],
    queryFn: async () => {
      const res = await fetch('/api/release')
      if (!res.ok) throw new Error('release metadata unavailable')
      return (await res.json()) as ReleaseInfo
    },
    retry: 1,
    refetchOnWindowFocus: false,
  })

  const t = ticker.data?.data
  const s = summary.data?.data
  const hist = useMemo(() => glancesHist.data?.data?.samples ?? [], [glancesHist.data])

  const topProcs = useMemo(() => (procs.data?.data?.procs ?? []).slice(0, 8), [procs.data])

  if (ticker.isLoading && !ticker.data) return <PanelSkeleton lines={4} />
  if (ticker.data && !ticker.data.ok) return <ErrorCard error={ticker.data.error ?? 'overview.ticker failed'} />

  const fs = festerStatus.data?.data
  const fmetrics = festerSummary.data?.data?.metrics
  const festerOnline = t?.fester === 'online'
  const themeName = activeTheme.data?.data ?? 'midnight'

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Overview"
        subtitle="host vitals and SysDeck suite health — real /proc collectors, no fabricated numbers"
        source="live"
        actions={<Badge variant="outline" className="font-mono text-[10px]">web edition</Badge>}
      />

      {/* hero: host identity + fester service */}
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelCard
          title="Host identity"
          className="lg:col-span-2"
          actions={<Badge variant="outline" className="font-mono text-[10px]">{s?.host.distro ?? '—'}</Badge>}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
              <Server className="h-4.5 w-4.5 text-primary" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-base font-semibold tracking-tight">{s?.host.hostname ?? '—'}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {s?.host.cpuModel ?? '—'} · {s?.host.cores ?? '—'} cores
              </p>
              <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
                <div>
                  <KV k="kernel" v={<span className="break-all">{s?.host.kernel ?? '—'}</span>} />
                  <KV k="arch" v={s?.host.arch ?? '—'} />
                </div>
                <div>
                  <KV k="uptime" v={fmtUptime(s?.host.uptimeS ?? t?.uptimeS ?? 0)} />
                  <KV k="load" v={`${(s?.cpu.load1 ?? 0).toFixed(2)} / ${(s?.cpu.load5 ?? 0).toFixed(2)} / ${(s?.cpu.load15 ?? 0).toFixed(2)}`} />
                </div>
              </div>
            </div>
          </div>
        </PanelCard>

        <PanelCard title="Fester build service" actions={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`h-1.5 w-1.5 rounded-full ${festerOnline ? 'bg-emerald-500 sd-live-dot' : 'bg-red-500'}`}
              aria-hidden
            />
            {festerOnline ? 'online' : 'offline'}
          </span>
        }>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" aria-hidden />
              <span className="font-mono text-sm font-semibold">{fs?.service ?? 'fester'}</span>
              <Mono>v{fs?.version ?? '—'}</Mono>
            </div>
            <KV k="transport" v={`${fs?.transport ?? 'rest+ws'} · :${fs?.port ?? 3010}`} />
            <KV k="cluster nodes" v={fs?.nodes ?? fmetrics?.nodes?.length ?? '—'} />
            <KV k="service uptime" v={fs ? fmtUptime(fs.uptime_s) : '—'} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
              <p className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {fmetrics?.builds?.running ?? 0}
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">builds running</p>
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
              <p className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {fmetrics?.builds?.succeeded ?? 0}/{fmetrics?.builds?.total ?? 0}
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">succeeded / total</p>
            </div>
          </div>
        </PanelCard>
      </div>

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="CPU"
          value={(t?.cpuPct ?? 0).toFixed(1)}
          unit="%"
          icon={<Cpu className="h-4 w-4" aria-hidden />}
          tone={statTone(t?.cpuPct ?? 0)}
          hint={`${s?.host.cores ?? '—'} cores · load1 ${(t?.load1 ?? 0).toFixed(2)}`}
        />
        <StatCard
          label="Memory"
          value={t ? (t.memUsedMb / 1024).toFixed(2) : '—'}
          unit={`/ ${t ? (t.memTotalMb / 1024).toFixed(1) : '—'} GB`}
          icon={<MemoryStick className="h-4 w-4" aria-hidden />}
          tone={statTone(t?.memPct ?? 0)}
          hint={`${t ? t.memUsedMb : '—'} / ${t ? t.memTotalMb : '—'} MB · ${(t?.memPct ?? 0).toFixed(1)}%`}
        />
        <StatCard
          label="Load avg"
          value={(t?.load1 ?? 0).toFixed(2)}
          icon={<Gauge className="h-4 w-4" aria-hidden />}
          hint={`1/5/15 min — ${(t?.load5 ?? 0).toFixed(2)} · ${(t?.load15 ?? 0).toFixed(2)}`}
        />
        <StatCard
          label="Disk /"
          value={(s?.disk.usedGb ?? 0).toFixed(1)}
          unit={`/ ${s ? (s.disk.totalGb).toFixed(1) : '—'} GB`}
          icon={<HardDrive className="h-4 w-4" aria-hidden />}
          tone={statTone(s?.disk.pct ?? 0)}
          hint={`${(s?.disk.pct ?? 0).toFixed(1)}% used on rootfs`}
        />
        <StatCard
          label="Processes"
          value={t?.procs ?? '—'}
          icon={<Activity className="h-4 w-4" aria-hidden />}
          hint="entries under /proc"
        />
        <StatCard
          label="Uptime"
          value={fmtUptime(t?.uptimeS ?? 0)}
          hint="since container boot (PID 1 tini)"
        />
        <StatCard
          label="Net RX total"
          value={(s ? s.network.rxMb / 1024 : 0).toFixed(2)}
          unit="GB"
          icon={<ArrowDownToLine className="h-4 w-4" aria-hidden />}
          hint={`${s?.network.rxMb?.toFixed(1) ?? '—'} MB · ${(s?.network.ifaces ?? []).join(', ')}`}
        />
        <StatCard
          label="Net TX total"
          value={(s ? s.network.txMb / 1024 : 0).toFixed(2)}
          unit="GB"
          icon={<ArrowUpFromLine className="h-4 w-4" aria-hidden />}
          hint={`${s?.network.txMb?.toFixed(1) ?? '—'} MB since boot`}
        />
      </div>

      {/* meters + cpu/mem history */}
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelCard title="Vitals meters">
          <div className="space-y-4">
            <MeterRow
              label="CPU"
              pct={t?.cpuPct ?? 0}
              display={`${(t?.cpuPct ?? 0).toFixed(1)}%`}
              tone={meterTone(t?.cpuPct ?? 0)}
            />
            <MeterRow
              label="Memory"
              pct={t?.memPct ?? 0}
              display={`${t ? t.memUsedMb : 0} / ${t ? t.memTotalMb : 0} MB`}
              tone={meterTone(t?.memPct ?? 0)}
            />
            <MeterRow
              label="Disk /"
              pct={s?.disk.pct ?? 0}
              display={`${(s?.disk.usedGb ?? 0).toFixed(1)} / ${(s?.disk.totalGb ?? 0).toFixed(1)} GB`}
              tone={meterTone(s?.disk.pct ?? 0)}
            />
            <div className="border-t border-border/50 pt-2">
              <KV k="cached" v={`${s?.memory.cachedMb ?? 0} MB`} />
              <KV k="swap" v={`${s?.memory.swapUsedMb ?? 0} / ${s?.memory.swapTotalMb ?? 0} MB`} />
            </div>
          </div>
        </PanelCard>

        <PanelCard
          title="CPU / memory history"
          className="lg:col-span-2"
          actions={
            <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-[2px] bg-chart-1" aria-hidden /> cpu %
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-[2px] bg-chart-2" aria-hidden /> mem %
              </span>
            </span>
          }
        >
          <div className="h-52" role="img" aria-label="CPU and memory percentage over time">
            {hist.length < 2 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                collecting ticker samples…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hist} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="ovCpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="ovMem" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="t"
                    tickFormatter={fmtClock}
                    stroke="var(--muted-foreground)"
                    fontSize={10}
                    tickLine={false}
                    minTickGap={44}
                  />
                  <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={10} tickLine={false} />
                  <Tooltip
                    labelFormatter={(l) => fmtClock(Number(l))}
                    formatter={(v: number | string, n) => [`${Number(v).toFixed(1)}%`, n === 'cpuPct' ? 'cpu' : 'mem']}
                    contentStyle={{
                      background: 'var(--popover)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--popover-foreground)',
                    }}
                  />
                  <Area type="monotone" dataKey="cpuPct" stroke="var(--chart-1)" strokeWidth={1.5} fill="url(#ovCpu)" isAnimationActive={false} />
                  <Area type="monotone" dataKey="memPct" stroke="var(--chart-2)" strokeWidth={1.5} fill="url(#ovMem)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </PanelCard>
      </div>

      {/* top processes + suite health */}
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelCard title="Top processes" className="lg:col-span-2" actions={<Mono>top 8 by cpu</Mono>}>
          <DataTable
            rows={topProcs}
            headers={['PID', 'Name', 'CPU %', 'MEM %', 'User', 'State', 'Command']}
            keyOf={(p) => String(p.pid)}
            maxH="22rem"
            empty={procs.isLoading ? 'loading…' : 'no process rows'}
            renderRow={(p) => (
              <>
                <TableCell className="font-mono text-xs tabular-nums">{p.pid}</TableCell>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  <span className={p.cpuPct > 50 ? 'text-amber-500' : 'text-foreground'}>{p.cpuPct.toFixed(1)}</span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{p.memPct.toFixed(1)}</TableCell>
                <TableCell className="text-xs">{p.user}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{p.state}</TableCell>
                <TableCell className="max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={p.cmd}>
                  {p.cmd}
                </TableCell>
              </>
            )}
          />
        </PanelCard>

        <div className="space-y-4">
          <PanelCard title="SysDeck suite health">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
                  <Waves className="h-4.5 w-4.5 text-primary" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-semibold">SysDeck v0.2.0</p>
                  <p className="font-mono text-[10px] text-muted-foreground">web edition · 28 bridge modules</p>
                </div>
              </div>
              <div className="mt-2">
                <KV k="bridge" v={<span className={ticker.data?.ok ? 'text-emerald-400' : 'text-red-400'}>{ticker.data?.ok ? 'POST /api/bridge ● live' : 'unreachable'}</span>} />
                <KV k="fester service" v={<span className={festerOnline ? 'text-emerald-400' : 'text-red-400'}>{festerOnline ? 'online :3010' : 'offline'}</span>} />
                <KV
                  k="active theme"
                  v={
                    <span className="inline-flex items-center gap-1.5">
                      <Palette className="h-3 w-3 text-primary" aria-hidden />
                      {themeName}
                    </span>
                  }
                />
              </div>
            </div>
          </PanelCard>

          <PanelCard
            title="Master tarball"
            actions={
              <Badge variant="outline" className="font-mono text-[10px]">
                v{release.data?.version ?? '0.2.0'}
              </Badge>
            }
          >
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                cockpit edition + web edition + fester, pre-integrated in one download.
              </p>
              <Button asChild size="sm" className="w-full gap-2 font-mono text-xs">
                <a
                  href={release.data?.url ?? '/download/sysdeck-0.2.0-master.tar.bz2'}
                  download
                  aria-label="Download the SysDeck master tarball"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />
                  sysdeck-0.2.0-master.tar.bz2
                </a>
              </Button>
              <KV k="size" v={fmtBytes(release.data?.sizeBytes)} />
              <KV
                k="sha256"
                v={
                  <span className="font-mono text-[10px]" title={release.data?.sha256}>
                    {release.data?.sha256 ? `${release.data.sha256.slice(0, 16)}…` : '—'}
                  </span>
                }
              />
              <KV k="fester" v={release.data?.fester ? `vendored v${release.data.fester.version}` : 'pre-integrated'} />
              {release.isError ? (
                <p className="text-[10px] text-amber-500">
                  tarball not built yet — run scripts/make-master-tarball.sh
                </p>
              ) : null}
            </div>
          </PanelCard>

          <PanelCard title="Quick meters">
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">memory breakdown</p>
                <Bar pct={t?.memPct ?? 0} tone={statTone(t?.memPct ?? 0)} />
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  used {t?.memUsedMb ?? 0} MB · cached {s?.memory.cachedMb ?? 0} MB · total {t?.memTotalMb ?? 0} MB
                </p>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">root filesystem</p>
                <Bar pct={s?.disk.pct ?? 0} tone={statTone(s?.disk.pct ?? 0)} />
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  used {(s?.disk.usedGb ?? 0).toFixed(1)} GB of {(s?.disk.totalGb ?? 0).toFixed(1)} GB
                </p>
              </div>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  )
}
