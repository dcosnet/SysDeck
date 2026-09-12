'use client'

// Packages panel — multi-backend package inventory (apt · pacman · dnf ·
// yum · zypper · apk · xbps · emerge · lunar · sorcery) with server-side
// search, pagination, upgradable list, repository search and
// single-package lookup. Mutations run the real package manager when the
// console has privilege (root / sudo -n) and otherwise fail honestly
// with the exact operator command — every attempt lands in the audit log.

import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, ArrowUpCircle, Database, Package, PackageCheck, Search, ShieldCheck, Trash2 } from 'lucide-react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TableCell } from '@/components/ui/table'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface PackagesSummary {
  manager: string
  family: string
  distro: string
  installed: number
  upgradable: number | null
  lastInstall: string | null
  dbSizeKb: number | null
  dbPath: string
  privileged: boolean
}

interface PkgRow {
  name: string
  version: string
  installed: boolean
}

interface PkgList {
  total: number
  offset: number
  limit: number
  packages: PkgRow[]
}

interface PkgInfo {
  name: string
  version: string
  status: string
  depends: string
  description: string
  maintainer: string
}

interface UpdateRow {
  name: string
  current: string
  candidate: string
}

interface SearchRow {
  name: string
  version: string
  description: string
  installed: boolean
}

const PAGE_SIZE = 50

// ── shared action helper (real runs when privileged, honest denials) ─

function usePkgAction() {
  const action = useBridgeAction()
  return async (command: 'install' | 'remove' | 'update' | 'updateAll', name?: string) => {
    const res = await action('packages', command, name ? { name } : {})
    if (res.ok) {
      toast.success(`${command} ${name ?? 'all'} completed`, {
        description: (res.data as { command?: string; via?: string } | undefined)?.command,
        duration: 8000,
      })
    } else {
      toast.error(`${command} ${name ?? 'all'} failed`, {
        description: res.error ?? 'org.sysdeck.packages.manage — not authorized',
        duration: 8000,
      })
    }
    return res
  }
}

// ── installed tab ────────────────────────────────────────────────────

