const HEX = /^[0-9a-f]+$/;

function isHex(value: string, length: number): boolean {
  return value.length === length && HEX.test(value);
}

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

/**
 * Parses and validates a traceparent header. Returns the trace id and the
 * caller's span id (which becomes our parent span id), or null when the header
 * is absent or malformed. Rejects all-zero ids and the forbidden `ff` version.
 */
export function parseTraceparent(
  header: string | null,
): { traceId: string; parentId: string } | null {
  if (!header) {
    return null;
  }
  const parts = header.trim().toLowerCase().split("-");
  if (parts.length !== 4) {
    return null;
  }
  const [version, traceId, parentId, flags] = parts;
  if (!isHex(version, 2) || version === "ff") {
    return null;
  }
  if (!isHex(traceId, 32) || isAllZero(traceId)) {
    return null;
  }
  if (!isHex(parentId, 16) || isAllZero(parentId)) {
    return null;
  }
  if (!isHex(flags, 2)) {
    return null;
  }
  return { traceId, parentId };
}

/** Formats a `00`-version traceparent for the given ids. */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled = true,
): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh 16-byte (32 hex) trace id. */
export function newTraceId(): string {
  return randomHex(16);
}

/** A fresh 8-byte (16 hex) span id. */
export function newSpanId(): string {
  return randomHex(8);
}

/** Strips hyphens, lowercases, and validates a 32-hex trace id. "" if invalid. */
export function normalizeTraceId(traceId: string): string {
  const normalized = traceId.replaceAll("-", "").toLowerCase();
  return isHex(normalized, 32) ? normalized : "";
}

/** Strips hyphens, lowercases, and validates a 16-hex span id; a longer value
 * (e.g. a full UUID) is truncated to its first 16 hex chars. "" if invalid. */
export function normalizeSpanId(spanId: string): string {
  let normalized = spanId.replaceAll("-", "").toLowerCase();
  if (normalized.length > 16) {
    normalized = normalized.slice(0, 16);
  }
  return isHex(normalized, 16) ? normalized : "";
}

/** W3C recommends a tracestate no larger than 512 chars. */
const TRACESTATE_MAX = 512;

/** Trims and length-bounds an inbound `tracestate` header for safe passthrough
 * onto exported spans. Returns "" when absent, blank, or over the size bound
 * (an oversized tracestate is dropped rather than truncated mid-member). */
export function sanitizeTracestate(header: string | null): string {
  if (!header) {
    return "";
  }
  const trimmed = header.trim();
  return trimmed.length > 0 && trimmed.length <= TRACESTATE_MAX ? trimmed : "";
}

/** A nested span the inference layer wants parented under the request span. */
export interface ChildSpanRecord {
  /** Span name, e.g. "chat openai" (provider attempt) or "mcp.tool gh__search". */
  name: string;
  /** Epoch-millis start (performance-independent, matches OtelSpanInput). */
  startMs: number;
  /** Epoch-millis end. */
  endMs: number;
  /** Additive span attributes (gen_ai and frosty namespaces, etc.). */
  attributes?: Record<string, string | number | boolean>;
  /** Marks the span's status as error (OTLP status code 2). */
  error?: boolean;
}

/** Defensive bound: a pathological tool loop cannot grow this unbounded. */
const MAX_CHILD_SPANS = 64;

const childSpansByRequest = new WeakMap<Request, ChildSpanRecord[]>();

/** Records a child span for this request (bounded; excess records are dropped). */
export function recordChildSpan(req: Request, span: ChildSpanRecord): void {
  const existing = childSpansByRequest.get(req);
  if (existing) {
    if (existing.length < MAX_CHILD_SPANS) {
      existing.push(span);
    }
    return;
  }
  childSpansByRequest.set(req, [span]);
}

/** Drains and returns the child spans recorded for this request (empty when
 * none were recorded — the default that keeps the single top span behavior). */
export function takeChildSpans(req: Request): ChildSpanRecord[] {
  const spans = childSpansByRequest.get(req);
  if (!spans) {
    return [];
  }
  childSpansByRequest.delete(req);
  return spans;
}
