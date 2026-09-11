'use client'

// Photos panel — photo library fleet (photoprism / piwigo / lychee /
// nextcloud-memories). The daemons are absent in this sandbox, so the
// bridge keeps a demo inventory: 4 libraries (~72k photos), one actively
// indexing, one in error state (missing EXIF tool). index advances the
// indexing pass ~7% per call; scan finds new files synchronously.

import { useState } from 'react'
import { toast } from 'sonner'
import { Camera, CircleAlert, Images, Play, RefreshCw, Video } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  Bar,
  ErrorCard,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'

// ── bridge shapes ────────────────────────────────────────────────────

interface PhSummary {
  libraries: number
  photos: number
  videos: number
  sizeGb: number
  states: { indexing: number; idle: number; error: number }
  errors: number
  indexingProgress: Record<string, number>
}

interface PhotoLib {
  id: string
  backend: string
  name: string
  photos: number
  videos: number
  sizeGb: number
  state: 'indexing' | 'idle' | 'error'
  progress: number | null
  error: string | null
}

// ── helpers ──────────────────────────────────────────────────────────

const BACKEND_CLS: Record<string, string> = {
  photoprism: 'border-teal-500/30 bg-teal-500/15 text-teal-400',
  piwigo: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  lychee: 'border-amber-500/30 bg-amber-500/15 text-amber-500',
  'nextcloud-memories': 'border-sky-500/30 bg-sky-500/15 text-sky-400',
  librephotos: 'border-orange-500/30 bg-orange-500/15 text-orange-400',
}

function backendBadge(backend: string) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
        BACKEND_CLS[backend] ?? 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      {backend}
    </span>
  )
}

function stateBadge(state: string) {
  if (state === 'indexing') {
    return (
      <span className="inline-block animate-pulse rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-500">
        indexing
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="rounded border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-red-500">
        error
      </span>
    )
  }
  return (
    <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
      idle
    </span>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function PhotosPanel() {
  const summary = useBridgeQuery<PhSummary>('photos', 'summary', {}, { refetchInterval: 8000 })
  const list = useBridgeQuery<{ libraries: PhotoLib[]; count: number }>('photos', 'list', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function mutate(command: 'index' | 'scan', lib: PhotoLib) {
    setBusyId(lib.id)
    try {
      const res = await action('photos', command, { id: lib.id })
      if (res.ok) {
        const d = res.data as { before?: number; after?: number; added?: number; scanned?: number; state?: string }
        if (command === 'index') {
          toast.success(`indexing: ${lib.name} ${d.before ?? 0}% → ${d.after ?? 0}%`, {
            description: d.after !== undefined && d.after >= 100 ? 'pass complete — library idle' : `state → ${d.state}`,
          })
        } else {
          toast.success(`scan: ${lib.name} — ${d.added ?? 0} new photos`, {
            description: `${d.scanned ?? '?'} total · state → ${d.state}`,
          })
        }
      } else {
        toast.error(`${command}: ${lib.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summary.isLoading || list.isLoading) {
    return (
      <div>
        <PanelHeader title="Photos" subtitle="library fleet — photoprism · piwigo · lychee · nextcloud-memories" source="demo" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Photos" subtitle="library fleet — photoprism · piwigo · lychee · nextcloud-memories" source="demo" />
        <ErrorCard error={summary.data?.error ?? 'photos.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const libs = list.data?.data?.libraries ?? []

  return (
    <div>
      <PanelHeader
        title="Photos"
        subtitle="library fleet — indexing passes · scans · 8s poll"
        source="demo"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="libraries" value={s.libraries} icon={<Images className="h-4 w-4" aria-hidden />} hint={`${s.states.indexing} indexing · ${s.states.error} error`} />
        <StatCard label="photos" value={s.photos.toLocaleString('en-US')} icon={<Camera className="h-4 w-4" aria-hidden />} />
        <StatCard label="videos" value={s.videos.toLocaleString('en-US')} icon={<Video className="h-4 w-4" aria-hidden />} />
        <StatCard label="total size" value={s.sizeGb} unit="GB" icon={<CircleAlert className="h-4 w-4" aria-hidden />} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {libs.map((lib) => (
          <PanelCard
            key={lib.id}
            title={
              <span className="flex items-center gap-2 normal-case">
                <span className="font-mono text-sm font-semibold text-foreground">{lib.name}</span>
                {backendBadge(lib.backend)}
                {stateBadge(lib.state)}
              </span>
            }
            actions={<Mono>{lib.sizeGb} GB</Mono>}
            contentClassName="space-y-3"
          >
            <div className="grid grid-cols-2 gap-x-6">
              <KV k="photos" v={lib.photos.toLocaleString('en-US')} />
              <KV k="videos" v={lib.videos.toLocaleString('en-US')} />
            </div>

            {lib.state === 'indexing' && lib.progress !== null ? (
              <div className="space-y-1">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-muted-foreground">indexing progress</span>
                  <span className="font-mono tabular-nums text-amber-500">{lib.progress}%</span>
                </div>
                <Bar pct={lib.progress} tone="warn" />
              </div>
            ) : null}

            {lib.state === 'error' && lib.error ? (
              <p className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-2 font-mono text-[11px] leading-relaxed text-red-400">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {lib.error}
              </p>
            ) : null}

            <div className="flex items-center gap-2 border-t border-border/50 pt-3">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 font-mono text-[11px]"
                disabled={busyId === lib.id}
                onClick={() => void mutate('index', lib)}
                aria-label={`index ${lib.name}`}
                title="run one indexing pass (~7% per call; 100% → idle)"
              >
                <Play className="h-3 w-3" aria-hidden /> index
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 font-mono text-[11px]"
                disabled={busyId === lib.id}
                onClick={() => void mutate('scan', lib)}
                aria-label={`scan ${lib.name}`}
                title={lib.state === 'error' ? 'refused while the backend is in error state' : 'scan for new files'}
              >
                <RefreshCw className="h-3 w-3" aria-hidden /> scan
              </Button>
            </div>
          </PanelCard>
        ))}
      </div>

      <p className="mt-4 pb-2 text-xs text-muted-foreground">
        no photoprism/piwigo/lychee/nextcloud daemons in this sandbox — the libraries above are the bridge&apos;s demo
        inventory (family is mid-indexing at {s.indexingProgress?.family ?? 0}%; scan is in error state until the EXIF
        tool is installed). index advances one pass per click; the bridge refuses operations on the error-state library.
      </p>
    </div>
  )
}
