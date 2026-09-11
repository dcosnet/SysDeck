/**
 * Fester — dedicated DAG build orchestration service.
 *
 * Port of the standalone fester repo (backend/) to a bun mini-service:
 *   - PipelineEngine  → engine.ts    (DAG execution, pause/step, retries, cache, BTC stamps)
 *   - scheduler/      → scheduler.ts (weighted node scoring: cpu/temp/policy/instability)
 *   - nodes/          → nodes.ts     (NodeStateRegistry + synthetic drift + real local node)
 *   - events/         → events.ts    (EventBus + FesterEvent schema)
 *   - storage/        → store.ts     (SQLite: builds / sessions / events / node_states)
 *   - analysis/       → autopsy.ts, cause.ts (failure autopsy + causal graph)
 *   - api/            → api.ts       (REST mirroring the repo's route surface)
 *   - seed            → seed.ts      (first-boot synthetic history for replay views)
 *
 * Transport: Bun.serve with native WebSocket at path '/' — the same
 * transport the original fester ui/app.js uses (raw WebSocket with
 * auto-reconnect). The gateway forwards /?XTransformPort=3010 upgrades
 * here; REST is served on the same port for the SysDeck server-side proxy.
 *
 * WebSocket client protocol (all optional, default = full broadcast):
 *   → {type:'debugger', buildId, command:'pause'|'resume'|'step'}
 *   → {type:'subscribe', buildId}    — only receive that build's events
 *                                      (+ global node_update / hello / heartbeat)
 *   → {type:'unsubscribe'}           — back to full broadcast
 *   ← {type:'hello'|'debugger-ack'|'subscribed'|'unsubscribed'|<FesterEvent>}
 * A {type:'node_update', heartbeat:true, nodes:N} frame is broadcast every
 * 10s so clients can detect a stale connection.
 */

import { FesterEngine } from './engine'
import { EventBus, type FesterEvent } from './events'
import { Store } from './store'
import { NodeRegistry } from './nodes'
import { seedHistory } from './seed'
import { bindLoop, ensureLoop } from './clock'
import { handleApi } from './api'
import type { ServerWebSocket } from 'bun'

const PORT = 3010
const JOURNAL_CAP = 5000 // max journaled events per build (oldest dropped)

const bus = new EventBus()
const store = new Store()
const nodes = new NodeRegistry()
const engine = new FesterEngine(bus, store, nodes)

// ── boot: recover state from a previous process ──────────────────────
// 1. Any build left 'running' in the store by a previous process is marked
//    failed with a "service restarted" note (never show phantom builds).
// 2. A fresh store is seeded with a realistic history (see seed.ts).
const staleBuilds = store.markStaleRunningFailed()
if (staleBuilds.length > 0) {
  console.log(`[fester] marked ${staleBuilds.length} stale running build(s) failed: ${staleBuilds.map((b) => b.build_id).join(', ')}`)
  for (const b of staleBuilds) {
    // journal the reason so the timeline explains the state transition
    void store
      .appendEvent({
        type: 'debug',
        timestamp: Date.now() / 1000,
        build_id: b.build_id,
        state: 'failed',
        reason: 'service restarted',
        meta: { note: 'service restarted while this build was running' },
      })
      .catch(() => undefined)
  }
}

const seededCount = seedHistory(store)
if (seededCount > 0) console.log(`[fester] seeded ${seededCount} synthetic historical builds + replay sessions`)

// ── WebSocket hub ────────────────────────────────────────────────────
// Every fester event is broadcast to all sockets as JSON — except sockets
// that subscribed to a single build: those only receive that build's
// events plus global node_update frames. Clients send
// {type:'hello'} | {type:'debugger',...} | {type:'subscribe'|'unsubscribe'}.
const clients = new Set<ServerWebSocket<undefined>>()
const subscriptions = new Map<ServerWebSocket<undefined>, string>()

