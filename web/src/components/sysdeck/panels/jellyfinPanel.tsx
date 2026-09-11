'use client'

// Jellyfin panel — media server (libraries, sessions, recent items).
// The jellyfin daemon is absent in this sandbox, so the bridge keeps a
// demo media inventory (4 libraries, 3 sessions — one 4K transcode).
// play/pause toggle the demo session states (transcoding card + audit).

import { useState } from 'react'
import { toast } from 'sonner'
import { Clapperboard, Film, Music, Pause, Play, Images, Tv, Users } from 'lucide-react'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableCell } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ── bridge shapes ────────────────────────────────────────────────────

interface JfSummary {
  libraries: number
  items: number
  tracks: number
  sessions: number
  playing: number
  transcode: number
  totalSizeMb: number
}

interface Library {
  name: string
  kind: string
  items: number
  tracks?: number
  sizeMb: number
  sizeHuman: string
  sampleItems: number
}

interface MediaItem {
  id: string
  kind: string
  title: string
  library: string
  sizeMb: number
  year?: number
  addedAt: string
  playCount: number
  sizeHuman: string
}

interface Session {
  id: string
  user: string
  device: string
  item: string
  state: 'playing' | 'paused' | 'idle'
  startedAt: string
  method: 'transcode' | 'direct' | 'idle'
  methodDetail: string
}

// ── helpers ──────────────────────────────────────────────────────────

const KIND_ICON: Record<string, typeof Film> = {
  movie: Film,
  series: Tv,
  music: Music,
  photo: Images,
}

function stateBadge(state: string) {
  if (state === 'playing') {
    return (
      <span className="inline-block animate-pulse rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
        playing
      </span>
    )
  }
  if (state === 'paused') {
    return (
      <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-500">
        paused
      </span>
    )
  }
  return (
    <span className="rounded border border-zinc-500/30 bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
      idle
    </span>
  )
}

