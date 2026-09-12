'use client'

// Modules panel — the 3rd-party cockpit-module installer with INLINE
// license disclosure (the v0.0.46 QA requirement): license, author,
// source and homepage are visible on the card BEFORE the install click —
// no modal. The Install button itself is the acceptance gesture: it calls
// install {id, acceptLicense: true} (the bridge refuses without it).
// Installs are REAL: the host package manager, git clone --depth 1, or
// curl + extraction into a cockpit scan root; depends[] checks are real
// which() probes.

import { useState } from 'react'
import { toast } from 'sonner'
import { BadgeCheck, ExternalLink, Package, Store, Trash2, User } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  ErrorCard,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
  StateBadge,
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
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── bridge shapes ────────────────────────────────────────────────────

interface CatalogEntry {
  id: string
  name: string
  description: string
  license: string
  author: string
  source: string
  homepage: string
  category: string
  kind: string
  depends: string[]
  installed: boolean
}

// ── license terms (the inline disclosure) ────────────────────────────

const LICENSE_TERMS: Record<string, string> = {
  'LGPL-2.1':
    'weak copyleft — proprietary code may link against it; modifications to the module itself must be republished under LGPL-2.1',
  'GPL-3.0':
    'strong copyleft — derivatives must be distributed under GPL-3.0 with complete corresponding source',
  'GPL-2.0': 'strong copyleft — derivatives must be distributed under GPL-2.0 with source',
  MIT: 'permissive — keep the copyright notice, do anything else',
  'Apache-2.0': 'permissive with patent grant — keep notices, state changes',
  'AGPL-3.0': 'network copyleft — serving it over a network counts as distribution',
  'BSD-3-Clause': 'permissive — no endorsement of derived works',
  'BSD-2-Clause': 'permissive — keep the copyright notice',
}

