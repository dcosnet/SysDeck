/**
 * Fester node registry — cluster node state with ambient drift.
 * Port of backend/nodes/{state_model,probe}.py. Cluster nodes run the
 * synthetic drift (real agents would be probed on :8787); the local node
 * reads REAL /proc metrics from this host.
 */

import { readFileSync } from 'fs'
import { bindLoop } from './clock'

export interface NodeConfig {
  name: string
  host: string
  max_jobs: number
  runtime: 'host' | 'lxc' | 'podman' | 'firecracker' | 'libvirt' | 'tmux'
  policy?: 'preferred' | 'avoid' | undefined
  arch?: string
  local?: boolean
}

export interface NodeState {
  name: string
  state: 'online' | 'degraded' | 'offline'
  cpu_load: number
  memory_load: number
  temp: number
  active_jobs: number
  max_jobs: number
  instability: number
  host: string
  runtime: string
  arch: string
  score?: number
}

// Mirrors the repo's config.yaml node list (x99-v3, x99-v4) plus the
// README architecture diagram's rpi-1 / ryzen-1, and this host as
// a real live node.
const CLUSTER: NodeConfig[] = [
  { name: 'localhost', host: '127.0.0.1', max_jobs: 4, runtime: 'host', arch: 'x86_64', local: true, policy: 'preferred' },
  { name: 'x99-v3', host: '192.168.1.10', max_jobs: 24, runtime: 'host', arch: 'x86_64' },
  { name: 'x99-v4', host: '192.168.1.11', max_jobs: 30, runtime: 'host', arch: 'x86_64' },
  { name: 'rpi-1', host: '192.168.1.12', max_jobs: 4, runtime: 'lxc', arch: 'arm64', policy: 'avoid' },
  { name: 'ryzen-1', host: '192.168.1.13', max_jobs: 16, runtime: 'podman', arch: 'x86_64' },
]

export class NodeRegistry {
  private states = new Map<string, NodeState>()
  private ambient = false
  private stopped = false

  constructor() {
    for (const n of CLUSTER) {
      this.states.set(n.name, {
        name: n.name,
        state: 'online',
        cpu_load: 10 + Math.random() * 30,
        memory_load: 20 + Math.random() * 40,
        temp: 40 + Math.random() * 20,
        active_jobs: 0,
        max_jobs: n.max_jobs,
        instability: 0,
        host: n.host,
        runtime: n.runtime,
        arch: n.arch ?? 'x86_64',
      })
    }
  }

  names(): string[] {
    return [...this.states.keys()]
  }

  configs(): NodeConfig[] {
    return CLUSTER
  }

  get(name: string): NodeState | undefined {
    return this.states.get(name)
  }

  all(): NodeState[] {
    return [...this.states.values()]
  }

  update(name: string, fields: Partial<NodeState>) {
    const s = this.states.get(name)
    if (s) Object.assign(s, fields)
  }

  /** REAL local /proc read for the localhost node. */
  private readLocal(): { cpu: number; mem: number } {
    try {
      const stat = readFileSync('/proc/stat', 'utf-8').split('\n')[0] ?? ''
      const parts = stat.trim().split(/\s+/).slice(1).map(Number)
      const total = parts.reduce((a, b) => a + (b || 0), 0)
      const idle = (parts[3] ?? 0) + (parts[4] ?? 0)
      const mi = readFileSync('/proc/meminfo', 'utf-8')
      let memTotal = 1
      let memAvail = 0
      for (const line of mi.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)\s*kB/)
        if (!m) continue
        if (m[1] === 'MemTotal') memTotal = Number(m[2])
        if (m[1] === 'MemAvailable') memAvail = Number(m[2])
      }
      const cpu = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0
      const mem = Math.round((1 - memAvail / memTotal) * 1000) / 10
      return { cpu, mem }
    } catch {
      return { cpu: 0, mem: 0 }
    }
  }

  /** Ambient drift loop — updates every node state on an interval.
   *  The tick is registered via bindLoop and driven/supervised by
   *  ensureLoop() from live request contexts (see clock.ts) — this keeps
   *  the loop working across bun --hot re-evaluations. */
  startAmbiant(ms: number, cb: (snapshot: NodeState) => void) {
    this.startAmbient(ms, cb)
  }

  startAmbient(ms: number, cb: (snapshot: NodeState) => void) {
    if (this.ambient) return
    this.ambient = true
    this.stopped = false
    // deliberate this-alias: the callback outlives this method call and is
    // re-registered across bun --hot re-evaluations (bindLoop), so we
    // capture the registry instance explicitly.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const registry = this
    bindLoop('fester_ambient', ms, () => {
      if (registry.stopped) return
      for (const s of registry.states.values()) {
        if (s.name === 'localhost') {
          const { cpu, mem } = registry.readLocal()
          s.cpu_load = cpu
          s.memory_load = mem
          s.temp = 45 + Math.random() * 5
        } else {
          // bounded random walk
          s.cpu_load = clamp(s.cpu_load + (Math.random() - 0.5) * 14, 4, 96)
          s.memory_load = clamp(s.memory_load + (Math.random() - 0.5) * 6, 10, 92)
          s.temp = clamp(s.temp + (Math.random() - 0.5) * 3, 32, 78)
        }
        s.state = s.cpu_load > 90 || s.temp > 75 ? 'degraded' : 'online'
        s.score = undefined as unknown as number
        cb(s)
      }
    })
  }

  stop() {
    this.stopped = true
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
