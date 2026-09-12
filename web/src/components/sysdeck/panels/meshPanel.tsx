'use client'

// Mesh panel — kubernetes cluster view (services / deployments / pods).
// The bridge runs the REAL kubectl (`kubectl get services/deployments/
// pods -A -o json`) on every poll; scale runs `kubectl scale`, describe
// and logs run the real `kubectl describe` / `kubectl logs`. Absent
// kubectl or unreachable cluster → an honest zero-count inventory.

import { useState } from 'react'
import { toast } from 'sonner'
import { FileText, Layers, Network, ScrollText, Server, Boxes } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import type { BridgeResponse } from '@/lib/sysdeck/types'
import {
  Bar,
  DataTable,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TableCell } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ── bridge shapes ────────────────────────────────────────────────────

interface MeshSummary {
  nodes: number
  namespaces: number
  services: number
  deployments: number
  pods: number
  readyPct: number
}

interface Svc {
  name: string
  namespace: string
  type: string
  clusterIP: string
  ports: string[]
}

interface Dep {
  name: string
  namespace: string
  replicas: number
  ready: number
  image: string
  strategy: string
}

interface Pod {
  name: string
  namespace: string
  deployment: string | null
  status: 'Running' | 'Pending' | 'CrashLoopBackOff' | 'Completed'
  restarts: number
  node: string | null
  ip: string
  ageS: number
  age: string
}

// ── helpers ──────────────────────────────────────────────────────────

const NS_CLS: Record<string, string> = {
  'kube-system': 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  monitoring: 'border-teal-500/30 bg-teal-500/15 text-teal-400',
  'ingress-nginx': 'border-amber-500/30 bg-amber-500/15 text-amber-500',
  'prod-web': 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
}

function nsBadge(ns: string) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${
        NS_CLS[ns] ?? 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      {ns}
    </span>
  )
}