function licenseBadge(license: string) {
  const terms = LICENSE_TERMS[license] ?? 'review the license text at the source repository'
  const copyleft = license.startsWith('GPL') || license.startsWith('LGPL') || license.startsWith('AGPL')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`cursor-help rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
              copyleft
                ? 'border-amber-500/30 bg-amber-500/15 text-amber-500'
                : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400'
            }`}
            aria-label={`license ${license} — ${terms}`}
          >
            {license}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 font-mono text-[11px] leading-relaxed">
          {license}: {terms}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function ModulesPanel() {
  const catalog = useBridgeQuery<{ entries: CatalogEntry[]; count: number; installedCount: number }>('modules', 'catalog', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()

  const [busyId, setBusyId] = useState<string | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<CatalogEntry | null>(null)

  async function install(entry: CatalogEntry) {
    setBusyId(entry.id)
    try {
      const res = await action('modules', 'install', { id: entry.id, acceptLicense: true })
      if (res.ok) {
        const d = res.data as { status?: string; missingDeps?: string[]; command?: string }
        if (d.status === 'already-installed') {
          toast.info(`${entry.name} is already installed`)
        } else {
          toast.success(`installed ${entry.name}`, {
            description:
              d.missingDeps && d.missingDeps.length > 0
                ? `${d.command ?? 'real install'} — missing deps: ${d.missingDeps.join(', ')}`
                : (d.command ?? 'real install'),
          })
        }
      } else {
        toast.error(`install ${entry.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  async function doUninstall() {
    const entry = uninstallTarget
    if (!entry) return
    setUninstallTarget(null)
    setBusyId(entry.id)
    try {
      const res = await action('modules', 'uninstall', { id: entry.id })
      if (res.ok) {
        const d = res.data as { status?: string }
        if (d.status === 'not-installed') {
          toast.info(`${entry.name} was not installed`)
        } else {
          toast.success(`removed ${entry.name}`)
        }
      } else {
        toast.error(`uninstall ${entry.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (catalog.isLoading) {
    return (
      <div>
        <PanelHeader title="Modules" subtitle="3rd-party module installer — with inline license disclosure" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!catalog.data?.ok || !catalog.data.data) {
    return (
      <div>
        <PanelHeader title="Modules" subtitle="3rd-party module installer — with inline license disclosure" />
        <ErrorCard error={catalog.data?.error ?? 'modules.catalog failed'} />
      </div>
    )
  }

  const entries = catalog.data.data.entries
  const installedCount = catalog.data.data.installedCount

  return (
    <div>
      <PanelHeader
        title="Modules"
        subtitle="3rd-party module installer — license, author, source and homepage are disclosed inline BEFORE the install click"
        source={catalog.data?.source ?? 'live'}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="catalog entries" value={entries.length} icon={<Store className="h-4 w-4" aria-hidden />} hint="ported verbatim from the cockpit-modules registry" />
        <StatCard label="installed" value={installedCount} tone={installedCount > 0 ? 'good' : 'default'} icon={<Package className="h-4 w-4" aria-hidden />} hint={`${entries.length - installedCount} available`} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((e) => (
          <PanelCard
            key={e.id}
            title={
              <span className="flex flex-wrap items-center gap-2 normal-case">
                <span className="text-sm font-semibold text-foreground">{e.name}</span>
                <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground">
                  {e.category}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">{e.kind}</span>
              </span>
            }
            actions={e.installed ? <StateBadge state="installed" /> : <StateBadge state="uninstalled" />}
            contentClassName="flex h-full flex-col space-y-3"
            className="flex flex-col"
          >
            <p className="text-sm leading-relaxed text-muted-foreground">{e.description}</p>

            {/* the v0.0.46 inline license disclosure — everything is here,
                above the Install button, never behind a modal */}
            <div className="grid grid-cols-1 gap-1.5 rounded border border-border/60 bg-muted/30 p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">license</span>
                {licenseBadge(e.license)}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">author</span>
                <span className="flex items-center gap-1 font-mono text-foreground">
                  <User className="h-3 w-3 text-muted-foreground" aria-hidden />
                  {e.author}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">source</span>
                <a
                  href={e.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-sky-400 hover:underline"
                  title={e.source}
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                  {e.source.replace(/^https?:\/\//, '')}
                </a>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">homepage</span>
                <a
                  href={e.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 truncate font-mono text-[11px] text-sky-400 hover:underline"
                  title={e.homepage}
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                  {e.homepage.replace(/^https?:\/\//, '')}
                </a>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">requires</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {e.depends.length > 0 ? e.depends.join(', ') : 'nothing'}
                </span>
              </div>
            </div>

            <div className="mt-auto space-y-1.5">
              {e.installed ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-full gap-1.5 font-mono text-xs text-red-400 hover:text-red-300"
                  disabled={busyId === e.id}
                  onClick={() => setUninstallTarget(e)}
                  aria-label={`uninstall ${e.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> uninstall
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 w-full gap-1.5 font-mono text-xs"
                  disabled={busyId === e.id}
                  onClick={() => void install(e)}
                  aria-label={`install ${e.name} accepting the ${e.license} license`}
                >
                  {busyId === e.id ? (
                    'installing…'
                  ) : (
                    <>
                      <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> install
                    </>
                  )}
                </Button>
              )}
              <p className="text-center font-mono text-[10px] leading-relaxed text-muted-foreground">
                {e.installed
                  ? 'installed on this host — remove via the registry'
                  : 'clicking install accepts the license disclosed above'}
              </p>
            </div>
          </PanelCard>
        ))}
      </div>

      <p className="mt-4 pb-2 text-xs text-muted-foreground">
        catalog values are ported verbatim from the cockpit-modules registry; installs are real (host package manager,
        git clone, or curl + extraction) and the <Mono>depends[]</Mono> checks are real <Mono>which()</Mono> probes — a
        missing dep is reported by the install result instead of blocking it.
        refuses installs without <Mono>acceptLicense: true</Mono>; this UI never opens a license modal — the disclosure
        lives inline on the card, next to the button.
      </p>

      <AlertDialog open={uninstallTarget !== null} onOpenChange={(o) => !o && setUninstallTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">uninstall {uninstallTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the module from the local registry ({uninstallTarget?.license} — your license obligations for
              already-obtained copies are unaffected). depends[] probes re-run on the next install.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-500" onClick={() => void doUninstall()}>
              uninstall module
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
