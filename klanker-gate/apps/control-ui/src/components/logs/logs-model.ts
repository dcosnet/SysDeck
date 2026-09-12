import type { LogEntry } from "../../api";

export type Outcome = "success" | "error" | "processing" | "cancelled";

/**
 * Classify a log line into a request outcome using only recorded fields.
 * - cancelled: HTTP 499 (client closed request convention)
 * - error:     level "error", or a status >= 400
 * - success:   any other numeric status (< 400)
 * - processing: no numeric status yet (in-flight or non-request log line)
 *
 * Every branch is a real predicate over recorded data; "cancelled" simply
 * matches rarely (the gateway seldom emits 499), which is honest, not faked.
 */
export function classifyOutcome(entry: LogEntry): Outcome {
  if (entry.status === 499) {
    return "cancelled";
  }
  if (
    entry.level === "error" ||
    (typeof entry.status === "number" && entry.status >= 400)
  ) {
    return "error";
  }
  if (typeof entry.status === "number") {
    return "success";
  }
  return "processing";
}

export const OUTCOME_ORDER: Outcome[] = [
  "success",
  "error",
  "processing",
  "cancelled",
];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  success: "Success",
  error: "Error",
  processing: "Processing",
  cancelled: "Cancelled",
};

export type OutcomeCounts = Record<Outcome, number>;

export function emptyCounts(): OutcomeCounts {
  return { success: 0, error: 0, processing: 0, cancelled: 0 };
}

/** Time-range value -> window length in ms (matches DEFAULT_TIME_RANGES). */
export const WINDOW_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Human timestamp; falls back to the raw string when unparseable. */
export function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
}

/** "{n}ms" for a recorded duration, or null when latency is not recorded. */
export function formatLatency(durationMs: number | undefined): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  return `${durationMs}ms`;
}

/* ------------------------- derived request type ------------------------- */

const TYPE_BY_PATH: Record<string, string> = {
  "/v1/chat/completions": "chat",
  "/v1/completions": "text",
  "/v1/responses": "responses",
  "/v1/embeddings": "embedding",
  "/v1/messages": "messages",
  "/v1/images/generations": "image",
  "/v1/audio/speech": "speech",
  "/v1/audio/transcriptions": "transcription",
};

/**
 * Request type derived from the recorded path, or null when the path is not an
 * inference surface (admin API, static asset, health probe).
 */
export function requestType(entry: LogEntry): string | null {
  return entry.path ? TYPE_BY_PATH[entry.path] ?? null : null;
}

/* ----------------------------- tokens + cost ---------------------------- */

/** Total tokens for an entry, or null when no usage was recorded. */
export function entryTokens(entry: LogEntry): number | null {
  if (typeof entry.totalTokens === "number") {
    return entry.totalTokens;
  }
  const prompt = entry.promptTokens;
  const completion = entry.completionTokens;
  if (typeof prompt !== "number" && typeof completion !== "number") {
    return null;
  }
  return (prompt ?? 0) + (completion ?? 0);
}

/**
 * Formats integer micro-USD as a USD string. Sub-cent costs keep enough
 * precision to stay non-zero, which matters because a single small completion
 * routinely costs well under a cent.
 */
export function formatCostUsd(costMicroUsd: number): string {
  const usd = costMicroUsd / 1_000_000;
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(6)}`;
  }
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

/* ----------------------------- table columns ---------------------------- */

export type ColumnKey =
  | "time"
  | "type"
  | "provider"
  | "model"
  | "message"
  | "latency"
  | "tokens"
  | "status";

export interface ColumnMeta {
  key: ColumnKey;
  label: string;
  /** true when the column is backed by a recorded field. */
  real: boolean;
}

export const ALL_COLUMNS: ColumnMeta[] = [
  { key: "time", label: "Time", real: true },
  { key: "type", label: "Type", real: true },
  { key: "provider", label: "Provider", real: true },
  { key: "model", label: "Model", real: true },
  { key: "message", label: "Message", real: true },
  { key: "latency", label: "Latency", real: true },
  { key: "tokens", label: "Tokens", real: true },
  { key: "status", label: "Status", real: true },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ALL_COLUMNS.map((c) =>
  c.key
);

/* -------------------------- honest-empty facets ------------------------- */

export interface HonestFacet {
  id: string;
  label: string;
  /**
   * false when the gateway records nothing for this dimension; true when it is
   * recorded per entry but has no filter control yet. The two cases get
   * different affordance text so neither overstates the other.
   */
  recorded?: boolean;
}

export const HONEST_FACETS: HonestFacet[] = [
  { id: "selectedKeys", label: "Selected Keys" },
  { id: "virtualKeys", label: "Virtual Keys" },
  { id: "aliases", label: "Aliases" },
  { id: "routingEngines", label: "Routing Engines" },
  { id: "routingRules", label: "Routing Rules" },
  { id: "user", label: "User" },
  { id: "session", label: "Session" },
  // Recorded per entry (costMicroUsd) but a range filter is not built.
  { id: "cost", label: "Cost", recorded: true },
  { id: "stopReason", label: "Stop Reason" },
  { id: "metadata", label: "Metadata" },
];

/* --------------------------- live value facets -------------------------- */

/** A recorded dimension the rail can filter on by exact value. */
export interface ValueFacet {
  id: "model" | "provider" | "type";
  label: string;
  /** Recorded (or derived) value for an entry, or null when it has none. */
  valueOf: (entry: LogEntry) => string | null;
  /** Rendered with a search box above the option list. */
  searchable?: boolean;
}

export const VALUE_FACETS: ValueFacet[] = [
  {
    id: "model",
    label: "Models",
    valueOf: (entry) => entry.model ?? null,
    searchable: true,
  },
  {
    id: "provider",
    label: "Provider",
    valueOf: (entry) => entry.provider ?? null,
  },
  { id: "type", label: "Type", valueOf: requestType },
];

/** Distinct values of a facet across `entries`, with counts, sorted by value. */
export function facetValues(
  entries: LogEntry[],
  facet: ValueFacet,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const value = facet.valueOf(entry);
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Selected values per live facet id; an empty array means "no constraint". */
export type FacetSelection = Partial<Record<ValueFacet["id"], string[]>>;

/** Applies every non-empty live-facet selection (AND across facets). */
export function applyValueFacets(
  entries: LogEntry[],
  selection: FacetSelection,
): LogEntry[] {
  const active = VALUE_FACETS.filter((facet) =>
    (selection[facet.id]?.length ?? 0) > 0
  );
  if (active.length === 0) {
    return entries;
  }
  return entries.filter((entry) =>
    active.every((facet) => {
      const value = facet.valueOf(entry);
      return value !== null && selection[facet.id]!.includes(value);
    })
  );
}

export function outcomeCounts(entries: LogEntry[]): OutcomeCounts {
  const counts = emptyCounts();
  for (const entry of entries) {
    counts[classifyOutcome(entry)] += 1;
  }
  return counts;
}
