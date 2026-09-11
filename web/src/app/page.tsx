'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { PANEL_MAP } from '@/components/sysdeck/panels-map'
import { MODULE_MAP, GROUP_LABELS, modulesByGroup, SYSDECK_VERSION } from '@/lib/sysdeck/registry'
import { bridgeCall, useBridgeQuery } from '@/lib/sysdeck/client'
import type { HostTicker } from '@/lib/sysdeck/types'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Toaster } from '@/components/ui/sonner'
import { PanelSkeleton } from '@/components/sysdeck/ui'
import { cn } from '@/lib/utils'
import {
  Activity,
  ArrowDownToLine,
  Boxes,
  Cpu,
  Database,
  Flame,
  Gauge,
  HardDrive,
  LayoutDashboard,
  MemoryStick,
  Menu,
  Moon,
  Network,
  Palette,
  Server,
  Shield,
  Terminal,
  Waves,
  type LucideIcon,
} from 'lucide-react'

const GROUP_ICONS: Record<string, LucideIcon> = {
  system: Gauge,
  security: Shield,
  compute: Boxes,
  build: Terminal,
  media: Palette,
  integrations: Activity,
}

const MODULE_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  glances: Activity,
  sensors: Flame,
  fleet: Server,
  services: Network,
  packages: Boxes,
  benchmark: Gauge,
  firmware: HardDrive,
  themes: Palette,
  firewall: Shield,
  netsec: Network,
  integrity: Shield,
  vault: Database,
  auth: HardDrive,
  hwalert: Shield,
  policy: Shield,
  containers: Boxes,
  mesh: Network,
  kata: Boxes,
  remotefs: HardDrive,
  db: Database,
  fester: Terminal,
  builder: HardDrive,
  mining: Cpu,
  jellyfin: Palette,
  photos: Palette,
  monitoring: Activity,
  modules: Boxes,
}

