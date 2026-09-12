'use client'

// Firmware panel — fwupd-style device inventory (real DMI identity +
// real fwupdmgr get-devices when fwupd exists), raw DMI fields, TPM
// PCR0 boot-chain block, and updates straight from fwupdmgr
// get-updates. Stage runs the real fwupdmgr flow when fwupd is present
// and refuses honestly otherwise.

import { toast } from 'sonner'
import { Download, Fingerprint, HardDrive, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  InstallHint,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
  StateBadge,
} from '@/components/sysdeck/ui'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface FwDevice {
  Name: string
  Vendor: string
  Version: string
  Kind: string
  Flags: string
  Guid: string
}

interface DmiFields {
  sys_vendor: string
  product_name: string
  product_version: string
  board_name: string
  board_version: string
  bios_vendor: string
  bios_version: string
  bios_date: string
}

interface FwUpdate {
  device: string
  guid: string
  current: string
  candidate: string
  severity: 'critical' | 'low'
  description: string
  releaseNotes?: string
  staged: boolean
}

// ── panel ────────────────────────────────────────────────────────────

export default function FirmwarePanel() {
  const devices = useBridgeQuery<{ Devices: FwDevice[]; applied: number }>('firmware', 'devices')
  const dmi = useBridgeQuery<{ dmi: DmiFields }>('firmware', 'dmi')
  const tpm = useBridgeQuery<{
    installed: boolean
    note: string
    pcr0: { algorithm: string; pcr: number; digest: string; extensions: string[] }
  }>('firmware', 'tpm')
  const updates = useBridgeQuery<{ updates: FwUpdate[]; count: number }>('firmware', 'updates')
  const action = useBridgeAction()

  const dev = devices.data?.data
  const d = dmi.data?.data?.dmi
  const t = tpm.data?.data
  const ups = updates.data?.data

  async function stageUpdate(u: FwUpdate) {
    const res = await action('firmware', 'apply', { guid: u.guid })
    if (res.ok) {
      toast.success(`${u.device} — update staged`, {
        description: `${u.current} → ${u.candidate}: staging recorded; the actual flash requires the cockpit bridge on a managed host`,
      })
    } else {
      toast.error('firmware apply failed', { description: res.error })
    }
  }

  if (devices.isLoading && !devices.data) return <PanelSkeleton lines={3} />
  if (devices.data && !devices.data.ok) return <ErrorCard error={devices.data.error ?? 'firmware.devices failed'} />

  const dmiKnown = Object.values(d ?? {}).some((v) => v.length > 0)
  const stagedCount = (ups?.updates ?? []).filter((u) => u.staged).length

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Firmware"
        subtitle="fwupd-style firmware inventory, DMI identity and the TPM PCR boot chain"
        source="hybrid"
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Devices" value={dev?.Devices?.length ?? '—'} icon={<HardDrive className="h-4 w-4" aria-hidden />} hint="DMI entry + fwupd-style inventory" />
        <StatCard
          label="Updates available"
          value={ups?.count ?? '—'}
          icon={<Download className="h-4 w-4" aria-hidden />}
          tone={ups && ups.count > 0 ? 'warn' : 'default'}
          hint="LVFS-style catalog"
        />
        <StatCard
          label="Staged"
          value={stagedCount}
          icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
          tone={stagedCount > 0 ? 'good' : 'default'}
          hint="staging recorded in SdKv"
        />
        <StatCard
          label="TPM"
          value={t ? (t.installed ? 'present' : 'absent') : '—'}
          icon={<Fingerprint className="h-4 w-4" aria-hidden />}
          tone={t?.installed ? 'good' : 'default'}
          hint={t?.note ?? 'tpm2-tools probe'}
        />
      </div>

      {/* devices */}
      <PanelCard
        title="Device inventory"
        actions={<Mono>real identity from /sys/class/dmi + fwupdmgr when installed</Mono>}
      >
        <DataTable
          rows={dev?.Devices ?? []}
          headers={['Device', 'Vendor', 'Version', 'Kind', 'Flags', '']}
          keyOf={(r) => r.Guid}
          maxH="22rem"
          empty="no devices reported"
          renderRow={(r) => (
            <>
              <TableCell className="max-w-56 truncate font-medium" title={r.Name}>
                {r.Name}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.Vendor}</TableCell>
              <TableCell className="font-mono text-xs">{r.Version}</TableCell>
              <TableCell className="text-xs">{r.Kind}</TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {r.Flags.split('|').map((f) => (
                  <Badge
                    key={f}
                    variant="outline"
                    className={`mr-1 font-mono text-[9px] ${f === 'staged' ? 'border-emerald-500/30 text-emerald-400' : 'border-zinc-500/30 text-zinc-400'}`}
                  >
                    {f}
                  </Badge>
                ))}
              </TableCell>
              <TableCell className="text-right">
                <Badge variant="outline" className="border-emerald-500/30 font-mono text-[9px] text-emerald-400" title="read from this host's kernel/DMI identity + fwupdmgr">
                  real
                </Badge>
              </TableCell>
            </>
          )}
        />
      </PanelCard>

      {/* DMI + TPM */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard
          title="DMI identity"
          actions={<Badge variant="outline" className="font-mono text-[10px]">{dmiKnown ? 'real' : 'live · empty'}</Badge>}
        >
          <div>
            <KV k="sys vendor" v={d?.sys_vendor || '—'} />
            <KV k="product" v={d?.product_name || '—'} />
            <KV k="product version" v={d?.product_version || '—'} />
            <KV k="board" v={d?.board_name ? `${d.board_name} (${d.board_version || '—'})` : '—'} />
            <KV k="bios vendor" v={d?.bios_vendor || '—'} />
            <KV k="bios version" v={d?.bios_version || '—'} />
            <KV k="bios date" v={d?.bios_date || '—'} />
          </div>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {dmiKnown
              ? 'raw /sys/class/dmi/id values'
              : dmi.data?.note ?? '/sys/class/dmi/id is not exposed by this host — values stay honestly empty'}
          </p>
        </PanelCard>

        <PanelCard
          title="TPM PCR0 — boot chain"
          actions={
            t?.installed ? (
              <Badge variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-400">present</Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500/30 font-mono text-[10px] text-amber-500">tpm2-tools absent</Badge>
            )
          }
        >
          {t?.installed && t.pcr0 ? (
            <div>
              <KV k="algorithm" v={t.pcr0.algorithm} />
              <KV k="pcr index" v={t.pcr0.pcr} />
              <p className="mt-2 break-all rounded-md border border-border bg-zinc-950/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                {t.pcr0.digest}
              </p>
            </div>
          ) : (
            <InstallHint
              bin="tpm2-tools"
              hint="tpm2_pcrread sha256:0  # reads the real measured-boot digest"
            />
          )}
        </PanelCard>
      </div>

      {/* updates */}
      <PanelCard title="Firmware updates" actions={<Mono>{ups?.count ?? 0} in catalog · real fwupdmgr get-updates</Mono>}>
        <div className="space-y-3">
          {(ups?.updates ?? []).map((u) => (
            <div key={u.guid} className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {u.device}
                    {u.severity === 'critical' ? (
                      <span className="flex items-center gap-1">
                        <ShieldAlert className="h-3.5 w-3.5 text-red-500" aria-hidden />
                        <StateBadge state="critical" />
                      </span>
                    ) : (
                      <StateBadge state="low" />
                    )}
                    {u.staged ? <StateBadge state="staged" /> : null}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {u.current} <span className="text-foreground">→</span>{' '}
                    <span className="text-emerald-400">{u.candidate}</span>
                  </p>
                </div>
                <Button
                  variant={u.staged ? 'outline' : 'default'}
                  size="sm"
                  className="gap-2 font-mono text-xs"
                  disabled={u.staged}
                  onClick={() => void stageUpdate(u)}
                  aria-label={`Stage update for ${u.device}`}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {u.staged ? 'staged' : 'Stage update'}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{u.description}</p>
              {u.releaseNotes ? (
                <details className="mt-2">
                  <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground hover:text-foreground">
                    release notes
                  </summary>
                  <p className="mt-1 rounded border border-border/60 bg-background/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                    {u.releaseNotes}
                  </p>
                </details>
              ) : null}
            </div>
          ))}
          {(ups?.updates ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">no firmware updates in the catalog</p>
          ) : null}
        </div>
      </PanelCard>
    </div>
  )
}
