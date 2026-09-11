// SysDeck bridge — mesh (demo Kubernetes cluster view)
// Port of bridge/mesh.py semantics: the cockpit edition ran
// `kubectl get services -A -o json` and returned empty items when
// kubectl was absent ("0 Kubernetes services"). This sandbox has no
// kubectl/cluster, so the web edition keeps the same surface over a
// seeded 3-node demo cluster (services/deployments/pods) persisted as
// JSON in SdKv — scale() really adjusts pod rows, and every mutation
// is audited. describe()/logs() return kubectl-style output.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'kubectl absent — demo cluster'

/** fail() + source → top-level {ok:false, error, source} envelope. */
function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'mesh', action, detail } })
}

// ── cluster state (JSON in SdKv) ────────────────────────────────────

interface K8sPod {
  name: string
  namespace: string
  deployment: string | null
  status: 'Running' | 'Pending' | 'CrashLoopBackOff' | 'Completed'
  restarts: number
  node: string | null
  ip: string | null
  ageS: number
}

interface K8sDeployment {
  name: string
  namespace: string
  replicas: number
  ready: number
  image: string
  strategy: string
}

interface K8sService {
  name: string
  namespace: string
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer'
  clusterIP: string
  ports: string[]
}

const NODES = ['k8s-node-1', 'k8s-node-2', 'k8s-node-3']

