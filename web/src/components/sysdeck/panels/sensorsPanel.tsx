'use client'

// Sensors panel — hardware readings grouped by adapter.
// The bridge reads the same sysfs sources lm-sensors reads and — when
// this container's sparse /sys/class/hwmon yields fewer than 3 real
// readings — supplements a clearly-labeled demo chip set (reading rows
// carry demo:true). Real rows are always first and unflagged.

import { useMemo } from 'react'
import { Flame, Thermometer, Wind, Zap, Boxes } from 'lucide-react'
import { useBridgeQuery } from '@/lib/sysdeck/client'
import type { DataSource } from '@/lib/sysdeck/types'
import {
  Bar,
  DataTable,
  ErrorCard,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
} from '@/components/sysdeck/ui'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface SensorReading {
  label: string
  value: number
  unit: string
  critical?: number
  demo?: boolean
}

interface SensorAdapter {
  name: string
  kind: 'temp' | 'fan' | 'voltage'
  readings: SensorReading[]
}

interface SensorsSummary {
  adapters: SensorAdapter[]
  source: DataSource
}

// ── helpers ──────────────────────────────────────────────────────────

/** proximity of value to critical → display tone */
function tempTone(reading: SensorReading): 'good' | 'warn' | 'bad' {
  if (reading.critical && reading.critical > 0) {
    const r = reading.value / reading.critical
    if (r >= 0.8) return 'bad'
    if (r >= 0.65) return 'warn'
  }
  return 'good'
}

const TEMP_TONE_CLS: Record<'good' | 'warn' | 'bad', string> = {
  good: 'text-emerald-400',
  warn: 'text-amber-500',
  bad: 'text-red-500',
}