function methodBadge(method: string) {
  if (method === 'transcode') {
    return (
      <span className="rounded border border-violet-500/30 bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-violet-300">
        transcode
      </span>
    )
  }
  if (method === 'direct') {
    return (
      <span className="rounded border border-teal-500/30 bg-teal-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-400">
        direct
      </span>
    )
  }
  return <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">idle</span>
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

// ── panel ────────────────────────────────────────────────────────────

export default function JellyfinPanel() {
  const summary = useBridgeQuery<JfSummary>('jellyfin', 'summary', {}, { refetchInterval: 8000 })
  const libraries = useBridgeQuery<{ libraries: Library[]; count: number }>('jellyfin', 'libraries')
  const sessions = useBridgeQuery<{ sessions: Session[]; count: number }>('jellyfin', 'sessions', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()

  const [lib, setLib] = useState('Movies')
  const items = useBridgeQuery<{ library: string; items: MediaItem[]; returned: number }>(
    'jellyfin',
    'items',
    { library: lib, limit: 200 },
    { enabled: true },
  )

  const [busySession, setBusySession] = useState<string | null>(null)

  async function toggle(command: 'play' | 'pause', s: Session) {
    setBusySession(s.id)
    try {
      const res = await action('jellyfin', command, { sessionId: s.id })
      if (res.ok) {
        toast.success(`${s.user} → ${(res.data as { state?: string })?.state ?? command}`, {
          description: `${s.device} · ${s.item}`,
        })
      } else {
        toast.error(`${command}: ${s.user} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusySession(null)
    }
  }

  if (summary.isLoading) {
    return (
      <div>
        <PanelHeader title="Jellyfin" subtitle="media server — libraries · sessions · items" source="demo" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Jellyfin" subtitle="media server — libraries · sessions · items" source="demo" />
        <ErrorCard error={summary.data?.error ?? 'jellyfin.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const libRows = libraries.data?.data?.libraries ?? []
  const sesRows = sessions.data?.data?.sessions ?? []
  const itemRows = items.data?.data?.items ?? []
  const totalPlays = itemRows.reduce((a, i) => a + i.playCount, 0)

  return (
    <div>
      <PanelHeader
        title="Jellyfin"
        subtitle="media server — 4 libraries · sessions with live transport state · 8s poll"
        source="demo"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="libraries" value={s.libraries} icon={<Clapperboard className="h-4 w-4" aria-hidden />} hint={`${(s.totalSizeMb / 1024 / 1024).toFixed(1)} TB total`} />
        <StatCard label="items" value={s.items.toLocaleString('en-US')} icon={<Film className="h-4 w-4" aria-hidden />} hint={`${s.tracks.toLocaleString('en-US')} music tracks`} />
        <StatCard label="active sessions" value={s.sessions} icon={<Users className="h-4 w-4" aria-hidden />} hint={`${s.playing} playing`} />
        <StatCard label="transcoding" value={s.transcode} tone={s.transcode > 0 ? 'warn' : 'default'} icon={<Tv className="h-4 w-4" aria-hidden />} hint="4K HDR → 1080p H.264" />
      </div>

      <Tabs defaultValue="libraries" className="mt-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="libraries" className="gap-1.5 font-mono text-xs">libraries</TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1.5 font-mono text-xs">
            sessions <span className="text-muted-foreground">{sesRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="items" className="gap-1.5 font-mono text-xs">recent items</TabsTrigger>
        </TabsList>

        <TabsContent value="libraries" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {libRows.map((l) => {
              const Icon = KIND_ICON[l.kind] ?? Film
              return (
                <PanelCard
                  key={l.name}
                  title={
                    <span className="flex items-center gap-2 normal-case">
                      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                      <span className="font-mono text-sm font-semibold text-foreground">{l.name}</span>
                    </span>
                  }
                  actions={<Mono>{l.kind}</Mono>}
                  contentClassName="space-y-1"
                >
                  <KV k={l.kind === 'music' ? 'tracks' : 'items'} v={(l.tracks ?? l.items).toLocaleString('en-US')} />
                  <KV k="size" v={l.sizeHuman} />
                  <KV k="sample rows" v={l.sampleItems} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7 px-2 font-mono text-[11px]"
                    onClick={() => setLib(l.name)}
                    aria-label={`browse ${l.name} sample items`}
                  >
                    browse sample items
                  </Button>
                </PanelCard>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          <PanelCard title="Active sessions" actions={<Mono>transport state · play/pause round-trips</Mono>}>
            <DataTable
              rows={sesRows}
              headers={['User', 'Device', 'Now playing', 'State', 'Method', 'Since', '']}
              keyOf={(r) => r.id}
              maxH="20rem"
              renderRow={(r) => (
                <>
                  <TableCell className="font-mono text-xs font-medium">{r.user}</TableCell>
                  <TableCell className="text-xs">{r.device}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-[11px] text-muted-foreground" title={r.item}>
                    {r.item}
                  </TableCell>
                  <TableCell>{stateBadge(r.state)}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      {methodBadge(r.method)}
                      {r.method !== 'idle' ? (
                        <span className="max-w-44 truncate font-mono text-[10px] text-muted-foreground" title={r.methodDetail}>
                          {r.methodDetail}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtDate(r.startedAt)}</TableCell>
                  <TableCell className="text-right">
                    {r.state === 'playing' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busySession === r.id}
                        onClick={() => void toggle('pause', r)}
                        aria-label={`pause ${r.user}`}
                      >
                        <Pause className="h-3 w-3" aria-hidden /> pause
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busySession === r.id}
                        onClick={() => void toggle('play', r)}
                        aria-label={`play ${r.user}`}
                        title="resume playback"
                      >
                        <Play className="h-3 w-3" aria-hidden /> play
                      </Button>
                    )}
                  </TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        <TabsContent value="items" className="mt-4">
          <PanelCard
            title="Library items"
            actions={
              <span className="flex items-center gap-2">
                <Select value={lib} onValueChange={setLib}>
                  <SelectTrigger size="sm" className="h-7 w-40 font-mono text-xs" aria-label="library">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {libRows.map((l) => (
                      <SelectItem key={l.name} value={l.name} className="font-mono text-xs">
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Mono>{itemRows.length} rows · {totalPlays} plays</Mono>
              </span>
            }
          >
            {items.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">loading items…</p>
            ) : (
              <DataTable
                rows={itemRows}
                headers={['Title', 'Year', 'Size', 'Plays', 'Added']}
                keyOf={(r) => r.id}
                maxH="26rem"
                empty={`no sample rows in ${lib}`}
                renderRow={(r) => (
                  <>
                    <TableCell className="font-mono text-xs font-medium">{r.title}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{r.year ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{r.sizeHuman}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">{r.playCount}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtDate(r.addedAt)}</TableCell>
                  </>
                )}
              />
            )}
          </PanelCard>
          <p className="mt-2 pb-2 text-xs text-muted-foreground">
            aggregate counts live in the bridge; item rows are a sample (up to 200 per library, honestly labeled).
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