const SEED_SERVICES: K8sService[] = [
  { name: 'kube-dns', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.96.0.10', ports: ['53/UDP', '53/TCP', '9153/TCP'] },
  { name: 'metrics-server', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.96.44.132', ports: ['443/TCP'] },
  { name: 'kube-api', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.96.0.1', ports: ['6443/TCP'] },
  { name: 'prometheus', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.96.101.55', ports: ['9090/TCP'] },
  { name: 'grafana', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.96.102.61', ports: ['3000/TCP'] },
  { name: 'alertmanager', namespace: 'monitoring', type: 'ClusterIP', clusterIP: '10.96.103.7', ports: ['9093/TCP', '8080/TCP'] },
  { name: 'ingress-nginx', namespace: 'ingress-nginx', type: 'LoadBalancer', clusterIP: '10.96.200.1', ports: ['80:30180/TCP', '443:30443/TCP'] },
  { name: 'frontend', namespace: 'prod-web', type: 'ClusterIP', clusterIP: '10.96.11.20', ports: ['80/TCP'] },
  { name: 'api', namespace: 'prod-web', type: 'ClusterIP', clusterIP: '10.96.11.21', ports: ['8080/TCP'] },
  { name: 'worker', namespace: 'prod-web', type: 'ClusterIP', clusterIP: '10.96.11.22', ports: ['8080/TCP'] },
  { name: 'postgresql', namespace: 'prod-db', type: 'ClusterIP', clusterIP: '10.96.12.30', ports: ['5432/TCP'] },
  { name: 'redis', namespace: 'prod-db', type: 'NodePort', clusterIP: '10.96.12.31', ports: ['6379:30379/TCP'] },
]

const SEED_DEPLOYMENTS: K8sDeployment[] = [
  { name: 'frontend', namespace: 'prod-web', replicas: 3, ready: 3, image: 'nginx:1.25', strategy: 'RollingUpdate' },
  { name: 'api', namespace: 'prod-web', replicas: 4, ready: 4, image: 'registry.local/api:2.14.0', strategy: 'RollingUpdate' },
  { name: 'worker', namespace: 'prod-web', replicas: 2, ready: 2, image: 'registry.local/worker:2.14.0', strategy: 'RollingUpdate' },
  { name: 'prometheus', namespace: 'monitoring', replicas: 1, ready: 1, image: 'prom/prometheus:v2.54.1', strategy: 'RollingUpdate' },
  { name: 'grafana', namespace: 'monitoring', replicas: 1, ready: 1, image: 'grafana/grafana:11.2.0', strategy: 'RollingUpdate' },
  { name: 'kube-dns', namespace: 'kube-system', replicas: 2, ready: 2, image: 'registry.k8s.io/coredns/coredns:v1.11.1', strategy: 'RollingUpdate' },
  { name: 'cert-manager', namespace: 'kube-system', replicas: 1, ready: 1, image: 'quay.io/jetstack/cert-manager-controller:v1.15.3', strategy: 'RollingUpdate' },
  { name: 'canary-api', namespace: 'prod-web', replicas: 1, ready: 0, image: 'registry.local/api:2.15.0-rc2 (ErrImagePull)', strategy: 'Canary' },
]

const SEED_PODS: K8sPod[] = [
  { name: 'frontend-5d8f7c9b4-8xk2q', namespace: 'prod-web', deployment: 'frontend', status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.17', ageS: 432000 },
  { name: 'frontend-5d8f7c9b4-m9plw', namespace: 'prod-web', deployment: 'frontend', status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.31', ageS: 432000 },
  { name: 'frontend-5d8f7c9b4-v4n7t', namespace: 'prod-web', deployment: 'frontend', status: 'Running', restarts: 1, node: 'k8s-node-3', ip: '10.244.3.9', ageS: 431850 },
  { name: 'api-7c9d8f6b5-j3k8w', namespace: 'prod-web', deployment: 'api', status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.18', ageS: 259200 },
  { name: 'api-7c9d8f6b5-p5m2n', namespace: 'prod-web', deployment: 'api', status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.32', ageS: 259200 },
  { name: 'api-7c9d8f6b5-r9q4z', namespace: 'prod-web', deployment: 'api', status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.33', ageS: 259200 },
  { name: 'api-7c9d8f6b5-t7v1y', namespace: 'prod-web', deployment: 'api', status: 'Running', restarts: 2, node: 'k8s-node-3', ip: '10.244.3.10', ageS: 259100 },
  { name: 'worker-84f9d7c6-c2h5f', namespace: 'prod-web', deployment: 'worker', status: 'Running', restarts: 0, node: 'k8s-node-3', ip: '10.244.3.11', ageS: 172800 },
  { name: 'worker-84f9d7c6-g8j3k', namespace: 'prod-web', deployment: 'worker', status: 'Running', restarts: 0, node: 'k8s-node-3', ip: '10.244.3.12', ageS: 172800 },
  { name: 'canary-api-6f8d9e2-w4x7q', namespace: 'prod-web', deployment: 'canary-api', status: 'Pending', restarts: 0, node: 'k8s-node-2', ip: null, ageS: 900 },
  { name: 'postgresql-0', namespace: 'prod-db', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.40', ageS: 864000 },
  { name: 'redis-6d9c8f7-l4p9s', namespace: 'prod-db', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.41', ageS: 864000 },
  { name: 'prometheus-monitoring-0', namespace: 'monitoring', deployment: null, status: 'Running', restarts: 1, node: 'k8s-node-3', ip: '10.244.3.20', ageS: 604800 },
  { name: 'grafana-7f8d9cb6-n5q2w', namespace: 'monitoring', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.25', ageS: 604800 },
  { name: 'alertmanager-5c8f9d8-k7m3z', namespace: 'monitoring', deployment: null, status: 'CrashLoopBackOff', restarts: 7, node: 'k8s-node-2', ip: '10.244.2.44', ageS: 3600 },
  { name: 'kube-apiserver-k8s-node-1', namespace: 'kube-system', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.1', ageS: 1296000 },
  { name: 'etcd-k8s-node-1', namespace: 'kube-system', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.2', ageS: 1296000 },
  { name: 'coredns-6d9c8f7a-x4y8z', namespace: 'kube-system', deployment: 'kube-dns', status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.3', ageS: 1296000 },
  { name: 'coredns-6d9c8f7a-b2w5q', namespace: 'kube-system', deployment: 'kube-dns', status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.3', ageS: 1296000 },
  { name: 'metrics-server-7d8f9c4-j6n4r', namespace: 'kube-system', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-1', ip: '10.244.1.5', ageS: 1296000 },
  { name: 'cert-manager-64f8d9c-v3w5q', namespace: 'kube-system', deployment: 'cert-manager', status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.6', ageS: 345600 },
  { name: 'kube-proxy-4h7w2', namespace: 'kube-system', deployment: null, status: 'Running', restarts: 0, node: 'k8s-node-2', ip: '10.244.2.2', ageS: 1296000 },
  { name: 'metrics-exporter-5f8d9e-p2n4r', namespace: 'monitoring', deployment: null, status: 'Pending', restarts: 0, node: null, ip: null, ageS: 400 },
  { name: 'backup-job-28k-restore-q9w4e', namespace: 'kube-system', deployment: null, status: 'Completed', restarts: 0, node: 'k8s-node-3', ip: '10.244.3.30', ageS: 28800 },
]

async function ensureSeeded(): Promise<void> {
  const existing = await db.sdKv.findUnique({ where: { key: 'mesh.pods' } })
  if (existing) return
  try {
    await db.sdKv.createMany({
      data: [
        { key: 'mesh.services', value: JSON.stringify(SEED_SERVICES) },
        { key: 'mesh.deployments', value: JSON.stringify(SEED_DEPLOYMENTS) },
        { key: 'mesh.pods', value: JSON.stringify(SEED_PODS) },
      ],
    })
  } catch {
    return // concurrent seed won the race
  }
  await audit('seed', 'seeded demo cluster: 3 nodes, 5 namespaces, 12 services, 8 deployments, 24 pods')
}

async function getPods(): Promise<K8sPod[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'mesh.pods' } })
  return row ? (JSON.parse(row.value) as K8sPod[]) : []
}

async function getDeployments(): Promise<K8sDeployment[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'mesh.deployments' } })
  return row ? (JSON.parse(row.value) as K8sDeployment[]) : []
}

async function getServices(): Promise<K8sService[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'mesh.services' } })
  return row ? (JSON.parse(row.value) as K8sService[]) : []
}

async function putPods(pods: K8sPod[]) {
  await db.sdKv.update({ where: { key: 'mesh.pods' }, data: { value: JSON.stringify(pods), ts: new Date() } })
}

async function putDeployments(deps: K8sDeployment[]) {
  await db.sdKv.update({ where: { key: 'mesh.deployments' }, data: { value: JSON.stringify(deps), ts: new Date() } })
}

function ageHuman(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function randSuffix(n = 5): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

// ── describe / logs (kubectl-style output) ──────────────────────────

async function describe(podName: string): Promise<string> {
  const pods = await getPods()
  const pod = pods.find((p) => p.name === podName)
  if (!pod) return ''
  const deps = await getDeployments()
  const dep = pod.deployment ? deps.find((d) => d.name === pod.deployment) : undefined
  const image = dep?.image ?? 'registry.local/pod:latest'
  const lines = [
    `Name:             ${pod.name}`,
    `Namespace:        ${pod.namespace}`,
    `Priority:         0`,
    `Node:             ${pod.node ? `${pod.node}/10.0.0.1${NODES.indexOf(pod.node) + 1}` : '<unscheduled>'}`,
    `Status:           ${pod.status}`,
    `IP:               ${pod.ip ?? '<none>'}`,
    pod.deployment ? `Controlled By:    ReplicaSet/${pod.name.split('-').slice(0, 2).join('-')}` : `Controlled By:    <none>`,
    `Containers:`,
    `  main:`,
    `    Image:          ${image}`,
    `    State:          ${pod.status === 'Running' ? 'Running' : pod.status}`,
    `    Ready:          ${pod.status === 'Running'}`,
    `    Restart Count:  ${pod.restarts}`,
    `Conditions:`,
    `  Type              Status`,
    `  Initialized       True`,
    `  Ready             ${pod.status === 'Running' ? 'True' : 'False'}`,
    `  ContainersReady   ${pod.status === 'Running' ? 'True' : 'False'}`,
    `  PodScheduled      ${pod.node ? 'True' : 'False'}`,
  ]
  if (pod.status === 'Pending' && !pod.node) {
    lines.push(`Events:`, `  Warning  FailedScheduling  0/3 nodes are available: 1 Insufficient memory, 2 node(s) had untolerated taint.`)
  }
  return lines.join('\n')
}

function logLines(podName: string): string[] {
  const now = new Date()
  const ts = () => new Date(now.getTime() - Math.floor(Math.random() * 60000)).toISOString()
  if (podName.startsWith('frontend')) {
    return [
      `${ts()} 10.244.2.50 - - [10/Sep/2026:20:50:01 +0000] "GET / HTTP/1.1" 200 612 "-" "Mozilla/5.0 (X11; Linux x86_64)" 0.002`,
      `${ts()} 10.244.2.50 - - [10/Sep/2026:20:50:04 +0000] "GET /static/app.js HTTP/1.1" 200 3411 "-" "Mozilla/5.0" 0.001`,
      `${ts()} 10.244.2.51 - - [10/Sep/2026:20:50:11 +0000] "GET /api/health HTTP/1.1" 200 15 "-" "kube-probe/1.31" 0.001`,
      `${ts()} 10.244.2.51 - - [10/Sep/2026:20:50:41 +0000] "GET /api/health HTTP/1.1" 200 15 "-" "kube-probe/1.31" 0.001`,
    ]
  }
  if (podName.startsWith('api')) {
    return [
      `${ts()} INFO  [req_id=8f2c1a] GET /api/v2/items?limit=50 → 200 (12ms)`,
      `${ts()} INFO  [req_id=9d4e7b] POST /api/v2/auth → 200 (48ms)`,
      `${ts()} WARN  [req_id=2a91ff] slow query 312ms: SELECT * FROM orders WHERE status='pending'`,
      `${ts()} INFO  [req_id=c1e8d0] GET /api/v2/items/9942 → 404 (3ms)`,
    ]
  }
  if (podName.startsWith('alertmanager')) {
    return [
      `${ts()} level=error ts=component=component error="notification failed: dial tcp 10.96.103.7:9093: connect: connection refused"`,
      `${ts()} level=info ts=component=component starting alertmanager`,
      `${ts()} level=error ts=component=component error="notification failed: dial tcp 10.96.103.7:9093: connect: connection refused"`,
      `${ts()} level=info ts=component=component exited with code 2 (crash — restart 7)`,
    ]
  }
  if (podName.startsWith('kube-apiserver')) {
    return [
      `${ts()} I0910 20:49:58.312211       1 trace.go:236] Trace[180412]: "Get" url,/api/v1/namespaces/prod-web/pods (10-Sep-2026 20:49:48.312) (total time: 10ms):`,
      `${ts()} I0910 20:49:59.104502       1 httplog.go:132] "HTTP" verb="GET" URI="/healthz" latency="1.2ms"`,
      `${ts()} I0910 20:50:00.220115       1 controller.go:132] "OpenAPI AggregationController: Processing item" key="v1."`,
    ]
  }
  if (podName.startsWith('canary') || podName.includes('exporter')) {
    return [
      `Warning: Failed to pull image "registry.local/api:2.15.0-rc2": rpc error: code = Unknown desc = Error response from daemon: manifest unknown`,
      `Warning: Back-off pulling image "registry.local/api:2.15.0-rc2"`,
      `Error: ErrImagePull`,
      `Normal: Back-off restarting failed container`,
    ]
  }
  return [
    `${ts()} INFO  starting ${podName}`,
    `${ts()} INFO  listening on :8080`,
    `${ts()} INFO  readiness probe passed`,
  ]
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const [pods, deployments, services] = await Promise.all([getPods(), getDeployments(), getServices()])
    const namespaces = new Set([
      ...pods.map((p) => p.namespace),
      ...deployments.map((d) => d.namespace),
      ...services.map((s) => s.namespace),
    ])
    const running = pods.filter((p) => p.status === 'Running').length
    return ok(
      {
        nodes: NODES.length,
        namespaces: namespaces.size,
        services: services.length,
        deployments: deployments.length,
        pods: pods.length,
        readyPct: pods.length ? Math.round((running / pods.length) * 100) : 100,
      },
      SOURCE,
      NOTE,
    )
  },

  services: async () => {
    await ensureSeeded()
    const services = await getServices()
    return ok({ services, count: services.length }, SOURCE, NOTE)
  },

  deployments: async () => {
    await ensureSeeded()
    const deployments = await getDeployments()
    return ok({ deployments, count: deployments.length }, SOURCE, NOTE)
  },

  pods: async () => {
    await ensureSeeded()
    const pods = (await getPods()).map((p) => ({ ...p, age: ageHuman(p.ageS) }))
    return ok({ pods, count: pods.length }, SOURCE, NOTE)
  },

  scale: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const deployment = String(args.deployment ?? '')
    const replicas = Number(args.replicas)
    if (!deployment) return failE('deployment is required')
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 50) return failE('replicas must be an integer 0-50')
    const deployments = await getDeployments()
    const dep = deployments.find((d) => d.name === deployment)
    if (!dep) return failE(`deployment '${deployment}' not found`)
    const pods = await getPods()
    const depPods = pods.filter((p) => p.deployment === deployment)
    const delta = replicas - depPods.length
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        const node = NODES[Math.floor(Math.random() * NODES.length)]
        pods.push({
          name: `${deployment}-${randSuffix(5)}-${randSuffix(5)}`,
          namespace: dep.namespace,
          deployment,
          status: 'Running',
          restarts: 0,
          node,
          ip: `10.244.${NODES.indexOf(node) + 1}.${20 + pods.length}`,
          ageS: 1,
        })
      }
    } else if (delta < 0) {
      // remove the newest pods of this deployment first
      const toRemove = depPods.slice(delta)
      for (const p of toRemove) {
        const idx = pods.findIndex((q) => q.name === p.name)
        if (idx >= 0) pods.splice(idx, 1)
      }
    }
    dep.replicas = replicas
    dep.ready = Math.min(replicas, pods.filter((p) => p.deployment === deployment && p.status === 'Running').length)
    await Promise.all([putPods(pods), putDeployments(deployments)])
    await audit('scale', `deployment ${dep.namespace}/${deployment} → ${replicas} replicas (was ${depPods.length}, ${delta >= 0 ? '+' : ''}${delta} pods)`)
    return ok(
      { deployment: dep, pods: pods.filter((p) => p.deployment === deployment).length, delta },
      SOURCE,
      `scaled ${deployment} to ${replicas} — pod rows adjusted`,
    )
  },

  describe: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const pod = String(args.pod ?? '')
    if (!pod) return failE('pod is required')
    const text = await describe(pod)
    if (!text) return failE(`pod '${pod}' not found`)
    return ok({ pod, text }, SOURCE, 'kubectl describe -style output (demo)')
  },

  logs: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const pod = String(args.pod ?? '')
    if (!pod) return failE('pod is required')
    const pods = await getPods()
    if (!pods.some((p) => p.name === pod)) return failE(`pod '${pod}' not found`)
    return ok({ pod, lines: logLines(pod) }, SOURCE, 'kubectl logs -style output (demo)')
  },
}
