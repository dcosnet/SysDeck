'use client'

// Firewall panel — nftables/iptables ruleset manager.
// Bridge source is DEMO: the registry (rulesets/rules) is persisted in the
// db, template topologies are ported verbatim from the cockpit edition's
// firewall/templates/*.sh, and `apply` runs a dry-run first (the exact nft
// script) before the registry activation — no nft binary exists in this
// sandbox, so kernel-level apply is simulated and honestly labeled.

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Boxes,
  CheckCircle2,
  FilePlus2,
  Flame,
  Layers,
  Play,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
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
  StateBadge,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TableCell } from '@/components/ui/table'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface TemplatePort {
  port: number
  proto: 'tcp' | 'udp'
  dir: 'in' | 'loopback' | 'blocked'
  comment: string
}

interface FwTemplate {
  id: string
  name: string
  description: string
  backend: string
  ports: TemplatePort[]
}

interface RulesetRow {
  id: string
  name: string
  backend: string
  template: string | null
  active: boolean
  appliedAt: string | null
  ruleCount: number
}

interface FwRule {
  id: string
  ruleset: string
  chain: string
  action: string
  proto: string
  port: string | null
  source: string | null
  comment: string | null
  position: number
}

interface RulesResponse {
  ruleset: { name: string; backend: string; template: string | null; active: boolean; appliedAt: string | null }
  rules: FwRule[]
  count: number
}

// ── helpers ──────────────────────────────────────────────────────────

const BACKENDS = ['nftables', 'iptables', 'firewalld', 'sysdeck-fw', 'cilium'] as const
const CHAINS = ['INPUT', 'FORWARD', 'OUTPUT', 'POLICY'] as const
const ACTIONS = ['accept', 'drop', 'reject', 'log'] as const
const PROTOS = ['tcp', 'udp', 'any'] as const

