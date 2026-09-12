'use client'

// Builder panel — the image-builder workbench (mkosi / vmdb2 / archiso /
// live-build). Builds run the backend's REAL command (mkosi build /
// mkarchiso / lb / vmdb2) against a synthesized profile; a host without
// any backend gets an honest refusal. importHostPackages reads the
// host's REAL package database via the packages bridge. Profiles are a
// Prisma registry; every mutation is audited.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Boxes, Copy, Download, FileArchive, Hammer, PackagePlus, Play, Trash2 } from 'lucide-react'
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
  StateBadge,
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableCell } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

// ── bridge shapes ────────────────────────────────────────────────────

interface SdProfile {
  id: string
  name: string
  backend: string
  base: string | null
  packages: string[]
  createdAt: string
  updatedAt: string
  packageCount: number
}

interface SdArtifact {
  id: string
  buildId: string
  path: string
  sizeBytes: number
  createdAt: string
  state?: string
}

interface SdBuild {
  id: string
  buildId: string
  profile: string
  backend: string
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  rc: number
  durationMs: number
  log: string
  startedAt: string
  finishedAt: string | null
  artifacts: SdArtifact[]
}

// ── helpers ──────────────────────────────────────────────────────────

const BACKEND_CLS: Record<string, string> = {
  mkosi: 'border-teal-500/30 bg-teal-500/15 text-teal-400',
  vmdb2: 'border-sky-500/30 bg-sky-500/15 text-sky-400',
  archiso: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  'live-build': 'border-amber-500/30 bg-amber-500/15 text-amber-500',
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

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function fmtDate(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ')
}

// ── panel ────────────────────────────────────────────────────────────

export default function BuilderPanel() {
  const summary = useBridgeQuery<{ profiles: number; builds: number; backendsInstalled: string[] }>('builder', 'summary')
  const profiles = useBridgeQuery<{ profiles: SdProfile[]; count: number }>('builder', 'profiles')
  const action = useBridgeAction()

  const [tab, setTab] = useState('profiles')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)

  // create form
  const [newName, setNewName] = useState('')
  const [newBackend, setNewBackend] = useState('mkosi')
  const [newPackages, setNewPackages] = useState('')
  const [creating, setCreating] = useState(false)

  // copy dialog
  const [copySrc, setCopySrc] = useState<SdProfile | null>(null)
  const [copyName, setCopyName] = useState('')
  const [copying, setCopying] = useState(false)

  // import dialog
  const [importTarget, setImportTarget] = useState<SdProfile | null>(null)
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append')
  const [importing, setImporting] = useState(false)

  // delete dialog
  const [deleteTarget, setDeleteTarget] = useState<SdProfile | null>(null)

  // artifact dialog
  const [artifactRecord, setArtifactRecord] = useState<SdArtifact | null>(null)
  const [artifactProfile, setArtifactProfile] = useState('myarch')
  const [clearTarget, setClearTarget] = useState<string | null>(null)

  const buildsActive = useMemo(() => {
    // poll faster while a build is in flight (queued/running)
    return tab === 'builds' ? 5000 : 20000
  }, [tab])

  const builds = useBridgeQuery<{ builds: SdBuild[]; count: number }>('builder', 'builds', {}, { refetchInterval: buildsActive })
  const anyRunning = (builds.data?.data?.builds ?? []).some((b) => b.state === 'running' || b.state === 'queued')
  const artifacts = useBridgeQuery<{ profile: string; artifacts: SdArtifact[]; count?: number; builds: number }>(
    'builder',
    'artifacts',
    { profile: artifactProfile },
    { refetchInterval: anyRunning ? 5000 : 20000, enabled: tab === 'artifacts' },
  )

  async function runBuild(p: SdProfile) {
    setBusyName(p.name)
    try {
      const res = await action('builder', 'build', { profile: p.name })
      if (res.ok) {
        const d = res.data as { buildId?: string; state?: string; build?: SdBuild }
        toast.success(`build started: ${p.name}`, {
          description: `${d.buildId ?? ''} → ${d.state ?? 'succeeded'} in ${fmtDuration(d.build?.durationMs ?? 0)} — see the Builds tab`,
        })
        setTab('builds')
      } else {
        toast.error(`build ${p.name} failed`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyName(null)
    }
  }

  async function doImport() {
    const p = importTarget
    if (!p) return
    setImporting(true)
    try {
      const res = await action('builder', 'importHostPackages', { profile: p.name, mode: importMode })
      if (res.ok) {
        const d = res.data as { count?: number }
        toast.success(`${d.count ?? 0} packages imported from dpkg`, {
          description: `${p.name} (${importMode}) — REAL dpkg-query read, capped at 300 stored names`,
        })
        setImportTarget(null)
      } else {
        toast.error(`import into ${p.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setImporting(false)
    }
  }

  async function doCopy() {
    const src = copySrc
    if (!src || !copyName.trim()) return
    setCopying(true)
    try {
      const res = await action('builder', 'copy', { src: src.name, name: copyName.trim() })
      if (res.ok) {
        toast.success(`copied ${src.name} → ${copyName.trim()}`, {
          description: `${src.packageCount} packages duplicated`,
        })
        setCopySrc(null)
        setCopyName('')
      } else {
        toast.error(`copy refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setCopying(false)
    }
  }

  async function doCreate() {
    const name = newName.trim()
    if (!name) {
      toast.error('profile name is required')
      return
    }
    const pkgs = newPackages
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    setCreating(true)
    try {
      const res = await action('builder', 'create', {
        name,
        backend: newBackend,
        packages: pkgs,
      })
      if (res.ok) {
        toast.success(`profile created: ${name}`, {
          description: `${newBackend} · ${pkgs.length} packages`,
        })
        setNewName('')
        setNewPackages('')
      } else {
        toast.error('create refused', { description: res.error, duration: 8000 })
      }
    } finally {
      setCreating(false)
    }
  }

  async function doDelete() {
    const p = deleteTarget
    if (!p) return
    setDeleteTarget(null)
    setBusyName(p.name)
    try {
      const res = await action('builder', 'delete', { name: p.name })
      if (res.ok) {
        const d = res.data as { deleted?: { builds?: number } }
        toast.success(`deleted ${p.name}`, {
          description: `cascade: ${d.deleted?.builds ?? 0} builds + their artifacts`,
        })
        if (artifactProfile === p.name) setArtifactProfile('myarch')
      } else {
        toast.error(`delete ${p.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyName(null)
    }
  }

  async function cancelBuild(buildId: string) {
    const res = await action('builder', 'cancel', { buildId })
    if (res.ok) {
      toast.warning(`cancelled ${buildId}`, {
        description: `state → failed (rc 130) — the schema has no 'cancelled' state, artifacts dropped`,
      })
    } else {
      toast.error(`cancel refused`, { description: res.error, duration: 8000 })
    }
  }

  async function deleteArtifact(id: string) {
    const res = await action('builder', 'deleteArtifact', { id })
    if (res.ok) {
      toast.success('artifact deleted')
    } else {
      toast.error('deleteArtifact refused', { description: res.error, duration: 8000 })
    }
  }

  async function doClearArtifacts() {
    const profile = clearTarget
    if (!profile) return
    setClearTarget(null)
    const res = await action('builder', 'clearArtifacts', { profile })
    if (res.ok) {
      toast.success(`cleared all artifacts of ${profile}`)
    } else {
      toast.error('clearArtifacts refused', { description: res.error, duration: 8000 })
    }
  }

  if (summary.isLoading || profiles.isLoading) {
    return (
      <div>
        <PanelHeader title="Builder" subtitle="image-builder workbench — mkosi · vmdb2 · archiso · live-build" source="hybrid" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Builder" subtitle="image-builder workbench — mkosi · vmdb2 · archiso · live-build" source="hybrid" />
        <ErrorCard error={summary.data?.error ?? 'builder.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const profileRows = profiles.data?.data?.profiles ?? []
  const buildRows = builds.data?.data?.builds ?? []
  const artifactRows = artifacts.data?.data?.artifacts ?? []

  return (
    <div>
      <PanelHeader
        title="Builder"
        subtitle="image-builder workbench — profiles · builds · artifacts · dpkg import is REAL"
        source="hybrid"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="profiles" value={s.profiles} icon={<Boxes className="h-4 w-4" aria-hidden />} />
        <StatCard label="builds" value={s.builds} icon={<Hammer className="h-4 w-4" aria-hidden />} hint={anyRunning ? 'build in flight' : 'none running'} />
        <StatCard
          label="backends installed"
          value={s.backendsInstalled.length}
          tone={s.backendsInstalled.length > 0 ? 'good' : 'warn'}
          icon={<FileArchive className="h-4 w-4" aria-hidden />}
          hint={s.backendsInstalled.length > 0 ? s.backendsInstalled.join(' · ') : 'none — build commands are refused until one is installed'}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="profiles" className="gap-1.5 font-mono text-xs">
            profiles <span className="text-muted-foreground">{profileRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="builds" className="gap-1.5 font-mono text-xs">
            builds <span className="text-muted-foreground">{buildRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="gap-1.5 font-mono text-xs">artifacts</TabsTrigger>
        </TabsList>

        {/* ── profiles ─────────────────────────────────────────────── */}
        <TabsContent value="profiles" className="mt-4 space-y-4">
          <PanelCard title="Create profile" actions={<Mono>builder create</Mono>}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sd-name" className="text-xs">name</Label>
                  <Input
                    id="sd-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="mydistro"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">backend</Label>
                  <Select value={newBackend} onValueChange={setNewBackend}>
                    <SelectTrigger className="w-40 font-mono text-xs" aria-label="backend">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['mkosi', 'vmdb2', 'archiso', 'live-build'].map((b) => (
                        <SelectItem key={b} value={b} className="font-mono text-xs">{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" onClick={() => void doCreate()} disabled={creating || !newName.trim()} className="gap-1.5 font-mono text-xs">
                  <PackagePlus className="h-3.5 w-3.5" aria-hidden />
                  {creating ? 'creating…' : 'create profile'}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sd-pkgs" className="text-xs">packages (one per line)</Label>
                <Textarea
                  id="sd-pkgs"
                  value={newPackages}
                  onChange={(e) => setNewPackages(e.target.value)}
                  placeholder={'linux\nsystemd\nopenssh\ndocker'}
                  className="h-28 font-mono text-xs"
                />
              </div>
            </div>
          </PanelCard>

          <PanelCard title="Profiles" actions={<Mono>click a row to expand the package list</Mono>}>
            <DataTable
              rows={profileRows}
              headers={['Name', 'Backend', 'Base', 'Packages', 'Created', '']}
              keyOf={(p) => p.id}
              maxH="26rem"
              renderRow={(p) => (
                <>
                  <TableCell className="font-mono text-xs font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setExpanded(expanded === p.name ? null : p.name)}
                      aria-label={`toggle package list of ${p.name}`}
                    >
                      {p.name} <span className="text-muted-foreground">{expanded === p.name ? '▾' : '▸'}</span>
                    </button>
                    {expanded === p.name ? (
                      <ScrollArea className="mt-2 h-36 w-72 rounded border border-border bg-zinc-950/80">
                        <pre className="p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                          {p.packages.join('\n') || '(no packages)'}
                          {p.packageCount > p.packages.length
                            ? `\n… ${p.packageCount - p.packages.length} more (first 20 stored in the list response)`
                            : ''}
                        </pre>
                      </ScrollArea>
                    ) : null}
                  </TableCell>
                  <TableCell>{backendBadge(p.backend)}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{p.base ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{p.packageCount}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtDate(p.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyName === p.name}
                        onClick={() => void runBuild(p)}
                        aria-label={`build ${p.name}`}
                      >
                        <Play className="h-3 w-3" aria-hidden /> build
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        disabled={busyName === p.name}
                        onClick={() => {
                          setImportTarget(p)
                          setImportMode('append')
                        }}
                        aria-label={`import host packages into ${p.name}`}
                      >
                        <PackagePlus className="h-3 w-3" aria-hidden /> import dpkg
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        onClick={() => {
                          setCopySrc(p)
                          setCopyName(`${p.name}-copy`)
                        }}
                        aria-label={`copy ${p.name}`}
                      >
                        <Copy className="h-3 w-3" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px] text-red-400 hover:text-red-300"
                        disabled={busyName === p.name}
                        onClick={() => setDeleteTarget(p)}
                        aria-label={`delete ${p.name}`}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        {/* ── builds ───────────────────────────────────────────────── */}
        <TabsContent value="builds" className="mt-4">
          <PanelCard
            title="Builds"
            actions={<Mono>{anyRunning ? '5s poll — build in flight' : '20s poll'}</Mono>}
          >
            <DataTable
              rows={buildRows}
              headers={['Build', 'Profile', 'Backend', 'State', 'RC', 'Duration', 'Artifacts', 'Finished', '']}
              keyOf={(b) => b.id}
              maxH="26rem"
              renderRow={(b) => (
                <>
                  <TableCell className="font-mono text-[11px]" title={b.buildId}>
                    <span className="block max-w-44 truncate">{b.buildId}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{b.profile}</TableCell>
                  <TableCell>{backendBadge(b.backend)}</TableCell>
                  <TableCell>
                    <StateBadge state={b.state} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    <span className={b.rc === 0 ? 'text-emerald-400' : b.rc === 130 ? 'text-amber-500' : 'text-red-400'}>{b.rc}</span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtDuration(b.durationMs)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{b.artifacts.length}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {b.finishedAt ? fmtDate(b.finishedAt) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {b.state === 'running' || b.state === 'queued' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px] text-amber-500 hover:text-amber-400"
                        onClick={() => void cancelBuild(b.buildId)}
                        aria-label={`cancel ${b.buildId}`}
                      >
                        cancel
                      </Button>
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </>
              )}
            />
            {buildRows.some((b) => b.state === 'failed' && b.rc === 130) ? (
              <p className="mt-2 text-xs text-muted-foreground">
                rc 130 = cancelled by operator (SIGINT); the schema has no separate &apos;cancelled&apos; state.
              </p>
            ) : null}
          </PanelCard>
        </TabsContent>

        {/* ── artifacts ────────────────────────────────────────────── */}
        <TabsContent value="artifacts" className="mt-4">
          <PanelCard
            title="Artifacts"
            actions={
              <span className="flex items-center gap-2">
                <Select value={artifactProfile} onValueChange={setArtifactProfile}>
                  <SelectTrigger size="sm" className="h-7 w-40 font-mono text-xs" aria-label="profile">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {profileRows.map((p) => (
                      <SelectItem key={p.id} value={p.name} className="font-mono text-xs">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 font-mono text-[11px] text-red-400 hover:text-red-300"
                  disabled={artifactRows.length === 0}
                  onClick={() => setClearTarget(artifactProfile)}
                  aria-label={`clear all artifacts of ${artifactProfile}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden /> clear all
                </Button>
              </span>
            }
          >
            {artifacts.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">loading artifacts…</p>
            ) : (
              <DataTable
                rows={artifactRows}
                headers={['Path', 'Size', 'Build', 'Created', '']}
                keyOf={(a) => a.id}
                maxH="26rem"
                empty={`no artifacts for ${artifactProfile} — run a build first`}
                renderRow={(a) => (
                  <>
                    <TableCell className="font-mono text-[11px]">{a.path}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{fmtBytes(a.sizeBytes)}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      <span className="block max-w-44 truncate" title={a.buildId}>
                        {a.buildId}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtDate(a.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 font-mono text-[11px]"
                          onClick={() => setArtifactRecord(a)}
                          aria-label={`view ${a.path} record`}
                          title="no real download — view the artifact record"
                        >
                          <Download className="h-3 w-3" aria-hidden /> record
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 font-mono text-[11px] text-red-400 hover:text-red-300"
                          onClick={() => void deleteArtifact(a.id)}
                          aria-label={`delete ${a.path}`}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </>
                )}
              />
            )}
          </PanelCard>
          <p className="mt-2 pb-2 text-xs text-muted-foreground">
            artifacts persist per profile after successful builds (mkosi → image.raw + rootfs.tar.xz; archiso/live-build →
            .iso) in the profile's build directory — the record dialog shows the stored entry.
          </p>
        </TabsContent>
      </Tabs>

      {/* import host packages — real dpkg read, destructive to the profile list */}
      <AlertDialog open={importTarget !== null} onOpenChange={(o) => !o && setImportTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">
              import host packages → {importTarget?.name}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This performs a <strong>REAL read of this host&apos;s package database</strong> (dpkg / pacman / rpm){' '}
                  and {importMode === 'replace' ? 'REPLACES' : 'appends to'} the profile&apos;s package list. The first 300
                  names are stored; the host total at import time is kept in SdKv.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">mode</span>
                  <Select value={importMode} onValueChange={(v) => setImportMode(v as 'append' | 'replace')}>
                    <SelectTrigger size="sm" className="h-7 w-32 font-mono text-xs" aria-label="import mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="append" className="font-mono text-xs">append</SelectItem>
                      <SelectItem value="replace" className="font-mono text-xs">replace</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doImport()} disabled={importing}>
              {importing ? 'importing…' : 'import from dpkg'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* copy dialog */}
      <Dialog open={copySrc !== null} onOpenChange={(o) => !o && setCopySrc(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono">
              copy profile — <span className="text-muted-foreground">{copySrc?.name}</span>
            </DialogTitle>
            <DialogDescription>duplicate the profile (backend + full package list)</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="copy-name" className="text-xs">new name</Label>
            <Input
              id="copy-name"
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setCopySrc(null)}>cancel</Button>
            <Button size="sm" onClick={() => void doCopy()} disabled={copying || !copyName.trim()}>
              {copying ? 'copying…' : 'copy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete profile */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Cascades: artifacts → builds → profile. The bridge refuses names with slashes or &apos;..&apos;; this action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-500" onClick={() => void doDelete()}>
              delete profile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* clear artifacts */}
      <AlertDialog open={clearTarget !== null} onOpenChange={(o) => !o && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">clear all artifacts of {clearTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes every stored artifact row for this profile. The builds themselves remain in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-500" onClick={() => void doClearArtifacts()}>
              clear artifacts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* artifact record dialog (the 'download' target) */}
      <Dialog open={artifactRecord !== null} onOpenChange={(o) => !o && setArtifactRecord(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>artifact record</DialogTitle>
            <DialogDescription>artifacts stay on the host in the profile&apos;s build directory — this is the stored record</DialogDescription>
          </DialogHeader>
          {artifactRecord ? (
            <div className="rounded border border-border bg-zinc-950/80 p-3">
              <KV k="path" v={artifactRecord.path} />
              <KV k="size" v={`${fmtBytes(artifactRecord.sizeBytes)} (${artifactRecord.sizeBytes.toLocaleString('en-US')} B)`} />
              <KV k="buildId" v={artifactRecord.buildId} />
              <KV k="createdAt" v={artifactRecord.createdAt} />
            </div>
          ) : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setArtifactRecord(null)}>close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
