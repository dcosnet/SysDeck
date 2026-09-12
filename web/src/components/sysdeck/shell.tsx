'use client'

// SysDeck shell — the authenticated application frame (sidebar,
// header, panel host, status bar, command palette). v0.4.0+: the frame
// now carries the signed-in unix identity — an avatar menu with
// account provenance (PAM unix account / console account), the
// administrative-access badge, a live session-expiry countdown, and a
// user@host segment in the status bar, cockpit-style.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PANEL_MAP } from '@/components/sysdeck/panels-map'
import { MODULES, MODULE_MAP, GROUP_LABELS, modulesByGroup, SYSDECK_VERSION } from '@/lib/sysdeck/registry'
import { bridgeCall, useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import type { ConsoleUser } from '@/lib/sysdeck/users'
import type { HostTicker } from '@/lib/sysdeck/types'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { toast } from 'sonner'
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
  BookOpen,
  Boxes,
  Clock,
  Cpu,
  Database,
  Flame,
  Gauge,
  HardDrive,
  LayoutDashboard,
  LogOut,
  MemoryStick,
  Menu,
  Moon,
  Network,
  Palette,
  Power,
  RotateCcw,
  Server,
  Shield,
  ShieldCheck,
  Terminal,
  UserRound,
  Waves,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react'
import { CockpitModulePanel, cockpitModuleIcon } from '@/components/sysdeck/panels/cockpitModulesPanel'
import type { CockpitModuleInfo, CockpitModuleList } from '@/lib/sysdeck/types'

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
  runbook: BookOpen,
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
  cockpit: LayoutGrid,
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

/** "4h 12m" style session countdown. */
function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function initialsOf(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, ' ')
  const parts = clean.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** Stable hue per username — the avatar reads as *that* account. */
function hueOf(username: string): number {
  let h = 0
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0
  return h % 360
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // mirrors session.ts

export function SysDeckShell({
  sessionUser,
  sessionExpiresAt,
}: {
  sessionUser: ConsoleUser
  sessionExpiresAt: number
}) {
  const [active, setActive] = useState('overview')
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [theme, setTheme] = useState('midnight')
  const [now, setNow] = useState(() => Date.now())

  const meta = MODULE_MAP[active]

  // session clock — refresh the countdown chip twice a minute
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const sessionRemaining = sessionExpiresAt - now

  // theme boot: hydrate from the localStorage mirror first (so the
  // login screen and the shell agree pre-bridge), then confirm through
  // the themes bridge module — the persisted source of truth.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sd_theme')
      if (saved) {
        setTheme(saved)
        document.documentElement.dataset.sdTheme = saved
      }
    } catch {
      /* storage unavailable — bridge value below still applies */
    }
    bridgeCall<string>('themes', 'getActive').then((r) => {
      const t = r.ok && typeof r.data === 'string' ? r.data : 'midnight'
      setTheme(t)
      document.documentElement.dataset.sdTheme = t
    })
  }, [])

  const applyTheme = useCallback((t: string) => {
    setTheme(t)
    document.documentElement.dataset.sdTheme = t
    // mirror for the login screen (the bridge is session-gated, the
    // login screen can't ask it — localStorage can)
    try {
      localStorage.setItem('sd_theme', t)
    } catch {
      /* non-fatal */
    }
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

  // sign out: clear the session cookie server-side, then reload — the
  // page-level gate re-renders the login screen.
  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      /* cookie may already be gone — reload decides */
    }
    window.location.reload()
  }, [])

  // live host ticker for the status bar (real /proc data via the overview bridge)
  const ticker = useBridgeQuery<HostTicker>('overview', 'ticker', undefined, { refetchInterval: 5000 })
  const t = ticker.data?.data

  // module visibility toggles (shell bridge, persisted in SQLite) — a
  // disabled module is hidden from the sidebar + palette and lands in
  // the "Disabled" section until re-enabled. Overview is protected.
  const togglesQ = useBridgeQuery<{ disabled: string[] }>('shell', 'toggles', undefined, { refetchInterval: 30000 })
  const disabledIds = useMemo(() => new Set(togglesQ.data?.data?.disabled ?? []), [togglesQ.data])
  const [pendingToggle, setPendingToggle] = useState<string | null>(null)
  const toggleAction = useBridgeAction()

  const toggleModule = useCallback(
    async (id: string, enabled: boolean) => {
      if (id === 'overview') return
      setPendingToggle(id)
      try {
        const res = await toggleAction('shell', 'setToggle', { id, enabled })
        if (res.ok === false) {
          toast.error(res.error ?? 'toggle failed')
        } else {
          toast.success(`${MODULE_MAP[id]?.name ?? id} ${enabled ? 'enabled' : 'disabled'}`)
          if (!enabled && active === id) setActive('overview')
        }
      } finally {
        setPendingToggle(null)
      }
    },
    [toggleAction, active],
  )

  const resetToggles = useCallback(async () => {
    const res = await toggleAction('shell', 'resetToggles', {})
    if (res.ok === false) toast.error(res.error ?? 'reset failed')
    else toast.success('all modules re-enabled')
  }, [toggleAction])

  const groups = useMemo(
    () =>
      modulesByGroup()
        .map((g) => ({ ...g, modules: g.modules.filter((m) => !disabledIds.has(m.id)) }))
        .filter((g) => g.modules.length > 0),
    [disabledIds],
  )
  const disabledModules = useMemo(() => MODULES.filter((m) => disabledIds.has(m.id)), [disabledIds])

  const goto = useCallback((id: string) => {
    setActive(id)
    setNavOpen(false)
    setPaletteOpen(false)
  }, [])

  // cross-panel module navigation (e.g. the overview "run without cockpit"
  // callout jumps to the runbook panel; detected cockpit modules route as
  // cm:<name> and the hub jumps to native panels by plain id)
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && (MODULE_MAP[id] || id.startsWith('cm:'))) goto(id)
    }
    window.addEventListener('sysdeck:goto', handler as EventListener)
    return () => window.removeEventListener('sysdeck:goto', handler as EventListener)
  }, [goto])

  // cockpit module detection (v0.4.1): every installed cockpit module —
  // distro (machines, podman...) and addon alike — loads into this
  // console's navigation. Filesystem scan via the bridge, 60s refresh.
  const cmQ = useBridgeQuery<CockpitModuleList>('cockpitmodules', 'list', undefined, {
    refetchInterval: 60000,
    staleTime: 30000,
  })
  const cockpitMods = useMemo(() => cmQ.data?.data?.modules ?? [], [cmQ.data])
  const cmSource: 'live' | 'demo' = cmQ.data?.data?.cockpitDetected ? 'live' : 'demo'

  // active view: a registry module, or a detected cockpit module (cm:<name>)
  const cmName = active.startsWith('cm:') ? active.slice(3) : null
  const cmMod = cmName ? (cockpitMods.find((m) => m.name === cmName) ?? null) : null
  const ActivePanel = useMemo(() => {
    if (cmName) {
      const CmPanel = () => <CockpitModulePanel mod={cmMod} />
      return CmPanel
    }
    return PANEL_MAP[active] ?? PANEL_MAP.overview
  }, [cmName, cmMod, active])
  const headerMeta = cmMod
    ? { name: cmMod.label, description: `cockpit module · ${cmMod.name}${cmMod.pkg ? ' · ' + cmMod.pkg : ''}` }
    : (meta ?? undefined)
  const avatarHue = hueOf(sessionUser.username)
  const sourceLabel =
    sessionUser.source === 'unix'
      ? 'Unix account · host PAM'
      : sessionUser.source === 'local'
        ? 'Console account · local store'
        : 'Shared session (pre-0.4.0 cookie)'
  const hostLabel = t?.hostname ?? 'localhost'

  const sidebar = (
    <nav aria-label="SysDeck modules" className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
          <Waves className="h-4.5 w-4.5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">SysDeck</p>
          <a
            href="http://dcos.net/"
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
            title="dcos.net"
          >
            dcos.net
          </a>
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
                    <li key={m.id} className="group relative">
                      <button
                        onClick={() => goto(m.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-7 text-left text-sm transition-colors',
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
                      {m.id !== 'overview' ? (
                        <button
                          type="button"
                          onClick={() => toggleModule(m.id, false)}
                          disabled={pendingToggle === m.id}
                          aria-label={`Disable ${m.name} module`}
                          title="disable module (hides it from navigation; re-enable from the Disabled section)"
                          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/50 opacity-70 transition-colors hover:text-red-400 hover:opacity-100 disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          <Power className="h-3 w-3" aria-hidden />
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
        {/* detected cockpit modules — the host's own install, loaded into
            this console (distro modules like machines/podman and addons) */}
        {cockpitMods.length > 0 ? (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <LayoutGrid className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Cockpit ({cockpitMods.length})
              </span>
              <span
                className={cn(
                  'ml-auto rounded border px-1 font-mono text-[9px] font-semibold tracking-wider',
                  cmSource === 'live'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-500',
                )}
                title={cmSource === 'live' ? 'detected on this host' : 'no cockpit tree — typical distro set'}
              >
                {cmSource === 'live' ? 'LIVE' : 'DEMO'}
              </span>
            </div>
            <ul className="space-y-0.5">
              {cockpitMods.map((m) => {
                const MIcon = cockpitModuleIcon(m.name)
                const isActive = active === `cm:${m.name}`
                return (
                  <li key={`cm-${m.name}`}>
                    <button
                      onClick={() => goto(`cm:${m.name}`)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-primary/15 text-foreground ring-1 ring-primary/25'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                      title={`${m.label} · cockpit module${m.pkg ? ' · ' + m.pkg : ''}`}
                    >
                      <MIcon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : '')} aria-hidden />
                      <span className="truncate">{m.label}</span>
                      {m.backend?.present ? (
                        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 sd-live-dot" title={`${m.backend.bin} present`} />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
        {disabledModules.length > 0 ? (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <Power className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Disabled ({disabledModules.length})
              </span>
              <button
                type="button"
                onClick={resetToggles}
                aria-label="Re-enable all disabled modules"
                title="re-enable all disabled modules"
                className="ml-auto rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" aria-hidden />
              </button>
            </div>
            <ul className="space-y-0.5">
              {disabledModules.map((m) => {
                const MIcon = MODULE_ICONS[m.id] ?? Boxes
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggleModule(m.id, true)}
                      disabled={pendingToggle === m.id}
                      aria-label={`Re-enable ${m.name} module`}
                      title="re-enable module"
                      className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <MIcon className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
                      <span className="truncate line-through decoration-muted-foreground/30">{m.name}</span>
                      <Power className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-emerald-400" aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
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
              <h2 className="truncate text-sm font-semibold">{headerMeta?.name ?? 'Overview'}</h2>
              <p className="hidden truncate font-mono text-[10px] text-muted-foreground sm:block">
                {headerMeta?.description ?? ''}
              </p>
            </div>

            <Button variant="ghost" size="sm" className="gap-2 border border-transparent font-mono text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground" asChild>
              <a
                href={`/download/sysdeck-${SYSDECK_VERSION}-master.tar.bz2`}
                download
                aria-label="Download the SysDeck master tarball"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
                <span className="hidden md:inline">master tarball</span>
              </a>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="gap-2 border border-transparent font-mono text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
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

            {/* cockpit-style account menu: who is signed in, how the
                session was minted, when it dies, and the way out */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Account menu — signed in as ${sessionUser.username}`}
                  className="sd-avatar h-8 w-8 text-xs font-semibold ring-1 ring-transparent transition-shadow hover:ring-primary/50"
                  style={{
                    // per-account hue: the avatar reads as *that* operator
                    background: `linear-gradient(135deg, oklch(0.34 0.09 ${avatarHue}), oklch(0.2 0.06 ${avatarHue}))`,
                    color: `oklch(0.9 0.07 ${avatarHue})`,
                    boxShadow: `inset 0 0 0 1px oklch(0.5 0.09 ${avatarHue} / 0.4), 0 0 10px oklch(0.6 0.1 ${avatarHue} / 0.25)`,
                  }}
                  title={`${sessionUser.username}@${hostLabel}`}
                >
                  {initialsOf(sessionUser.realname || sessionUser.username)}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8} className="w-64">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex items-center gap-3">
                    <span
                      className="sd-avatar h-10 w-10 text-sm font-semibold"
                      style={{
                        background: `linear-gradient(135deg, oklch(0.34 0.09 ${avatarHue}), oklch(0.2 0.06 ${avatarHue}))`,
                        color: `oklch(0.9 0.07 ${avatarHue})`,
                        boxShadow: `inset 0 0 0 1px oklch(0.5 0.09 ${avatarHue} / 0.4), 0 0 12px oklch(0.6 0.1 ${avatarHue} / 0.25)`,
                      }}
                      aria-hidden
                    >
                      {initialsOf(sessionUser.realname || sessionUser.username)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {sessionUser.realname || sessionUser.username}
                      </p>
                      <p
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={`${sessionUser.username}@${hostLabel}`}
                      >
                        {sessionUser.username}@{hostLabel}
                      </p>
                    </div>
                  </div>
                </DropdownMenuLabel>

                <DropdownMenuSeparator />

                <div className="px-2 py-1.5">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <UserRound className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
                    {sourceLabel}
                  </p>
                  {sessionUser.isAdmin ? (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-primary">
                      <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
                      Administrative access
                    </p>
                  ) : null}
                  {sessionUser.uid !== null ? (
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                      uid {sessionUser.uid}
                      {sessionUser.home ? ` · ${sessionUser.home}` : ''}
                    </p>
                  ) : null}
                </div>

                <DropdownMenuSeparator />

                <div className="px-2 py-1.5">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
                    Session expires in{' '}
                    <span className={cn('sd-session-chip font-mono', sessionRemaining < 30 * 60_000 ? 'text-amber-500' : 'text-foreground')}>
                      {fmtRemaining(sessionRemaining)}
                    </span>
                  </p>
                  {/* thin life bar: full at sign-in, drains to the expiry */}
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-1000',
                        sessionRemaining < 30 * 60_000 ? 'bg-amber-500' : 'bg-primary',
                      )}
                      style={{ width: `${Math.max(0, Math.min(100, (sessionRemaining / SESSION_TTL_MS) * 100))}%` }}
                      aria-hidden
                    />
                  </div>
                </div>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={signOut}
                  className="gap-2 text-red-400 focus:text-red-300 focus:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {/* main panel — cross-fade between modules */}
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <Suspense fallback={<PanelSkeleton />}>
                  <ActivePanel />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>

      {/* sticky footer status bar */}
      <footer className="mt-auto border-t border-border bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <UserRound className="h-3 w-3 text-primary" aria-hidden />
            <span className="text-foreground">
              {sessionUser.username}@{hostLabel}
            </span>
          </span>
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
          <span className="hidden sm:inline">
            SysDeck v{SYSDECK_VERSION} ·{' '}
            <a href="http://dcos.net/" target="_blank" rel="noreferrer" className="transition-colors hover:text-primary">
              dcos.net
            </a>
          </span>
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
          {cockpitMods.length > 0 ? (
            <CommandGroup key="cockpit-modules" heading={`Cockpit modules (${cockpitMods.length})`}>
              {cockpitMods.map((m: CockpitModuleInfo) => (
                <CommandItem key={`cm-${m.name}`} value={`${m.label} ${m.name} cockpit`} onSelect={() => goto(`cm:${m.name}`)}>
                  <span className="mr-2 text-muted-foreground">cockpit</span>
                  {m.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>

      {/* single app-wide sonner toaster */}
      <Toaster richColors position="bottom-right" />
    </div>
  )
}