function fmtUtc(iso: string | null): string {
  if (!iso) return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function actionBadgeCls(action: string): string {
  if (action === 'accept') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  if (action === 'drop' || action === 'reject') return 'bg-red-500/15 text-red-500 border-red-500/30'
  return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
}

function dirBadgeCls(dir: string): string {
  if (dir === 'in') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  if (dir === 'loopback') return 'bg-teal-500/15 text-teal-400 border-teal-500/30'
  return 'bg-red-500/15 text-red-500 border-red-500/30'
}

// ── add-rule form (used inside a ruleset card) ───────────────────────

function AddRuleForm({ ruleset, onAdd }: { ruleset: string; onAdd: (args: Record<string, unknown>) => Promise<void> }) {
  const [chain, setChain] = useState<string>('INPUT')
  const [action, setAction] = useState<string>('accept')
  const [proto, setProto] = useState<string>('tcp')
  const [port, setPort] = useState('')
  const [source, setSource] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  const portOk = port === '' || /^\d+([:-]\d+)?$/.test(port)
  const sourceOk = source === '' || /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(source)
  const valid = portOk && sourceOk

  async function submit() {
    setBusy(true)
    try {
      await onAdd({
        ruleset,
        chain,
        action,
        proto,
        port: port || undefined,
        source: source || undefined,
        comment: comment || undefined,
      })
      setPort('')
      setSource('')
      setComment('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-md border border-border/60 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <FilePlus2 className="h-3 w-3" aria-hidden />
        add rule to {ruleset}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Chain</Label>
          <Select value={chain} onValueChange={setChain}>
            <SelectTrigger aria-label="Chain" className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHAINS.map((c) => (
                <SelectItem key={c} value={c} className="font-mono text-xs">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger aria-label="Action" className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a} className="font-mono text-xs">
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Proto</Label>
          <Select value={proto} onValueChange={setProto}>
            <SelectTrigger aria-label="Protocol" className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROTOS.map((p) => (
                <SelectItem key={p} value={p} className="font-mono text-xs">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ar-port-${ruleset}`} className="text-[10px] text-muted-foreground">
            Port
          </Label>
          <Input
            id={`ar-port-${ruleset}`}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="443 / 3000:3100"
            className={`h-8 font-mono text-xs ${portOk ? '' : 'border-red-500'}`}
            aria-invalid={!portOk}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ar-src-${ruleset}`} className="text-[10px] text-muted-foreground">
            Source
          </Label>
          <Input
            id={`ar-src-${ruleset}`}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="192.168.1.0/24"
            className={`h-8 font-mono text-xs ${sourceOk ? '' : 'border-red-500'}`}
            aria-invalid={!sourceOk}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`ar-cmt-${ruleset}`} className="text-[10px] text-muted-foreground">
            Comment
          </Label>
          <Input
            id={`ar-cmt-${ruleset}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="who/why"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={!valid || busy} onClick={() => void submit()} className="gap-1.5 font-mono text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {busy ? 'adding…' : 'add rule'}
        </Button>
      </div>
    </div>
  )
}

// ── rules table for one ruleset (own query, own delete/add) ──────────

function RulesetRulesCard({
  ruleset,
  onDeleteRule,
  onAddRule,
}: {
  ruleset: string
  onDeleteRule: (rule: FwRule) => Promise<void>
  onAddRule: (args: Record<string, unknown>) => Promise<void>
}) {
  const q = useBridgeQuery<RulesResponse>('firewall', 'rules', { ruleset }, { staleTime: 3000 })
  const data = q.data?.data

  if (q.isLoading && !q.data) {
    return <p className="py-3 text-center text-xs text-muted-foreground">loading rules…</p>
  }
  if (q.data && !q.data.ok) return <ErrorCard error={q.data.error ?? 'firewall.rules failed'} />

  return (
    <div>
      <DataTable
        rows={data?.rules ?? []}
        headers={['#', 'Chain', 'Action', 'Proto', 'Port', 'Source', 'Comment', '']}
        keyOf={(r) => r.id}
        maxH="20rem"
        empty="no rules in this ruleset"
        renderRow={(r) => (
          <>
            <TableCell className="font-mono text-xs text-muted-foreground">{r.position}</TableCell>
            <TableCell className="font-mono text-xs">{r.chain}</TableCell>
            <TableCell>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${actionBadgeCls(r.action)}`}>
                {r.action}
              </span>
            </TableCell>
            <TableCell className="font-mono text-xs">{r.proto}</TableCell>
            <TableCell className="font-mono text-xs">{r.port ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="font-mono text-xs">{r.source ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={r.comment ?? undefined}>
              {r.comment ?? '—'}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-red-500"
                aria-label={`Delete rule ${r.position} from ${ruleset}`}
                title="delete rule"
                onClick={() => void onDeleteRule(r)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </TableCell>
          </>
        )}
      />
      <AddRuleForm ruleset={ruleset} onAdd={onAddRule} />
    </div>
  )
}

// ── apply flow: dry-run script dialog → confirm apply ────────────────

function ApplyDialog({ name, onApply }: { name: string; onApply: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [script, setScript] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ backend: string; rules: number } | null>(null)
  const [busy, setBusy] = useState(false)

  async function startDryRun() {
    setBusy(true)
    setScript(null)
    try {
      const res = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'firewall', command: 'apply', args: { name, dryRun: true } }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string; data?: { script: string; backend: string; rules: number } }
      if (!json.ok || !json.data) {
        toast.error('dry-run failed', { description: json.error ?? 'firewall.apply failed' })
        return
      }
      setScript(json.data.script)
      setMeta({ backend: json.data.backend, rules: json.data.rules })
      setOpen(true)
    } catch (err) {
      toast.error('dry-run failed', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function confirmApply() {
    setBusy(true)
    try {
      await onApply(name)
      setOpen(false)
      setScript(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 font-mono text-xs"
        disabled={busy}
        onClick={() => void startDryRun()}
      >
        <Play className="h-3.5 w-3.5" aria-hidden />
        {busy && script === null ? 'generating…' : 'apply'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono">
              dry run: <span className="text-primary">{name}</span>
            </DialogTitle>
            <DialogDescription>
              The exact script that would be loaded{' '}
              {meta ? (
                <>
                  (<Mono>{meta.backend}</Mono>, {meta.rules} rules)
                </>
              ) : null}
              . Inspect it, then confirm the apply.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80 rounded-md bg-zinc-950/80 p-1">
            <pre className="p-3 font-mono text-xs leading-relaxed text-zinc-300">{script ?? ''}</pre>
          </ScrollArea>
          <p className="text-xs text-muted-foreground">
            Confirming activates this ruleset in the registry (and deactivates the previously active one). On this
            sandbox the nft/iptables load itself is simulated — the kernel never changes here.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void confirmApply()} className="gap-1.5">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {busy ? 'applying…' : 'Confirm apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── create ruleset from template ─────────────────────────────────────

function CreateRulesetDialog({
  templates,
  onCreate,
}: {
  templates: FwTemplate[]
  onCreate: (args: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [backend, setBackend] = useState<string>('nftables')
  const [template, setTemplate] = useState<string>('__none__')
  const [busy, setBusy] = useState(false)

  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)

  async function submit() {
    setBusy(true)
    try {
      await onCreate({ name, backend, template: template === '__none__' ? undefined : template })
      setOpen(false)
      setName('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 font-mono text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          create ruleset
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Create ruleset</DialogTitle>
          <DialogDescription>
            Registers a new ruleset in the db. Starting from a template copies its rule rows; empty rulesets start with
            zero rules and are built rule-by-rule.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fw-name">Name</Label>
            <Input
              id="fw-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="edge-fleet-2"
              className={`font-mono ${valid || name === '' ? '' : 'border-red-500'}`}
              aria-invalid={!valid && name !== ''}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Backend</Label>
              <Select value={backend} onValueChange={setBackend}>
                <SelectTrigger aria-label="Backend" className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BACKENDS.map((b) => (
                    <SelectItem key={b} value={b} className="font-mono text-xs">
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Template</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger aria-label="Template" className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="font-mono text-xs">
                    (empty)
                  </SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="font-mono text-xs">
                      {t.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {template !== '__none__' ? (
            <p className="text-xs text-muted-foreground">
              copies {templates.find((t) => t.id === template)?.ports.length ?? 0} port declarations /{' '}
              {templates.find((t) => t.id === template)?.backend ?? ''} template rules into the new ruleset
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'creating…' : 'Create ruleset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── panel ────────────────────────────────────────────────────────────

export default function FirewallPanel() {
  const rulesetsQ = useBridgeQuery<{ rulesets: RulesetRow[]; count: number }>('firewall', 'rulesets', undefined, {
    refetchInterval: 8000,
  })
  const templatesQ = useBridgeQuery<{ templates: FwTemplate[]; count: number }>('firewall', 'templates')
  const action = useBridgeAction()
  const [expanded, setExpanded] = useState<string | null>(null)

  const rulesets = useMemo(() => rulesetsQ.data?.data?.rulesets ?? [], [rulesetsQ.data])
  const templates = useMemo(() => templatesQ.data?.data?.templates ?? [], [templatesQ.data])
  const activeRuleset = useMemo(() => rulesets.find((r) => r.active) ?? null, [rulesets])
  const rulesTotal = useMemo(() => rulesets.reduce((n, r) => n + r.ruleCount, 0), [rulesets])

  async function applyRuleset(name: string) {
    const res = await action('firewall', 'apply', { name })
    if (res.ok) {
      toast.success(`ruleset ${name} applied`, {
        description: 'activated in the registry — the nft load is simulated on this host',
      })
    } else {
      toast.error('apply failed', { description: res.error })
    }
  }

  async function deleteRuleset(rs: RulesetRow) {
    const res = await action('firewall', 'delete', { name: rs.name })
    if (res.ok) {
      toast.success(`ruleset ${rs.name} deleted`, { description: 'all its rules were removed too'})
      if (expanded === rs.name) setExpanded(null)
    } else {
      toast.error('delete refused', { description: res.error })
    }
  }

  async function createRuleset(args: Record<string, unknown>) {
    const res = await action('firewall', 'create', args)
    if (res.ok) {
      toast.success(`ruleset ${String(args.name)} created`, {
        description: res.data && typeof res.data === 'object' && 'rules' in res.data
          ? `${(res.data as { rules: number }).rules} rules copied from the template`
          : 'empty ruleset — add rules rule-by-rule',
      })
    } else {
      toast.error('create failed', { description: res.error })
    }
  }

  async function addRule(args: Record<string, unknown>) {
    const res = await action('firewall', 'addRule', args)
    if (res.ok) {
      toast.success('rule added', {
        description: `${String(args.chain)} ${String(args.action)} ${String(args.proto)}${
          args.port ? ` dport ${String(args.port)}` : ''
        } → ${String(args.ruleset)}`,
      })
    } else {
      toast.error('addRule failed', { description: res.error })
    }
  }

  async function deleteRule(rule: FwRule) {
    const res = await action('firewall', 'deleteRule', { id: rule.id })
    if (res.ok) {
      toast.success(`rule #${rule.position} removed from ${rule.ruleset}`)
    } else {
      toast.error('deleteRule failed', { description: res.error })
    }
  }

  if (rulesetsQ.isLoading && !rulesetsQ.data) return <PanelSkeleton lines={4} />
  if (rulesetsQ.data && !rulesetsQ.data.ok) return <ErrorCard error={rulesetsQ.data.error ?? 'firewall.rulesets failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Firewall"
        subtitle="nftables/iptables ruleset manager — 7 real topologies ported verbatim from the cockpit edition's firewall/templates/*.sh"
        source="demo"
        actions={<CreateRulesetDialog templates={templates} onCreate={createRuleset} />}
      />

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">overview</TabsTrigger>
          <TabsTrigger value="rulesets">rulesets</TabsTrigger>
          <TabsTrigger value="templates">templates</TabsTrigger>
        </TabsList>

        {/* ── overview ── */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Rulesets"
              value={rulesets.length}
              icon={<Layers className="h-4 w-4" aria-hidden />}
              hint="registered in the db"
            />
            <StatCard
              label="Active"
              value={activeRuleset ? activeRuleset.name : 'none'}
              tone="good"
              hint={activeRuleset ? `applied ${fmtUtc(activeRuleset.appliedAt)}` : 'no ruleset activated'}
            />
            <StatCard label="Rules total" value={rulesTotal} icon={<Boxes className="h-4 w-4" aria-hidden />} hint="across all rulesets" />
            <StatCard
              label="Templates"
              value={templates.length}
              icon={<ScrollText className="h-4 w-4" aria-hidden />}
              hint="topology catalog"
            />
          </div>

          <PanelCard
            title={
              activeRuleset ? (
                <span className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-primary" aria-hidden />
                  active ruleset · {activeRuleset.name}
                </span>
              ) : (
                'active ruleset'
              )
            }
            actions={activeRuleset ? <StateBadge state="active" /> : null}
          >
            {activeRuleset ? (
              <RulesetRulesCard ruleset={activeRuleset.name} onDeleteRule={deleteRule} onAddRule={addRule} />
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                no ruleset is active — pick one in the rulesets tab and run apply
              </p>
            )}
          </PanelCard>

          <HintCard title="Honesty note">
            <p>
              Ruleset state is persisted (rulesets, rules, activation, apply history in the audit log) — but the actual{' '}
              <Mono>nft</Mono>/<Mono>iptables-restore</Mono> load is simulated on this host: no nft binary exists in this
              sandbox. The dry-run scripts are the exact syntax the cockpit bridge would load on a managed host.
            </p>
          </HintCard>
        </TabsContent>

        {/* ── rulesets ── */}
        <TabsContent value="rulesets" className="mt-4 space-y-4">
          {rulesets.length === 0 ? (
            <PanelCard>
              <p className="py-4 text-center text-sm text-muted-foreground">no rulesets — create one from a template</p>
            </PanelCard>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {rulesets.map((rs) => (
                <PanelCard
                  key={rs.id}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-foreground">{rs.name}</span>
                      {rs.active ? <StateBadge state="active" /> : null}
                    </span>
                  }
                  actions={<Badge variant="outline" className="font-mono text-[10px]">{rs.backend}</Badge>}
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      <span className="text-muted-foreground">
                        template: <Mono>{rs.template ?? '(none)'}</Mono>
                      </span>
                      <span className="text-muted-foreground">
                        rules: <Mono>{rs.ruleCount}</Mono>
                      </span>
                      <span className="text-muted-foreground">
                        applied: <Mono>{fmtUtc(rs.appliedAt)}</Mono>
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 font-mono text-xs"
                        onClick={() => setExpanded(expanded === rs.name ? null : rs.name)}
                        aria-expanded={expanded === rs.name}
                      >
                        {expanded === rs.name ? 'hide rules' : 'view rules'}
                      </Button>
                      <ApplyDialog name={rs.name} onApply={applyRuleset} />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 font-mono text-xs text-muted-foreground hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            delete
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="font-mono">
                              delete ruleset {rs.name}?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the ruleset and all {rs.ruleCount} of its rules from the registry. Active
                              rulesets are refused by the bridge — deactivate first by applying another ruleset.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-red-600 text-white hover:bg-red-700"
                              onClick={() => void deleteRuleset(rs)}
                            >
                              Delete ruleset
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                    {expanded === rs.name ? (
                      <RulesetRulesCard ruleset={rs.name} onDeleteRule={deleteRule} onAddRule={addRule} />
                    ) : null}
                  </div>
                </PanelCard>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── templates ── */}
        <TabsContent value="templates" className="mt-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {templates.map((t) => (
              <PanelCard
                key={t.id}
                title={
                  <span className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
                    <span className="font-mono text-foreground">{t.id}</span>
                  </span>
                }
                actions={<Badge variant="outline" className="font-mono text-[10px]">{t.backend}</Badge>}
              >
                <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                <div className="mt-3">
                  <DataTable
                    rows={t.ports}
                    headers={['Port', 'Proto', 'Dir', 'Comment']}
                    keyOf={(p) => `${t.id}-${p.port}-${p.proto}`}
                    maxH="18rem"
                    empty="no declared ports"
                    renderRow={(p) => (
                      <>
                        <TableCell className="font-mono text-xs tabular-nums">{p.port}</TableCell>
                        <TableCell className="font-mono text-xs">{p.proto}</TableCell>
                        <TableCell>
                          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${dirBadgeCls(p.dir)}`}>
                            {p.dir}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{p.comment}</TableCell>
                      </>
                    )}
                  />
                </div>
              </PanelCard>
            ))}
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            templates carry the v0.0.47/v0.0.44 tarball topologies verbatim — port directions reflect each header&apos;s
            public/loopback/blocked exposure decisions.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
