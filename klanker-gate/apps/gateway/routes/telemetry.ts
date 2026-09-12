import {
  extractStreamModel,
  extractStreamUsage,
  getRequestTenant,
  normalizeUsage,
  tapSseTail,
  type TenantIdentity,
  type UsageShape,
} from "../../../packages/telemetry/src/usage.ts";
import { compactEnrichment } from "../../../packages/telemetry/src/logenrich.ts";
import {
  newSpanId,
  newTraceId,
  parseTraceparent,
  sanitizeTracestate,
  takeChildSpans,
} from "../../../packages/telemetry/src/trace.ts";
import { COLLAPSED_LABEL } from "../../../packages/telemetry/src/span_cardinality.ts";
import type { AppContext } from "../context.ts";
import { azureDeploymentFromPath } from "./azure_ingress.ts";
import { modelFromPath } from "./governance.ts";

/** OpenAI-shaped inference surfaces matched exactly. The URL-alias prefixes are
 * rewritten onto /v1 before middleware runs, so these cover them too. */
const CANONICAL_INFERENCE_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/messages",
]);

/** Azure deployment operations that dispatch a model. */
const AZURE_OPS = new Set(["chat/completions", "completions", "embeddings"]);

/** OpenRouter operations that dispatch a model (`models` is discovery only). */
const OPENROUTER_OPS = new Set(["chat/completions", "embeddings"]);

/** GenAI actions that dispatch a model (`countTokens` does not). */
const GENAI_ACTIONS = new Set(["generateContent", "streamGenerateContent"]);

/**
 * True for every ingress surface that dispatches a model. One predicate gates
 * metrics, the usage record, the `llm.call` span and log enrichment, so they
 * can only widen together - the reopen condition decision-log 56 set for its
 * four-path `INFERENCE_PATHS` gap.
 */
export function isInferencePath(pathname: string): boolean {
  if (
    CANONICAL_INFERENCE_PATHS.has(pathname) || pathname === "/cohere/v2/chat"
  ) {
    return true;
  }
  const genai = pathname.match(/^\/genai\/v1beta\/models\/([^/?]+)$/);
  if (genai) {
    const modelAction = decodeURIComponent(genai[1]);
    const colon = modelAction.lastIndexOf(":");
    return GENAI_ACTIONS.has(colon > 0 ? modelAction.slice(colon + 1) : "");
  }
  const azure = pathname.match(/^\/openai\/deployments\/[^/]+\/(.+)$/);
  if (azure) {
    return AZURE_OPS.has(azure[1]);
  }
  const openrouter = pathname.match(/^\/openrouter\/v1\/(.+)$/);
  return openrouter ? OPENROUTER_OPS.has(openrouter[1]) : false;
}

interface Observation {
  ctx: AppContext;
  requestId?: string;
  model: string;
  prompt: number;
  completion: number;
  cached?: number;
  cacheCreation?: number;
  status: number;
  stream: boolean;
  cacheHeader: string | null;
  ttftMs?: number;
  startedAtMs: number;
  endMs: number;
  durationMs: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** The request object, used to drain the request-scoped child spans (provider
   * attempts / MCP tool executions) the inference layer recorded against it. */
  req: Request;
  /** Sanitized inbound W3C tracestate, passed through onto every emitted span. */
  traceState?: string;
  /** Response finish reason (chat/completions surfaces), when present. */
  finishReason?: string;
  /** Governance-resolved tenant identity (absent for zero-virtual-key traffic). */
  tenant?: TenantIdentity;
}

const cap = (s: string, n = 256): string => s.length > n ? s.slice(0, n) : s;

/** Scans captured SSE text for the first choice's finish_reason (chat/completions
 * streaming). Duplicated head/tail lines are harmless; the last seen wins. */
function extractFinishReason(text: string): string | undefined {
  let reason: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ finish_reason?: string | null }>;
      };
      const found = parsed.choices?.[0]?.finish_reason;
      if (found) {
        reason = found;
      }
    } catch {
      // Line truncated at the capture seam: skip.
    }
  }
  return reason;
}

