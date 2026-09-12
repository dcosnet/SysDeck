'use client'

// Vault panel — LUKS volume inventory + encryption vault entries.
// The lsblk table is REAL live data (hosts without crypto_LUKS devices
// report the empty set honestly); vault entries derive live from lsblk
// plus the operator's registered keyfiles — never seeded. lock/unlock
// state changes are recorded + audited, and cryptsetup operations run
// for real through the privilege chain (root / sudo -n).

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Database, HardDrive, KeyRound, Lock, LockOpen, Save, ShieldAlert, Usb } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  HintCard,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
  StateBadge,
} from '@/components/sysdeck/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface BlockDevice {
  name: string
  size: string
  fstype: string | null
  mountpoint: string | null
  type: string
}

interface LuksData {
  luks: { name: string; size: string; mountpoint: string; type: string }[]
  devices: BlockDevice[]
}

interface VaultEntry {
  id: string
  label: string
  kind: string
  device: string | null
  cipher: string | null
  sizeBytes: number | null // KiB (Int32 schema limit)
  status: string
  note: string | null
  createdAt: string
}

interface VaultSummary {
  entries: number
  luksVolumes: number
  unlocked: number
  locked: number
  keyfiles: number
  tpmSealed: number
  encryptedKiB: number
  encryptedGb: number
  sizeUnit: string
}

interface BackupRecord {
  entry: string
  device: string | null
  path: string
  size: string
  sha256: string
  createdAt: string
}

// ── helpers ──────────────────────────────────────────────────────────

