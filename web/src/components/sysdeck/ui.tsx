'use client'

// SysDeck shared panel primitives — the React/shadcn equivalents of the
// cockpit edition's suite-card / suite-table / suite-badge classes.

import { type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { DataSource } from '@/lib/sysdeck/types'

export function PanelHeader({
  title,
  subtitle,
  source,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  source?: DataSource
  actions?: ReactNode
}) {
  return (
    <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {source ? <SourceBadge source={source} /> : null}
        {actions}
      </div>
    </header>
  )
}

export function SourceBadge({ source }: { source: DataSource }) {
  const map: Record<DataSource, { label: string; cls: string }> = {
    live: { label: 'LIVE', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    demo: { label: 'DEMO', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
    hybrid: { label: 'HYBRID', cls: 'bg-teal-500/15 text-teal-400 border-teal-500/30' },
    unavailable: { label: 'N/A', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
  }
  const m = map[source]
  return (
    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider', m.cls)}>
      {m.label}
    </span>
  )
}

export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  unit?: string
  hint?: string
  icon?: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const toneCls = {
    default: 'text-foreground',
    good: 'text-emerald-400',
    warn: 'text-amber-500',
    bad: 'text-red-500',
  }[tone]
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        </div>
        <p className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', toneCls)}>
          {value}
          {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
        </p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

export function PanelCard({
  title,
  actions,
  children,
  className,
  contentClassName,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={className}>
      {title ? (
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </CardTitle>
          {actions}
        </CardHeader>
      ) : null}
      <CardContent className={cn('pt-0', !title && 'pt-4', contentClassName)}>{children}</CardContent>
    </Card>
  )
}

export function DataTable<T>({
  rows,
  headers,
  renderRow,
  empty = 'No data.',
  maxH = '26rem',
  keyOf,
}: {
  rows: T[]
  headers: ReactNode[]
  renderRow: (row: T, i: number) => ReactNode
  empty?: string
  maxH?: string
  keyOf?: (row: T, i: number) => string
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  }
  return (
    <div className="overflow-auto sd-scroll" style={{ maxHeight: maxH }}>
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) => (
              <TableHead key={i}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={keyOf ? keyOf(row, i) : i}>{renderRow(row, i)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function StateBadge({ state }: { state: string }) {
  const s = state.toLowerCase()
  const cls =
    s === 'running' || s === 'online' || s === 'healthy' || s === 'succeeded' || s === 'active' || s === 'unlocked' || s === 'playing' || s === 'done' || s === 'allow' || s === 'installed' || s === 'pass'
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
      : s === 'stopped' || s === 'offline' || s === 'locked' || s === 'queued' || s === 'idle' || s === 'deny' || s === 'uninstalled'
        ? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
        : s === 'failed' || s === 'error' || s === 'danger' || s === 'crit' || s === 'critical'
          ? 'bg-red-500/15 text-red-500 border-red-500/30'
          : s === 'warn' || s === 'degraded' || s === 'warned' || s === 'frozen' || s === 'paused' || s === 'acknowledged'
            ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
            : 'bg-teal-500/15 text-teal-400 border-teal-500/30'
  return (
    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider', cls)}>
      {state}
    </span>
  )
}

export function KV({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className={cn('text-sm text-foreground', mono && 'font-mono')}>{v}</span>
    </div>
  )
}

export function Bar({ pct, tone = 'default' }: { pct: number; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const v = Math.max(0, Math.min(100, pct))
  const cls =
    tone === 'bad'
      ? '[&>div]:bg-red-500'
      : tone === 'warn'
        ? '[&>div]:bg-amber-500'
        : tone === 'good'
          ? '[&>div]:bg-emerald-500'
          : '[&>div]:bg-teal-500'
  return <Progress value={v} className={cn('h-1.5', cls)} />
}

export function MeterRow({ label, pct, display, tone }: { label: string; pct: number; display: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{display}</span>
      </div>
      <Bar pct={pct} tone={tone ?? (pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'default')} />
    </div>
  )
}

export function HintCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PanelCard title={title}>
      <div className="space-y-3 text-sm text-muted-foreground">{children}</div>
    </PanelCard>
  )
}

export function InstallHint({ bin, distro, hint }: { bin: string; distro: string; hint?: string }) {
  return (
    <HintCard title={`${bin} not available`}>
      <p>
        This panel backs itself with the <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{bin}</code>{' '}
        backend. It is not present on this host, so a {distro} dataset is shown instead.
      </p>
      {hint ? <pre className="overflow-auto rounded bg-zinc-950/80 p-3 font-mono text-xs text-zinc-300">{hint}</pre> : null}
    </HintCard>
  )
}

export function PanelSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}

export function ErrorCard({ error }: { error: string }) {
  return (
    <PanelCard title="Bridge error">
      <p className="font-mono text-xs text-red-400">{error}</p>
    </PanelCard>
  )
}
