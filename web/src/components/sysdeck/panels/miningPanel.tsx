'use client'

// Mining panel — rig fleet (basement-1, garage-2, attic-3, solar-1).
// No xmrig/bosminer daemons exist in this sandbox, so the bridge keeps a
// demo fleet with LIVE-FEEL values: the panel polls mining.refresh every
// 5s, which random-walks ±3% hashrates/temps on online rigs (each walk is
// audited — the demo XMRig-style API). start/stop zero/restore nominal.

import { useState } from 'react'
import { toast } from 'sonner'
import { Activity, Coins, Fan, Play, Square, Thermometer, Zap } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  Bar,
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

interface MiningSummary {
  rigs: number
  online: number
  idle: number
  offline: number
  totalHashrate: number
  totalPower: number
  avgTemp: number
}

interface Gpu {
  id: string
  model: string
  hashrate: number
  tempC: number
  fanPct: number
}

interface Rig {
  id: string
  name: string
  host: string
  coins: string
  status: 'online' | 'idle' | 'offline'
  hashrate: number
  powerW: number
  tempC: number
  pool: string
  updatedAt: string
  gpus: Gpu[]
}

// ── helpers ──────────────────────────────────────────────────────────

function tempTone(t: number): 'good' | 'warn' | 'bad' {
  if (t >= 75) return 'bad'
  if (t >= 68) return 'warn'
  return 'good'
}

function fmtHash(th: number): string {
  if (th <= 0) return '—'
  return `${th.toFixed(1)} TH/s`
}

// ── panel ────────────────────────────────────────────────────────────

