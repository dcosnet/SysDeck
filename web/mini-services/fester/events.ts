/**
 * Fester EventBus — the singleton every state change flows through.
 * Port of backend/events/{bus,schema}.py: FesterEvent dataclass shape.
 */

export type EventType =
  | 'node_update'
  | 'task_update'
  | 'pipeline_update'
  | 'cache_update'
  | 'failure'
  | 'debug'
  | 'replay'
  | 'btc_stamp'

export interface FesterEvent {
  type: EventType
  timestamp: number
  node?: string
  action?: string
  state?: string
  score?: number
  reason?: string
  parent?: string
  target?: string
  build_id?: string
  meta?: Record<string, unknown>
}

export type Subscriber = (event: FesterEvent) => void

export class EventBus {
  private subs = new Set<Subscriber>()

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  emit(event: FesterEvent): void {
    for (const fn of this.subs) {
      try {
        fn(event)
      } catch (err) {
        console.error('[fester:bus] subscriber error', err)
      }
    }
  }
}
