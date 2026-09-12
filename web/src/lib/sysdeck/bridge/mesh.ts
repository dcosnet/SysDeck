// SysDeck bridge — mesh (real kubectl cluster view, all live)
// Port of bridge/mesh.py semantics: the cockpit edition ran
// `kubectl get services -A -o json` and returned an EMPTY items list when
// kubectl was absent ("0 Kubernetes services"). The web edition does
// exactly that across the whole surface: services/deployments/pods/nodes
// come from real kubectl JSON; scale runs `kubectl scale`;
// describe/logs run `kubectl describe` / `kubectl logs`. When kubectl or
// the cluster is absent the panel gets an honest zero-count inventory
// with a note — never a fabricated cluster.
import { ok, fail, run, which } from './shared'
import { db } from '@/lib/db'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'mesh', action, detail } })
}

const KUBECTL_TIMEOUT = 20_000

// ── kubectl JSON plumbing ────────────────────────────────────────────

async function kubectlJson(args: string[]): Promise<unknown[] | null> {
  const r = await run('kubectl', args, KUBECTL_TIMEOUT)
  if (r.rc !== 0 || !r.stdout.trim()) return null
  try {
    const parsed = JSON.parse(r.stdout) as { items?: unknown[] }
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch {
    return null
  }
}

async function kubectlText(args: string[], timeoutMs = KUBECTL_TIMEOUT): Promise<{ rc: number; stdout: string; stderr: string } | null> {
  if (!(await which('kubectl'))) return null
  const r = await run('kubectl', args, timeoutMs)
  return r
}

function ageS(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const t = Date.parse(timestamp)
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / 1000))
}

// ── row mapping (panel contract) ─────────────────────────────────────

function mapService(it: Record<string, unknown>): {
  name: string
  namespace: string
  type: string
  clusterIP: string
  ports: string[]
} {
  const meta = (it.metadata ?? {}) as Record<string, unknown>
  const spec = (it.spec ?? {}) as Record<string, unknown>
  const ports = Array.isArray(spec.ports)
    ? (spec.ports as Record<string, unknown>[]).map((p) => {
        const port = String(p.port ?? '')
        const proto = String(p.protocol ?? 'TCP').toLowerCase()
        const np = p.nodePort ? `:${p.nodePort}` : ''
        return `${port}/${proto}${np}`
      })
    : []
  return {
    name: String(meta.name ?? ''),
    namespace: String(meta.namespace ?? 'default'),
    type: String(spec.type ?? 'ClusterIP'),
    clusterIP: String(spec.clusterIP ?? 'None'),
    ports,
  }
}

function mapDeployment(it: Record<string, unknown>): {
  name: string
  namespace: string
  replicas: number
  ready: number
} {
  const meta = (it.metadata ?? {}) as Record<string, unknown>
  const spec = (it.spec ?? {}) as Record<string, unknown>
  const status = (it.status ?? {}) as Record<string, unknown>
  return {
    name: String(meta.name ?? ''),
    namespace: String(meta.namespace ?? 'default'),
    replicas: Number(spec.replicas ?? 0),
    ready: Number(status.readyReplicas ?? 0),
  }
}