function podStatusBadge(status: string) {
  const map: Record<string, { cls: string; pulse?: boolean }> = {
    Running: { cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400' },
    Pending: { cls: 'border-amber-500/30 bg-amber-500/15 text-amber-500' },
    CrashLoopBackOff: { cls: 'border-red-500/30 bg-red-500/15 text-red-500', pulse: true },
    Completed: { cls: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-400' },
  }
  const m = map[status] ?? { cls: 'border-border bg-muted/50 text-muted-foreground' }
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${m.cls} ${
        m.pulse ? 'inline-block animate-pulse' : ''
      }`}
    >
      {status}
    </span>
  )
}

// ── scale dialog ─────────────────────────────────────────────────────

function ScaleDialog({
  dep,
  onScale,
}: {
  dep: Dep | null
  onScale: (deployment: string, replicas: number) => Promise<BridgeResponse<unknown>>
}) {
  const [open, setOpen] = useState(false)
  const [replicas, setReplicas] = useState('3')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!dep) return
    const n = Number(replicas)
    if (!Number.isInteger(n) || n < 0 || n > 50) {
      toast.error('replicas must be an integer 0–50')
      return
    }
    setBusy(true)
    try {
      const res = await onScale(dep.name, n)
      if (res.ok) {
        const d = res.data as { pods?: number; delta?: number } | undefined
        toast.success(`scaled ${dep.name} → ${n} replicas`, {
          description: `pods: ${d?.pods ?? '?'} (delta ${d?.delta ?? 0}) — ready recalculated`,
        })
        setOpen(false)
      } else {
        toast.error(`scale ${dep.name} refused`, { description: res.error, duration: 8000 })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && dep) setReplicas(String(dep.replicas))
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 font-mono text-[11px]"
        onClick={() => {
          if (dep) setReplicas(String(dep.replicas))
          setOpen(true)
        }}
        aria-label={`scale ${dep?.name ?? ''}`}
      >
        scale
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono">
            scale — <span className="text-muted-foreground">{dep?.name}</span>
          </DialogTitle>
          <DialogDescription>
            set the replica count (0–50). the bridge creates/removes pod rows and recalculates cluster readiness.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={0}
            max={50}
            value={replicas}
            onChange={(e) => setReplicas(e.target.value)}
            className="w-28 font-mono text-sm"
            aria-label="replicas"
          />
          <span className="text-xs text-muted-foreground">current: {dep?.ready}/{dep?.replicas} ready</span>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy ? 'scaling…' : 'apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── pod dialogs (describe / logs) ────────────────────────────────────

function usePodDialog() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState<string>('')
  const [title, setTitle] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [mode, setMode] = useState<'describe' | 'logs'>('describe')

  return { open, busy, text, title, lines, mode, setOpen, setMode, setTitle, setText, setLines, setBusy }
}

// ── panel ────────────────────────────────────────────────────────────

export default function MeshPanel() {
  const summary = useBridgeQuery<MeshSummary>('mesh', 'summary')
  const services = useBridgeQuery<{ services: Svc[] }>('mesh', 'services', {}, { refetchInterval: 8000 })
  const deployments = useBridgeQuery<{ deployments: Dep[] }>('mesh', 'deployments', {}, { refetchInterval: 8000 })
  const pods = useBridgeQuery<{ pods: Pod[] }>('mesh', 'pods', {}, { refetchInterval: 8000 })
  const action = useBridgeAction()

  const dlg = usePodDialog()
  const [scaleDep, setScaleDep] = useState<Dep | null>(null)

  async function openPod(kind: 'describe' | 'logs', pod: string) {
    dlg.setMode(kind)
    dlg.setTitle(pod)
    dlg.setText('')
    dlg.setLines([])
    dlg.setBusy(true)
    dlg.setOpen(true)
    try {
      const res = await action('mesh', kind, { pod })
      if (res.ok && res.data) {
        const d = res.data as { text?: string; lines?: string[] }
        dlg.setText(d.text ?? '')
        dlg.setLines(d.lines ?? [])
        const lineCount = d.text ? d.text.split('\n').length : (d.lines?.length ?? 0)
        toast.success(`${kind} — ${pod}`, { description: `${lineCount} lines` })
      } else {
        toast.error(`${kind} ${pod} failed`, { description: res.error, duration: 8000 })
        dlg.setOpen(false)
      }
    } finally {
      dlg.setBusy(false)
    }
  }

  if (summary.isLoading) {
    return (
      <div>
        <PanelHeader title="Mesh" subtitle="kubernetes cluster — services · deployments · pods" />
        <PanelSkeleton />
      </div>
    )
  }

  if (!summary.data?.ok || !summary.data.data) {
    return (
      <div>
        <PanelHeader title="Mesh" subtitle="kubernetes cluster — services · deployments · pods" />
        <ErrorCard error={summary.data?.error ?? 'mesh.summary failed'} />
      </div>
    )
  }

  const s = summary.data.data
  const depRows = deployments.data?.data?.deployments ?? []
  const podRows = pods.data?.data?.pods ?? []
  const svcRows = services.data?.data?.services ?? []

  return (
    <div>
      <PanelHeader
        title="Mesh"
        subtitle="kubernetes cluster — services · deployments · pods — real kubectl"
        source={summary.data?.source ?? 'live'}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="nodes" value={s.nodes} icon={<Server className="h-4 w-4" aria-hidden />} />
        <StatCard label="namespaces" value={s.namespaces} icon={<Layers className="h-4 w-4" aria-hidden />} />
        <StatCard label="deployments" value={s.deployments} icon={<Boxes className="h-4 w-4" aria-hidden />} />
        <StatCard label="pods" value={s.pods} icon={<Network className="h-4 w-4" aria-hidden />} />
        <StatCard
          label="ready"
          value={s.readyPct}
          unit="%"
          tone={s.readyPct >= 90 ? 'good' : s.readyPct >= 70 ? 'warn' : 'bad'}
          hint="desired replicas across the cluster"
        />
      </div>

      <Tabs defaultValue="services" className="mt-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="services" className="gap-1.5 font-mono text-xs">
            services <span className="text-muted-foreground">{svcRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="deployments" className="gap-1.5 font-mono text-xs">
            deployments <span className="text-muted-foreground">{depRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="pods" className="gap-1.5 font-mono text-xs">
            pods <span className="text-muted-foreground">{podRows.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="services" className="mt-4">
          <PanelCard title="Services" actions={<Mono>kubectl get svc -A</Mono>}>
            <DataTable
              rows={svcRows}
              headers={['Namespace', 'Name', 'Type', 'Cluster IP', 'Ports']}
              keyOf={(v) => `${v.namespace}/${v.name}`}
              maxH="26rem"
              renderRow={(v) => (
                <>
                  <TableCell>{nsBadge(v.namespace)}</TableCell>
                  <TableCell className="font-mono text-xs font-medium">{v.name}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${
                        v.type === 'LoadBalancer'
                          ? 'border-sky-500/30 bg-sky-500/15 text-sky-400'
                          : 'border-border bg-muted/50 text-muted-foreground'
                      }`}
                    >
                      {v.type}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{v.clusterIP}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{v.ports.join('  ')}</TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>

        <TabsContent value="deployments" className="mt-4">
          <PanelCard title="Deployments" actions={<Mono>kubectl get deploy -A</Mono>}>
            <DataTable
              rows={depRows}
              headers={['Namespace', 'Name', 'Replicas', 'Image', 'Strategy', '']}
              keyOf={(d) => `${d.namespace}/${d.name}`}
              maxH="26rem"
              renderRow={(d) => {
                const notReady = d.ready < d.replicas
                return (
                  <>
                    <TableCell>{nsBadge(d.namespace)}</TableCell>
                    <TableCell className="font-mono text-xs font-medium">{d.name}</TableCell>
                    <TableCell className="w-36">
                      <div className="space-y-1">
                        <div className="flex items-baseline justify-between font-mono text-[11px] tabular-nums">
                          <span className={notReady ? 'text-red-400' : 'text-emerald-400'}>
                            {d.ready}/{d.replicas}
                          </span>
                          <span className="text-muted-foreground">ready</span>
                        </div>
                        <Bar pct={d.replicas > 0 ? (d.ready / d.replicas) * 100 : 0} tone={notReady ? 'bad' : 'good'} />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 truncate font-mono text-[11px] text-muted-foreground" title={d.image}>
                      {d.image}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{d.strategy}</TableCell>
                    <TableCell className="text-right">
                      <ScaleDialog
                        dep={d}
                        onScale={(deployment, replicas) => action('mesh', 'scale', { deployment, replicas })}
                      />
                    </TableCell>
                  </>
                )
              }}
            />
          </PanelCard>
        </TabsContent>

        <TabsContent value="pods" className="mt-4">
          <PanelCard title="Pods" actions={<Mono>kubectl get pods -A · 8s poll</Mono>}>
            <DataTable
              rows={podRows}
              headers={['Namespace', 'Name', 'Node', 'Status', 'Restarts', 'Age', '']}
              keyOf={(p) => p.name}
              maxH="26rem"
              renderRow={(p) => (
                <>
                  <TableCell>{nsBadge(p.namespace)}</TableCell>
                  <TableCell className="font-mono text-xs">{p.name}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{p.node ?? '—'}</TableCell>
                  <TableCell>{podStatusBadge(p.status)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    <span className={p.restarts > 5 ? 'text-red-400' : p.restarts > 0 ? 'text-amber-500' : 'text-muted-foreground'}>
                      {p.restarts}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{p.age}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        onClick={() => void openPod('describe', p.name)}
                        aria-label={`describe ${p.name}`}
                      >
                        <FileText className="h-3 w-3" aria-hidden /> describe
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 font-mono text-[11px]"
                        onClick={() => void openPod('logs', p.name)}
                        aria-label={`logs ${p.name}`}
                      >
                        <ScrollText className="h-3 w-3" aria-hidden /> logs
                      </Button>
                    </div>
                  </TableCell>
                </>
              )}
            />
          </PanelCard>
        </TabsContent>
      </Tabs>

      <p className="mt-4 pb-2 text-xs text-muted-foreground">
        kubectl is not installed on this host (or the cluster is unreachable) — the inventory is honest zeros, nothing is
        fabricated. Install kubectl and point KUBECONFIG at the cluster, and services/deployments/pods appear here live;
        scale/describe/logs run the real kubectl commands against it.
      </p>

      <Dialog open={dlg.open} onOpenChange={dlg.setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono">
              {dlg.mode} — <span className="text-muted-foreground">{dlg.title}</span>
            </DialogTitle>
            <DialogDescription>
              {dlg.mode === 'describe' ? 'real kubectl describe output' : 'real kubectl logs output'}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-72 rounded border border-border bg-zinc-950/80">
            <pre className="p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {dlg.busy ? 'loading…' : dlg.mode === 'describe' ? dlg.text : dlg.lines.join('\n')}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (dlg.title) void openPod(dlg.mode, dlg.title)
              }}
              disabled={dlg.busy}
            >
              refetch
            </Button>
            <Button size="sm" variant="outline" onClick={() => dlg.setOpen(false)}>
              close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