export default function MiningPanel() {
  const summary = useBridgeQuery<MiningSummary>('mining', 'summary', {}, { refetchInterval: 5000 })
  // refresh (not list) is the polled command — it random-walks the live
  // values, giving the fleet its drifting hashrates/temps
  const list = useBridgeQuery<{ rigs: Rig[]; count: number }>('mining', 'refresh', {}, { refetchInterval: 5000 })
  const action = useBridgeAction()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function mutate(command: 'start' | 'stop', rig: Rig) {
    setBusyId(rig.id)
    try {
      const res = await action('mining', command, { id: rig.id })
      if (res.ok) {
        toast.success(`${command}: ${rig.name}`, {
          description: `status → ${(res.data as { status?: string })?.status ?? 'ok'}`,
        })
      } else {
        toast.error(`${command}: ${rig.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Mining" subtitle="rig fleet — hashrate · power · thermals" source="demo" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Mining" subtitle="rig fleet — hashrate · power · thermals" source="demo" />
        <ErrorCard error={summary.data?.error ?? 'mining.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const rigs = list.data?.data?.rigs ?? []

  return (
    <div>
      <PanelHeader
        title="Mining"
        subtitle="rig fleet — values random-walk every 5s (XMRig-style API) · 5s poll"
        source="demo"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="rigs online"
          value={`${s.online}/${s.rigs}`}
          tone={s.online > 0 ? 'good' : 'warn'}
          icon={<Activity className="h-4 w-4" aria-hidden />}
          hint={`${s.idle} idle · ${s.offline} offline`}
        />
        <StatCard label="total hashrate" value={s.totalHashrate.toFixed(1)} unit="TH/s" icon={<Coins className="h-4 w-4" aria-hidden />} />
        <StatCard label="power draw" value={s.totalPower.toLocaleString('en-US')} unit="W" tone="warn" icon={<Zap className="h-4 w-4" aria-hidden />} hint={`~${((s.totalPower * 24) / 1000).toFixed(0)} kWh/day`} />
        <StatCard
          label="avg temp"
          value={s.avgTemp.toFixed(1)}
          unit="°C"
          tone={s.avgTemp >= 75 ? 'bad' : s.avgTemp >= 68 ? 'warn' : 'good'}
          icon={<Thermometer className="h-4 w-4" aria-hidden />}
        />
      </div>

      <div className="mt-4 space-y-4">
        {rigs.map((rig) => {
          const nominalHash = Math.max(...rig.gpus.map((g) => g.hashrate), 1) * rig.gpus.length
          return (
            <PanelCard
              key={rig.id}
              title={
                <span className="flex flex-wrap items-center gap-2 normal-case">
                  <span className="font-mono text-sm font-semibold text-foreground">{rig.name}</span>
                  <StateBadge state={rig.status} />
                  <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-amber-500">
                    {rig.coins}
                  </span>
                </span>
              }
              actions={
                <span className="flex items-center gap-2">
                  <Mono>{rig.host}</Mono>
                  {rig.status !== 'offline' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 font-mono text-[11px]"
                      disabled={busyId === rig.id}
                      onClick={() => void mutate('stop', rig)}
                      aria-label={`stop ${rig.name}`}
                    >
                      <Square className="h-3 w-3" aria-hidden /> stop
                    </Button>
                  ) : null}
                  {rig.status !== 'online' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 font-mono text-[11px]"
                      disabled={busyId === rig.id}
                      onClick={() => void mutate('start', rig)}
                      aria-label={`start ${rig.name}`}
                    >
                      <Play className="h-3 w-3" aria-hidden /> start
                    </Button>
                  ) : null}
                </span>
              }
              contentClassName="space-y-3"
            >
              <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">hashrate</span>
                    <span className="font-mono tabular-nums text-foreground">{fmtHash(rig.hashrate)}</span>
                  </div>
                  <Bar pct={rig.hashrate > 0 ? Math.min(100, (rig.hashrate / Math.max(nominalHash, rig.hashrate)) * 100) : 0} tone="good" />
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">power</span>
                    <span className="font-mono tabular-nums text-foreground">{rig.powerW > 0 ? `${rig.powerW.toLocaleString('en-US')} W` : '—'}</span>
                  </div>
                  <Bar pct={rig.powerW > 0 ? Math.min(100, (rig.powerW / 2400) * 100) : 0} tone="warn" />
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">rig temp</span>
                    <span className="font-mono tabular-nums text-foreground">{rig.tempC > 0 ? `${rig.tempC.toFixed(1)} °C` : '—'}</span>
                  </div>
                  <Bar pct={rig.tempC > 0 ? rig.tempC : 0} tone={tempTone(rig.tempC)} />
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={rig.pool}>
                    {rig.pool}
                  </p>
                </div>

                <DataTable
                  rows={rig.gpus}
                  headers={['GPU', 'Hashrate', 'Temp', 'Fan']}
                  keyOf={(g) => g.id}
                  maxH="18rem"
                  empty="no gpus"
                  renderRow={(g) => (
                    <>
                      <TableCell className="font-mono text-xs">{g.model}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {g.hashrate > 0 ? `${g.hashrate.toFixed(1)} TH/s` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        <span
                          className={
                            g.tempC >= 75 ? 'text-red-400' : g.tempC >= 68 ? 'text-amber-500' : g.tempC > 0 ? 'text-emerald-400' : 'text-muted-foreground'
                          }
                        >
                          {g.tempC > 0 ? `${g.tempC.toFixed(0)} °C` : '—'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        <span className="flex items-center justify-end gap-1 text-muted-foreground">
                          <Fan className="h-3 w-3" aria-hidden />
                          {g.fanPct > 0 ? `${g.fanPct}%` : '—'}
                        </span>
                      </TableCell>
                    </>
                  )}
                />
              </div>
            </PanelCard>
          )
        })}

        <p className="pb-2 text-xs text-muted-foreground">
          no mining daemons (xmrig/bosminer) in this sandbox — the fleet is the bridge&apos;s demo registry, but the values
          are live-feel: the 5s poll calls mining.refresh, which random-walks ±3% hashrate/temps on online rigs (each
          walk is audited). stop zeroes hashrate/power/temps; start restores nominal values.
        </p>
      </div>
    </div>
  )
}