function InstalledTab({ manager }: { manager: string }) {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const pkgAction = usePkgAction()

  const list = useBridgeQuery<PkgList>('packages', 'list', { query: search, limit: PAGE_SIZE, offset })

  const data = list.data?.data
  const rows = data?.packages ?? []
  const from = data ? Math.min(offset + 1, data.total) : 0
  const to = data ? offset + rows.length : 0
  const hasPrev = offset > 0
  const hasNext = data ? offset + PAGE_SIZE < data.total : false

  function applySearch() {
    setSearch(input.trim())
    setOffset(0)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch()
            }}
            placeholder={`filter installed inventory… (Enter)`}
            className="pl-8 font-mono text-xs"
            aria-label="Filter installed packages"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" onClick={applySearch}>
          filter
        </Button>
        {search ? (
          <Button
            variant="ghost"
            size="sm"
            className="font-mono text-xs text-muted-foreground"
            onClick={() => {
              setInput('')
              setSearch('')
              setOffset(0)
            }}
          >
            clear
          </Button>
        ) : null}
      </div>

      <PanelCard
        title="Installed packages"
        actions={
          <div className="flex items-center gap-2">
            <Mono>
              {list.isLoading ? 'loading…' : `${from}–${to} of ${data?.total ?? '—'}`}
            </Mono>
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              disabled={!hasPrev}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              aria-label="Previous page"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              disabled={!hasNext}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              aria-label="Next page"
            >
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        }
      >
        <DataTable
          rows={rows}
          headers={['Package', 'Version', 'Status', '']}
          keyOf={(r) => r.name}
          maxH="30rem"
          empty={list.isLoading ? 'loading…' : 'no packages match'}
          renderRow={(r) => (
            <>
              <TableCell className="font-mono text-xs font-medium">{r.name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{r.version}</TableCell>
              <TableCell>
                {r.installed ? (
                  <Badge variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-400">
                    installed
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-500/30 font-mono text-[10px] text-zinc-400">
                    {r.installed === false ? 'config-files' : '—'}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-red-400"
                  onClick={() => setRemoveTarget(r.name)}
                  aria-label={`Remove ${r.name}`}
                  title={`${manager} remove ${r.name} — runs the real manager when privileged`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                  remove
                </Button>
              </TableCell>
            </>
          )}
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          {manager} installed-list cached 60s server-side · remove runs the real manager (root / sudo -n) and is audited either way
        </p>
      </PanelCard>

      {/* destructive actions confirm — one pattern across every panel */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">remove {removeTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              This runs <span className="font-mono">{manager} remove {removeTarget}</span> through the privilege chain
              (root / sudo -n) — configuration files stay unless the manager purges them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                if (removeTarget) void pkgAction('remove', removeTarget)
                setRemoveTarget(null)
              }}
            >
              Remove package
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── updates tab ──────────────────────────────────────────────────────

function UpdatesTab({ manager, privileged }: { manager: string; privileged: boolean }) {
  const q = useBridgeQuery<{ updates: UpdateRow[]; count: number }>('packages', 'updates')
  const pkgAction = usePkgAction()
  const [busyAll, setBusyAll] = useState(false)
  const data = q.data?.data

  if (q.isLoading && !q.data) return <PanelSkeleton lines={1} />
  if (q.data && !q.data.ok) {
    return <ErrorCard error={q.data.error ?? 'packages.updates failed'} />
  }

  async function updateAll() {
    setBusyAll(true)
    try {
      await pkgAction('updateAll')
    } finally {
      setBusyAll(false)
    }
  }

  return (
    <PanelCard
      title="Upgradable packages"
      actions={
        <div className="flex items-center gap-2">
          <Mono>{data?.count ?? 0} candidates</Mono>
          {data && data.count > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 font-mono text-[11px]"
              disabled={busyAll}
              onClick={() => void updateAll()}
              title={privileged ? `run the real system upgrade` : 'will be denied — console is unprivileged'}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden />
              {busyAll ? 'running…' : 'update all'}
            </Button>
          ) : null}
        </div>
      }
    >
      <DataTable
        rows={data?.updates ?? []}
        headers={['Package', 'Installed', 'Candidate', '']}
        keyOf={(r) => r.name}
        maxH="24rem"
        empty={`no upgradable packages — ${manager} databases are current`}
        renderRow={(r) => (
          <>
            <TableCell className="font-mono text-xs font-medium">{r.name}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{r.current || '(current)'}</TableCell>
            <TableCell className="font-mono text-xs text-emerald-400">{r.candidate}</TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-primary"
                onClick={() => void pkgAction('update', r.name)}
                aria-label={`Upgrade ${r.name}`}
                title={`${manager} upgrade ${r.name} — runs the real manager when privileged`}
              >
                <ArrowUpCircle className="h-3 w-3" aria-hidden />
                upgrade
              </Button>
            </TableCell>
          </>
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        candidates come from the real {manager} update query; the actual upgrade{' '}
        {privileged ? (
          <>runs with the console&apos;s privilege and streams the manager&apos;s own result</>
        ) : (
          <>requires root — the console runs unprivileged, and every attempt is denied honestly and audited</>
        )}
        .
      </p>
    </PanelCard>
  )
}

// ── repo search tab ──────────────────────────────────────────────────

function SearchTab({ manager }: { manager: string }) {
  const [input, setInput] = useState('')
  const [term, setTerm] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const pkgAction = usePkgAction()

  const q = useBridgeQuery<{ results: SearchRow[]; count: number }>('packages', 'search', { term }, { enabled: term.length > 0 })
  const data = q.data?.data
  const rows = data?.results ?? []

  async function install(name: string) {
    setBusy(name)
    try {
      await pkgAction('install', name)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setTerm(input.trim())
            }}
            placeholder={`search repositories… (Enter)`}
            className="pl-8 font-mono text-xs"
            aria-label="Search package repositories"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" onClick={() => setTerm(input.trim())}>
          search
        </Button>
      </div>

      {term && (q.isLoading || q.data) ? (
        q.isLoading && !q.data ? (
          <PanelSkeleton lines={1} />
        ) : q.data && !q.data.ok ? (
          <ErrorCard error={q.data.error ?? `repository search failed: ${term}`} />
        ) : (
          <PanelCard
            title="Repository results"
            actions={<Mono>{data?.count ?? 0} matches</Mono>}
          >
            <DataTable
              rows={rows}
              headers={['Package', 'Version', 'Description', '']}
              keyOf={(r) => `${r.name}-${r.version}`}
              maxH="24rem"
              empty={`no repository matches for "${term}"`}
              renderRow={(r) => (
                <>
                  <TableCell className="font-mono text-xs font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.version || '—'}</TableCell>
                  <TableCell className="max-w-72 truncate text-xs text-muted-foreground">{r.description || '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-primary"
                      disabled={busy !== null}
                      onClick={() => void install(r.name)}
                      aria-label={`Install ${r.name}`}
                      title={`${manager} install ${r.name} — runs the real manager when privileged`}
                    >
                      <Package className="h-3 w-3" aria-hidden />
                      {busy === r.name ? 'installing…' : 'install'}
                    </Button>
                  </TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              live {manager} repository search — results come straight from the package manager, nothing is cached or fabricated
            </p>
          </PanelCard>
        )
      ) : null}
    </div>
  )
}

// ── lookup tab ───────────────────────────────────────────────────────

function LookupTab({ manager }: { manager: string }) {
  const [input, setInput] = useState('curl')
  const [name, setName] = useState('curl')
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const pkgAction = usePkgAction()

  const info = useBridgeQuery<PkgInfo>('packages', 'info', { name }, { enabled: name.length > 0 })
  const d = info.data?.data

  async function run(command: 'install' | 'remove') {
    setBusy(command)
    try {
      await pkgAction(command, name)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setName(input.trim())
            }}
            placeholder="package name… (Enter)"
            className="pl-8 font-mono text-xs"
            aria-label="Package name to look up"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" onClick={() => setName(input.trim())}>
          lookup
        </Button>
      </div>

      {info.isLoading && !info.data ? (
        <PanelSkeleton lines={1} />
      ) : info.data && !info.data.ok ? (
        <ErrorCard error={info.data.error ?? `package not found: ${name}`} />
      ) : d ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <PanelCard title={`${manager} info`} className="lg:col-span-2">
            <div>
              <KV k="package" v={d.name} />
              <KV k="version" v={d.version} />
              <KV k="status" v={d.status} />
              <KV k="maintainer" v={d.maintainer} />
              <KV k="depends" v={<span className="break-all text-[11px]">{d.depends || '—'}</span>} />
              <div className="border-b border-border/50 py-1.5 last:border-0">
                <p className="text-xs text-muted-foreground">description</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{d.description || '—'}</p>
              </div>
            </div>
          </PanelCard>

          <PanelCard title="Operations">
            <p className="text-sm text-muted-foreground">
              The cockpit edition channeled these through polkit superuser sessions. The web console runs the{' '}
              <span className="text-foreground">real {manager} command</span> when it holds privilege (root or sudo -n) —
              otherwise the attempt is denied honestly and audited.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                className="gap-2 font-mono text-xs"
                disabled={busy !== null}
                onClick={() => void run('install')}
              >
                <Package className="h-3.5 w-3.5" aria-hidden />
                {busy === 'install' ? 'running…' : `${manager} install ${d.name}`}
              </Button>
              <Button
                variant="outline"
                className="gap-2 font-mono text-xs"
                disabled={busy !== null}
                onClick={() => setRemoveTarget(d.name)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {busy === 'remove' ? 'running…' : `${manager} remove ${d.name}`}
              </Button>
            </div>
            <p className="mt-3 font-mono text-[10px] text-muted-foreground">
              action id: org.sysdeck.packages.manage
            </p>
          </PanelCard>
        </div>
      ) : null}

      {/* destructive actions confirm — one pattern across every panel */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">remove {removeTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              This runs <span className="font-mono">{manager} remove {removeTarget}</span> through the privilege chain
              (root / sudo -n) — configuration files stay unless the manager purges them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                if (removeTarget) void pkgAction('remove', removeTarget)
                setRemoveTarget(null)
              }}
            >
              Remove package
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function PackagesPanel() {
  const summary = useBridgeQuery<PackagesSummary>('packages', 'summary')
  const s = summary.data?.data

  if (summary.isLoading && !summary.data) return <PanelSkeleton lines={3} />
  if (summary.data && !summary.data.ok) return <ErrorCard error={summary.data.error ?? 'packages.summary failed'} />

  const dbMb = s?.dbSizeKb != null ? (s.dbSizeKb / 1024).toFixed(1) : null
  const lastInstall = s?.lastInstall ?? null
  const manager = s?.manager ?? '—'

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Packages"
        subtitle={`package inventory, repository search, updates and operations via ${manager} (${s?.family ?? ''}) — every action honestly reported`}
        source="live"
        actions={
          <div className="flex items-center gap-1.5">
            {s?.distro ? (
              <Badge variant="outline" className="hidden max-w-56 truncate font-mono text-[10px] text-muted-foreground sm:inline-flex">
                {s.distro}
              </Badge>
            ) : null}
            <Badge variant="outline" className="font-mono text-[10px]">{manager}</Badge>
          </div>
        }
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Installed" value={s?.installed ?? '—'} icon={<Package className="h-4 w-4" aria-hidden />} hint={`${manager} installed query`} />
        <StatCard
          label="Upgradable"
          value={s?.upgradable ?? '—'}
          icon={<PackageCheck className="h-4 w-4" aria-hidden />}
          tone={s?.upgradable ? 'warn' : 'default'}
          hint={s?.upgradable == null ? 'update preview unavailable on this backend' : `${manager} update query`}
        />
        <StatCard
          label="package database"
          value={dbMb ?? '—'}
          unit={dbMb ? 'MB' : ''}
          icon={<Database className="h-4 w-4" aria-hidden />}
          hint={s?.dbPath ?? manager}
        />
        <StatCard
          label="Last install"
          value={lastInstall ? lastInstall.slice(5, 16).replace('T', ' ') : '—'}
          hint={s?.privileged ? 'console privileged — mutations execute for real' : 'unprivileged — mutations denied honestly'}
          icon={s?.privileged ? <ShieldCheck className="h-4 w-4" aria-hidden /> : undefined}
        />
      </div>

      <Tabs defaultValue="installed">
        <TabsList className="flex-wrap">
          <TabsTrigger value="installed">installed</TabsTrigger>
          <TabsTrigger value="updates">updates</TabsTrigger>
          <TabsTrigger value="search">repo search</TabsTrigger>
          <TabsTrigger value="lookup">info lookup</TabsTrigger>
        </TabsList>
        <TabsContent value="installed" className="mt-4">
          <InstalledTab manager={manager} />
        </TabsContent>
        <TabsContent value="updates" className="mt-4">
          <UpdatesTab manager={manager} privileged={s?.privileged ?? false} />
        </TabsContent>
        <TabsContent value="search" className="mt-4">
          <SearchTab manager={manager} />
        </TabsContent>
        <TabsContent value="lookup" className="mt-4">
          <LookupTab manager={manager} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
