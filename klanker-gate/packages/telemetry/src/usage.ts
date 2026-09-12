/** Usage field pairs across surfaces: OpenAI- and Anthropic-shaped. */
export interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic cache-read tokens, separate from its ordinary input bucket. */
  cache_read_input_tokens?: number;
  /** Anthropic cache-write tokens, billed as an additional priced bucket. */
  cache_creation_input_tokens?: number;
  /** Gemini native usageMetadata fields. */
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  /** Cohere v2 response usage shape. */
  billed_units?: { input_tokens?: number; output_tokens?: number };
}

/** Governance-resolved tenant identity. All fields optional: a request may have
 * a key with no team, or no key at all. */
export interface TenantIdentity {
  virtualKeyId?: string;
  virtualKeyName?: string;
  teamId?: string;
  teamName?: string;
  customerId?: string;
  customerName?: string;
  /**
   * True when the key restricts dispatch to a provider/model allowlist. Read
   * by anything that may serve a result the request did not itself produce -
   * the response cache - since those paths run before the dispatch filter.
   */
  dispatchScoped?: boolean;
}

const tenantByRequest = new WeakMap<Request, TenantIdentity>();

/** Records the governance-resolved tenant identity for this request. */
export function setRequestTenant(req: Request, identity: TenantIdentity): void {
  tenantByRequest.set(req, identity);
}

/** Reads the tenant identity resolved upstream by governance, if any. */
export function getRequestTenant(req: Request): TenantIdentity | undefined {
  return tenantByRequest.get(req);
}

/**
 * Units a media surface delivered, as counted by the route that dispatched it.
 * Every field is optional: a surface reports only the dimensions it can count.
 * Absence means "not counted", never "zero" (decision-log 56).
 */
export interface MediaUnits {
  /** Non-negative safe integer. */
  imageCount?: number;
  /** Non-negative safe integer. */
  characterCount?: number;
  /** Non-negative finite; fractional is legitimate. */
  audioSeconds?: number;
}

/**
 * What the gateway ADMITTED AND DISPATCHED, plus what a provider actually
 * delivered. Written by the media route; read by governanceMiddleware and
 * telemetryMiddleware.
 */
export interface RequestDispatch {
  providerId: string;
  /** `""` when the caller named no model, which prices to null with no case. */
  model: string;
  /**
   * The PROVIDER's own HTTP status, recorded once its response headers are in
   * hand. Absent means no provider response was ever seen (pre-headers abort,
   * DNS failure, connection refusal). This field is the evidence that a
   * provider was reached; `units`/`tokens` are only ever written alongside a
   * 2xx. Never derived from the gateway's own response status, which
   * mapDispatchError and errorHandler both rewrite.
   */
  providerStatus?: number;
  /**
   * Token usage the media response itself reported, already through
   * {@link normalizeUsage}. Absent when the body carried none.
   */
  tokens?: {
    prompt: number;
    completion: number;
    cached: number;
    cacheCreation: number;
  };
  units?: MediaUnits;
  /**
   * Which accounting site has already settled. Per-site, because the two sites
   * settle DIFFERENT authorities: governance owns recordCost, telemetry owns
   * emit. Not one global flag.
   */
  settledBy?: { governance?: boolean; telemetry?: boolean };
}

/** The counter surface `Metrics.increment` satisfies structurally, so this file
 * needs no import from the metrics module. */
export interface CounterSink {
  increment(name: string, value?: number): void;
}

const dispatchByRequest = new WeakMap<Request, RequestDispatch>();

/**
 * Records the target this request was dispatched to, immediately before the
 * dispatch. **First-write-wins**: a second write is refused, counted as
 * `accounting.dispatch_rewritten`, and leaves the recorded target alone.
 *
 * Because the channel is authoritative at both accounting sites, a
 * last-write-wins setter would bill a target that was never dispatched to in
 * preference to the response body's own model. Quantities are added afterwards
 * through {@link mergeRequestUnits} / {@link mergeRequestTokens}, which are not
 * rewrites. Returns whether the write took effect; pass `ctx.metrics` so a
 * refused rewrite is observable.
 */
export function setRequestDispatch(
  req: Request,
  dispatch: RequestDispatch,
  counters?: CounterSink,
): boolean {
  if (dispatchByRequest.has(req)) {
    counters?.increment("accounting.dispatch_rewritten");
    return false;
  }
  dispatchByRequest.set(req, dispatch);
  return true;
}

/** Reads what this request was dispatched to and delivered, if anything. */
export function getRequestDispatch(req: Request): RequestDispatch | undefined {
  return dispatchByRequest.get(req);
}

/**
 * Records the PROVIDER's own response status, once its headers are in hand.
 * First-write-wins: a media route dispatches exactly once, so a second status
 * would belong to a dispatch this channel never recorded. Returns whether it was
 * recorded. Not a target rewrite, so it does not touch that counter.
 */
