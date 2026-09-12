import type { LogEntry } from "./logbus.ts";

/** Inference fields the telemetry layer resolves for a single request. */
export interface LogEnrichment {
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costMicroUsd?: number;
}

/**
 * Applied when enrichment arrives AFTER the log entry has already been
 * published and appended (the streaming case). Implementations patch the live
 * ring and the durable trail by request id.
 */
export type LateEnrichmentSink = (
  requestId: string,
  enrichment: LogEnrichment,
) => void;

/** Per-request slot. Deleted as soon as both sides have been seen. */
interface Slot {
  /** Resolved by telemetry, still waiting for the log entry to be built. */
  enrichment?: LogEnrichment;
  /** The log entry already went out; a later record() must patch instead. */
  emitted?: boolean;
}

/**
 * Default cap on concurrently tracked requests. Only inference requests are
 * ever tracked, and a slot lives for the duration of one request, so this
 * bounds memory even when a slot leaks (a middleware throwing between track()
 * and both callbacks). Oldest-out eviction keeps the map from growing without
 * a timer.
 */
const MAX_TRACKED = 1024;

export class LogEnrichmentBridge {
  /** Insertion-ordered, so eviction of the oldest slot is a first-key delete. */
  private slots = new Map<string, Slot>();

  /**
   * @param onLate patches an already-emitted entry. Left undefined in unit
   * contexts, where the streaming patch simply does not happen.
   */
  constructor(
    private onLate?: LateEnrichmentSink,
    private maxTracked = MAX_TRACKED,
  ) {}

  /** Installs the late-patch sink after construction (composition root wiring). */
  setLateSink(sink: LateEnrichmentSink): void {
    this.onLate = sink;
  }

  /**
   * Marks a request as enrichment-eligible. Called by telemetryMiddleware on
   * entry, so ONLY inference requests ever occupy a slot: health probes, asset
   * reads, and admin API calls never allocate.
   */
  track(requestId: string | undefined): void {
    if (!requestId || this.slots.has(requestId)) {
      return;
    }
    this.slots.set(requestId, {});
    while (this.slots.size > this.maxTracked) {
      const oldest = this.slots.keys().next();
      if (oldest.done) {
        break;
      }
      this.slots.delete(oldest.value);
    }
  }

  /**
   * Merges any enrichment already resolved for this entry, returning the entry
   * UNCHANGED when the request was never tracked or nothing has resolved yet.
   * A tracked-but-unresolved entry is flagged so the eventual record() patches.
   */
  attach(entry: LogEntry): LogEntry {
    const id = entry.requestId;
    if (!id) {
      return entry;
    }
    const slot = this.slots.get(id);
    if (!slot) {
      return entry; // not an inference request, or evicted under load
    }
    if (slot.enrichment) {
      this.slots.delete(id);
      return { ...entry, ...slot.enrichment };
    }
    slot.emitted = true; // streaming: usage lands after the tap flushes
    return entry;
  }

  /**
   * Publishes the resolved inference fields for a request. Stashes them when
   * the log entry has not been built yet; otherwise hands them to the late sink
   * so the already-stored entry is patched.
   */
  record(requestId: string | undefined, enrichment: LogEnrichment): void {
    if (!requestId) {
      return;
    }
    const slot = this.slots.get(requestId);
    if (!slot) {
      return; // never tracked, or evicted before both sides were seen
    }
    if (slot.emitted) {
      this.slots.delete(requestId);
      try {
        this.onLate?.(requestId, enrichment);
      } catch {
        // Log enrichment must never throw into the response path.
      }
      return;
    }
    slot.enrichment = enrichment;
  }

  /** Slots currently held. Exposed for tests and leak assertions. */
  size(): number {
    return this.slots.size;
  }
}

/**
 * Drops undefined/empty fields so `attach` never overwrites a recorded value
 * with `undefined`, and so an all-empty enrichment serializes a LogEntry
 * byte-identically to how it did before this module existed.
 */
export function compactEnrichment(input: {
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costMicroUsd?: number | null;
}): LogEnrichment {
  const out: LogEnrichment = {};
  if (input.provider) {
    out.provider = input.provider;
  }
  if (input.model) {
    out.model = input.model;
  }
  if (typeof input.promptTokens === "number") {
    out.promptTokens = input.promptTokens;
  }
  if (typeof input.completionTokens === "number") {
    out.completionTokens = input.completionTokens;
  }
  if (typeof input.totalTokens === "number") {
    out.totalTokens = input.totalTokens;
  }
  if (typeof input.costMicroUsd === "number") {
    out.costMicroUsd = input.costMicroUsd;
  }
  return out;
}