/** Fans one observation out to metrics, the usage tracker, and an LLM span. */
function emit(o: Observation): void {
  const { ctx } = o;
  // Cap caller-influenced strings before they enter records/spans (metric
  // labels are separately bounded to the catalog key or "other").
  const model = cap(o.model);
  const requestId = o.requestId ? cap(o.requestId) : undefined;
  const provider = (model ? ctx.providers.tryProviderId(model) : undefined) ??
    "unknown";
  const totalTokens = o.prompt + o.completion + (o.cacheCreation ?? 0);
  const costMicroUsd = model
    ? (ctx.pricing?.costMicroUsd(model, {
      prompt_tokens: o.prompt,
      completion_tokens: o.completion,
      cached_tokens: o.cached,
      cache_creation_tokens: o.cacheCreation,
      prompt_tokens_total: o.prompt,
    }) ?? null)
    : null;
  const statusClass = `${Math.floor(o.status / 100)}xx`;
  // Cardinality-safe metric label: the resolved catalog key, else "other".
  const modelLabel = ctx.pricing?.resolveKey(model) ?? "other";

  ctx.logEnrichment?.record(
    requestId,
    compactEnrichment({
      // "unknown" is the metric/span placeholder; the log trail omits the field
      // instead, so an unattributable request renders an honest N/A rather than
      // a provider named "unknown".
      provider: provider === "unknown" ? undefined : provider,
      model,
      promptTokens: o.prompt,
      completionTokens: o.completion,
      totalTokens,
      costMicroUsd,
    }),
  );

  ctx.metrics.recordLlmUsage({
    provider,
    model: modelLabel,
    statusClass,
    promptTokens: o.prompt,
    completionTokens: o.completion,
    costMicroUsd,
    // Tenant labels (ids). virtual_key is bounded to the known-key allowlist
    // inside recordLlmUsage; absent identity omits the labels entirely.
    virtualKey: o.tenant?.virtualKeyId,
    team: o.tenant?.teamId,
    customer: o.tenant?.customerId,
  });
  if (o.cacheHeader === "hit" || o.cacheHeader === "miss") {
    ctx.metrics.recordCacheEvent(o.cacheHeader);
  }

  // Per-request record keeps the RAW model (analytics wants the real id) and the
  // resolved tenant identity (ids + names) when a virtual key was present.
  ctx.usage?.record({
    ts: new Date(o.startedAtMs).toISOString(),
    requestId,
    provider,
    model,
    promptTokens: o.prompt,
    completionTokens: o.completion,
    totalTokens,
    costMicroUsd,
    durationMs: o.durationMs,
    status: o.status,
    stream: o.stream,
    cacheHit: o.cacheHeader === "hit",
    ...(o.tenant ?? {}),
  });

  if (ctx.otel) {
    // The span keeps the real model; `frosty.metrics.model` is its bounded twin
    // and the only one promoted to a metric label (span_cardinality.ts).
    const metricsModel = ctx.spanCardinality?.label(model) ??
      (model || "unknown");
    if (metricsModel === COLLAPSED_LABEL) {
      // Drives the dashboard's cardinality panel, so a truncated label set is
      // visible rather than merely absent.
      ctx.metrics.increment("telemetry.span_model_label_collapsed");
    }
    const attributes: Record<string, string | number | boolean> = {
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": model || "unknown",
      "gen_ai.response.model": model || "unknown",
      "frosty.metrics.model": metricsModel,
      "gen_ai.usage.prompt_tokens": o.prompt,
      "gen_ai.usage.completion_tokens": o.completion,
      "gen_ai.usage.total_tokens": totalTokens,
      "http.response.status_code": o.status,
      "gen_ai.stream": o.stream,
    };
    if (costMicroUsd !== null) {
      attributes["gen_ai.usage.cost"] = costMicroUsd / 1e6;
    }
    if (o.stream && o.ttftMs !== undefined) {
      attributes["gen_ai.response.time_to_first_token"] = Math.round(o.ttftMs);
    }
    // Response finish reason (Bifrost AttrFinishReason parity). Read from the
    // response the client received, so it is accurate whether or not the
    // request fell through to a fallback provider.
    if (o.finishReason) {
      attributes["gen_ai.response.finish_reason"] = o.finishReason;
    }
    // Per-tenant attribution on the gen_ai span (Go labels these; frosty now
    // matches). Each attribute is set only when its id resolved, so zero-key
    // spans are unchanged.
    const tenant = o.tenant;
    if (tenant?.virtualKeyId) {
      attributes["frosty.virtual_key.id"] = tenant.virtualKeyId;
      if (tenant.virtualKeyName) {
        attributes["frosty.virtual_key.name"] = tenant.virtualKeyName;
      }
    }
    if (tenant?.teamId) {
      attributes["frosty.team.id"] = tenant.teamId;
      if (tenant.teamName) {
        attributes["frosty.team.name"] = tenant.teamName;
      }
    }
    if (tenant?.customerId) {
      attributes["frosty.customer.id"] = tenant.customerId;
      if (tenant.customerName) {
        attributes["frosty.customer.name"] = tenant.customerName;
      }
    }
    ctx.otel.record({
      name: "llm.call",
      startMs: o.startedAtMs,
      endMs: o.endMs,
      traceId: o.traceId,
      spanId: o.spanId,
      parentSpanId: o.parentSpanId,
      kind: 3, // CLIENT
      attributes,
      error: o.status >= 500,
      traceState: o.traceState,
    });

    for (const child of takeChildSpans(o.req)) {
      ctx.otel.record({
        name: child.name,
        startMs: child.startMs,
        endMs: child.endMs,
        traceId: o.traceId,
        spanId: newSpanId(),
        parentSpanId: o.spanId,
        kind: 3, // CLIENT
        attributes: child.attributes,
        error: child.error,
        traceState: o.traceState,
      });
    }
  }
}