/** demo marker: italic + tooltip, per the honesty contract */
function ReadingLabel({ r }: { r: SensorReading }) {
  return r.demo ? (
    <span className="italic text-muted-foreground" title="supplemented dataset">
      {r.label}
      <sup className="ml-0.5 font-mono text-[9px] not-italic text-amber-500/80" aria-label="demo reading">
        d
      </sup>
    </span>
  ) : (
    <span>{r.label}</span>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function SensorsPanel() {
  const q = useBridgeQuery<SensorsSummary>('sensors', 'summary', undefined, { refetchInterval: 5000 })
  const data = q.data?.data
  const source = q.data?.source ?? 'hybrid'

  const temps = useMemo(() => (data?.adapters ?? []).filter((a) => a.kind === 'temp'), [data])
  const fans = useMemo(() => (data?.adapters ?? []).filter((a) => a.kind === 'fan'), [data])
  const volts = useMemo(() => (data?.adapters ?? []).filter((a) => a.kind === 'voltage'), [data])

  const readings = data?.adapters?.reduce((n, a) => n + a.readings.length, 0) ?? 0
  const demoCount =
    data?.adapters?.reduce((n, a) => n + a.readings.filter((r) => r.demo).length, 0) ?? 0
  const hottest = useMemo(() => {
    let best: SensorReading | null = null
    for (const a of temps) {
      for (const r of a.readings) {
        if (!best || r.value > best.value) best = r
      }
    }
    return best
  }, [temps])

  if (q.isLoading && !q.data) return <PanelSkeleton lines={3} />
  if (q.data && !q.data.ok) return <ErrorCard error={q.data.error ?? 'sensors.summary failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Sensors"
        subtitle="hardware sensor readings — temperature, fans, voltages from /sys/class/hwmon + thermal zones"
        source={source}
      />

      {/* stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Readings"
          value={readings}
          icon={<Boxes className="h-4 w-4" aria-hidden />}
          hint={`${data?.adapters?.length ?? 0} adapters grouped by kind`}
        />
        <StatCard
          label="Hottest"
          value={hottest ? hottest.value.toFixed(1) : '—'}
          unit={hottest?.unit ?? ''}
          icon={<Thermometer className="h-4 w-4" aria-hidden />}
          tone={hottest ? tempTone(hottest) : 'default'}
          hint={hottest ? (hottest.critical ? `critical ${hottest.critical}°C` : 'no critical trip') : 'no temperature readings'}
        />
        <StatCard
          label="Fans"
          value={fans.reduce((n, a) => n + a.readings.length, 0)}
          icon={<Wind className="h-4 w-4" aria-hidden />}
          hint="RPM tachometers"
        />
        <StatCard
          label="Supplemented"
          value={demoCount}
          icon={<Flame className="h-4 w-4" aria-hidden />}
          tone={demoCount > 0 ? 'warn' : 'default'}
          hint={demoCount > 0 ? 'italic rows — demo chip set' : 'all rows real sysfs'}
        />
      </div>

      {/* temperatures */}
      <PanelCard
        title={
          <span className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-primary" aria-hidden /> Temperatures
          </span>
        }
        actions={<Mono>°C · red ≥ 80% of critical</Mono>}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {temps.map((a) => (
            <div key={a.name} className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {a.name}
                </span>
                <Mono>{a.readings.length} sensors</Mono>
              </div>
              <div className="space-y-3">
                {a.readings.map((r) => {
                  const tone = tempTone(r)
                  const pct = r.critical && r.critical > 0 ? (r.value / r.critical) * 100 : Math.min(100, r.value)
                  return (
                    <div key={r.label}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm">
                          <ReadingLabel r={r} />
                        </span>
                        <span className={`font-mono text-lg font-semibold tabular-nums ${TEMP_TONE_CLS[tone]}`}>
                          {r.value.toFixed(1)}
                          <span className="text-xs font-normal text-muted-foreground">{r.unit}</span>
                        </span>
                      </div>
                      <div className="mt-1">
                        <Bar pct={pct} tone={tone} />
                      </div>
                      {r.critical ? (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          critical trip at {r.critical}{r.unit} · {(pct).toFixed(0)}% of trip
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {temps.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
              no temperature adapters reported
            </p>
          ) : null}
        </div>
      </PanelCard>

      {/* fans + voltages */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard
          title={
            <span className="flex items-center gap-2">
              <Wind className="h-4 w-4 text-primary" aria-hidden /> Fans
            </span>
          }
        >
          <DataTable
            rows={fans.flatMap((a) => a.readings.map((r) => ({ adapter: a.name, ...r })))}
            headers={['Adapter', 'Label', 'Speed']}
            keyOf={(r, i) => `${r.adapter}-${r.label}-${i}`}
            maxH="20rem"
            empty="no fan adapters reported"
            renderRow={(r) => (
              <>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.adapter}</TableCell>
                <TableCell className="text-sm">
                  <ReadingLabel r={r} />
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">
                  {r.value.toFixed(0)} <span className="text-xs text-muted-foreground">{r.unit}</span>
                </TableCell>
              </>
            )}
          />
        </PanelCard>

        <PanelCard
          title={
            <span className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" aria-hidden /> Voltages
            </span>
          }
        >
          <DataTable
            rows={volts.flatMap((a) => a.readings.map((r) => ({ adapter: a.name, ...r })))}
            headers={['Adapter', 'Label', 'Rail']}
            keyOf={(r, i) => `${r.adapter}-${r.label}-${i}`}
            maxH="20rem"
            empty="no voltage adapters reported"
            renderRow={(r) => {
              const nominal = r.label.toLowerCase().includes('12') ? 12 : r.label.toLowerCase().includes('5') ? 5 : null
              const off = nominal !== null && Math.abs(r.value - nominal) > nominal * 0.1
              return (
                <>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.adapter}</TableCell>
                  <TableCell className="text-sm">
                    <ReadingLabel r={r} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    <span className={off ? 'text-amber-500' : 'text-foreground'}>
                      {r.value.toFixed(2)} <span className="text-xs text-muted-foreground">{r.unit}</span>
                    </span>
                  </TableCell>
                </>
              )
            }}
          />
        </PanelCard>
      </div>

      {demoCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          <sup className="font-mono text-[9px] text-amber-500/80">d</sup>{' '}
          <span className="italic">italic readings are a supplemented dataset</span> —{' '}
          {q.data?.note ?? '/sys/class/hwmon is sparse in this container, so the bridge models the chips every lm-sensors user knows (coretemp / nct6798 / it8620).'}
        </p>
      ) : null}
    </div>
  )
}
