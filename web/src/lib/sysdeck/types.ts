// SysDeck Web Edition — shared types
// The bridge protocol mirrors the cockpit edition's python bridge:
//   shared/bridge.js → bridge.<module>.<method>() spawns
//   python3 /usr/lib/sysdeck/bridge/<module>.py <subcommand>
// In the web edition, the same call goes over POST /api/bridge.

export type DataSource = 'live' | 'demo' | 'hybrid' | 'unavailable'

export interface BridgeResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** Where the data came from — 'live' = read from this host, 'demo' = seeded dataset */
  source?: DataSource
  /** Optional human note, e.g. "k8s unreachable — demo cluster shown" */
  note?: string
  module?: string
  command?: string
}

export interface BridgeRequest {
  module: string
  command: string
  args?: Record<string, unknown>
}

export interface ModuleMeta {
  id: string
  name: string
  group: ModuleGroup
  order: number
  description: string
  /** marks modules that are read-write vs read-only */
  interactive?: boolean
  /** module health states surfaced in the sidebar */
  status?: 'live' | 'demo' | 'hybrid' | 'unavailable'
}

export type ModuleGroup =
  | 'system'
  | 'security'
  | 'compute'
  | 'build'
  | 'media'
  | 'integrations'

export interface HostTicker {
  cpuPct: number
  memPct: number
  memUsedMb: number
  memTotalMb: number
  load1: number
  load5: number
  load15: number
  uptimeS: number
  procs: number
  fester: 'online' | 'offline'
}
