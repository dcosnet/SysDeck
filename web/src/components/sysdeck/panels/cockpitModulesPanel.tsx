'use client'

// Cockpit Modules panel (v0.4.1) — the 100%-compatibility surface.
//
// Detects every cockpit module installed on the host — distro modules
// (cockpit-machines, cockpit-podman, networking, storage...), addons,
// anything with a menu entry in /usr/share/cockpit/<pkg>/manifest.json
// — and loads them into this console:
//
//   · the hub (this panel) lists everything detected with live backend
//     presence probes (virsh, podman, nmcli...) and menu ordering;
//   · each module opens a detail view (cm:<name>) with its manifest,
//     shipped files, backend version probe and a jump to the native
//     console panel that covers the domain (podman/machines →
//     Containers & VMs, packagekit → Packages, and so on);
//   · detection is pure filesystem — it works with cockpit stopped or
//     absent; when no tree exists the panel shows a clearly-badged
//     typical-distro set so the surface stays explorable.
import { useMemo } from 'react'
import {
  ArrowRight,
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  LayoutGrid,
  Network,
  Package,
  Server,
  Shield,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useBridgeQuery } from '@/lib/sysdeck/client'
import type { CockpitModuleInfo, CockpitModuleList } from '@/lib/sysdeck/types'
import {
  DataTable,
  ErrorCard,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  SourceBadge,
  StatCard,
  StateBadge,
} from '@/components/sysdeck/ui'
import { cn } from '@/lib/utils'

// ── module identity helpers ──────────────────────────────────────────

const CM_ICONS: Record<string, LucideIcon> = {
  machines: Server,
  podman: Package,
  networkmanager: Network,
  storage: HardDrive,
  users: UserRound,
  systemd: Activity,
  packagekit: Package,
  selinux: Shield,
  metrics: Activity,
  kdump: TriangleAlert,
  tuned: Gauge,
  sosreport: Package,
  certificates: Shield,
}

export function cockpitModuleIcon(name: string): LucideIcon {
  return CM_ICONS[name] ?? LayoutGrid
}

function gotoModule(name: string) {
  window.dispatchEvent(new CustomEvent<string>('sysdeck:goto', { detail: `cm:${name}` }))
}

// ── the hub panel (sidebar entry "Cockpit Modules") ──────────────────

