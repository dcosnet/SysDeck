/**
 * Fester cause graph — port of backend/analysis/cause_graph.py.
 * Builds a causal graph from the event stream so the UI can answer
 * "why did this node make this decision?".
 */

import type { FesterEvent } from './events'

export interface CauseNode {
  id: string
  kind: 'decision' | 'task' | 'failure' | 'cache' | 'policy' | 'stamp'
  label: string
  detail?: string
}

export interface CauseEdge {
  from: string
  to: string
  label?: string
}

export interface CauseGraph {
  nodes: CauseNode[]
  edges: CauseEdge[]
}

export function buildCauseGraph(events: FesterEvent[]): CauseGraph {
  const nodes = new Map<string, CauseNode>()
  const edges: CauseEdge[] = []

  const addNode = (n: CauseNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n)
  }

  for (const e of events) {
    if (e.type === 'task_update' && e.action) {
      const id = `task:${e.action}`
      addNode({
        id,
        kind: 'task',
        label: short(e.action),
        detail: `${e.state}${e.node ? ` @ ${e.node}` : ''}`,
      })
      // decision → task edge (scheduler chose this node)
      if (e.state === 'scheduled' && e.node) {
        const decId = `decision:${e.action}`
        addNode({ id: decId, kind: 'decision', label: `score ${e.score ?? '?'} → ${e.node}`, detail: e.reason })
        edges.push({ from: decId, to: id, label: 'scheduled' })
        // node state influenced the decision
        const nodeId = `node:${e.node}`
        addNode({ id: nodeId, kind: 'policy', label: e.node, detail: 'node state' })
        edges.push({ from: nodeId, to: decId, label: 'load/temp' })
      }
      // dependency edge
      if (e.parent) {
        const parentId = `task:${e.parent}`
        if (nodes.has(parentId) || events.some((x) => x.action === e.parent)) {
          addNode({ id: parentId, kind: 'task', label: short(e.parent), detail: 'upstream' })
          edges.push({ from: parentId, to: id, label: 'depends' })
        }
      }
    }
    if (e.type === 'cache_update' && e.action) {
      const id = `cache:${e.action}`
      addNode({ id, kind: 'cache', label: `CAS hit ${short(e.action)}`, detail: String(e.meta?.key ?? '') })
      edges.push({ from: id, to: `task:${e.action}`, label: 'skipped exec' })
    }
    if (e.type === 'failure' && e.action) {
      const id = `failure:${e.action}`
      addNode({ id, kind: 'failure', label: `✗ ${short(e.action)}`, detail: e.reason })
      edges.push({ from: `task:${e.action}`, to: id, label: 'rc≠0' })
    }
    if (e.type === 'btc_stamp' && e.action) {
      const id = `stamp:${e.action}`
      addNode({ id, kind: 'stamp', label: `stamp ${short(e.action)}`, detail: String(e.meta?.toolchain ?? 'BTC') })
      edges.push({ from: `task:${e.action}`, to: id, label: 'verified' })
    }
  }

  return { nodes: [...nodes.values()], edges }
}

function short(name: string): string {
  const parts = name.split(':')
  return parts.slice(-2).join(':')
}
