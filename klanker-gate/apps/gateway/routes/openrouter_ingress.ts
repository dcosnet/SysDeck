import {
  ChatCompletionRequestSchema,
  EmbeddingRequestSchema,
} from "../../../packages/contracts/src/mod.ts";
import {
  GatewayError,
  gatewayErrorResponse,
  type Router,
} from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import {
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";
import { runChatCompletion } from "./inference.ts";

/** Client-supplied `fallbacks`, kept verbatim ahead of anything mapped. */
function normalizeFallbacks(
  existing: unknown,
): Array<{ provider: string; model?: string }> {
  if (!Array.isArray(existing)) {
    return [];
  }
  const out: Array<{ provider: string; model?: string }> = [];
  for (const item of existing) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const { provider, model } = item as { provider?: unknown; model?: unknown };
    if (typeof provider !== "string" || provider.length === 0) {
      continue;
    }
    out.push(typeof model === "string" ? { provider, model } : { provider });
  }
  return out;
}

/**
 * Failover depth a single request may request. Beyond this an OpenRouter-shaped
 * `models[]` is an amplification vector, not a fallback preference.
 */
const MAX_MODELS_CHAIN = 12;

/**
 * OpenRouter `models[]` -> the gateway's request-level fallback chain. Entries
 * split on the FIRST `/` into provider + model; an entry without a `/` is
 * skipped, because a fallback needs an account id. When the request names its
 * own `model`, EVERY entry is a fallback; otherwise `models[0]` is the primary
 * and the rest are fallbacks.
 */
export function modelsToFallbacks(
  models: unknown,
  existing: unknown,
  requestModel?: unknown,
): { model?: string; fallbacks?: Array<{ provider: string; model?: string }> } {
  if (!Array.isArray(models) || models.length === 0) {
    return {};
  }
  // Non-string entries are dropped rather than voiding the whole array, and
  // the chain is capped: every entry becomes a dispatch attempt, so an
  // unbounded `models[]` would turn one client request into thousands of
  // upstream calls (decision-log 79).
  const list = (models.filter((m) => typeof m === "string") as string[])
    .slice(0, MAX_MODELS_CHAIN);
  if (list.length === 0) {
    return {};
  }
  const hasModel = typeof requestModel === "string" && requestModel.length > 0;
  const fallbacks = normalizeFallbacks(existing);
  for (const entry of hasModel ? list : list.slice(1)) {
    const slash = entry.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const provider = entry.slice(0, slash);
    // A `:tag` suffix (`:free`, `:nitro`) rides along untouched.
    const model = entry.slice(slash + 1);
    fallbacks.push(model ? { provider, model } : { provider });
  }
  const capped = fallbacks.slice(0, MAX_MODELS_CHAIN);
  return {
    model: hasModel ? undefined : list[0],
    fallbacks: capped.length > 0 ? capped : undefined,
  };
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
}

/** Folds `models[]` into `model` + `fallbacks`; `models` stays on for egress. */
function applyModels(raw: Record<string, unknown>): Record<string, unknown> {
  const patch = modelsToFallbacks(raw.models, raw.fallbacks, raw.model);
  const model = typeof raw.model === "string" && raw.model.length > 0
    ? raw.model
    : patch.model;
  if (typeof model !== "string" || model.length === 0) {
    return raw;
  }
  return patch.fallbacks
    ? { ...raw, model, fallbacks: patch.fallbacks }
    : { ...raw, model };
}

/**
 * OpenRouter-shaped ingress. Only the `/openrouter/v1/*` shapes are registered:
 * an upstream rewrite folds `/openrouter/api/v1/*` onto them before routing.
 * The canonical wire IS the OpenRouter wire, so chat flows through
 * `runChatCompletion` unchanged in both streaming and non-streaming modes.
 */
export function registerOpenRouterIngressRoutes(
  router: Router,
  ctx: AppContext,
): void {
  // `HTTP-Referer` / `X-Title` are accepted and dropped: egress attribution is
  // the per-account `network.extraHeaders` setting, not a client-set header.
  router.post("/openrouter/v1/chat/completions", async (req) => {
    ctx.metrics.increment("requests.compat.openrouter");
    try {
      const parsed = ChatCompletionRequestSchema.safeParse(
        applyModels(bodyObject(await parseJsonBody(req))),
      );
      if (!parsed.success) {
        return validationErrorResponse(parsed.error);
      }
      return await runChatCompletion(ctx, req, parsed.data);
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/openrouter/v1/embeddings", async (req) => {
    ctx.metrics.increment("requests.compat.openrouter");
    try {
      const parsed = EmbeddingRequestSchema.safeParse(await parseJsonBody(req));
      if (!parsed.success) {
        return validationErrorResponse(parsed.error);
      }
      const target = ctx.providers.resolve(parsed.data.model);
      if (
        !target.capabilities.supportsEmbeddings || !target.adapter.embeddings
      ) {
        throw new GatewayError(
          400,
          `Provider "${target.providerId}" does not support embeddings.`,
          "invalid_request_error",
        );
      }
      return await target.adapter.embeddings(
        { ...parsed.data, model: target.model },
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.get("/openrouter/v1/models", () => {
    ctx.metrics.increment("requests.compat.openrouter");
    return jsonResponse({ object: "list", data: ctx.providers.models() });
  });

  const notProxied = (surface: string, detail: string) => (): Response => {
    ctx.metrics.increment("requests.compat.openrouter");
    return gatewayErrorResponse(
      new GatewayError(
        501,
        `OpenRouter ${surface} is not implemented. ${detail}`,
        "not_implemented",
      ),
    );
  };

  router.get(
    "/openrouter/v1/generation",
    notProxied(
      "GET /generation",
      "Frosty does not proxy OpenRouter's native per-generation cost " +
        "accounting; it keeps its own. Use GET /api/analytics for cost and " +
        "token rollups, or GET /api/logs for per-request records.",
    ),
  );

  router.get(
    "/openrouter/v1/key",
    notProxied(
      "GET /key",
      "Frosty does not proxy OpenRouter key introspection; the credential " +
        "you present is a frosty one. Use GET /api/virtual-keys for virtual " +
        "keys, or GET /api/providers for provider accounts.",
    ),
  );
}