export function CockpitModulesPanel() {
  const q = useBridgeQuery<CockpitModuleList>('cockpitmodules', 'list', undefined, {
    refetchInterval: 60000,
    staleTime: 30000,
  })

  if (q.isLoading) return <PanelSkeleton lines={4} />
  if (q.isError) return <ErrorCard error={q.error instanceof Error ? q.error.message : String(q.error)} />
  const res = q.data
  if (!res?.ok || !res.data) return <ErrorCard error={res?.error ?? 'cockpitmodules.list failed'} />

  const { cockpitDetected, scanned, modules } = res.data
  const withBackend = modules.filter((m) => m.backend?.present).length
  const native = modules.filter((m) => m.nativeModule).length

  return (
    <div className="space-y-4">
      <PanelHeader
        title="Cockpit Modules"
        subtitle={
          cockpitDetected
            ? 'Every cockpit module detected on this host — loaded into this console.'
            : 'No cockpit tree on this host — a typical distro install is shown, clearly badged.'
        }
        source={res.source}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Modules" value={modules.length} icon={<LayoutGrid className="h-4 w-4" />} hint={cockpitDetected ? 'detected on this host' : 'typical distro set'} />
        <StatCard label="Backends live" value={withBackend} icon={<Cpu className="h-4 w-4" />} tone={withBackend > 0 ? 'good' : 'default'} hint="management binaries present" />
        <StatCard label="Native coverage" value={native} icon={<ArrowRight className="h-4 w-4" />} hint="domains with a native panel here" />
        <StatCard label="Cockpit" value={cockpitDetected ? 'installed' : 'absent'} icon={<Server className="h-4 w-4" />} tone={cockpitDetected ? 'good' : 'warn'} hint={scanned[0] ?? '/usr/share/cockpit'} />
      </div>

      <PanelCard title={`Detected modules (${modules.length})`}>
        <DataTable<CockpitModuleInfo>
          rows={modules}
          keyOf={(m) => m.name}
          empty="No cockpit modules detected."
          headers={['Module', 'Cockpit name', 'Package', 'Backend', 'API', 'Order']}
          renderRow={(m) => (
            <tr
              className="cursor-pointer"
              onClick={() => gotoModule(m.name)}
              title={`open ${m.label} detail`}
            >
              <td className="flex items-center gap-2 font-medium">
                {(() => {
                  const Icon = cockpitModuleIcon(m.name)
                  return <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                })()}
                {m.label}
                {m.source === 'demo' ? <StateBadge state="demo" /> : null}
              </td>
              <td className="font-mono text-xs text-muted-foreground">{m.name}</td>
              <td className="font-mono text-xs text-muted-foreground">{m.pkg ?? '—'}</td>
              <td className="font-mono text-xs">
                {m.backend ? (
                  <span className={cn('flex items-center gap-1.5', m.backend.present ? 'text-emerald-400' : 'text-muted-foreground')}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', m.backend.present ? 'bg-emerald-500 sd-live-dot' : 'bg-muted-foreground/40')} />
                    {m.backend.bin}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="font-mono text-xs text-muted-foreground">{m.apiVersion ?? '—'}</td>
              <td className="font-mono text-xs tabular-nums text-muted-foreground">{m.order}</td>
            </tr>
          )}
        />
      </PanelCard>

      <PanelCard title="How detection works">
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p>
            The console scans the cockpit package tree the same way the cockpit shell discovers
            pages — every <span className="font-mono text-xs">/usr/share/cockpit/&lt;pkg&gt;/manifest.json</span>{' '}
            with a <span className="font-mono text-xs">menu</span> entry is a module.{' '}
            <span className="font-mono text-xs">sysdeck-*</span> modules are skipped (native panels
            already ship here), and chrome packages without a menu (base1, shell) never appear.
          </p>
          <p>
            Distro modules — <span className="text-foreground">cockpit-machines</span>,{' '}
            <span className="text-foreground">cockpit-podman</span>, networking, storage, updates —
            get live backend presence probes, and each detail view links straight to the native
            panel covering the domain. Point{' '}
            <span className="font-mono text-xs">SYSDECK_COCKPIT_SCAN</span> at extra trees
            (colon-separated) to include staged installs.
          </p>
        </div>
      </PanelCard>
    </div>
  )
}

// ── per-module detail view (routed as cm:<name> by the shell) ────────

interface InfoRow {
  name: string
  sizeBytes: number
}

interface InfoPayload {
  name: string
  path: string
  files: InfoRow[]
  fileCount: number
  manifest: unknown
  backendVersion: string | null
  source: 'live' | 'demo'
  error?: string
}

function fmtBytes(n: number): string {
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function CockpitModulePanel({ mod }: { mod: CockpitModuleInfo | null }) {
  const infoQ = useBridgeQuery<InfoPayload>('cockpitmodules', 'info', { name: mod?.name }, {
    enabled: !!mod,
    staleTime: 30000,
  })
  const info = infoQ.data?.data
  const nativeLabel = useMemo(() => mod?.nativeModule ?? null, [mod])

  if (!mod) {
    return (
      <div className="space-y-4">
        <PanelHeader title="Cockpit module" subtitle="not currently detected — refresh the Cockpit Modules hub" />
        <PanelCard title="Not found">
          <p className="text-sm text-muted-foreground">
            This module was in navigation but the latest detection pass no longer reports it. Open
            the Cockpit Modules hub to see what is installed right now.
          </p>
        </PanelCard>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PanelHeader
        title={mod.label}
        subtitle={`cockpit module · ${mod.name}`}
        source={mod.source}
        actions={
          nativeLabel ? (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent<string>('sysdeck:goto', { detail: nativeLabel }))}
              className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              native panel
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Backend"
          value={mod.backend ? (mod.backend.present ? 'present' : 'absent') : 'n/a'}
          icon={<Cpu className="h-4 w-4" />}
          tone={mod.backend ? (mod.backend.present ? 'good' : 'warn') : 'default'}
          hint={info?.backendVersion ?? mod.backend?.bin ?? 'no probe for this module'}
        />
        <StatCard label="Files" value={info?.fileCount ?? mod.fileCount} icon={<Package className="h-4 w-4" />} hint="shipped by the package" />
        <StatCard label="Cockpit API" value={mod.apiVersion ?? '—'} icon={<Activity className="h-4 w-4" />} hint="requires.cockpit" />
        <StatCard label="Menu order" value={mod.order} icon={<Gauge className="h-4 w-4" />} hint="cockpit sidebar position" />
      </div>

      <PanelCard title="Identity">
        <div className="space-y-2">
          {mod.description ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{mod.description}</p>
          ) : null}
          <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <p className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">package</span>
              <span className="font-mono text-xs">{mod.pkg ?? '—'}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">cockpit name</span>
              <span className="font-mono text-xs">{mod.name}</span>
            </p>
            <p className="flex items-center justify-between gap-2 sm:col-span-2">
              <span className="text-muted-foreground">path</span>
              <span className="truncate font-mono text-xs" title={mod.path}>{mod.path}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">detection</span>
              <SourceBadge source={mod.source} />
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">files</span>
              <span className="font-mono text-xs tabular-nums">{info?.fileCount ?? mod.fileCount}</span>
            </p>
          </div>
        </div>
      </PanelCard>

      {nativeLabel ? (
        <PanelCard title="Native coverage in this console">
          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p className="leading-relaxed">
              The domain this module covers has a native panel in this console — live collectors,
              no cockpit required.
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent<string>('sysdeck:goto', { detail: nativeLabel }))}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              open the native panel
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </PanelCard>
      ) : (
        <PanelCard title="Native coverage in this console">
          <p className="text-sm leading-relaxed text-muted-foreground">
            No native collector ships for this domain yet — its richest surface stays the cockpit
            page itself. Everything else in this console is native, and the module&apos;s manifest
            and shipped files below are read live from disk.
          </p>
        </PanelCard>
      )}

      <PanelCard title="Shipped files">
        {infoQ.isLoading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">scanning…</p>
        ) : info?.error ? (
          <p className="py-4 text-center text-sm text-red-400">{info.error}</p>
        ) : (
          <DataTable<InfoRow>
            rows={info?.files ?? []}
            keyOf={(f) => f.name}
            empty="No files listed."
            maxH="18rem"
            headers={['File', 'Size']}
            renderRow={(f) => (
              <tr>
                <td className="font-mono text-xs">{f.name}</td>
                <td className="font-mono text-xs tabular-nums text-muted-foreground">
                  {f.sizeBytes > 0 ? fmtBytes(f.sizeBytes) : '—'}
                </td>
              </tr>
            )}
          />
        )}
      </PanelCard>
    </div>
  )
}