export function mergeRequestStatus(req: Request, status: number): boolean {
  const existing = dispatchByRequest.get(req);
  if (!existing || existing.providerStatus !== undefined) {
    return false;
  }
  existing.providerStatus = status;
  return true;
}

/**
 * Adds delivered units to an existing dispatch record. A merge with no record
 * is DROPPED rather than creating one: a quantity whose target is unknown would
 * otherwise bill to an empty provider/model, and misattribution is worse than
 * an uncounted unit.
 */
export function mergeRequestUnits(req: Request, units: MediaUnits): void {
  const existing = dispatchByRequest.get(req);
  if (!existing) {
    return;
  }
  existing.units = { ...existing.units, ...units };
}

/** Adds the response body's own token usage. Same no-record rule as
 * {@link mergeRequestUnits}. */
export function mergeRequestTokens(
  req: Request,
  tokens: RequestDispatch["tokens"],
): void {
  const existing = dispatchByRequest.get(req);
  if (!existing || !tokens) {
    return;
  }
  existing.tokens = { ...existing.tokens, ...tokens };
}

/**
 * Claims settlement for one accounting site. Returns `false` when that site has
 * already settled - or when there is no dispatch record to settle - so the
 * caller short-circuits. Deliberately per-site: governance and telemetry own
 * different authorities and each must run exactly once, so claiming one must
 * never suppress the other.
 */
export function markSettled(
  req: Request,
  site: "governance" | "telemetry",
): boolean {
  const existing = dispatchByRequest.get(req);
  if (!existing) {
    return false;
  }
  const settled = existing.settledBy ?? {};
  if (settled[site]) {
    return false;
  }
  existing.settledBy = { ...settled, [site]: true };
  return true;
}

/**
 * Non-negative safe integer, or 0. For token counts and image counts. Guards
 * every downstream multiplication: a negative token count renders a decreasing
 * Prometheus counter, and a non-finite one propagates as NaN.
 */
export function clampCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.min(Math.trunc(v), Number.MAX_SAFE_INTEGER)
    : 0;
}

/** Non-negative finite, or undefined. For audio seconds, where a fraction is
 * real and absence must not become a billed zero. */
export function clampSeconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function normalizeUsage(
  usage: UsageShape,
): {
  prompt: number;
  completion: number;
  cached: number;
  cacheCreation: number;
  total: number;
} {
  const cached = usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ?? usage.cachedContentTokenCount ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const openAiPrompt = usage.prompt_tokens;
  const providerInput = usage.input_tokens ?? usage.promptTokenCount ??
    usage.billed_units?.input_tokens;
  // OpenAI's prompt_tokens already includes its cached subset. Anthropic's
  // input_tokens excludes cache-read input, so add that bucket for correct
  // total-context tier selection and cache-read pricing.
  const prompt = openAiPrompt ?? ((providerInput ?? 0) +
    (usage.cache_read_input_tokens ?? 0));
  const completion = usage.completion_tokens ?? usage.output_tokens ??
    usage.candidatesTokenCount ?? usage.billed_units?.output_tokens ?? 0;
  // Clamped after the vendor arithmetic above, not per input field: the
  // Anthropic prompt sum can overflow to Infinity from two finite addends, so
  // a clamp applied before the sum would not catch it. Math.trunc on an
  // integer is identity, so no existing usage figure moves.
  const p = clampCount(prompt);
  const c = clampCount(completion);
  const created = clampCount(cacheCreation);
  return {
    prompt: p,
    completion: c,
    cached: clampCount(cached),
    cacheCreation: created,
    total: p + c + created,
  };
}

const SSE_TAP_CAP = 16_384;

/** Cap on the one retained frame. 128 KiB is roughly 32k output tokens of JSON
 * tool arguments, past any provider's per-response ceiling, and holds the tap's
 * worst case to 2 * SSE_TAP_CAP + 2 * SSE_FRAME_CAP = 288 KiB per stream -
 * O(cap), never O(stream). A larger frame is dropped rather than buffered. */
const SSE_FRAME_CAP = 131_072;

/**
 * Pass-through byte tap retaining the first and last SSE_TAP_CAP chars plus the
 * last complete `data:` line. Usage blocks live at the stream's edges
 * (Anthropic message_start / OpenAI include_usage final chunk), so the capture
 * is bounded no matter how large the stream. Dies with the consumer;
 * cancellation propagates.
 *
 * The retained line exists because a single frame can be larger than the tail
 * window: translators that buffer tool-call arguments and emit them whole
 * (GenAI) put them in the same frame as usage, and a window holding only that
 * frame's truncated halves parses as nothing, which billed the request zero.
 * Duplication with the tail is a no-op - {@link extractStreamUsage} maxes.
 *
 * `onFirstChunk` (optional) fires exactly once, on the first byte the upstream
 * produces, so callers can measure time-to-first-token without touching the
 * bytes. `onChunk` observes each forwarded transport chunk. Existing callers
 * are unaffected; no callback can alter client-visible SSE bytes.
 */
