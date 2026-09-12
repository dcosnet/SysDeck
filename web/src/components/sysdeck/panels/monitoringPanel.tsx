'use client'

// Monitoring panel — Prometheus / Grafana / native metrics.
// Prometheus + Grafana are REAL 1.5s probes (neither is installed in this
// sandbox — cockpit-ws owns 9090, our own Next app answers :3000). The
// native metrics tab is genuinely LIVE: a 120-sample /proc ring buffer in
// the bridge, one real sample per poll (cpu/mem pct + net KB/s), charted
// with recharts.

import { Gauge, MemoryStick, Network } from 'lucide-react'
import {
  Area,
  AreaChart as RAraChart,
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useBridgeQuery } from '@/lib/sysdeck/client'
import {
  ErrorCard,
  HintCard,
  InstallHint,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  SourceBadge,
  StatCard,
} from '@/components/sysdeck/ui'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ── bridge shapes ────────────────────────────────────────────────────

interface ProbeSummary {
  installed: boolean
  url: string
  hint?: string
  responder?: string
}

interface NativeMetrics {
  samples: { t: number; cpuPct: number; memPct: number; netRxKb: number; netTxKb: number }[]
  count: number
  max: number
}

// ── helpers ──────────────────────────────────────────────────────────

const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--popover-foreground)',
}

function fmtClock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false })
}

// ── panel ────────────────────────────────────────────────────────────

