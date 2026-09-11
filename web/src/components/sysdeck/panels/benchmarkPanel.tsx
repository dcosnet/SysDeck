'use client'

// Benchmark panel — real micro-benchmarks (cpu / memory / disk suites)
// executed by the bridge, persisted to BenchmarkResult + audit log.
// Run buttons stream loading state while the suite actually executes
// (hundreds of ms to seconds), then toast the measured score.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Cpu, HardDrive, Loader2, MemoryStick, Play } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
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
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface SuiteRun {
  score: number
  ts: string
}

interface BenchmarkHistory {
  suites: Record<string, SuiteRun[]>
  total: number
  last: { suite: string; score: number; ts: string } | null
}

interface RunResult {
  suite: string
  score: number
  metric: string
  detail: Record<string, unknown>
  durationMs: number
}

// ── suite metadata ───────────────────────────────────────────────────

const SUITES: { id: string; name: string; icon: typeof Cpu; blurb: string }[] = [
  { id: 'cpu', name: 'CPU', icon: Cpu, blurb: '3 rounds · 50M int adds + 50M sqrt + 100k string concats (checksum-guarded)' },
  { id: 'memory', name: 'Memory', icon: MemoryStick, blurb: '4 × 64MB buffers — write pattern, read back, verify' },
  { id: 'disk', name: 'Disk', icon: HardDrive, blurb: '64MB through /tmp in 1MB chunks — write, read back, unlink' },
]

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false })
}

// ── panel ────────────────────────────────────────────────────────────

