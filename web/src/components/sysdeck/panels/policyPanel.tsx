'use client'

// Policy panel — polkit-style allow/deny rule registry over the
// org.sysdeck.* scope catalog, with a full audit trail. Scopes are parsed
// from the REAL .policy XML files; the rules registry is the operator's
// workspace; sync materializes it into /etc/polkit-1/rules.d/
// 40-sysdeck.rules (privilege-gated) — the same scope/subject/effect/
// priority semantics the cockpit edition enforced.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckSquare, Gavel, ListChecks, Plus, ScrollText, ShieldCheck, Square, Trash2 } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  StatCard,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface PolicyRule {
  id: string
  scope: string
  subject: string
  effect: 'allow' | 'deny'
  priority: number
  enabled: boolean
  note: string | null
}

interface ScopeRow {
  scope: string
  description: string
}

interface AuditEntry {
  id: string
  ts: string
  module: string
  action: string
  detail: string
  actor: string
}

// ── helpers ──────────────────────────────────────────────────────────

const SUBJECT_RE = /^(unix-user|group|netgroup|user):[a-zA-Z0-9._-]+$/

function fmtUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function effectBadge(effect: string) {
  if (effect === 'allow') {
    return (
      <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
        allow
      </span>
    )
  }
  return (
    <span className="rounded border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-red-500">
      deny
    </span>
  )
}

interface RuleForm {
  scope: string
  subject: string
  effect: string
  priority: string
  note: string
}