export function telemetryMiddleware(
  ctx: AppContext,
): (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response> {
  return async (req, next) => {
    const pathname = new URL(req.url).pathname;
    if (!isInferencePath(pathname)) {
      return await next(req);
    }
    // Azure and GenAI name the dispatched model in the URL and ignore/omit it in
    // the response body, so the path wins there; every other surface keeps
    // reading the body model exactly as before.
    const pathModel = azureDeploymentFromPath(pathname) ??
      modelFromPath(pathname);

    const startedAtMs = Date.now();
    const start = performance.now();
    // Tier-A trace context: adopt an inbound traceparent or mint a fresh trace.
    const parsed = parseTraceparent(req.headers.get("traceparent"));
    const traceId = parsed?.traceId ?? newTraceId();
    const parentSpanId = parsed?.parentId;
    const spanId = newSpanId();
    const requestId = req.headers.get("x-request-id") ?? undefined;
    // Claim an enrichment slot BEFORE the route runs, so the request logger
    // knows this entry is expecting provider/model/token/cost. Only inference
    // paths reach here, so probes and admin calls never allocate one.
    ctx.logEnrichment?.track(requestId);
    // Tenant identity resolved by governanceMiddleware (the immediate outer
    // middleware) for this exact Request. Undefined when no virtual key applied.
    const tenant = getRequestTenant(req);
    // Inbound W3C tracestate, passed through onto every emitted span (Bifrost
    // propagation.go parity). Absent/blank/oversized -> "" (omitted downstream).
    const traceState = sanitizeTracestate(req.headers.get("tracestate"));

    const response = await next(req);

    try {
      const contentType = response.headers.get("Content-Type") ?? "";
      const cacheHeader = response.headers.get("x-frosty-cache");

      if (
        response.ok && contentType.includes("text/event-stream") &&
        response.body
      ) {
        let ttftMs: number | undefined;
        let lastChunkAtMs: number | undefined;
        const tapped = tapSseTail(
          response.body,
          (text) => {
            const found = extractStreamUsage(text);
            emit({
              ctx,
              requestId,
              // extractStreamUsage yields nothing without a usage block, which
              // most providers omit unless asked - so fall back to the model the
              // chunks always carry, or every streamed span reads "unknown".
              model: pathModel ?? (found?.model || extractStreamModel(text)),
              prompt: found?.prompt ?? 0,
              completion: found?.completion ?? 0,
              cached: found?.cached,
              cacheCreation: found?.cacheCreation,
              status: response.status,
              stream: true,
              cacheHeader,
              ttftMs,
              startedAtMs,
              endMs: Date.now(),
              durationMs: Math.round(performance.now() - start),
              traceId,
              spanId,
              parentSpanId,
              req,
              traceState,
              finishReason: extractFinishReason(text),
              tenant,
            });
          },
          undefined,
          () => {
            const now = performance.now();
            if (lastChunkAtMs === undefined) {
              ttftMs = now - start;
              ctx.metrics.recordStreamFirstTokenLatency(ttftMs);
            } else {
              ctx.metrics.recordStreamInterTokenLatency(now - lastChunkAtMs);
            }
            lastChunkAtMs = now;
          },
        );
        return new Response(tapped, {
          status: response.status,
          headers: response.headers,
        });
      }

      // JSON completions (and non-usage responses): bounded clone, read usage.
      let model = pathModel ?? "";
      let prompt = 0;
      let completion = 0;
      let cached = 0;
      let cacheCreation = 0;
      let finishReason: string | undefined;
      if (response.ok && contentType.includes("application/json")) {
        try {
          const body = await response.clone().json() as {
            model?: string;
            modelVersion?: string;
            usage?: UsageShape;
            usageMetadata?: UsageShape;
            choices?: Array<{ finish_reason?: string | null }>;
          };
          model = pathModel ?? body?.model ?? body?.modelVersion ?? "";
          // GenAI reports usage as top-level `usageMetadata`; reading only
          // `usage` would emit a counted-but-uncosted record for that surface.
          const usage = body?.usage ?? body?.usageMetadata;
          if (usage) {
            const n = normalizeUsage(usage);
            prompt = n.prompt;
            completion = n.completion;
            cached = n.cached;
            cacheCreation = n.cacheCreation;
          }
          const found = body?.choices?.[0]?.finish_reason;
          if (found) {
            finishReason = found;
          }
        } catch {
          // Not a usage-bearing JSON body: record the request with zero tokens.
        }
      }
      emit({
        ctx,
        requestId,
        model,
        prompt,
        completion,
        cached,
        cacheCreation,
        status: response.status,
        stream: false,
        cacheHeader,
        startedAtMs,
        endMs: Date.now(),
        durationMs: Math.round(performance.now() - start),
        traceId,
        spanId,
        parentSpanId,
        req,
        traceState,
        finishReason,
        tenant,
      });
      return response;
    } catch {
      // Telemetry must never throw into the response path.
      return response;
    }
  };
}