export function tapSseTail(
  body: ReadableStream<Uint8Array>,
  onDone: (text: string) => void,
  onFirstChunk?: () => void,
  onChunk?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let frame = "";
  // Line under assembly across chunk boundaries, and whether it has already
  // outgrown SSE_FRAME_CAP (in which case it is discarded, not buffered).
  let partial = "";
  let dropped = false;
  let firstSeen = false;

  const keepLine = (line: string): void => {
    if (!line.startsWith("data:")) {
      return;
    }
    // [DONE] carries no usage, and on OpenAI-shaped streams it is the last
    // line - retaining it would displace the frame that does carry usage.
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    frame = line;
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!firstSeen) {
          firstSeen = true;
          if (onFirstChunk) {
            try {
              onFirstChunk();
            } catch {
              // First-chunk timing must never break the stream.
            }
          }
        }
        controller.enqueue(chunk);
        if (onChunk) {
          try {
            onChunk();
          } catch {
            // Timing telemetry must never interrupt the stream.
          }
        }
        // Incremental UTF-8: a character split across chunks is held here, not
        // corrupted, so line assembly below always sees whole characters.
        const text = decoder.decode(chunk, { stream: true });
        if (head.length < SSE_TAP_CAP) {
          head += text.slice(0, SSE_TAP_CAP - head.length);
        }
        tail = (tail + text).slice(-SSE_TAP_CAP);
        const parts = text.split("\n");
        for (let i = 0; i < parts.length - 1; i++) {
          if (!dropped && partial.length + parts[i].length <= SSE_FRAME_CAP) {
            keepLine(partial + parts[i]);
          }
          partial = "";
          dropped = false;
        }
        const rest = parts[parts.length - 1];
        if (!dropped) {
          if (partial.length + rest.length > SSE_FRAME_CAP) {
            dropped = true;
            partial = "";
          } else {
            partial += rest;
          }
        }
      },
      flush() {
        // An upstream cut short leaves no trailing newline; a truncated line
        // cannot parse, so taking it can only recover usage, never invent it.
        if (!dropped && partial) {
          keepLine(partial);
        }
        try {
          onDone(
            frame ? head + "\n" + tail + "\n" + frame : head + "\n" + tail,
          );
        } catch {
          // Accounting must never error the stream close.
        }
      },
    }),
  );
}

/** Shape of the SSE data payloads the scanners below understand. */
interface StreamChunk {
  model?: string;
  usage?: UsageShape | null;
  usageMetadata?: UsageShape;
  modelVersion?: string;
  delta?: { usage?: UsageShape };
  message?: { model?: string; usage?: UsageShape };
}

/** Yields each parseable `data:` payload; truncated seam lines are skipped. */
function* streamChunks(text: string): Generator<StreamChunk> {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      yield JSON.parse(payload) as StreamChunk;
    } catch {
      continue;
    }
  }
}

/** Model id from a chunk, across the vendor shapes we translate. */
function chunkModel(chunk: StreamChunk): string {
  return chunk.model || chunk.message?.model || chunk.modelVersion || "";
}

/**
 * Model id from a streamed response, independent of whether it carried usage.
 *
 * {@link extractStreamUsage} returns undefined without a usage block because its
 * callers gate billing on that, but most providers omit usage unless asked
 * (OpenAI needs `stream_options.include_usage`). Hence the split: usage stays
 * usage-gated, the model does not.
 */
export function extractStreamModel(text: string): string {
  for (const chunk of streamChunks(text)) {
    const model = chunkModel(chunk);
    if (model) {
      return model;
    }
  }
  return "";
}

/**
 * Scans captured SSE text for the model id and the maximal usage figures
 * (lines duplicated across the tap's head/tail/retained-frame captures are
 * harmless under max()).
 *
 * Returns undefined when the stream carried NO usage block - callers use that
 * to skip billing. Use {@link extractStreamModel} when you only need the model.
 */
export function extractStreamUsage(
  text: string,
): {
  model: string;
  prompt: number;
  completion: number;
  cached: number;
  cacheCreation: number;
  total: number;
} | undefined {
  let model = "";
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheCreation = 0;
  let seen = false;
  for (const chunk of streamChunks(text)) {
    model = model || chunkModel(chunk);
    for (
      const usage of [
        chunk.usage,
        chunk.message?.usage,
        chunk.usageMetadata,
        chunk.delta?.usage,
      ]
    ) {
      if (!usage) {
        continue;
      }
      seen = true;
      const n = normalizeUsage(usage);
      prompt = Math.max(prompt, n.prompt);
      completion = Math.max(completion, n.completion);
      cached = Math.max(cached, n.cached);
      cacheCreation = Math.max(cacheCreation, n.cacheCreation);
    }
  }
  return seen
    ? {
      model,
      prompt,
      completion,
      cached,
      cacheCreation,
      total: prompt + completion + cacheCreation,
    }
    : undefined;
}
