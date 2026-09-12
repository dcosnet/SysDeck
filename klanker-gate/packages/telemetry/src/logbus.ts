/**
 * Opt-in per-modality content capture (a subset of the request/response bodies).
 * Absent unless content logging is explicitly enabled (see {@link
 * logContentEnabled}); default OFF for privacy. `modality` tags which inference
 * surface produced it ("chat" | "text" | "embedding" | "speech" |
 * "transcription" | "image" | "responses" | "rerank" | ...).
 */
export interface LogContent {
  modality?: string;
  request?: unknown;
  response?: unknown;
}

export interface LogEntry {
  ts: string;
  level: "info" | "error";
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;

  /** Upstream provider id (e.g. "openai"), when the request reached inference. */
  provider?: string;
  /** Resolved model name, when known. */
  model?: string;
  /** Prompt/input tokens, when the response carried usage. */
  promptTokens?: number;
  /** Completion/output tokens, when the response carried usage. */
  completionTokens?: number;
  /** Total tokens; defaults to prompt+completion when a caller omits it. */
  totalTokens?: number;
  /**
   * Per-entry cost in integer micro-USD (the repo-wide cost unit; floats only
   * appear at the API edge). Derived from the pricing catalog + token counts,
   * either at capture time or by POST /api/logs/recalculate-cost.
   */
  costMicroUsd?: number;
  /** Opt-in captured content; only present when FROSTY_LOG_CONTENT is enabled. */
  content?: LogContent;
}

/** "1xx" | "2xx" | "3xx" | "4xx" | "5xx" for a status code, else "unknown". */
export function statusClass(status?: number): string {
  if (status === undefined || status < 100 || status >= 600) {
    return "unknown";
  }
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Whether opt-in per-modality content capture is enabled. Default OFF for
 * privacy: content is NEVER captured unless FROSTY_LOG_CONTENT is set to
 * on|1|true|yes. Reading the env is defensive (a missing --allow-env falls back
 * to OFF rather than throwing), matching the gateway's other env probes.
 */
export function logContentEnabled(
  raw = safeEnv("FROSTY_LOG_CONTENT"),
): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "on" || value === "1" || value === "true" || value === "yes";
}

/* ------------------------- dashboard path exclusion ---------------------- */

/**
 * Paths excluded from the Logs trail by default: the container healthcheck and
 * the Prometheus scrape target, plus the browser's unconditional favicon probe.
 *
 * These are machine probes on fixed intervals, so they accumulate at a constant
 * rate whether or not the gateway is doing any work. Measured on a real
 * deployment they were 4982 of 5000 stored entries (99.6%), which turns the
 * whole durable trail over roughly every 10 hours of pure idle time and
 * guarantees that any genuine inference request is pruned away by probe noise.
 * They also poison the KPI row: "avg latency 1.82ms / success rate 100%" was
 * measuring health probes, not traffic.
 */
export const DEFAULT_LOG_EXCLUDE_PATHS = "/healthz,/metrics,/favicon.ico";

/** Bounds on the parsed pattern list, so a hostile env value stays cheap. */
const MAX_EXCLUDE_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 256;
/** Values that explicitly disable exclusion (mirrors FROSTY_LOG_STORE's vocab). */
const EXCLUDE_OFF = ["off", "none", "0", "false", "disabled"];

/**
 * Builds a path predicate from a comma-separated pattern list.
 *
 * - unset or blank -> {@link DEFAULT_LOG_EXCLUDE_PATHS} (blank is treated as
 *   "use the default" to match this repo's other knobs, where Compose passes
 *   `${VAR:-}` through as an empty string).
 * - `off`/`none`/`0`/`false`/`disabled` -> exclude nothing; every request is
 *   logged to the dashboard trail.
 * - `/healthz` matches that exact path; `/assets/*` matches any path under
 *   `/assets/`. No other wildcard syntax is supported.
 *
 * Matching is exact-or-prefix only (never a regex) so a pattern can never cost
 * more than a string compare per request.
 */