function broadcast(event: FesterEvent | { type: string; [k: string]: unknown }): void {
  const payload = JSON.stringify(event)
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue
    const sub = subscriptions.get(ws)
    if (!sub || event.type === 'node_update' || event.build_id === sub) ws.send(payload)
  }
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url)
    // live request context: (re)start the periodic loops if needed (see clock.ts)
    ensureLoop('fester_ambient')
    ensureLoop('fester_heartbeat')
    // WebSocket endpoint: the gateway sends upgrades at path '/' with the
    // XTransformPort query (io-style contract: path always '/').
    if (url.pathname === '/') {
      if (req.headers.get('upgrade') === 'websocket' || url.searchParams.get('EIO')) {
        if (srv.upgrade(req)) return undefined
      }
      // plain GET / → service banner (also used as a WS health probe)
      return Response.json({ ok: true, service: 'fester', version: '0.2.1', ws: '/', nodes: nodes.names() })
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi({ req, url, bus, store, nodes, engine })
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 })
  },
  websocket: {
    open(ws) {
      clients.add(ws)
      ensureLoop('fester_ambient')
      ensureLoop('fester_heartbeat')
      ws.send(JSON.stringify({ type: 'hello', service: 'fester', version: '0.2.1', nodes: nodes.names(), clients: clients.size }))
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message)) as { type?: string; buildId?: string; command?: string }
        if (msg?.type === 'debugger' && msg.buildId && msg.command) {
          const out = engine.debuggerCommand(msg.buildId, msg.command)
          ws.send(JSON.stringify({ type: 'debugger-ack', ...out }))
          broadcast({ type: 'debug', timestamp: Date.now() / 1000, build_id: msg.buildId, state: out.state ?? out.command, meta: { command: msg.command } })
        } else if (msg?.type === 'subscribe' && msg.buildId) {
          subscriptions.set(ws, msg.buildId)
          ws.send(JSON.stringify({ type: 'subscribed', buildId: msg.buildId, clients: clients.size }))
        } else if (msg?.type === 'unsubscribe') {
          const had = subscriptions.delete(ws)
          ws.send(JSON.stringify({ type: 'unsubscribed', buildId: msg.buildId ?? null, wasSubscribed: had }))
        }
      } catch {
        /* ignore malformed client messages */
      }
    },
    close(ws) {
      clients.delete(ws)
      subscriptions.delete(ws)
    },
  },
})

// ── event fan-out: bus → WS broadcast + capped timeline journal ──────
const journalCounts = new Map<string, number>()
const capNoted = new Set<string>()

bus.subscribe((event) => {
  broadcast(event)
  void journal(event)
})

async function journal(event: FesterEvent): Promise<void> {
  try {
    const bid = event.build_id
    if (!bid) {
      await store.appendEvent(event)
      return
    }
    let n = journalCounts.get(bid)
    if (n === undefined) {
      n = store.countEvents(bid)
      journalCounts.set(bid, n)
    }
    await store.appendEvent(event)
    n += 1
    if (n > JOURNAL_CAP) {
      // drop the oldest overflow, note the cap once per build
      await store.trimEvents(bid, n - JOURNAL_CAP)
      journalCounts.set(bid, JOURNAL_CAP)
      if (!capNoted.has(bid)) {
        capNoted.add(bid)
        const note: FesterEvent = {
          type: 'debug',
          timestamp: Date.now() / 1000,
          build_id: bid,
          state: 'journal-cap',
          reason: `journal capped at ${JOURNAL_CAP} events per build — oldest entries dropped`,
          meta: { cap: JOURNAL_CAP },
        }
        await store.appendEvent(note)
        broadcast(note)
      }
    } else {
      journalCounts.set(bid, n)
    }
  } catch (err) {
    console.error('[fester:journal] failed to persist event', err)
  }
}

// ── heartbeat: a 10s liveness frame so clients can detect stale links ─
// Loop is created/supervised from live request contexts (see clock.ts).
bindLoop('fester_heartbeat', 10_000, () => {
  broadcast({ type: 'node_update', timestamp: Date.now() / 1000, heartbeat: true, nodes: nodes.names().length })
})

// Ambient node drift loop — synthetic probe results for cluster nodes,
// real /proc metrics for the local node.
nodes.startAmbient(2000, (snapshot) => {
  broadcast({ type: 'node_update', timestamp: Date.now() / 1000, ...snapshot })
  store.upsertNodeState(snapshot)
})

// start both periodic loops immediately at boot (see clock.ts: loops are
// re-created/supervised from live request contexts after hot reloads, but on
// a fresh boot starting them here avoids depending on a first request).
ensureLoop('fester_ambient')
ensureLoop('fester_heartbeat')

console.log(`[fester] DAG orchestration service on :${PORT}`)
console.log(`[fester] nodes: ${nodes.names().join(', ')}`)

export { server }
