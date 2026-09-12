'use client'

// Auth panel — PKCS#11 smartcard identity (readers, certificates, session).
// LIVE: readers come from the real lsusb device list + pcscd service
// state; certificates from pkcs11-tool --list-certificates when a token
// is present (opensc required), else the operator's real ~/.ssh public
// keys; unlock runs a real `pkcs11-tool --login` against the chosen
// reader. No opensc/pcsc-lite → honest empty inventory + install hints.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CreditCard, IdCard, KeyRound, Lock, LockOpen, ShieldCheck, Smartphone } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface Reader {
  id: string
  name: string
  vendor: string
  slots: number
  pinSupport: string
  present: boolean
}

interface Cert {
  id: string
  label: string
  kind: string
  keyType: string
  subject: string
  notBefore: string
  notAfter: string
  status: 'valid' | 'expiring' | 'expired'
  daysLeft: number
}

interface SessionState {
  loggedIn: boolean
  reader: string | null
  slot: number | null
  mechanism: string | null
  ts: string | null
}

interface SessionsData {
  session: SessionState
  slots: { reader: string; slot: number; token: string }[]
  availableCerts: number
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtUtc(iso: string): string {
  return `${iso.slice(0, 10)}`
}

function certBadge(status: string) {
  if (status === 'expired') {
    return <span className="rounded border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-red-500">expired</span>
  }
  if (status === 'expiring') {
    return <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-500">&lt;30d</span>
  }
  return <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">valid</span>
}

// ── unlock dialog ────────────────────────────────────────────────────

function UnlockDialog({ reader, onUnlock }: { reader: Reader; onUnlock: (pin: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const ok = await onUnlock(pin)
      if (ok) {
        setOpen(false)
        setPin('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 font-mono text-xs">
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          unlock
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono">
            unlock <span className="text-primary">{reader.name}</span>
          </DialogTitle>
          <DialogDescription>
            PKCS#11 <Mono>C_Login</Mono> (CKU_USER, slot 0) — card PIN verification through the real{' '}
            <Mono>pkcs11-tool --login</Mono>. Wrong PINs return the ISO 7816 <Mono>SW=6982</Mono> status word and burn
            an attempt (typically 3 before the card locks — check your token&apos;s PIN policy).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="au-pin">Card PIN</Label>
            <Input
              id="au-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••••"
              className="font-mono tracking-widest"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pin.length > 0 && !busy) void submit()
              }}
            />
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            {reader.id} · {reader.pinSupport}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pin.length === 0 || busy} onClick={() => void submit()}>
            {busy ? 'verifying…' : 'Verify PIN'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function AuthPanel() {
  const readersQ = useBridgeQuery<{ readers: Reader[]; count: number; pcscd: string }>('auth', 'readers', undefined, {
    refetchInterval: 10000,
  })
  const certsQ = useBridgeQuery<{ certs: Cert[]; count: number }>('auth', 'certs', undefined, { refetchInterval: 10000 })
  const sessionsQ = useBridgeQuery<SessionsData>('auth', 'sessions', undefined, { refetchInterval: 8000 })
  const action = useBridgeAction()

  const readers = useMemo(() => readersQ.data?.data?.readers ?? [], [readersQ.data])
  const certs = useMemo(() => certsQ.data?.data?.certs ?? [], [certsQ.data])
  const session = sessionsQ.data?.data?.session
  const slots = sessionsQ.data?.data?.slots ?? []
  const expiringSoon = certs.filter((c) => c.status === 'expiring').length
  const presentReaders = readers.filter((r) => r.present).length

  async function unlock(reader: Reader, pin: string): Promise<boolean> {
    const res = await action('auth', 'unlock', { reader: reader.id, pin })
    if (res.ok) {
      toast.success('PKCS#11 session opened', {
        description: `C_Login CKU_USER on slot 0 — ${reader.name} (${reader.id})`,
      })
      return true
    }
    toast.error('PIN verification failed', {
      description: res.error,
      duration: 8000,
    })
    return false
  }

  async function lockSession() {
    const res = await action('auth', 'lock')
    if (res.ok) {
      toast.success('PKCS#11 session closed', { description: 'the card is locked again' })
    } else {
      toast.error('lock failed', { description: res.error })
    }
  }

  if (readersQ.isLoading && !readersQ.data) return <PanelSkeleton lines={4} />
  if (readersQ.data && !readersQ.data.ok) return <ErrorCard error={readersQ.data.error ?? 'auth.readers failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Smartcard Auth"
        subtitle="PKCS#11 readers, certificates and login sessions — the identity layer the cockpit edition read via opensc"
        source={readersQ.data?.source ?? 'live'}
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Readers"
          value={readers.length}
          icon={<Smartphone className="h-4 w-4" aria-hidden />}
          hint={`${presentReaders} with a card present`}
        />
        <StatCard
          label="Certificates"
          value={certs.length}
          icon={<IdCard className="h-4 w-4" aria-hidden />}
          hint="PIV / openvpn slots"
        />
        <StatCard
          label="Expiring soon"
          value={expiringSoon}
          tone={expiringSoon ? 'warn' : 'good'}
          hint="under 30 days to expiry"
        />
        <StatCard
          label="Session"
          value={session?.loggedIn ? 'OPEN' : 'closed'}
          tone={session?.loggedIn ? 'good' : 'default'}
          icon={<CreditCard className="h-4 w-4" aria-hidden />}
          hint={session?.loggedIn ? session.reader ?? '' : 'no card logged in'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* readers */}
        <div className="space-y-4">
          <PanelCard title="Readers" actions={<Mono>{readersQ.data?.data?.pcscd ?? 'pcscd n/a'}</Mono>}>
            <div className="space-y-3">
              {readers.map((r) => {
                const unlocked = session?.loggedIn && session.reader === r.name
                return (
                  <div key={r.id} className="rounded-md border border-border/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-mono text-sm font-semibold">
                          <CreditCard className="h-4 w-4 text-primary" aria-hidden />
                          {r.name}
                          {unlocked ? <StateBadge state="unlocked" /> : null}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {r.vendor} · <Mono>{r.id}</Mono> · {r.slots} slot{r.slots === 1 ? '' : 's'}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{r.pinSupport}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={r.present ? 'border-emerald-500/30 text-emerald-400' : 'border-zinc-500/30 text-zinc-400'}>
                          {r.present ? 'card present' : 'empty'}
                        </Badge>
                        {r.present ? (
                          unlocked ? null : (
                            <UnlockDialog reader={r} onUnlock={(pin) => unlock(r, pin)} />
                          )
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })}
              {readers.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">no readers detected</p> : null}
            </div>
          </PanelCard>

          <InstallHint
            bin="pkcs11-tool / pcscd"
            distro="debian"
            hint={'apt install opensc pcsc-lite\nsystemctl enable --now pcscd.socket\npkcs11-tool --list-token-slots'}
          />
        </div>

        {/* session + certs */}
        <div className="space-y-4">
          <PanelCard
            title="PKCS#11 session"
            actions={
              session?.loggedIn ? (
                <Button variant="outline" size="sm" className="h-7 gap-1.5 font-mono text-xs" onClick={() => void lockSession()}>
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  lock
                </Button>
              ) : null
            }
          >
            <div>
              <KV k="logged in" v={session?.loggedIn ? <StateBadge state="unlocked" /> : 'no'} mono={false} />
              <KV k="reader" v={session?.reader ?? '—'} />
              <KV k="slot" v={session?.slot ?? '—'} />
              <KV k="mechanism" v={<span className="text-[11px] break-all">{session?.mechanism ?? '—'}</span>} />
              <KV k="since" v={session?.ts ? `${session.ts.slice(0, 19).replace('T', ' ')} UTC` : '—'} />
              <KV k="available certs" v={sessionsQ.data?.data?.availableCerts ?? '—'} />
            </div>
            <div className="mt-3 border-t border-border/50 pt-2">
              <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">token slots</p>
              <DataTable
                rows={slots}
                headers={['Reader', 'Slot', 'Token']}
                keyOf={(s) => `${s.reader}-${s.slot}`}
                maxH="10rem"
                renderRow={(s) => (
                  <>
                    <TableCell className="text-xs">{s.reader}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">{s.slot}</TableCell>
                    <TableCell>
                      <span
                        className={`font-mono text-xs ${s.token === 'present' ? 'text-emerald-400' : 'text-muted-foreground'}`}
                      >
                        {s.token}
                      </span>
                    </TableCell>
                  </>
                )}
              />
            </div>
          </PanelCard>

          <PanelCard
            title="Certificates"
            actions={
              <Mono>
                <ShieldCheck className="mr-1 inline h-3 w-3" aria-hidden />
                {certs.length} on card
              </Mono>
            }
          >
            <DataTable
              rows={certs}
              headers={['Subject', 'Kind', 'Key', 'Valid until', 'Days', 'Status']}
              keyOf={(c) => c.id}
              maxH="24rem"
              renderRow={(c) => (
                <>
                  <TableCell className="max-w-56 truncate font-mono text-xs" title={c.subject}>
                    {c.label}
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-xs text-muted-foreground" title={c.kind}>
                    {c.kind}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.keyType}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {fmtUtc(c.notBefore)} → {fmtUtc(c.notAfter)}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    <span className={c.daysLeft < 30 ? 'text-amber-500' : c.daysLeft < 0 ? 'text-red-500' : ''}>
                      {c.daysLeft}
                    </span>
                  </TableCell>
                  <TableCell>{certBadge(c.status)}</TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              expiring &lt;30d amber · expired red — rows are the token&apos;s real certificates and this account&apos;s
              ~/.ssh public keys, read live.
            </p>
          </PanelCard>
        </div>
      </div>
    </div>
  )
}