export function makePathExcluder(
  raw?: string,
): (path: string | undefined) => boolean {
  const value = (raw ?? "").trim();
  const source = value === "" ? DEFAULT_LOG_EXCLUDE_PATHS : value;
  if (EXCLUDE_OFF.includes(source.toLowerCase())) {
    return () => false;
  }
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const part of source.split(",")) {
    const pattern = part.trim().slice(0, MAX_PATTERN_LENGTH);
    if (!pattern || exact.size + prefixes.length >= MAX_EXCLUDE_PATTERNS) {
      continue;
    }
    if (pattern.endsWith("/*")) {
      prefixes.push(pattern.slice(0, -1)); // "/assets/*" -> "/assets/"
    } else {
      exact.add(pattern);
    }
  }
  if (exact.size === 0 && prefixes.length === 0) {
    return () => false;
  }
  return (path) => {
    if (!path) {
      return false;
    }
    if (exact.has(path)) {
      return true;
    }
    for (const prefix of prefixes) {
      if (path.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  };
}

/** {@link makePathExcluder} over FROSTY_LOG_EXCLUDE_PATHS. */
export function logExcludedPathsFromEnv(
  raw = safeEnv("FROSTY_LOG_EXCLUDE_PATHS"),
): (path: string | undefined) => boolean {
  return makePathExcluder(raw);
}

function safeEnv(name: string): string | undefined {
  try {
    // Reach Deno via globalThis so browser-side type-checkers stay happy: the
    // control UI imports the LogEntry type from this module and must not require
    // the Deno global. At runtime on Deno this resolves normally.
    const denoEnv =
      (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
        .Deno?.env;
    return denoEnv?.get(name) ?? undefined;
  } catch {
    return undefined; // env not readable (no --allow-env): treat as unset.
  }
}

/** Object keys whose values are redacted from captured content (never logged). */
const SECRET_KEY_RE =
  /(authorization|api[-_]?key|secret|token|password|passwd|bearer|cookie|credential|access[-_]?key|client[-_]?secret|private[-_]?key|session[-_]?id|x-api-key)/i;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
/** Recursion cap: guards against deeply-nested / cyclic content structures. */
const MAX_REDACT_DEPTH = 8;

/**
 * Deep-copies `value`, replacing any secret-looking KEY's value with
 * "[redacted]". Message/prompt bodies (the point of content capture) are kept;
 * only credential-bearing fields (headers, api keys, cookies, ...) are stripped.
 * The copy also detaches references and caps depth, so the result is safe to
 * persist via structured clone (KV) without leaking secrets or looping on cycles.
 */
export function redactContent(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContent(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key)
      ? REDACTED
      : redactContent(val, depth + 1);
  }
  return out;
}

/**
 * Builds a captured-content record for a request/response pair, or `undefined`
 * when capture is disabled (the default). Secrets are redacted from both sides.
 *
 * NOTE: the `provider` / `model` / token / cost half of the follow-up this
 * docblock used to describe is DONE - `logenrich.ts` bridges the always-on
 * telemetry middleware to the request-log trail, so those fields are populated
 * for every inference request. `content` remains unpopulated: the request
 * logger still only sees method/path/status, and no production caller invokes
 * this helper. See environment-variables.md 5.3.
 */
export function captureContent(
  modality: string,
  request: unknown,
  response: unknown,
  enabled = logContentEnabled(),
): LogContent | undefined {
  if (!enabled) {
    return undefined;
  }
  return {
    modality,
    request: redactContent(request),
    response: redactContent(response),
  };
}

/** In-memory ring buffer with live subscribers for the UI log stream. */
export class LogBus {
  private buffer: LogEntry[] = [];
  private subscribers = new Set<(entry: LogEntry) => void>();
  /** Count of entries evicted from the ring (oldest-out) over its lifetime. */
  private droppedCount = 0;

  constructor(private capacity = 500) {}

  publish(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      const removed = this.buffer.length - this.capacity;
      this.buffer.splice(0, removed);
      this.droppedCount += removed;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // a broken subscriber must never break request logging
      }
    }
  }

  /**
   * Patches the newest buffered entry carrying `requestId` and republishes the
   * merged result to live subscribers, returning it. Used when a streamed
   * response resolves its usage after the entry was already published.
   *
   * This is an in-place rewrite, NOT an append: the ring length and the
   * dropped-entry counter are untouched, so a patch can never evict a
   * neighbouring entry. Returns undefined when the entry has already aged out.
   */
  update(
    requestId: string,
    patch: Partial<LogEntry>,
  ): LogEntry | undefined {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].requestId !== requestId) {
        continue;
      }
      const merged = { ...this.buffer[i], ...patch };
      this.buffer[i] = merged;
      for (const subscriber of this.subscribers) {
        try {
          subscriber(merged);
        } catch {
          // a broken subscriber must never break request logging
        }
      }
      return merged;
    }
    return undefined;
  }

  recent(limit = 100): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  /** Entries evicted from the live ring (oldest-out) since start. */
  dropped(): number {
    return this.droppedCount;
  }

  subscribe(fn: (entry: LogEntry) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