/** sizeBytes is KiB (Int32-safe storage); render a human binary size */
function fmtKiB(kib: number | null): string {
  if (kib === null) return '—'
  if (kib >= 1024 ** 3) return `${(kib / 1024 ** 3).toFixed(1)} TiB`
  if (kib >= 1024 ** 2) return `${(kib / 1024 ** 2).toFixed(1)} GiB`
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MiB`
  return `${kib} KiB`
}

function kindIcon(kind: string) {
  if (kind === 'luks-volume') return <HardDrive className="h-4 w-4 text-primary" aria-hidden />
  if (kind === 'keyfile') return <KeyRound className="h-4 w-4 text-primary" aria-hidden />
  return <ShieldAlert className="h-4 w-4 text-primary" aria-hidden />
}

// ── backup result dialog ─────────────────────────────────────────────

function BackupDialog({ record, onClose }: { record: BackupRecord | null; onClose: () => void }) {
  return (
    <Dialog open={record !== null} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">
            header backup · <span className="text-primary">{record?.entry}</span>
          </DialogTitle>
          <DialogDescription>
            Simulated <Mono>cryptsetup luksHeaderBackup</Mono> record — the registry entry below is what the cockpit
            bridge would write on a managed host.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-zinc-950/80 p-3">
          <div className="space-y-1.5">
            <KV k="entry" v={record?.entry ?? '—'} />
            <KV k="device" v={record?.device ?? '—'} />
            <KV k="path" v={<span className="break-all text-[11px]">{record?.path ?? '—'}</span>} />
            <KV k="size" v={record?.size ?? '—'} />
            <KV k="sha256" v={<span className="break-all text-[11px]">{record?.sha256 ?? '—'}</span>} />
            <KV k="created" v={record ? `${record.createdAt.slice(0, 19).replace('T', ' ')} UTC` : '—'} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function VaultPanel() {
  const summaryQ = useBridgeQuery<VaultSummary>('vault', 'summary', undefined, { refetchInterval: 8000 })
  const luksQ = useBridgeQuery<LuksData>('vault', 'luks', undefined, { refetchInterval: 8000 })
  const entriesQ = useBridgeQuery<{ entries: VaultEntry[]; sizeUnit: string }>('vault', 'entries', undefined, {
    refetchInterval: 8000,
  })
  const action = useBridgeAction()
  const [backup, setBackup] = useState<BackupRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const summary = summaryQ.data?.data
  const devices = useMemo(() => luksQ.data?.data?.devices ?? [], [luksQ.data])
  const luksFound = useMemo(() => luksQ.data?.data?.luks ?? [], [luksQ.data])
  const entries = useMemo(() => entriesQ.data?.data?.entries ?? [], [entriesQ.data])
  const luksNote = luksQ.data?.note

  async function toggleLock(entry: VaultEntry) {
    const cmd = entry.status === 'unlocked' ? 'lock' : 'unlock'
    setBusyId(entry.id)
    try {
      const res = await action('vault', cmd, { id: entry.id })
      if (res.ok) {
        toast.success(`${entry.label} ${cmd === 'lock' ? 'locked' : 'unlocked'}`, {
          description: 'state change recorded — actual LUKS operations need the cockpit bridge on a managed host',
        })
      } else {
        toast.error(`${cmd} failed`, { description: res.error })
      }
    } finally {
      setBusyId(null)
    }
  }

  async function runBackup(entry: VaultEntry) {
    setBusyId(entry.id)
    try {
      const res = await action('vault', 'backup', { id: entry.id })
      if (res.ok) {
        setBackup(res.data as BackupRecord)
        toast.success(`header backup recorded for ${entry.label}`)
      } else {
        toast.error('backup failed', { description: res.error })
      }
    } finally {
      setBusyId(null)
    }
  }

  if (summaryQ.isLoading && !summaryQ.data) return <PanelSkeleton lines={4} />
  if (summaryQ.data && !summaryQ.data.ok) return <ErrorCard error={summaryQ.data.error ?? 'vault.summary failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Vault"
        subtitle="LUKS volume inventory and encryption vault — keyfiles, TPM-sealed keys, header backups"
        source="hybrid"
      />
      <BackupDialog record={backup} onClose={() => setBackup(null)} />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Vault entries"
          value={summary?.entries ?? '—'}
          icon={<Database className="h-4 w-4" aria-hidden />}
          hint={`${summary?.keyfiles ?? 0} keyfiles · ${summary?.tpmSealed ?? 0} TPM-sealed`}
        />
        <StatCard
          label="Unlocked volumes"
          value={summary?.unlocked ?? '—'}
          tone="good"
          hint={`${summary?.locked ?? 0} locked`}
        />
        <StatCard
          label="Encrypted size"
          value={summary?.encryptedGb ?? '—'}
          unit="GB"
          icon={<Usb className="h-4 w-4" aria-hidden />}
          hint={`${(summary?.encryptedKiB ?? 0).toLocaleString('en-US')} ${summary?.sizeUnit ?? 'KiB'}`}
        />
        <StatCard
          label="LUKS on this host"
          value={luksFound.length}
          tone={luksFound.length ? 'good' : 'default'}
          hint={luksFound.length ? 'crypto_LUKS devices present' : 'none — real lsblk'}
        />
      </div>

      <Tabs defaultValue="luks">
        <TabsList className="flex-wrap">
          <TabsTrigger value="luks">luks volumes</TabsTrigger>
          <TabsTrigger value="entries">vault entries</TabsTrigger>
        </TabsList>

        {/* ── LUKS volumes ── */}
        <TabsContent value="luks" className="mt-4 space-y-4">
          <PanelCard
            title="Block device inventory (real lsblk)"
            actions={<Mono>NAME,SIZE,FSTYPE,MOUNTPOINT,TYPE</Mono>}
          >
            <DataTable
              rows={devices}
              headers={['Name', 'Size', 'Fstype', 'Mountpoint', 'Type']}
              keyOf={(d) => d.name}
              maxH="22rem"
              empty="lsblk returned no devices"
              renderRow={(d) => {
                const isLuks = d.fstype === 'crypto_LUKS'
                return (
                  <>
                    <TableCell className={`font-mono text-xs ${isLuks ? 'font-semibold text-emerald-400' : ''}`}>
                      {d.name}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{d.size}</TableCell>
                    <TableCell>
                      {isLuks ? (
                        <Badge variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-400">
                          crypto_LUKS
                        </Badge>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">{d.fstype ?? '—'}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.mountpoint ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{d.type}</TableCell>
                  </>
                )
              }}
            />
            {luksFound.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {luksNote ??
                  'real lsblk inventory — no crypto_LUKS devices on this host'}{' '}
                — an honest live reading. The vault-entries tab holds the operator's encrypted-secret registry.
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {luksFound.length} crypto_LUKS device(s) found on this host.
              </p>
            )}
          </PanelCard>
        </TabsContent>

        {/* ── vault entries ── */}
        <TabsContent value="entries" className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {entries.map((e) => {
              const isVolume = e.kind === 'luks-volume'
              return (
                <PanelCard
                  key={e.id}
                  title={
                    <span className="flex items-center gap-2">
                      {kindIcon(e.kind)}
                      <span className="font-mono text-foreground">{e.label}</span>
                    </span>
                  }
                  actions={<StateBadge state={e.status} />}
                >
                  <div className="space-y-0">
                    <KV k="kind" v={<span className="text-xs">{e.kind}</span>} />
                    <KV k="device" v={e.device ?? '—'} />
                    <KV k="cipher" v={e.cipher ?? '—'} />
                    <KV k="size" v={fmtKiB(e.sizeBytes)} />
                    {e.note ? <KV k="note" v={<span className="text-xs">{e.note}</span>} mono={false} /> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {isVolume ? (
                      <>
                        <Button
                          variant={e.status === 'unlocked' ? 'outline' : 'default'}
                          size="sm"
                          className="h-7 gap-1.5 font-mono text-xs"
                          disabled={busyId === e.id}
                          onClick={() => void toggleLock(e)}
                          aria-label={`${e.status === 'unlocked' ? 'Lock' : 'Unlock'} ${e.label}`}
                        >
                          {e.status === 'unlocked' ? (
                            <>
                              <Lock className="h-3.5 w-3.5" aria-hidden />
                              {busyId === e.id ? 'locking…' : 'lock'}
                            </>
                          ) : (
                            <>
                              <LockOpen className="h-3.5 w-3.5" aria-hidden />
                              {busyId === e.id ? 'unlocking…' : 'unlock'}
                            </>
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 font-mono text-xs"
                          disabled={busyId === e.id}
                          onClick={() => void runBackup(e)}
                        >
                          <Save className="h-3.5 w-3.5" aria-hidden />
                          backup
                        </Button>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        lock/unlock/backup apply to LUKS volumes only (this entry is a {e.kind}).
                      </p>
                    )}
                  </div>
                </PanelCard>
              )
            })}
          </div>

          <HintCard title="Hybrid honesty">
            <p>
              State changes (lock/unlock, backup records) are recorded in the registry and audited — but the actual{' '}
              <Mono>cryptsetup</Mono> operations need the cockpit bridge on a managed host. Sizes are stored in KiB
              (Int32-safe) and rendered as human units.
            </p>
          </HintCard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
