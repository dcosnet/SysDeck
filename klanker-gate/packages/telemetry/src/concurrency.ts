/** Lifetimes averaged over this many most-recent completed connections. */
const LIFETIME_WINDOW = 1000;

/**
 * Handle for one open connection. `close()` is idempotent: a response stream
 * can both flush and cancel, and a double count would corrupt the gauge.
 */
export interface ConnectionHandle {
  close(): void;
}

/**
 * Counts connections for their whole lifetime - from request receipt until the
 * response body is fully flushed or the client goes away - and separately
 * counts handler dispatch, which is a strictly shorter window for any streamed
 * response.
 */
export class ConcurrencyGauge {
  #active = 0;
  #peak = 0;
  #total = 0;
  #completed = 0;
  #maxLifetimeMs = 0;

  #dispatching = 0;
  #peakDispatching = 0;

  /** token -> start mark, so the oldest open connection is answerable. */
  readonly #open = new Map<number, number>();
  #nextToken = 1;

  readonly #ring = new Float64Array(LIFETIME_WINDOW);
  #ringCount = 0;
  #ringIndex = 0;
  #ringSum = 0;

  readonly #since = Date.now();

  /** Connections open right now, this process. */
  active(): number {
    return this.#active;
  }

  /** Highest simultaneous open connections since process start. */
  peak(): number {
    return this.#peak;
  }

  /** Connections accepted since process start. */
  total(): number {
    return this.#total;
  }

  /** Handlers executing right now. Excludes time spent streaming a body. */
  dispatching(): number {
    return this.#dispatching;
  }

  /** Epoch millis the gauge started counting. */
  since(): number {
    return this.#since;
  }

  /**
   * Opens a connection. The returned handle must be closed exactly once, from
   * every exit path including client aborts, or the gauge reads as permanently
   * saturated.
   */
  open(): ConnectionHandle {
    const token = this.#nextToken++;
    this.#open.set(token, performance.now());
    this.#active++;
    this.#total++;
    if (this.#active > this.#peak) {
      this.#peak = this.#active;
    }
    let closed = false;
    return {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.#close(token);
      },
    };
  }

  #close(token: number): void {
    const start = this.#open.get(token);
    if (start === undefined) {
      return;
    }
    this.#open.delete(token);
    this.#active--;
    this.#completed++;
    const elapsed = performance.now() - start;
    if (elapsed > this.#maxLifetimeMs) {
      this.#maxLifetimeMs = elapsed;
    }
    this.#recordLifetime(elapsed);
  }

  #recordLifetime(ms: number): void {
    if (this.#ringCount === LIFETIME_WINDOW) {
      this.#ringSum -= this.#ring[this.#ringIndex];
    } else {
      this.#ringCount++;
    }
    this.#ring[this.#ringIndex] = ms;
    this.#ringSum += ms;
    this.#ringIndex = (this.#ringIndex + 1) % LIFETIME_WINDOW;
    // Resum on wrap: repeated subtraction accumulates float error otherwise.
    if (this.#ringIndex === 0) {
      let sum = 0;
      for (let i = 0; i < this.#ringCount; i++) {
        sum += this.#ring[i];
      }
      this.#ringSum = sum;
    }
  }

  enterDispatch(): void {
    this.#dispatching++;
    if (this.#dispatching > this.#peakDispatching) {
      this.#peakDispatching = this.#dispatching;
    }
  }

  exitDispatch(): void {
    if (this.#dispatching > 0) {
      this.#dispatching--;
    }
  }

  /** Runs `fn` counted as dispatch. try/finally so a throw still decrements. */
  async trackDispatch<T>(fn: () => Promise<T>): Promise<T> {
    this.enterDispatch();
    try {
      return await fn();
    } finally {
      this.exitDispatch();
    }
  }

  /** Age of the oldest still-open connection in ms, or 0 when none are open. */
  longestOpenMs(): number {
    if (this.#open.size === 0) {
      return 0;
    }
    const now = performance.now();
    let oldest = Infinity;
    for (const start of this.#open.values()) {
      if (start < oldest) {
        oldest = start;
      }
    }
    return Math.round(now - oldest);
  }

  snapshot(): ConcurrencySnapshot {
    return {
      active: this.#active,
      peak: this.#peak,
      total: this.#total,
      completed: this.#completed,
      avgLifetimeMs: this.#ringCount === 0
        ? 0
        : Math.round(this.#ringSum / this.#ringCount),
      maxLifetimeMs: Math.round(this.#maxLifetimeMs),
      longestOpenMs: this.longestOpenMs(),
      dispatching: this.#dispatching,
      peakDispatching: this.#peakDispatching,
      since: new Date(this.#since).toISOString(),
    };
  }
}

export interface ConcurrencySnapshot {
  /** Open right now, THIS PROCESS only. */
  active: number;
  /** Peak simultaneous open, this process, since start. */
  peak: number;
  /** Connections accepted since start, this process. */
  total: number;
  /** Connections fully closed since start. */
  completed: number;
  /** Mean lifetime over the last 1000 completed connections. */
  avgLifetimeMs: number;
  /** Longest completed lifetime since start. */
  maxLifetimeMs: number;
  /** Age of the oldest connection still open. */
  longestOpenMs: number;
  /** Handlers executing right now; excludes streaming time. */
  dispatching: number;
  /** Peak simultaneous handler dispatch. */
  peakDispatching: number;
  /** ISO timestamp the counters started. */
  since: string;
}

/**
 * Returns `response` with its body counted until the last byte is flushed or
 * the client disconnects. Chunks pass through by reference - nothing is
 * buffered, inspected, or reordered, and backpressure is preserved, so the
 * streaming contract holds. A bodyless response closes the handle at once.
 */
export function trackResponseLifetime(
  response: Response,
  handle: ConnectionHandle | undefined,
): Response {
  if (handle === undefined) {
    return response;
  }
  if (response.body === null) {
    handle.close();
    return response;
  }
  const reader = response.body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          handle.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        handle.close();
        controller.error(error);
      }
    },
    async cancel(reason) {
      handle.close();
      await reader.cancel(reason);
    },
  });
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
