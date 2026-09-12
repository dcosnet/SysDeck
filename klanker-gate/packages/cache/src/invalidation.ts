import type { PgExecutor } from "../../config/src/pg.ts";
import type { PgSubscription, Sql } from "../../config/src/pg_types.ts";

/** Channel every gateway process listens on. */
export const INVALIDATION_CHANNEL = "frosty_invalidation";

/** What was invalidated. Carried for observability; every kind drops L1. */
export type InvalidationKind =
  | "cache-clear"
  | "cache-key"
  | "cache-request-id"
  | "config";

export interface InvalidationEvent {
  /** Publishing process id; receivers skip their own. */
  origin: string;
  kind: InvalidationKind;
  /** Free-form detail (a request id, say). Never the cache key - too large. */
  detail?: string;
}

export interface InvalidationHandlers {
  /** Drop this process's in-process cache tier. */
  onCacheInvalidated?: () => void;
  /** Re-read durable config (a provider or setting changed on another node). */
  onConfigChanged?: () => void | Promise<void>;
}

export interface InvalidationBusOptions {
  /** Pooled executor used for NOTIFY. Safe behind transaction pooling. */
  publisher: PgExecutor;
  /** Session-stable handle used for LISTEN. Must NOT be transaction-pooled. */
  listener?: Sql;
  handlers?: InvalidationHandlers;
  /** Stable id for this process; defaults to a random UUID. */
  processId?: string;
}

export class InvalidationBus {
  readonly processId: string;
  #publisher: PgExecutor;
  #listener?: Sql;
  #handlers: InvalidationHandlers;
  #subscription?: PgSubscription;
  /** Counts events applied from other processes. Surfaced in health output. */
  #applied = 0;

  constructor(options: InvalidationBusOptions) {
    this.#publisher = options.publisher;
    this.#listener = options.listener;
    this.#handlers = options.handlers ?? {};
    this.processId = options.processId ?? crypto.randomUUID();
  }

  /** Number of remote invalidations this process has applied. */
  appliedCount(): number {
    return this.#applied;
  }

  /**
   * Subscribes to the channel. No-op without a session handle, so a
   * single-process deployment can run the whole bus as a publish-only stub
   * rather than branching at every call site.
   */
  async start(): Promise<void> {
    if (!this.#listener || this.#subscription) {
      return;
    }
    this.#subscription = await this.#listener.listen(
      INVALIDATION_CHANNEL,
      (payload) => this.#receive(payload),
      () => {
        // Fires on the initial LISTEN and again after every reconnect. Any
        // events during the gap are gone, so assume the worst and drop L1.
        this.#handlers.onCacheInvalidated?.();
      },
    );
  }

  async stop(): Promise<void> {
    await this.#subscription?.unlisten().catch(() => {});
    this.#subscription = undefined;
  }

  #receive(payload: string): void {
    let event: InvalidationEvent;
    try {
      event = JSON.parse(payload) as InvalidationEvent;
    } catch {
      // A malformed payload means someone else is writing to this channel.
      // Fail safe: invalidate rather than ignore.
      this.#handlers.onCacheInvalidated?.();
      return;
    }
    if (event.origin === this.processId) {
      return;
    }
    this.#applied++;
    if (event.kind === "config") {
      void Promise.resolve(this.#handlers.onConfigChanged?.()).catch(
        (error) => {
          console.error("config invalidation handler failed", error);
        },
      );
      return;
    }
    this.#handlers.onCacheInvalidated?.();
  }

  /**
   * Publishes an event. Never throws: invalidation is best-effort fanout on top
   * of an authoritative store, and an admin clear that already succeeded
   * locally must not be reported as failed because the notify leg did.
   */
  async publish(kind: InvalidationKind, detail?: string): Promise<void> {
    const event: InvalidationEvent = {
      origin: this.processId,
      kind,
      ...(detail !== undefined ? { detail } : {}),
    };
    try {
      // pg_notify(text, text) rather than `NOTIFY channel, 'payload'` because
      // the latter needs the payload as a string LITERAL, which cannot be a
      // bind parameter.
      await this.#publisher.unsafe(`SELECT pg_notify($1, $2)`, [
        INVALIDATION_CHANNEL,
        JSON.stringify(event),
      ]);
    } catch (error) {
      console.warn(
        `invalidation publish failed (other replicas keep their cached ` +
          `entries until TTL): ${
            error instanceof Error ? error.message : error
          }`,
      );
    }
  }

  publishCacheClear(): Promise<void> {
    return this.publish("cache-clear");
  }

  /** Detail deliberately omitted: the key is too large for a NOTIFY payload. */
  publishCacheKey(_request: Record<string, unknown>): Promise<void> {
    return this.publish("cache-key");
  }

  publishRequestId(requestId: string): Promise<void> {
    return this.publish("cache-request-id", requestId);
  }

  publishConfigChanged(): Promise<void> {
    return this.publish("config");
  }
}