function RuleFormFields({
  value,
  onChange,
  scopes,
}: {
  value: RuleForm
  onChange: (v: RuleForm) => void
  scopes: ScopeRow[]
}) {
  const subjectOk = SUBJECT_RE.test(value.subject)
  const priorityOk = /^\d+$/.test(value.priority) && Number(value.priority) >= 0 && Number(value.priority) <= 100
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Scope</Label>
        <Select value={value.scope} onValueChange={(scope) => onChange({ ...value, scope })}>
          <SelectTrigger aria-label="Scope" className="font-mono text-xs">
            <SelectValue placeholder="org.sysdeck…" />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {scopes.map((s) => (
              <SelectItem key={s.scope} value={s.scope} className="font-mono text-xs">
                {s.scope}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {scopes.find((s) => s.scope === value.scope)?.description ?? 'pick a scope from the catalog'}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="pl-subject">Subject</Label>
          <Input
            id="pl-subject"
            value={value.subject}
            onChange={(e) => onChange({ ...value, subject: e.target.value })}
            placeholder="unix-user:jeremy"
            className={`font-mono text-xs ${subjectOk || value.subject === '' ? '' : 'border-red-500'}`}
            aria-invalid={!subjectOk && value.subject !== ''}
          />
          {!subjectOk && value.subject !== '' ? (
            <p className="text-[10px] text-red-500">unix-user:&lt;name&gt; · group:&lt;name&gt; · netgroup:&lt;name&gt;</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pl-priority">Priority</Label>
          <Input
            id="pl-priority"
            value={value.priority}
            onChange={(e) => onChange({ ...value, priority: e.target.value })}
            inputMode="numeric"
            className={`font-mono text-xs ${priorityOk || value.priority === '' ? '' : 'border-red-500'}`}
            aria-invalid={!priorityOk && value.priority !== ''}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Effect</Label>
        <Select value={value.effect} onValueChange={(effect) => onChange({ ...value, effect })}>
          <SelectTrigger aria-label="Effect" className="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow" className="font-mono text-xs">
              allow
            </SelectItem>
            <SelectItem value="deny" className="font-mono text-xs">
              deny
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">higher priority wins on conflicting rules (0–100)</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pl-note">Note (optional)</Label>
        <Input
          id="pl-note"
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
          placeholder="why this rule exists"
          className="text-xs"
        />
      </div>
    </div>
  )
}

function formValid(f: RuleForm): boolean {
  return f.scope !== '' && SUBJECT_RE.test(f.subject) && /^\d+$/.test(f.priority) && Number(f.priority) <= 100
}

// ── create dialog ────────────────────────────────────────────────────

function CreateRuleDialog({
  scopes,
  onCreate,
}: {
  scopes: ScopeRow[]
  onCreate: (args: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<RuleForm>({
    scope: scopes[0]?.scope ?? '',
    subject: '',
    effect: 'allow',
    priority: '50',
    note: '',
  })

  async function submit() {
    setBusy(true)
    try {
      await onCreate({
        scope: form.scope,
        subject: form.subject,
        effect: form.effect,
        priority: Number(form.priority),
        note: form.note || undefined,
      })
      setOpen(false)
      setForm({ scope: form.scope, subject: '', effect: form.effect, priority: form.priority, note: '' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 font-mono text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          create rule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Create policy rule</DialogTitle>
          <DialogDescription>
            polkit-style rule — the cockpit edition enforced these through <Mono>org.sysdeck.*</Mono> actions; here they
            persist in the registry with full audit history.
          </DialogDescription>
        </DialogHeader>
        <RuleFormFields value={form} onChange={setForm} scopes={scopes} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!formValid(form) || busy} onClick={() => void submit()}>
            {busy ? 'creating…' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── edit dialog ──────────────────────────────────────────────────────

function EditRuleDialog({
  rule,
  scopes,
  onUpdate,
}: {
  rule: PolicyRule
  scopes: ScopeRow[]
  onUpdate: (id: string, args: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<RuleForm>({
    scope: rule.scope,
    subject: rule.subject,
    effect: rule.effect,
    priority: String(rule.priority),
    note: rule.note ?? '',
  })

  async function submit() {
    setBusy(true)
    try {
      await onUpdate(rule.id, {
        subject: form.subject,
        effect: form.effect,
        priority: Number(form.priority),
        note: form.note,
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" aria-label={`Edit rule ${rule.scope} ${rule.subject}`} title="edit rule">
          <Gavel className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Edit rule</DialogTitle>
          <DialogDescription>
            <Mono>{rule.scope}</Mono> — the scope is fixed; subject, effect, priority and note are mutable.
          </DialogDescription>
        </DialogHeader>
        <RuleFormFields value={form} onChange={setForm} scopes={scopes} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!formValid(form) || busy} onClick={() => void submit()}>
            {busy ? 'saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function PolicyPanel() {
  const rulesQ = useBridgeQuery<{ rules: PolicyRule[]; count: number }>('policy', 'rules', undefined, {
    refetchInterval: 8000,
  })
  const scopesQ = useBridgeQuery<{ scopes: ScopeRow[]; count: number }>('policy', 'scopes')
  const auditQ = useBridgeQuery<{ entries: AuditEntry[]; count: number }>('policy', 'audit', undefined, {
    refetchInterval: 8000,
  })
  const action = useBridgeAction()

  const rules = useMemo(() => rulesQ.data?.data?.rules ?? [], [rulesQ.data])
  const scopes = useMemo(() => scopesQ.data?.data?.scopes ?? [], [scopesQ.data])
  const audit = useMemo(() => (auditQ.data?.data?.entries ?? []).slice(0, 30), [auditQ.data])
  const allows = rules.filter((r) => r.effect === 'allow').length
  const denies = rules.filter((r) => r.effect === 'deny').length
  const enabled = rules.filter((r) => r.enabled).length

  async function createRule(args: Record<string, unknown>) {
    const res = await action('policy', 'create', args)
    if (res.ok) {
      toast.success('rule created', {
        description: `${String(args.effect)} ${String(args.scope)} for ${String(args.subject)} (priority ${String(args.priority)})`,
      })
    } else {
      toast.error('create failed', { description: res.error })
    }
  }

  async function updateRule(id: string, args: Record<string, unknown>) {
    const res = await action('policy', 'update', { id, ...args })
    if (res.ok) {
      toast.success('rule updated', {
        description: Object.entries(args)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' · '),
      })
    } else {
      toast.error('update failed', { description: res.error })
    }
  }

  async function deleteRule(rule: PolicyRule) {
    const res = await action('policy', 'delete', { id: rule.id })
    if (res.ok) {
      toast.success(`rule deleted`, {
        description: `${rule.effect} ${rule.scope} for ${rule.subject} removed`,
      })
    } else {
      toast.error('delete failed', { description: res.error })
    }
  }

  async function toggleRule(rule: PolicyRule) {
    const res = await action('policy', 'toggle', { id: rule.id })
    if (res.ok) {
      toast.success(rule.enabled ? 'rule disabled' : 'rule enabled', {
        description: `${rule.scope} · ${rule.subject}`,
      })
    } else {
      toast.error('toggle failed', { description: res.error })
    }
  }

  if (rulesQ.isLoading && !rulesQ.data) return <PanelSkeleton lines={4} />
  if (rulesQ.data && !rulesQ.data.ok) return <ErrorCard error={rulesQ.data.error ?? 'policy.rules failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Policy"
        subtitle="polkit-style allow/deny rules over the org.sysdeck.* scope catalog — who may do what"
        source={scopesQ.data?.source ?? 'live'}
        actions={<CreateRuleDialog scopes={scopes} onCreate={createRule} />}
      />

      {/* stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Rules" value={rules.length} icon={<ListChecks className="h-4 w-4" aria-hidden />} hint="ordered by priority desc" />
        <StatCard label="Allow" value={allows} tone="good" icon={<CheckSquare className="h-4 w-4" aria-hidden />} />
        <StatCard label="Deny" value={denies} tone={denies ? 'bad' : 'default'} icon={<Square className="h-4 w-4" aria-hidden />} />
        <StatCard
          label="Enabled"
          value={`${enabled}/${rules.length}`}
          tone={enabled === rules.length ? 'good' : 'warn'}
          icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
          hint={enabled === rules.length ? 'all rules active' : `${rules.length - enabled} disabled`}
        />
      </div>

      <Tabs defaultValue="rules">
        <TabsList className="flex-wrap">
          <TabsTrigger value="rules">rules</TabsTrigger>
          <TabsTrigger value="audit">audit log</TabsTrigger>
        </TabsList>

        {/* ── rules ── */}
        <TabsContent value="rules" className="mt-4 space-y-4">
          <PanelCard title="Rule registry" actions={<Mono>priority desc</Mono>}>
            <DataTable
              rows={rules}
              headers={['Scope', 'Subject', 'Effect', 'Priority', 'Note', 'On', '']}
              keyOf={(r) => r.id}
              maxH="26rem"
              empty="no rules — create one from the catalog"
              renderRow={(r) => (
                <>
                  <TableCell className="font-mono text-xs">{r.scope}</TableCell>
                  <TableCell className={`font-mono text-xs ${r.enabled ? '' : 'text-muted-foreground'}`}>
                    {r.subject}
                  </TableCell>
                  <TableCell>{effectBadge(r.effect)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{r.priority}</TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={r.note ?? undefined}>
                    {r.note ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={() => void toggleRule(r)}
                      aria-label={`Toggle rule ${r.scope} ${r.subject}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <EditRuleDialog rule={r} scopes={scopes} onUpdate={updateRule} />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-red-500"
                            aria-label={`Delete rule ${r.scope} ${r.subject}`}
                            title="delete rule"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="font-mono">
                              delete this {r.effect} rule?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              <Mono>{r.scope}</Mono> for <Mono>{r.subject}</Mono>
                              {r.note ? ` — ${r.note}` : ''} will be removed from the registry. The action is audited.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => void deleteRule(r)}>
                              Delete rule
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              effect: allow=emerald · deny=red — conflicting rules resolve by priority (higher wins).
            </p>
          </PanelCard>

          <PanelCard title="Scope catalog" actions={<Mono>{scopes.length} org.sysdeck.* scopes</Mono>}>
            <DataTable
              rows={scopes}
              headers={['Scope', 'Description']}
              keyOf={(s) => s.scope}
              maxH="22rem"
              renderRow={(s) => (
                <>
                  <TableCell className="font-mono text-xs">{s.scope}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.description}</TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        {/* ── audit ── */}
        <TabsContent value="audit" className="mt-4 space-y-4">
          <PanelCard
            title={
              <span className="flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-primary" aria-hidden />
                policy audit log
              </span>
            }
            actions={<Mono>latest {audit.length} (of {auditQ.data?.data?.count ?? 0})</Mono>}
          >
            <DataTable
              rows={audit}
              headers={['When', 'Module', 'Action', 'Detail']}
              keyOf={(e) => e.id}
              maxH="30rem"
              empty="no policy mutations recorded yet"
              renderRow={(e) => (
                <>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{fmtUtc(e.ts)}</TableCell>
                  <TableCell>
                    <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                      {e.module}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="max-w-96 truncate font-mono text-[11px] text-muted-foreground" title={e.detail}>
                    {e.detail}
                  </TableCell>
                </>
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              AuditLog rows where module=policy OR action contains &quot;policy&quot; — every create/update/toggle/delete
              from this panel lands here.
            </p>
          </PanelCard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
