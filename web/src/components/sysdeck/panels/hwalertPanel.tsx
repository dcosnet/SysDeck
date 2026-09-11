'use client'

// Hwalert panel — hardware intrusion indicators. The cockpit edition had
// a 628-line bridge for this module and NO panel (it was orphaned); this
// is the first UI it ever got. Foreign USB storage, DMA-capable
// Thunderbolt, rogue Bluetooth pairings, new PCI devices and firmware
// tamper — with a persisted policy, device whitelist and per-alert state.
// Devices/alerts are seeded (the container's buses are empty), but `scan`
// reads the REAL DMI host identity and re-detects the new PCI device
// idempotently. Source: HYBRID.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BellOff,
  Check,
  CircuitBoard,
  EyeOff,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Usb,
  Bluetooth,
  Zap,
} from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  HintCard,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
} from '@/components/sysdeck/ui'
import { Badge } from '@/components/ui/badge'
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
import { Switch } from '@/components/ui/switch'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface HwDevice {
  id: string
  deviceId: string
  kind: string
  name: string
  vendor: string
  authorized: boolean
  whitelisted: boolean
  firstSeen: string
  lastSeen: string
  dmaCapable: boolean
  blocked: boolean
}

interface HwAlert {
  id: string
  deviceId: string
  kind: string
  severity: string
  message: string
  state: string
  ts: string
}

interface HwSummary {
  activeAlerts: number
  alerts: number
  bySeverity: Record<string, number>
  devices: number
  unauthorizedDevices: number
  policy: Record<string, boolean>
  whitelistCount: number
}