export default function BenchmarkPanel() {
  const history = useBridgeQuery<BenchmarkHistory>('benchmark', 'history')
  const action = useBridgeAction()
  const [running, setRunning] = useState<string | null>(null)
  const [suite, setSuite] = useState('cpu')
  const [lastRun, setLastRun] = useState<RunResult | null>(null)

  const h = history.data?.data

  const runs = useMemo(() => {
    const flat: (SuiteRun & { suite: string })[] = []
    for (const [s, rows] of Object.entries(h?.suites ?? {})) {
      for (const r of rows) flat.push({ ...r, suite: s })
    }
    flat.sort((a, b) => (a.ts < b.ts ? 1 : -1))
    return flat
  }, [h])

  const bestOf = (id: string): { score: number; ts: string } | null => {
    const rows = h?.suites?.[id]
    if (!rows || rows.length === 0) return null
    return rows.reduce((best, r) => (r.score > best.score ? r : best), rows[0]!)
  }

  const chartData = useMemo(() => (h?.suites?.[suite] ?? []).map((r) => ({ ts: fmtTime(r.ts), score: r.score })), [h, suite])

  async function run(id: string) {
    setRunning(id)
    try {
      const res = await action('benchmark', 'run', { suite: id })
      if (res.ok) {
        const d = res.data as RunResult
        setLastRun(d)
        toast.success(`${d.suite} benchmark complete — score ${d.score}`, {
          description: `${d.metric} · measured in ${d.durationMs} ms`,
        })
      } else {
        toast.error('benchmark failed', { description: res.error })
      }
    } finally {
      setRunning(null)
    }
  }

  if (history.isLoading && !history.data) return <PanelSkeleton lines={3} />
  if (history.data && !history.data.ok) return <ErrorCard error={history.data.error ?? 'benchmark.history failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Benchmark"
        subtitle="CPU, memory and disk micro-benchmarks — real measured runs with score history (no fabricated numbers)"
        source="live"
      />

      {/* suite cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {SUITES.map((s) => {
          const rows = h?.suites?.[s.id] ?? []
          const last = rows.length > 0 ? rows[0] : null // bridge returns newest-first
          const best = bestOf(s.id)
          const busy = running === s.id
          return (
            <PanelCard key={s.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
                    <s.icon className="h-4.5 w-4.5 text-primary" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{s.name} suite</p>
                    <Mono>{rows.length} runs recorded</Mono>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="gap-2 font-mono text-xs"
                  disabled={running !== null}
                  onClick={() => void run(s.id)}
                  aria-label={`Run ${s.name} benchmark`}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                  {busy ? 'running…' : 'Run'}
                </Button>
              </div>
              <div className="mt-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">last score</p>
                <p className="font-mono text-2xl font-semibold tabular-nums">{last ? last.score : '—'}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {last ? `${fmtTime(last.ts)}` : 'never run'}{best ? ` · best ${best.score}` : ''}
                </p>
              </div>
              <p className="mt-2 border-t border-border/50 pt-2 text-xs text-muted-foreground">{s.blurb}</p>
            </PanelCard>
          )
        })}
      </div>

      {/* score history chart */}
      <PanelCard
        title="Score history"
        actions={
          <div className="flex items-center gap-1" role="group" aria-label="Suite selector">
            {SUITES.map((s, i) => (
              <Button
                key={s.id}
                variant={suite === s.id ? 'default' : 'ghost'}
                size="sm"
                className="h-6 px-2.5 font-mono text-[11px]"
                onClick={() => setSuite(s.id)}
                aria-pressed={suite === s.id}
              >
                <span
                  className="mr-1.5 inline-block h-2 w-2 rounded-[2px]"
                  style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                  aria-hidden
                />
                {s.id}
              </Button>
            ))}
          </div>
        }
      >
        <div className="h-52" role="img" aria-label={`${suite} benchmark score history`}>
          {chartData.length < 2 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {chartData.length === 1 ? 'one run recorded — run again for a trend' : 'no runs recorded yet — hit Run'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="ts" stroke="var(--muted-foreground)" fontSize={10} tickLine={false} minTickGap={40} />
                <YAxis stroke="var(--muted-foreground)" fontSize={10} tickLine={false} domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--popover-foreground)',
                  }}
                />
                <Line type="monotone" dataKey="score" stroke="var(--chart-1)" strokeWidth={1.5} dot={{ r: 2.5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </PanelCard>

      {/* history table + last run detail */}
      <div className="grid gap-4 lg:grid-cols-3">
        <PanelCard title="Run history" className="lg:col-span-2" actions={<Mono>{h?.total ?? 0} runs · newest first</Mono>}>
          <DataTable
            rows={runs}
            headers={['Suite', 'Score', 'Metric', 'When']}
            keyOf={(r, i) => `${r.suite}-${r.ts}-${i}`}
            maxH="24rem"
            empty="no benchmark runs recorded"
            renderRow={(r) => (
              <>
                <TableCell className="font-mono text-xs font-semibold">{r.suite}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{r.score}</TableCell>
                <TableCell className="max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={metricOf(r.suite)}>
                  {metricOf(r.suite)}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{new Date(r.ts).toLocaleString()}</TableCell>
              </>
            )}
          />
        </PanelCard>

        <div className="space-y-4">
          {h?.last ? (
            <StatCard
              label="Last run"
              value={h.last.score}
              hint={`${h.last.suite} · ${fmtTime(h.last.ts)}`}
            />
          ) : null}
          <PanelCard title="Run detail">
            {lastRun ? (
              <div>
                <KV k="suite" v={lastRun.suite} />
                <KV k="score" v={<span className="text-primary">{lastRun.score}</span>} />
                <KV k="wall clock" v={`${lastRun.durationMs} ms`} />
                <KV k="metric" v={<span className="text-[11px]">{lastRun.metric}</span>} />
                <div className="mt-2 border-t border-border/50 pt-2">
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">measured</p>
                  {Object.entries(lastRun.detail).map(([k, v]) => (
                    <KV key={k} k={k} v={<span className="break-all text-[11px]">{String(v)}</span>} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                run a suite to see the measured detail block — ops counts, timings, bandwidths and the checksum sink.
              </p>
            )}
          </PanelCard>
        </div>
      </div>
    </div>
  )
}

function metricOf(suite: string): string {
  if (suite === 'cpu') return 'score = round(1e6 / total ms) — higher is better'
  if (suite === 'memory') return 'MB/s combined write+read bandwidth (4 × 64MB buffers)'
  return 'MB/s (average of 64MB write + 64MB read on /tmp)'
}
