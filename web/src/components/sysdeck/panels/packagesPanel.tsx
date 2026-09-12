'use client'

// Packages panel — dpkg/apt inventory with server-side search,
// pagination, upgradable list and single-package lookup. install/remove
// run through the bridge and fail honestly with the polkit denial —
// that IS the web edition's behavior (unprivileged sandbox, no root),
// so the error is surfaced clearly in the toast, and the attempt is
// recorded to the audit log (visible in summary.lastInstall).

import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, ArrowUpCircle, Database, Package, PackageCheck, Search, Trash2 } from 'lucide-react'
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
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface PackagesSummary {
  manager: string
  installed: number
  upgradable: number | null
  lastInstall: string | null
  dpkgDbSizeKb: number | null
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

const PAGE_SIZE = 50

// ── shared action helper (honest polkit denials) ─────────────────────

function usePkgAction() {
  const action = useBridgeAction()
  return async (command: 'install' | 'remove', name: string) => {
    const res = await action('packages', command, { name })
    if (res.ok) {
      // the bridge never reaches here unprivileged, but stay correct
      toast.success(`${command} ${name} completed`)
    } else {
      toast.error(`polkit denial — ${command} ${name} (expected in the unprivileged console sandbox)`, {
        description: res.error ?? 'org.sysdeck.packages.manage — not authorized',
        duration: 8000,
      })
    }
    return res
  }
}

// ── installed tab ────────────────────────────────────────────────────

function InstalledTab() {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
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
            placeholder="search dpkg inventory… (Enter)"
            className="pl-8 font-mono text-xs"
            aria-label="Search installed packages"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" onClick={applySearch}>
          search
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
                  onClick={() => void pkgAction('remove', r.name)}
                  aria-label={`Remove ${r.name}`}
                  title="remove — will be denied by polkit (unprivileged console)"
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                  remove
                </Button>
              </TableCell>
            </>
          )}
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          dpkg-query -W output cached 60s server-side · remove attempts are denied by polkit (org.sysdeck.packages.manage) and audited
        </p>
      </PanelCard>
    </div>
  )
}

// ── updates tab ──────────────────────────────────────────────────────

function UpdatesTab() {
  const q = useBridgeQuery<{ updates: UpdateRow[]; count: number }>('packages', 'updates')
  const pkgAction = usePkgAction()
  const data = q.data?.data

  if (q.isLoading && !q.data) return <PanelSkeleton lines={1} />
  if (q.data && !q.data.ok) {
    return (
      <ErrorCard error={q.data.error ?? 'packages.updates failed'} />
    )
  }

  return (
    <PanelCard title="Upgradable packages" actions={<Mono>{data?.count ?? 0} candidates</Mono>}>
      <DataTable
        rows={data?.updates ?? []}
        headers={['Package', 'Installed', 'Candidate', '']}
        keyOf={(r) => r.name}
        maxH="24rem"
        empty="no upgradable packages — apt cache is current"
        renderRow={(r) => (
          <>
            <TableCell className="font-mono text-xs font-medium">{r.name}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{r.current || '(not installed)'}</TableCell>
            <TableCell className="font-mono text-xs text-emerald-400">{r.candidate}</TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-primary"
                onClick={() => void pkgAction('install', r.name)}
                aria-label={`Upgrade ${r.name}`}
                title="apt upgrade — will be denied by polkit (unprivileged console)"
              >
                <ArrowUpCircle className="h-3 w-3" aria-hidden />
                upgrade
              </Button>
            </TableCell>
          </>
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        candidates come from <span className="font-mono">apt list --upgradable</span>; the actual upgrade requires root — the
        web edition runs unprivileged and the polkit denial is shown honestly on every attempt.
      </p>
    </PanelCard>
  )
}

// ── lookup tab ───────────────────────────────────────────────────────

function LookupTab() {
  const [input, setInput] = useState('curl')
  const [name, setName] = useState('curl')
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
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
          <PanelCard title="dpkg-query -s" className="lg:col-span-2">
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
              The cockpit edition channeled these through polkit superuser sessions. The web edition runs unprivileged —
              attempts are <span className="text-foreground">denied and audited</span>, which is the honest expected behavior.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                className="gap-2 font-mono text-xs"
                disabled={busy !== null}
                onClick={() => void run('install')}
              >
                <Package className="h-3.5 w-3.5" aria-hidden />
                {busy === 'install' ? 'attempting…' : `apt install ${d.name}`}
              </Button>
              <Button
                variant="outline"
                className="gap-2 font-mono text-xs"
                disabled={busy !== null}
                onClick={() => void run('remove')}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {busy === 'remove' ? 'attempting…' : `apt remove ${d.name}`}
              </Button>
            </div>
            <p className="mt-3 font-mono text-[10px] text-muted-foreground">
              action id: org.sysdeck.packages.manage
            </p>
          </PanelCard>
        </div>
      ) : null}
    </div>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function PackagesPanel() {
  const summary = useBridgeQuery<PackagesSummary>('packages', 'summary')
  const s = summary.data?.data

  if (summary.isLoading && !summary.data) return <PanelSkeleton lines={3} />
  if (summary.data && !summary.data.ok) return <ErrorCard error={summary.data.error ?? 'packages.summary failed'} />

  const dbMb = s?.dpkgDbSizeKb != null ? (s.dpkgDbSizeKb / 1024).toFixed(1) : null
  const lastInstall = s?.lastInstall ?? null

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Packages"
        subtitle="package inventory, updates and operations via dpkg/apt — every action honestly reported"
        source="live"
        actions={<Badge variant="outline" className="font-mono text-[10px]">{s?.manager ?? 'apt'}</Badge>}
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Installed" value={s?.installed ?? '—'} icon={<Package className="h-4 w-4" aria-hidden />} hint="dpkg-query -W" />
        <StatCard
          label="Upgradable"
          value={s?.upgradable ?? '—'}
          icon={<PackageCheck className="h-4 w-4" aria-hidden />}
          tone={s?.upgradable ? 'warn' : 'default'}
          hint={s?.upgradable == null ? 'apt cache unavailable' : 'apt list --upgradable'}
        />
        <StatCard
          label="dpkg database"
          value={dbMb ?? '—'}
          unit={dbMb ? 'MB' : ''}
          icon={<Database className="h-4 w-4" aria-hidden />}
          hint="/var/lib/dpkg"
        />
        <StatCard
          label="Last install"
          value={lastInstall ? lastInstall.slice(5, 16).replace('T', ' ') : '—'}
          hint={lastInstall ?? 'no install recorded'}
        />
      </div>

      <Tabs defaultValue="installed">
        <TabsList className="flex-wrap">
          <TabsTrigger value="installed">installed</TabsTrigger>
          <TabsTrigger value="updates">updates</TabsTrigger>
          <TabsTrigger value="lookup">info lookup</TabsTrigger>
        </TabsList>
        <TabsContent value="installed" className="mt-4">
          <InstalledTab />
        </TabsContent>
        <TabsContent value="updates" className="mt-4">
          <UpdatesTab />
        </TabsContent>
        <TabsContent value="lookup" className="mt-4">
          <LookupTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