export const SD_THEMES = [
  { id: 'midnight', name: 'Midnight', swatch: '#1e1e1e' },
  { id: 'carbon', name: 'Carbon', swatch: '#0b0b0b' },
  { id: 'phosphor', name: 'Phosphor', swatch: '#0f1f12' },
  { id: 'amber', name: 'Amber', swatch: '#1f1405' },
  { id: 'paper', name: 'Paper', swatch: '#f5f5f4' },
  { id: 'arctic', name: 'Arctic', swatch: '#eef2f5' },
]

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function Home() {
  const [active, setActive] = useState('overview')
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [theme, setTheme] = useState('midnight')

  const meta = MODULE_MAP[active]

  // theme boot + persistence through the themes bridge module
  useEffect(() => {
    bridgeCall<string>('themes', 'getActive').then((r) => {
      const t = r.ok && typeof r.data === 'string' ? r.data : 'midnight'
      setTheme(t)
      document.documentElement.dataset.sdTheme = t
    })
  }, [])

  const applyTheme = useCallback((t: string) => {
    setTheme(t)
    document.documentElement.dataset.sdTheme = t
    bridgeCall('themes', 'setActive', { theme: t })
  }, [])

  // Ctrl/Cmd+K opens the module palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // live host ticker for the status bar (real /proc data via the overview bridge)
  const ticker = useBridgeQuery<HostTicker>('overview', 'ticker', undefined, { refetchInterval: 5000 })
  const t = ticker.data?.data

  const groups = useMemo(() => modulesByGroup(), [])

  const goto = useCallback((id: string) => {
    setActive(id)
    setNavOpen(false)
    setPaletteOpen(false)
  }, [])

  const ActivePanel = PANEL_MAP[active] ?? PANEL_MAP.overview

  const sidebar = (
    <nav aria-label="SysDeck modules" className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
          <Waves className="h-4.5 w-4.5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">SysDeck</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">web edition v{SYSDECK_VERSION}</p>
        </div>
      </div>
      <div className="sd-scroll flex-1 overflow-y-auto px-2 pb-4">
        {groups.map(({ group, modules }) => {
          const GIcon = GROUP_ICONS[group] ?? Boxes
          return (
            <div key={group} className="mb-3">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <GIcon className="h-3 w-3 text-muted-foreground" aria-hidden />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {GROUP_LABELS[group]}
                </span>
              </div>
              <ul className="space-y-0.5">
                {modules.map((m) => {
                  const MIcon = MODULE_ICONS[m.id] ?? Boxes
                  const isActive = m.id === active
                  return (
                    <li key={m.id}>
                      <button
                        onClick={() => goto(m.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-primary/15 text-foreground ring-1 ring-primary/25'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <MIcon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : '')} aria-hidden />
                        <span className="truncate">{m.name}</span>
                        {m.id === 'fester' ? (
                          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 sd-live-dot" title="dedicated service" />
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <p className="font-mono text-[10px] text-muted-foreground">
          bridge <span className={t ? 'text-emerald-400' : 'text-red-400'}>{t ? '●' : '○'}</span> · fester{' '}
          <span className={t?.fester === 'online' ? 'text-emerald-400' : 'text-red-400'}>{t?.fester === 'online' ? '●' : '○'}</span>
        </p>
      </div>
    </nav>
  )

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex flex-1 flex-col sm:flex-row">
        {/* desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground sm:block">
          {sidebar}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* header */}
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur">
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Open module navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-0">
                <SheetTitle className="sr-only">SysDeck modules</SheetTitle>
                {sidebar}
              </SheetContent>
            </Sheet>

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{meta?.name ?? 'Overview'}</h2>
              <p className="hidden truncate font-mono text-[10px] text-muted-foreground sm:block">
                {meta?.description ?? ''}
              </p>
            </div>

            <Button variant="outline" size="sm" className="gap-2 font-mono text-xs" asChild>
              <a
                href="/download/sysdeck-0.2.0-master.tar.bz2"
                download
                aria-label="Download the SysDeck master tarball"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
                <span className="hidden md:inline">master tarball</span>
              </a>
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="gap-2 font-mono text-xs"
              onClick={() => setPaletteOpen(true)}
            >
              <span className="hidden sm:inline">jump</span>
              <kbd className="rounded bg-muted px-1 text-[10px]">⌘K</kbd>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Switch theme">
                  <Moon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Theme engine</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {SD_THEMES.map((th) => (
                  <DropdownMenuItem key={th.id} onClick={() => applyTheme(th.id)} className="gap-2">
                    <span
                      className="h-3.5 w-3.5 rounded-sm border border-border"
                      style={{ background: th.swatch }}
                      aria-hidden
                    />
                    {th.name}
                    {theme === th.id ? <span className="ml-auto text-primary">✓</span> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {/* main panel */}
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
            <Suspense fallback={<PanelSkeleton />}>
              <ActivePanel />
            </Suspense>
          </main>
        </div>
      </div>

      {/* sticky footer status bar */}
      <footer className="mt-auto border-t border-border bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Cpu className="h-3 w-3 text-primary" aria-hidden />
            cpu <span className="tabular-nums text-foreground">{t ? `${t.cpuPct.toFixed(0)}%` : '—'}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <MemoryStick className="h-3 w-3 text-primary" aria-hidden />
            mem{' '}
            <span className="tabular-nums text-foreground">
              {t ? `${(t.memUsedMb / 1024).toFixed(1)}/${(t.memTotalMb / 1024).toFixed(1)}G` : '—'}
            </span>
          </span>
          <span>
            load <span className="tabular-nums text-foreground">{t ? t.load1.toFixed(2) : '—'}</span>
          </span>
          <span>
            up <span className="tabular-nums text-foreground">{t ? fmtUptime(t.uptimeS) : '—'}</span>
          </span>
          <span>
            procs <span className="tabular-nums text-foreground">{t ? t.procs : '—'}</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', t?.fester === 'online' ? 'bg-emerald-500 sd-live-dot' : 'bg-red-500')} />
            fester {t?.fester ?? 'offline'}
          </span>
          <span className="hidden sm:inline">SysDeck v{SYSDECK_VERSION} · web edition</span>
        </div>
      </footer>

      {/* command palette */}
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Jump to module…" />
        <CommandList className="sd-scroll">
          <CommandEmpty>No module found.</CommandEmpty>
          {groups.map(({ group, modules }) => (
            <CommandGroup key={group} heading={GROUP_LABELS[group]}>
              {modules.map((m) => (
                <CommandItem key={m.id} value={`${m.name} ${m.id}`} onSelect={() => goto(m.id)}>
                  <span className="mr-2 text-muted-foreground">#</span>
                  {m.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>

      {/* single app-wide sonner toaster */}
      <Toaster richColors position="bottom-right" />
    </div>
  )
}