interface PolicyData {
  policy: Record<string, boolean>
  keys: { key: string; value: boolean; description: string }[]
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function severityCls(severity: string): string {
  if (severity === 'danger') return 'bg-red-500/15 text-red-500 border-red-500/30'
  if (severity === 'warn') return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
  return 'bg-teal-500/15 text-teal-400 border-teal-500/30'
}

function alertStateCls(state: string): string {
  if (state === 'active') return 'bg-red-500/15 text-red-500 border-red-500/30'
  if (state === 'acknowledged') return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
  return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
}

function alertCardTone(severity: string): string {
  if (severity === 'danger') return 'border-red-500/40 bg-red-500/[0.04]'
  if (severity === 'warn') return 'border-amber-500/40 bg-amber-500/[0.04]'
  return 'border-teal-500/30 bg-teal-500/[0.03]'
}

function kindIcon(kind: string) {
  if (kind.startsWith('usb')) return <Usb className="h-3.5 w-3.5" aria-hidden />
  if (kind === 'thunderbolt') return <Zap className="h-3.5 w-3.5" aria-hidden />
  if (kind === 'bluetooth') return <Bluetooth className="h-3.5 w-3.5" aria-hidden />
  return <CircuitBoard className="h-3.5 w-3.5" aria-hidden />
}

function kindCls(kind: string): string {
  if (kind === 'usb-storage') return 'border-red-500/30 text-red-500 bg-red-500/10'
  if (kind === 'usb') return 'border-teal-500/30 text-teal-400 bg-teal-500/10'
  if (kind === 'thunderbolt') return 'border-amber-500/30 text-amber-500 bg-amber-500/10'
  if (kind === 'bluetooth') return 'border-sky-500/30 text-sky-400 bg-sky-500/10'
  return 'border-zinc-500/30 text-zinc-400 bg-zinc-500/10'
}

// ── panel ────────────────────────────────────────────────────────────

export default function HwalertPanel() {
  const summaryQ = useBridgeQuery<HwSummary>('hwalert', 'summary', undefined, { refetchInterval: 6000 })
  const alertsQ = useBridgeQuery<{ alerts: HwAlert[]; count: number; activeCount: number }>('hwalert', 'alerts', undefined, {
    refetchInterval: 6000,
  })
  const devicesQ = useBridgeQuery<{ devices: HwDevice[]; count: number }>('hwalert', 'devices', undefined, {
    refetchInterval: 8000,
  })
  const policyQ = useBridgeQuery<PolicyData>('hwalert', 'policy', undefined, { refetchInterval: 10000 })
  const action = useBridgeAction()
  const [scanning, setScanning] = useState(false)

  const summary = summaryQ.data?.data
  const alerts = useMemo(() => alertsQ.data?.data?.alerts ?? [], [alertsQ.data])
  const devices = useMemo(() => devicesQ.data?.data?.devices ?? [], [devicesQ.data])
  const policyKeys = useMemo(() => policyQ.data?.data?.keys ?? [], [policyQ.data])

  async function acknowledge(id: string) {
    const res = await action('hwalert', 'acknowledge', { id })
    if (res.ok) {
      toast.success('alert acknowledged', { description: 'it stays visible until dismissed' })
    } else {
      toast.error('acknowledge failed', { description: res.error })
    }
  }

  async function dismiss(id: string) {
    const res = await action('hwalert', 'dismiss', { id })
    if (res.ok) {
      toast.success('alert dismissed')
    } else {
      toast.error('dismiss failed', { description: res.error })
    }
  }

  async function toggleBlock(device: HwDevice) {
    const cmd = device.authorized ? 'block' : 'unblock'
    const res = await action('hwalert', cmd, { deviceId: device.deviceId })
    if (res.ok) {
      toast.success(`${device.name} ${cmd === 'block' ? 'blocked' : 'unblocked'}`, {
        description:
          cmd === 'block'
            ? 'registry state changed — on a managed host this writes 0 to the sysfs authorized file'
            : 'device authorized again',
      })
    } else {
      toast.error(`${cmd} failed`, { description: res.error })
    }
  }

  async function toggleWhitelist(device: HwDevice) {
    const cmd = device.whitelisted ? 'unwhitelist' : 'whitelist'
    const res = await action('hwalert', cmd, { deviceId: device.deviceId })
    if (res.ok) {
      toast.success(`${device.name} ${cmd === 'whitelist' ? 'whitelisted' : 'removed from the whitelist'}`, {
        description: cmd === 'whitelist' ? 'the device is auto-authorized from now on' : undefined,
      })
    } else {
      toast.error(`${cmd} failed`, { description: res.error })
    }
  }

  async function setPolicy(key: string, value: boolean) {
    const res = await action('hwalert', 'policy', { key, value: String(value) })
    if (res.ok) {
      toast.success(`policy: ${key} = ${value}`, {
        description: 'persisted — applied on the next scan / device event',
      })
    } else {
      toast.error('policy update failed', { description: res.error })
    }
  }

  async function runScan() {
    setScanning(true)
    try {
      const res = await action('hwalert', 'scan')
      if (res.ok) {
        const d = res.data as { host: string; scanned: number; newAlert: { message: string } | null }
        if (d.newAlert) {
          toast.warning('new hardware detected', { description: d.newAlert.message, duration: 9000 })
        } else {
          toast.success('scan complete — all quiet', {
            description: `${d.scanned} devices on host '${d.host}' — no new hardware`,
          })
        }
      } else {
        toast.error('scan failed', { description: res.error })
      }
    } finally {
      setScanning(false)
    }
  }

  if (summaryQ.isLoading && !summaryQ.data) return <PanelSkeleton lines={4} />
  if (summaryQ.data && !summaryQ.data.ok) return <ErrorCard error={summaryQ.data.error ?? 'hwalert.summary failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Hardware Alerts"
        subtitle="hardware intrusion indicators — foreign USB storage, Thunderbolt DMA, rogue Bluetooth, new PCI devices, firmware tamper"
        source="hybrid"
        actions={
          <Button size="sm" className="gap-1.5 font-mono text-xs" disabled={scanning} onClick={() => void runScan()}>
            <Radar className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} aria-hidden />
            {scanning ? 'scanning…' : 'run hardware scan'}
          </Button>
        }
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active alerts"
          value={summary?.activeAlerts ?? '—'}
          tone={summary?.activeAlerts ? 'bad' : 'good'}
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
          hint={`${summary?.alerts ?? 0} total recorded`}
        />
        <StatCard
          label="Danger"
          value={summary?.bySeverity?.danger ?? 0}
          tone={summary?.bySeverity?.danger ? 'bad' : 'default'}
          icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
          hint={`warn ${summary?.bySeverity?.warn ?? 0} · info ${summary?.bySeverity?.info ?? 0}`}
        />
        <StatCard
          label="Devices"
          value={summary?.devices ?? '—'}
          hint={`${summary?.unauthorizedDevices ?? 0} unauthorized`}
        />
        <StatCard
          label="Whitelisted"
          value={summary?.whitelistCount ?? '—'}
          tone="good"
          icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
          hint={summary?.policy?.whitelistEnforced ? 'whitelist is enforced' : 'whitelist advisory'}
        />
      </div>

      {/* alerts — the section this module was built for */}
      <PanelCard
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
            alerts · {alertsQ.data?.data?.activeCount ?? 0} active
          </span>
        }
        actions={<Mono>{alerts.length} recorded</Mono>}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {alerts.map((a) => (
            <div key={a.id} className={`rounded-md border p-3 ${alertCardTone(a.severity)} ${a.state === 'active' && a.severity === 'danger' ? 'animate-pulse' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${severityCls(a.severity)}`}>
                  {a.severity}
                </span>
                <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-foreground/80">
                  {a.kind}
                </span>
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${alertStateCls(a.state)}`}>
                  {a.state}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{fmtUtc(a.ts)}</span>
              </div>
              <p className="mt-2 text-sm leading-snug text-foreground/90">{a.message}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">device: {a.deviceId}</p>
              <div className="mt-2 flex gap-2">
                {a.state === 'active' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 font-mono text-[11px]"
                    onClick={() => void acknowledge(a.id)}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    acknowledge
                  </Button>
                ) : null}
                {a.state !== 'dismissed' ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-red-500"
                      >
                        <EyeOff className="h-3.5 w-3.5" aria-hidden />
                        dismiss
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="font-mono">dismiss this {a.severity} alert?</AlertDialogTitle>
                        <AlertDialogDescription>
                          <span className="block font-mono text-xs">{a.kind}</span>
                          {a.message}
                          <span className="mt-2 block text-xs">
                            The alert moves to <Mono>dismissed</Mono> state (kept for history). The underlying device is
                            NOT unblocked by dismissing.
                          </span>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => void dismiss(a.id)}>
                          Dismiss alert
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                    <BellOff className="h-3 w-3" aria-hidden />
                    dismissed by operator
                  </span>
                )}
              </div>
            </div>
          ))}
          {alerts.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground lg:col-span-2">no alerts recorded</p>
          ) : null}
        </div>
      </PanelCard>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* devices */}
        <PanelCard
          title="Device inventory"
          className="lg:col-span-2"
          actions={<Mono>{devices.length} devices</Mono>}
        >
          <DataTable
            rows={devices}
            headers={['Device ID', 'Kind', 'Name', 'Vendor', 'State', '']}
            keyOf={(d) => d.id}
            maxH="26rem"
            empty="no hardware recorded — run a scan"
            renderRow={(d) => (
              <>
                <TableCell className="font-mono text-xs">{d.deviceId}</TableCell>
                <TableCell>
                  <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${kindCls(d.kind)}`}>
                    {kindIcon(d.kind)}
                    {d.kind}
                    {d.dmaCapable ? <span className="text-amber-500">·DMA</span> : null}
                  </span>
                </TableCell>
                <TableCell className="max-w-52 truncate text-xs" title={d.name}>
                  {d.name}
                </TableCell>
                <TableCell className="max-w-40 truncate text-xs text-muted-foreground" title={d.vendor}>
                  {d.vendor}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        d.authorized
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/15 text-red-500 border-red-500/30'
                      }`}
                    >
                      {d.authorized ? 'authorized' : 'blocked'}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        d.whitelisted
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
                      }`}
                    >
                      {d.whitelisted ? 'whitelisted' : 'unlisted'}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant={d.authorized ? 'ghost' : 'outline'}
                      size="sm"
                      className={`h-6 gap-1 font-mono text-[10px] ${d.authorized ? 'text-muted-foreground hover:text-red-500' : ''}`}
                      onClick={() => void toggleBlock(d)}
                      aria-label={`${d.authorized ? 'Block' : 'Unblock'} ${d.name}`}
                      title={d.authorized ? 'block this device' : 'unblock this device'}
                    >
                      {d.authorized ? 'block' : 'unblock'}
                    </Button>
                    <Button
                      variant={d.whitelisted ? 'ghost' : 'outline'}
                      size="sm"
                      className={`h-6 font-mono text-[10px] ${d.whitelisted ? 'text-muted-foreground hover:text-red-500' : ''}`}
                      onClick={() => void toggleWhitelist(d)}
                      aria-label={`${d.whitelisted ? 'Remove' : 'Add'} ${d.name} ${d.whitelisted ? 'from' : 'to'} the whitelist`}
                      title={d.whitelisted ? 'remove from whitelist' : 'whitelist this device'}
                    >
                      {d.whitelisted ? 'unwhitelist' : 'whitelist'}
                    </Button>
                  </div>
                </TableCell>
              </>
            )}
          />
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            blocks/unblocks are registry state — on a managed host they write the sysfs authorized file / udev rule.
          </p>
        </PanelCard>

        {/* policy switches */}
        <div className="space-y-4">
          <PanelCard title="Device policy" actions={<Mono>persisted</Mono>}>
            <div className="space-y-3">
              {policyKeys.map((k) => (
                <div key={k.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-semibold">{k.key}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{k.description}</p>
                  </div>
                  <Switch
                    checked={k.value}
                    onCheckedChange={(v) => void setPolicy(k.key, v)}
                    aria-label={`Policy ${k.key}`}
                    className="mt-0.5"
                  />
                </div>
              ))}
              {policyKeys.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">policy unavailable</p>
              ) : null}
            </div>
          </PanelCard>

          <HintCard title="What is real here">
            <p>
              The <Mono>scan</Mono> host identity is REAL (<Mono>/sys/class/dmi/id/product_name</Mono> — reported as
              unknown in this container, no DMI). The usb/thunderbolt/bluetooth/pci bus inventory is seeded: this
              sandbox has no populated buses. Policy, whitelist, block and alert state persist in the db.
            </p>
            <p>
              The I225-V PCI device appears once on the first scan (idempotent — no alert spam), exactly like a
              previously-unseen device would on a real host.
            </p>
          </HintCard>
        </div>
      </div>
    </div>
  )
}