export default function MonitoringPanel() {
  const summary = useBridgeQuery<{
    prometheus: ProbeSummary
    grafana: ProbeSummary
    native: { available: boolean; samples: number; max: number }
  }>('monitoring', 'summary')
  const native = useBridgeQuery<NativeMetrics>('monitoring', 'nativeMetrics', {}, { refetchInterval: 5000 })

  if (summary.isLoading) {
    return (
      <div>
        <PanelHeader title="Monitoring" subtitle="prometheus · grafana · native metrics" source="hybrid" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Monitoring" subtitle="prometheus · grafana · native metrics" source="hybrid" />
        <ErrorCard error={summary.data?.error ?? 'monitoring.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const samples = (native.data?.data?.samples ?? []).slice()
  const last = samples.at(-1)
  const prom = s.prometheus
  const graf = s.grafana

  return (
    <div>
      <PanelHeader
        title="Monitoring"
        subtitle="prometheus · grafana · native /proc metrics — native tab is live, 5s poll"
        source="hybrid"
      />

      <Tabs defaultValue="native" className="mt-0">
        <TabsList className="flex-wrap">
          <TabsTrigger value="native" className="gap-1.5 font-mono text-xs">native <SourceBadge source="live" /></TabsTrigger>
          <TabsTrigger value="prometheus" className="gap-1.5 font-mono text-xs">prometheus</TabsTrigger>
          <TabsTrigger value="grafana" className="gap-1.5 font-mono text-xs">grafana</TabsTrigger>
        </TabsList>

        {/* ── native (LIVE) ────────────────────────────────────────── */}
        <TabsContent value="native" className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="cpu"
              value={(last?.cpuPct ?? 0).toFixed(1)}
              unit="%"
              tone={(last?.cpuPct ?? 0) > 70 ? 'warn' : 'default'}
              icon={<Gauge className="h-4 w-4" aria-hidden />}
            />
            <StatCard
              label="memory"
              value={(last?.memPct ?? 0).toFixed(1)}
              unit="%"
              tone={(last?.memPct ?? 0) > 85 ? 'warn' : 'default'}
              icon={<MemoryStick className="h-4 w-4" aria-hidden />}
            />
            <StatCard
              label="net rx"
              value={(last?.netRxKb ?? 0).toFixed(1)}
              unit="KB/s"
              icon={<Network className="h-4 w-4" aria-hidden />}
              hint="since previous sample"
            />
            <StatCard
              label="net tx"
              value={(last?.netTxKb ?? 0).toFixed(1)}
              unit="KB/s"
              icon={<Network className="h-4 w-4" aria-hidden />}
              hint="since previous sample"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PanelCard
              title="CPU + memory"
              actions={
                <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-1" aria-hidden /> cpu %
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-2" aria-hidden /> mem %
                  </span>
                  <Mono>{samples.length}/{s.native.max}</Mono>
                </span>
              }
            >
              <div className="h-56" role="img" aria-label="CPU and memory percentage history">
                {samples.length < 2 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    collecting native samples… (one per 5s poll)
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <RAraChart data={samples} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="mnCpu" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="mnMem" x1="0" y1="0" x2="0" y2="1">
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
                      <Area type="monotone" dataKey="cpuPct" stroke="var(--chart-1)" strokeWidth={1.5} fill="url(#mnCpu)" isAnimationActive={false} />
                      <Area type="monotone" dataKey="memPct" stroke="var(--chart-2)" strokeWidth={1.5} fill="url(#mnMem)" isAnimationActive={false} />
                    </RAraChart>
                  </ResponsiveContainer>
                )}
              </div>
            </PanelCard>

            <PanelCard
              title="Network throughput"
              actions={
                <span className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-1" aria-hidden /> rx KB/s
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-[2px] bg-chart-3" aria-hidden /> tx KB/s
                  </span>
                </span>
              }
            >
              <div className="h-56" role="img" aria-label="network rx and tx rate history">
                {samples.length < 2 ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    collecting native samples…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <RLineChart data={samples} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="t" tickFormatter={fmtClock} stroke="var(--muted-foreground)" fontSize={10} tickLine={false} minTickGap={44} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} />
                      <Tooltip
                        labelFormatter={(l) => fmtClock(Number(l))}
                        formatter={(v: number | string, n) => [`${Number(v).toFixed(1)} KB/s`, n === 'netRxKb' ? 'rx' : 'tx']}
                        contentStyle={tooltipStyle}
                      />
                      <Line type="monotone" dataKey="netRxKb" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="netTxKb" stroke="var(--chart-3)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </RLineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </PanelCard>
          </div>

          <HintCard title="Native collector">
            <p>
              the bridge keeps a {s.native.max}-sample ring buffer of <Mono>/proc</Mono> snapshots (cpu jiffies, meminfo,
              /proc/net/dev deltas). each poll of this tab appends one real sample — no Prometheus needed.
            </p>
          </HintCard>
        </TabsContent>

        {/* ── prometheus ───────────────────────────────────────────── */}
        <TabsContent value="prometheus" className="mt-4 space-y-4">
          {prom.installed ? (
            <PanelCard title="Prometheus" actions={<SourceBadge source="live" />}>
              <div className="space-y-1">
                <KV k="status" v={<span className="text-emerald-400">installed</span>} />
                <KV k="health endpoint" v={prom.url} />
              </div>
            </PanelCard>
          ) : (
            <>
              <InstallHint
                bin="prometheus"
                distro="not-installed"
                hint={`# real 1.5s probe of ${prom.url} → connection refused
# ${prom.hint ?? 'cockpit-ws owns 9090 — run Prometheus on 9095'}
apt install prometheus
# /etc/default/prometheus: ARGS="--web.listen-address=127.0.0.1:9095"
systemctl restart prometheus  # needs systemd`}
              />
              <HintCard title="Port guidance — why 9095?">
                <p>
                  cockpit-ws already binds <Mono>0.0.0.0:9090</Mono> on a managed host. Run Prometheus on{' '}
                  <Mono>127.0.0.1:9095</Mono> and point the collector at it with{' '}
                  <Mono>PROM_API_URL=http://localhost:9095</Mono> — the bridge probes{' '}
                  <Mono>{prom.url}</Mono> for <Mono>/-/healthy</Mono>.
                </p>
                <p>
                  This panel is driven by a real probe (1.5s timeout): a healthy answer flips the badge to installed and
                  the native collector keeps working regardless.
                </p>
              </HintCard>
            </>
          )}
        </TabsContent>

        {/* ── grafana ──────────────────────────────────────────────── */}
        <TabsContent value="grafana" className="mt-4 space-y-4">
          {graf.installed ? (
            <PanelCard title="Grafana" actions={<SourceBadge source="live" />}>
              <div className="space-y-1">
                <KV k="status" v={<span className="text-emerald-400">installed</span>} />
                <KV k="health endpoint" v={graf.url} />
                <KV k="responder" v={graf.responder ?? '—'} />
              </div>
            </PanelCard>
          ) : (
            <>
              <InstallHint
                bin="grafana"
                distro="not-installed"
                hint={`# real 1.5s probe of ${graf.url}
apt install grafana
systemctl restart grafana  # needs systemd`}
              />
              <HintCard title="Probe result">
                <p>
                  the bridge probes <Mono>{graf.url}</Mono> and detects Grafana by its JSON{' '}
                  <Mono>database</Mono>/<Mono>version</Mono> keys. Current responder:
                </p>
                <p className="font-mono text-xs text-foreground">{graf.responder ?? 'no response'}</p>
                <p>
                  a port owned by another HTTP service answers 404 HTML instead of Grafana&apos;s health JSON — the probe
                  result distinguishes the two.
                </p>
              </HintCard>
            </>
          )}
        </TabsContent>
      </Tabs>

      <p className="mt-4 pb-2 text-xs text-muted-foreground">
        HYBRID: the native metrics tab is REAL (live /proc ring buffer, 5s poll); the Prometheus/Grafana tabs are real
        availability probes — when neither daemon is installed, their install guidance is shown instead. Charts render
        after the first couple of poll samples.
      </p>
    </div>
  )
}
