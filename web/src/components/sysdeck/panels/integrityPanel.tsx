'use client'

// Integrity panel — tripwire-style file integrity monitoring.
// Everything here is LIVE: sha256 baselines of 13 real system files plus
// the sentinel, re-hash on check, drift rows (modified/added/removed)
// persisted with per-row resolve. No seeding — the hashes you see are
// this container's real file digests.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCheck, FileCheck2, FileWarning, Hash, RefreshCw, ShieldCheck } from 'lucide-react'
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
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface BaselineFile {
  path: string
  hash: string
  size: number
}

interface BaselineData {
  baselined: number
  files: BaselineFile[]
  skipped: { path: string; reason: string }[]
  sentinel: { path: string; created: boolean }
  ts: string
}

interface DriftRow {
  id: string
  path: string
  change: string
  oldHash: string | null
  newHash: string | null
  detected: string
  resolved: boolean
}

interface IntegritySummary {
  monitored: number
  drift: number
  driftRows: DriftRow[]
  lastCheck: string | null
  sentinel: string
  baselined: boolean
}

interface CheckData {
  clean: boolean
  drift: { path: string; change: string; oldHash: string | null; newHash: string | null }[]
  checked: number
  unreadable: string[]
  lastCheck: string
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtUtc(iso: string | null): string {
  if (!iso) return 'never'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function shortHash(h: string | null): string {
  if (!h) return '—'
  return `${h.slice(0, 12)}…${h.slice(-6)}`
}

function changeBadgeCls(change: string): string {
  if (change === 'modified') return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
  if (change === 'added') return 'bg-teal-500/15 text-teal-400 border-teal-500/30'
  return 'bg-red-500/15 text-red-500 border-red-500/30'
}

// ── panel ────────────────────────────────────────────────────────────

export default function IntegrityPanel() {
  const summaryQ = useBridgeQuery<IntegritySummary>('integrity', 'summary', undefined, { refetchInterval: 8000 })
  const driftsQ = useBridgeQuery<{ drifts: DriftRow[]; unresolved: number; total: number }>(
    'integrity',
    'drifts',
    undefined,
    { refetchInterval: 8000 },
  )
  const action = useBridgeAction()
  const [checking, setChecking] = useState(false)
  const [files, setFiles] = useState<BaselineData | null>(null)

  const summary = summaryQ.data?.data
  const drifts = useMemo(() => driftsQ.data?.data?.drifts ?? [], [driftsQ.data])
  const unresolved = drifts.filter((d) => !d.resolved)

  // auto-baseline ONLY when no baseline exists yet and there is no drift
  // to preserve (a re-baseline resets drift detection — never silent)
  const autoBaselineQ = useBridgeQuery<BaselineData>('integrity', 'baseline', undefined, {
    enabled: summary?.baselined === false && summary?.drift === 0,
    staleTime: Infinity,
  })

  async function runCheck() {
    setChecking(true)
    try {
      const res = await action('integrity', 'check')
      if (res.ok) {
        const d = res.data as CheckData
        if (d.clean) {
          toast.success('integrity check: clean', {
            description: `${d.checked} monitored files re-hashed — all match the baseline`,
          })
        } else {
          toast.warning(`integrity check: ${d.drift.length} drift${d.drift.length === 1 ? '' : 's'}`, {
            description: d.drift.map((x) => `${x.change}: ${x.path.replace('/var/tmp/', '~/')}`).join(' · '),
          })
        }
      } else {
        toast.error('check failed', { description: res.error })
      }
    } finally {
      setChecking(false)
    }
  }

  async function reBaseline() {
    const res = await action('integrity', 'baseline')
    if (res.ok) {
      const d = res.data as BaselineData
      setFiles(d)
      toast.success('baseline re-hashed', {
        description: `${d.baselined} files sha256-baselined, ${d.skipped.length} skipped — drift detection restarts from now`,
      })
    } else {
      toast.error('baseline failed', { description: res.error })
    }
  }

  async function resolveDrift(row: DriftRow) {
    const res = await action('integrity', 'resolve', { id: row.id })
    if (res.ok) {
      toast.success('drift resolved', {
        description: `${row.change}: ${row.path} accepted as the new normal`,
      })
    } else {
      toast.error('resolve failed', { description: res.error })
    }
  }

  if (summaryQ.isLoading && !summaryQ.data) return <PanelSkeleton lines={4} />
  if (summaryQ.data && !summaryQ.data.ok) return <ErrorCard error={summaryQ.data.error ?? 'integrity.summary failed'} />

  const shownFiles = files ?? (autoBaselineQ.data?.ok ? autoBaselineQ.data.data : null)

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Integrity"
        subtitle="tripwire-style file integrity monitoring — sha256 baselines, real drift detection, per-row resolve"
        source="live"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="gap-1.5 font-mono text-xs" disabled={checking} onClick={() => void runCheck()}>
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden />
              {checking ? 'checking…' : 'run check'}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 font-mono text-xs">
                  <Hash className="h-3.5 w-3.5" aria-hidden />
                  re-baseline
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-mono">re-hash the baseline?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This re-hashes all {summary?.monitored ?? 0} monitored files and REPLACES the stored digests —
                    drift detection resets from this moment. Any currently-unresolved drift{' '}
                    {unresolved.length > 0 ? `(${unresolved.length} row${unresolved.length === 1 ? '' : 's'}) ` : ''}
                    will report clean on the next check unless you resolve it first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void reBaseline()}>Re-baseline</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Monitored files"
          value={summary?.monitored ?? '—'}
          icon={<FileCheck2 className="h-4 w-4" aria-hidden />}
          hint={summary?.baselined ? 'sha256-baselined' : 'no baseline yet'}
        />
        <StatCard
          label="Unresolved drift"
          value={summary?.drift ?? '—'}
          tone={summary?.drift ? 'bad' : 'good'}
          icon={<FileWarning className="h-4 w-4" aria-hidden />}
          hint={summary?.drift ? 'review and resolve below' : 'everything matches'}
        />
        <StatCard label="Drift rows total" value={drifts.length} hint="incl. resolved history" />
        <StatCard
          label="Last check"
          value={summary?.lastCheck ? fmtUtc(summary.lastCheck).slice(11) : 'never'}
          hint={summary?.lastCheck ? fmtUtc(summary.lastCheck).slice(0, 10) : 'run the first check'}
        />
      </div>

      {/* drift table */}
      <PanelCard
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
            drift {unresolved.length > 0 ? `· ${unresolved.length} unresolved` : '· all clear'}
          </span>
        }
        actions={<Mono>{driftsQ.data?.data?.total ?? 0} rows recorded</Mono>}
      >
        <DataTable
          rows={drifts}
          headers={['Path', 'Change', 'old → new sha256', 'Detected', '']}
          keyOf={(d) => d.id}
          maxH="22rem"
          empty="no drift ever recorded — the monitored set matches its baseline"
          renderRow={(d) => (
            <>
              <TableCell className={`font-mono text-xs ${d.resolved ? 'text-muted-foreground line-through' : ''}`}>
                {d.path}
              </TableCell>
              <TableCell>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${changeBadgeCls(d.change)}`}
                >
                  {d.change}
                </span>
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {shortHash(d.oldHash)} <span className="text-foreground/40">→</span> {shortHash(d.newHash)}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtUtc(d.detected)}</TableCell>
              <TableCell className="text-right">
                {d.resolved ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                    <CheckCheck className="h-3 w-3" aria-hidden />
                    resolved
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 font-mono text-[11px]"
                    onClick={() => void resolveDrift(d)}
                    aria-label={`Resolve drift on ${d.path}`}
                  >
                    resolve
                  </Button>
                )}
              </TableCell>
            </>
          )}
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          modified = amber · added = teal · removed = red — one unresolved row per path+change, refreshed in place.
        </p>
      </PanelCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* monitored files */}
        <PanelCard
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
              monitored set
            </span>
          }
          actions={<Mono>{shownFiles?.files.length ?? summary?.monitored ?? 0} files</Mono>}
        >
          {shownFiles ? (
            <>
              <DataTable
                rows={shownFiles.files}
                headers={['Path', 'sha256', 'Size']}
                keyOf={(f) => f.path}
                maxH="22rem"
                renderRow={(f) => (
                  <>
                    <TableCell className="font-mono text-xs">{f.path}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{shortHash(f.hash)}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{f.size} B</TableCell>
                  </>
                )}
              />
              {shownFiles.skipped.length > 0 ? (
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  skipped: {shownFiles.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}
                </p>
              ) : null}
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {summary?.monitored ?? 0} files are baselined (hashes stored server-side). Run{' '}
                <span className="font-mono text-xs">re-baseline</span> to re-hash and display the current digests.
              </p>
              <div>
                <KV k="sentinel" v={summary?.sentinel ?? '—'} />
                <KV k="last check" v={fmtUtc(summary?.lastCheck ?? null)} />
              </div>
            </div>
          )}
        </PanelCard>

        {/* hint */}
        <HintCard title="Try real drift detection">
          <p>
            Sentinel file: <Mono>/var/tmp/sysdeck-integrity-sentinel</Mono> — edit it and re-run check to see real drift
            detection.
          </p>
          <pre className="overflow-auto rounded bg-zinc-950/80 p-3 font-mono text-xs text-zinc-300">
{`echo tampered >> /var/tmp/sysdeck-integrity-sentinel
# then: run check  →  drift: modified (old → new sha256)
# resolve it, or re-baseline to accept the change`}
          </pre>
          <p>
            The baseline covers <Mono>/etc/passwd</Mono>, <Mono>/etc/group</Mono>, <Mono>/etc/hosts</Mono>,{' '}
            <Mono>/etc/os-release</Mono>, <Mono>/bin/sh</Mono>, <Mono>/usr/bin/dpkg</Mono> and friends —{' '}
            <Mono>/etc/shadow</Mono> is honestly skipped (root-only). All hashes are real sha256
            digests of this host&apos;s files.
          </p>
        </HintCard>
      </div>
    </div>
  )
}