function mapPod(it: Record<string, unknown>): {
  name: string
  namespace: string
  deployment: string
  status: string
  restarts: number
  node: string
  ip: string
  ageS: number
} {
  const meta = (it.metadata ?? {}) as Record<string, unknown>
  const spec = (it.spec ?? {}) as Record<string, unknown>
  const status = (it.status ?? {}) as Record<string, unknown>
  const owners = Array.isArray(meta.ownerReferences) ? (meta.ownerReferences as Record<string, unknown>[]) : []
  const owner = owners[0] ? String(owners[0].name ?? '') : ''
  const containerStatuses = Array.isArray(status.containerStatuses)
    ? (status.containerStatuses as Record<string, unknown>[])
    : []
  const restarts = containerStatuses.reduce((acc, c) => acc + Number(c.restartCount ?? 0), 0)
  let phase = String(status.phase ?? 'Unknown')
  // surface CrashLoopBackOff / ImagePullBackOff like kubectl does
  for (const c of containerStatuses) {
    const waiting = (c.state ?? {}) as Record<string, unknown>
    const w = (waiting.waiting ?? {}) as Record<string, unknown>
    if (w.reason && phase === 'Running') phase = String(w.reason)
    if (w.reason && phase === 'Pending') phase = String(w.reason)
  }
  return {
    name: String(meta.name ?? ''),
    namespace: String(meta.namespace ?? 'default'),
    deployment: owner,
    status: phase,
    restarts,
    node: String(spec.nodeName ?? ''),
    ip: String((status.podIP ?? '') || (status.podIPs ?? '') || ''),
    ageS: ageS(String(meta.creationTimestamp ?? '')),
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    if (!(await which('kubectl'))) {
      return ok(
        { nodes: 0, namespaces: 0, services: 0, deployments: 0, pods: 0, readyPct: 100 },
        'live',
        'kubectl not detected — install kubectl and configure ~/.kube/config (or KUBECONFIG) for a live cluster view',
      )
    }
    const [nodes, services, deployments, pods] = await Promise.all([
      kubectlJson(['get', 'nodes', '-o', 'json']),
      kubectlJson(['get', 'services', '-A', '-o', 'json']),
      kubectlJson(['get', 'deployments', '-A', '-o', 'json']),
      kubectlJson(['get', 'pods', '-A', '-o', 'json']),
    ])
    if (services === null && deployments === null && pods === null) {
      return failE('kubectl is installed but the cluster is unreachable — check ~/.kube/config and the API server (kubectl get services failed)')
    }
    const podRows = (pods ?? []).map((p) => mapPod(p as Record<string, unknown>))
    const namespaces = new Set(podRows.map((p) => p.namespace))
    const running = podRows.filter((p) => p.status === 'Running').length
    return ok(
      {
        nodes: nodes?.length ?? 0,
        namespaces: namespaces.size,
        services: services?.length ?? 0,
        deployments: deployments?.length ?? 0,
        pods: podRows.length,
        readyPct: podRows.length ? Math.round((running / podRows.length) * 100) : 100,
      },
      'live',
      'live cluster view via kubectl get -A',
    )
  },

  services: async () => {
    const items = await kubectlJson(['get', 'services', '-A', '-o', 'json'])
    if (items === null) {
      if (!(await which('kubectl'))) {
        return ok({ services: [], count: 0 }, 'live', 'kubectl not detected — 0 Kubernetes services (honest empty)')
      }
      return failE('cluster unreachable — kubectl get services failed')
    }
    return ok({ services: items.map((s) => mapService(s as Record<string, unknown>)), count: items.length }, 'live')
  },

  deployments: async () => {
    const items = await kubectlJson(['get', 'deployments', '-A', '-o', 'json'])
    if (items === null) {
      if (!(await which('kubectl'))) {
        return ok({ deployments: [], count: 0 }, 'live', 'kubectl not detected — 0 deployments (honest empty)')
      }
      return failE('cluster unreachable — kubectl get deployments failed')
    }
    return ok({ deployments: items.map((d) => mapDeployment(d as Record<string, unknown>)), count: items.length }, 'live')
  },

  pods: async () => {
    const items = await kubectlJson(['get', 'pods', '-A', '-o', 'json'])
    if (items === null) {
      if (!(await which('kubectl'))) {
        return ok({ pods: [], count: 0 }, 'live', 'kubectl not detected — 0 pods (honest empty)')
      }
      return failE('cluster unreachable — kubectl get pods failed')
    }
    const pods = items.map((p) => mapPod(p as Record<string, unknown>))
    return ok({ pods, count: pods.length }, 'live')
  },

  scale: async (args: Record<string, unknown>) => {
    const deployment = String(args.deployment ?? '')
    const replicas = Number(args.replicas)
    if (!deployment) return failE('deployment is required')
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 50) return failE('replicas must be an integer 0-50')
    if (!(await which('kubectl'))) return failE('kubectl not detected — nothing to scale')
    const r = await kubectlText(['scale', `deployment/${deployment}`, '--replicas', String(replicas)])
    if (!r) return failE('kubectl invocation failed')
    await audit('scale', `kubectl scale deployment/${deployment} --replicas=${replicas} → rc=${r.rc}`)
    if (r.rc !== 0) {
      return failE(`kubectl scale failed — ${r.stderr.trim().split('\n')[0] ?? 'cluster error'}`)
    }
    return ok(
      { deployment, replicas, command: `kubectl scale deployment/${deployment} --replicas=${replicas}` },
      'live',
      r.stdout.trim() || r.stderr.trim(),
    )
  },

  describe: async (args: Record<string, unknown>) => {
    const pod = String(args.pod ?? '')
    if (!pod) return failE('pod is required')
    if (!(await which('kubectl'))) return failE('kubectl not detected')
    const r = await kubectlText(['describe', 'pod', pod, '-A'], 30_000)
    if (!r || r.rc !== 0) return failE(`pod '${pod}' not found — ${r?.stderr.trim().split('\n')[0] ?? 'kubectl error'}`)
    return ok({ pod, text: r.stdout.trim() }, 'live')
  },

  logs: async (args: Record<string, unknown>) => {
    const pod = String(args.pod ?? '')
    if (!pod) return failE('pod is required')
    if (!(await which('kubectl'))) return failE('kubectl not detected')
    const r = await kubectlText(['logs', pod, '-A', '--tail=100'], 30_000)
    if (!r || r.rc !== 0) return failE(`pod '${pod}' not found — ${r?.stderr.trim().split('\n')[0] ?? 'kubectl error'}`)
    const lines = r.stdout.trimEnd().split('\n').filter((l) => l.length > 0)
    return ok({ pod, lines: lines.length ? lines : ['(no output)'] }, 'live')
  },
}
