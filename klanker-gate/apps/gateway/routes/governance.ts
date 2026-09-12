import { z } from "zod";
import {
  BudgetSchema,
  publicVirtualKey,
  type VirtualKey,
} from "../../../packages/governance/src/virtual_keys.ts";
import type {
  Customer,
  Team,
} from "../../../packages/governance/src/hierarchy.ts";
import type {
  BudgetEntityKind,
  BudgetSubject,
  ScheduledBudget,
} from "../../../packages/governance/src/budget_epochs.ts";
import {
  errorResponse,
  GatewayError,
  type Router,
} from "../../../packages/core/src/mod.ts";
import {
  type DispatchScope,
  targetScope,
} from "../../../packages/providers/src/mod.ts";
import {
  extractStreamUsage,
  normalizeUsage,
  setRequestTenant,
  tapSseTail,
  type UsageShape,
} from "../../../packages/telemetry/src/usage.ts";
import { parseTraceparent } from "../../../packages/telemetry/src/trace.ts";
import { trackResponseLifetime } from "../../../packages/telemetry/src/concurrency.ts";
import { syncPricingFromLiteLLM } from "../../../packages/governance/src/pricing_sync.ts";
import type { AppContext } from "../context.ts";
import { azureDeploymentFromPath } from "./azure_ingress.ts";
import {
  jsonResponse,
  MAX_JSON_BODY_BYTES,
  parseJsonBody,
  readCappedText,
  validationErrorResponse,
} from "./helpers.ts";

const CreateVirtualKeySchema = z.object({
  name: z.string().min(1),
  /** Optional human-readable note surfaced in the control UI. */
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  rateLimit: z.object({
    maxRequests: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }).optional(),
  tokenLimit: z.object({
    maxTokens: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }).optional(),
  budget: BudgetSchema.optional(),
  /** Optional team membership (governance hierarchy). */
  teamId: z.string().optional(),
  /** Optional admission scope; empty arrays are rejected (absence = unrestricted). */
  allowedProviders: z.array(z.string().min(1)).min(1).optional(),
  allowedModels: z.array(z.string().min(1)).min(1).optional(),
});

const PricingSchema = z.record(
  z.string(),
  z.object({
    inputPerMTokUsd: z.number().nonnegative(),
    outputPerMTokUsd: z.number().nonnegative(),
  }),
);

const CreateTeamSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  customerId: z.string().optional(),
  budget: BudgetSchema.optional(),
});

const CreateCustomerSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  budget: BudgetSchema.optional(),
});

// Update accepts `null` for the scope fields to explicitly CLEAR them (the
// partial-merge otherwise cannot distinguish "leave as-is" from "unrestrict").
const UpdateVirtualKeySchema = CreateVirtualKeySchema.partial().extend({
  allowedProviders: z.array(z.string().min(1)).min(1).nullable().optional(),
  allowedModels: z.array(z.string().min(1)).min(1).nullable().optional(),
});

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "vk-" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function scheduleChanged(
  previous: { resetIntervalMs?: number } | undefined,
  next: { resetIntervalMs?: number } | undefined,
): boolean {
  return previous?.resetIntervalMs !== next?.resetIntervalMs;
}

async function configureSchedule(
  ctx: AppContext,
  kind: BudgetEntityKind,
  id: string,
  previous: { resetIntervalMs?: number } | undefined,
  next: { resetIntervalMs?: number } | undefined,
): Promise<void> {
  if (scheduleChanged(previous, next)) {
    await ctx.budgetEpochs?.configure(kind, id, previous, next);
  }
}

export function registerGovernanceRoutes(
  router: Router,
  ctx: AppContext,
): void {
  // Keep the virtual_key metric-label allowlist in step with the store (mirrors
  // setKnownModels for the model label). Seeded here at registration (boot) from
  // the already-loaded keys, then refreshed on every create/update/delete below.
  const syncKnownVirtualKeys = () =>
    ctx.metrics.setKnownVirtualKeys(ctx.virtualKeys.list().map((k) => k.id));
  syncKnownVirtualKeys();

  router.get("/api/virtual-keys", () => {
    return jsonResponse({
      virtualKeys: ctx.virtualKeys.list().map(publicVirtualKey),
    });
  });

  router.post("/api/virtual-keys", async (req) => {
    const parsed = CreateVirtualKeySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const rawToken = generateToken();
    const key: VirtualKey = {
      id: crypto.randomUUID(),
      token: rawToken,
      usedRequests: 0,
      usedCostMicroUsd: 0,
      ...parsed.data,
    };
    await configureSchedule(ctx, "virtual-key", key.id, undefined, key.budget);
    // upsert() returns the stored hash-only record (raw token stripped); persist
    // that so the token is never written to KV in recoverable form.
    const stored = ctx.virtualKeys.upsert(key);
    syncKnownVirtualKeys();
    await ctx.config?.upsertVirtualKey(stored);
    // The full token is returned exactly once, at creation time.
    return jsonResponse({ ...publicVirtualKey(stored), token: rawToken }, 201);
  });

  router.put("/api/virtual-keys/:id", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.virtualKeys.get(id);
    if (!existing) {
      return errorResponse(404, `Unknown virtual key "${id}".`);
    }
    const parsed = UpdateVirtualKeySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    // Scope fields carry null=clear semantics; keep them out of the plain merge
    // (VirtualKeySchema forbids null) and apply them explicitly: an array sets a
    // new scope, null clears it, undefined leaves the existing scope untouched.
    const { allowedProviders, allowedModels, ...rest } = parsed.data;
    const updated: VirtualKey = { ...existing, ...rest, id };
    if (allowedProviders !== undefined) {
      if (allowedProviders === null) {
        delete updated.allowedProviders;
      } else {
        updated.allowedProviders = allowedProviders;
      }
    }
    if (allowedModels !== undefined) {
      if (allowedModels === null) {
        delete updated.allowedModels;
      } else {
        updated.allowedModels = allowedModels;
      }
    }
    await configureSchedule(
      ctx,
      "virtual-key",
      id,
      existing.budget,
      updated.budget,
    );
    const stored = ctx.virtualKeys.upsert(updated);
    syncKnownVirtualKeys();
    await ctx.config?.upsertVirtualKey(stored);
    return jsonResponse(publicVirtualKey(stored));
  });

  router.delete("/api/virtual-keys/:id", async (_req, match) => {
    const id = match.pathname.groups.id!;
    if (!ctx.virtualKeys.get(id)) {
      return errorResponse(404, `Unknown virtual key "${id}".`);
    }
    ctx.virtualKeys.remove(id);
    syncKnownVirtualKeys();
    await ctx.config?.deleteVirtualKey(id);
    return new Response(null, { status: 204 });
  });

  router.get("/metrics", () => {
    return new Response(ctx.metrics.renderPrometheus(), {
      headers: { "Content-Type": "text/plain; version=0.0.4" },
    });
  });

  // Governance hierarchy CRUD: teams and customers.
  router.get("/api/teams", () => {
    return jsonResponse({ teams: ctx.hierarchy?.listTeams() ?? [] });
  });

  router.post("/api/teams", async (req) => {
    const parsed = CreateTeamSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const team: Team = {
      id: crypto.randomUUID(),
      usedRequests: 0,
      usedCostMicroUsd: 0,
      ...parsed.data,
    };
    await configureSchedule(ctx, "team", team.id, undefined, team.budget);
    ctx.hierarchy?.upsertTeam(team);
    await ctx.config?.upsertTeam(team);
    return jsonResponse(team, 201);
  });

  router.put("/api/teams/:id", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.hierarchy?.getTeam(id);
    if (!existing) {
      return errorResponse(404, `Unknown team "${id}".`);
    }
    const parsed = CreateTeamSchema.partial().safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const updated: Team = { ...existing, ...parsed.data, id };
    await configureSchedule(ctx, "team", id, existing.budget, updated.budget);
    ctx.hierarchy?.upsertTeam(updated);
    await ctx.config?.upsertTeam(updated);
    return jsonResponse(updated);
  });

  router.delete("/api/teams/:id", async (_req, match) => {
    const id = match.pathname.groups.id!;
    if (!ctx.hierarchy?.getTeam(id)) {
      return errorResponse(404, `Unknown team "${id}".`);
    }
    ctx.hierarchy.removeTeam(id);
    await ctx.config?.deleteTeam(id);
    return new Response(null, { status: 204 });
  });

  router.get("/api/customers", () => {
    return jsonResponse({ customers: ctx.hierarchy?.listCustomers() ?? [] });
  });

  router.post("/api/customers", async (req) => {
    const parsed = CreateCustomerSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const customer: Customer = {
      id: crypto.randomUUID(),
      usedRequests: 0,
      usedCostMicroUsd: 0,
      ...parsed.data,
    };
    await configureSchedule(
      ctx,
      "customer",
      customer.id,
      undefined,
      customer.budget,
    );
    ctx.hierarchy?.upsertCustomer(customer);
    await ctx.config?.upsertCustomer(customer);
    return jsonResponse(customer, 201);
  });

  router.put("/api/customers/:id", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.hierarchy?.getCustomer(id);
    if (!existing) {
      return errorResponse(404, `Unknown customer "${id}".`);
    }
    const parsed = CreateCustomerSchema.partial().safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    const updated: Customer = { ...existing, ...parsed.data, id };
    await configureSchedule(
      ctx,
      "customer",
      id,
      existing.budget,
      updated.budget,
    );
    ctx.hierarchy?.upsertCustomer(updated);
    await ctx.config?.upsertCustomer(updated);
    return jsonResponse(updated);
  });

  router.delete("/api/customers/:id", async (_req, match) => {
    const id = match.pathname.groups.id!;
    if (!ctx.hierarchy?.getCustomer(id)) {
      return errorResponse(404, `Unknown customer "${id}".`);
    }
    ctx.hierarchy.removeCustomer(id);
    await ctx.config?.deleteCustomer(id);
    return new Response(null, { status: 204 });
  });

  // Pricing catalog: feeds $-cost budgets and the cost metric.
  router.get("/api/pricing", () => {
    return jsonResponse({ prices: ctx.pricing?.list() ?? {} });
  });

  router.put("/api/pricing", async (req) => {
    const parsed = PricingSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.pricing?.replace(parsed.data);
    // Keep the metric-label allowlist in step with the catalog.
    ctx.metrics.setKnownModels(Object.keys(parsed.data));
    await ctx.config?.savePricing(parsed.data);
    return jsonResponse({ prices: parsed.data });
  });

  // On-demand LiteLLM pricing sync. Works even when scheduled sync is off. The
  // source URL is env-derived only (see pricing_sync.ts); no URL is ever read
  // from the request. Persisted /api/pricing overrides are re-applied last.
  router.post("/api/pricing/force-sync", async () => {
    if (!ctx.pricing) {
      return jsonResponse({ error: "pricing catalog unavailable" }, 503);
    }
    const overrides = (await ctx.config?.loadPricing()) ?? undefined;
    const result = await syncPricingFromLiteLLM(ctx.pricing, {
      metrics: ctx.metrics,
      overrides,
    });
    ctx.metrics.setKnownModels(ctx.pricing.modelKeys());
    if (result.error) {
      return jsonResponse({ error: result.error }, 502);
    }
    return jsonResponse({ synced: result.synced, updatedAt: result.updatedAt });
  });
}

/** Bare model id with any known-account prefix stripped (mirrors manager.resolve). */
function strippedModelId(model: string, ctx: AppContext): string {
  const slash = model.indexOf("/");
  if (slash > 0 && ctx.providers.get(model.slice(0, slash))) {
    return model.slice(slash + 1);
  }
  return model;
}

/**
 * Requested model from a genai path like /genai/v1beta/models/{model}:{action}.
 * Mirrors the genai router EXACTLY (compat_families.ts: decode then split on the
 * LAST colon), so a colon-tagged model id (e.g. "llama3:70b") is enforced as it
 * is actually dispatched, not truncated at the first colon.
 */
export function modelFromPath(pathname: string): string | undefined {
  const m = pathname.match(/\/genai\/[^/]+\/models\/([^/?]+)/);
  if (!m) {
    return undefined;
  }
  const modelAction = decodeURIComponent(m[1]);
  const colon = modelAction.lastIndexOf(":");
  return colon > 0 ? modelAction.slice(0, colon) : modelAction;
}

/**
 * Azure-shaped ingress, where the URL deployment segment IS the dispatched
 * model. The request body's `model` is ignored by the route, so admission must
 * ignore it too.
 */
function isAzurePath(pathname: string): boolean {
  return pathname.startsWith("/openai/deployments/");
}

interface ScopeDenial {
  status: number;
  code: string;
  message: string;
}

/**
 * Per-key provider/model admission. Absent scope = unrestricted (back-compat).
 * A scoped key whose request model cannot be determined fails CLOSED (deny).
 * Matching reuses the dispatcher's provider resolution (tryProviderId + prefix
 * strip), so an allow-listed model cannot be reached via a prefix/alias that
 * would route elsewhere. Model comparison is case-insensitive on both the
 * prefix-stripped id and the raw requested string.
 */
function checkScope(
  key: VirtualKey,
  model: string | undefined,
  ctx: AppContext,
): ScopeDenial | null {
  const providerScope = key.allowedProviders ?? [];
  const modelScope = key.allowedModels ?? [];
  if (providerScope.length === 0 && modelScope.length === 0) {
    return null; // unrestricted
  }
  if (!model) {
    return {
      status: 403,
      code: "model_not_permitted",
      message: `Virtual key "${key.name}" is scoped to specific models; the ` +
        `request model could not be determined.`,
    };
  }
  if (providerScope.length > 0) {
    const providerId = ctx.providers.tryProviderId(model);
    if (!providerId || !providerScope.includes(providerId)) {
      return {
        status: 403,
        code: "provider_not_permitted",
        message: `Virtual key "${key.name}" is not permitted to use provider ` +
          `"${providerId ?? "unknown"}".`,
      };
    }
  }
  if (modelScope.length > 0) {
    const stripped = strippedModelId(model, ctx).toLowerCase();
    const raw = model.toLowerCase();
    const allowed = modelScope.some((m) => {
      const lm = m.toLowerCase();
      return lm === stripped || lm === raw;
    });
    if (!allowed) {
      return {
        status: 403,
        code: "model_not_permitted",
        message: `Virtual key "${key.name}" is not permitted to use model ` +
          `"${strippedModelId(model, ctx)}".`,
      };
    }
  }
  return null;
}

/**
 * Dispatch-scope for a key's whole reachable target set (primary + failover +
 * client fallbacks), consumed by dispatchWithFallback + the ?provider= resolver.
 * null = unrestricted.
 */
function dispatchScopeFor(key: VirtualKey): DispatchScope | null {
  const providers = key.allowedProviders;
  const models = key.allowedModels;
  if ((!providers || !providers.length) && (!models || !models.length)) {
    return null;
  }
  return {
    providers: providers && providers.length ? new Set(providers) : null,
    models: models && models.length
      ? new Set(models.map((m) => m.toLowerCase()))
      : null,
  };
}

/**
 * Inference admission: once any enabled virtual key exists, /v1/* requires a
 * valid bearer token and enforces per-key rate limits and budgets.
 */
export function governanceMiddleware(
  ctx: AppContext,
): (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response> {
  return async (req, next) => {
    const pathname = new URL(req.url).pathname;
    // Every inference-capable surface is governed: canonical /v1, the MCP
    // server, the translated compat families (/genai, /cohere), the
    // Azure-shaped deployment surface (/openai/deployments) and OpenRouter
    // (/openrouter). The URL-alias prefixes are rewritten onto /v1, and
    // /v1beta onto /genai, before this middleware.
    const governed = pathname.startsWith("/v1/") || pathname === "/mcp" ||
      pathname.startsWith("/genai/") || pathname.startsWith("/cohere/") ||
      pathname.startsWith("/openai/deployments/") ||
      pathname.startsWith("/openrouter/");
    if (!governed || !ctx.virtualKeys.active()) {
      return await next(req);
    }

    const auth = req.headers.get("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

    let estimatedTokens = 0;
    // Requested model for per-key scope enforcement. Azure names it in the
    // deployment segment and genai in the model segment; every other governed
    // surface carries it in the JSON body. An Azure path NEVER consults the
    // body: the route ignores it, so trusting it here would admit a scoped key
    // against one model while dispatching another.
    const azurePath = isAzurePath(pathname);
    let requestModel: string | undefined = azureDeploymentFromPath(pathname) ??
      modelFromPath(pathname);
    const requestType = req.headers.get("Content-Type") ?? "";
    if (
      req.method === "POST" && req.body &&
      requestType.includes("application/json")
    ) {
      // Reject an oversized declared body before materializing it into a string
      // (memory-amplification DoS guard; the route re-checks on the parse path).
      const declaredBytes = Number(req.headers.get("content-length"));
      if (
        Number.isFinite(declaredBytes) && declaredBytes > MAX_JSON_BODY_BYTES
      ) {
        return errorResponse(
          413,
          "Request body exceeds the maximum allowed size.",
          "payload_too_large",
        );
      }
      let text: string | undefined;
      try {
        // Capped on the READ, not just on a declared content-length: a chunked
        // body omits the header and would otherwise buffer unbounded here,
        // before ctx.virtualKeys.check has authenticated anything.
        text = await readCappedText(req.clone(), MAX_JSON_BODY_BYTES);
      } catch (error) {
        if (error instanceof GatewayError && error.status === 413) {
          // Release the tee branch nothing downstream will read, so the source
          // body is cancelled instead of holding the buffered chunks.
          void req.body?.cancel().catch(() => {});
          return errorResponse(
            413,
            "Request body exceeds the maximum allowed size.",
            "payload_too_large",
          );
        }
        // Unreadable body: fall back to a zero estimate.
      }
      if (text !== undefined) {
        estimatedTokens = Math.ceil(text.length / 4);
        if (!requestModel && !azurePath) {
          try {
            const parsed = JSON.parse(text) as { model?: unknown };
            if (typeof parsed?.model === "string" && parsed.model) {
              requestModel = parsed.model;
            }
          } catch {
            // Non-JSON / unparseable: leave the model undetermined (fails closed
            // below for scoped keys).
          }
        }
      }
    }
    const decision = ctx.virtualKeys.check(token, estimatedTokens);

    if (!decision.ok) {
      ctx.metrics.increment(`governance.denied.${decision.code}`);
      const response = errorResponse(
        decision.status,
        decision.message,
        "governance_error",
        undefined,
        decision.code,
      );
      if (decision.status === 429) {
        const headers = new Headers(response.headers);
        const waitMs = decision.retryAfterMs ?? 60_000;
        headers.set(
          "Retry-After",
          String(Math.max(1, Math.ceil(waitMs / 1000))),
        );
        return new Response(response.body, { status: 429, headers });
      }
      return response;
    }

    // Hierarchy admission: a disabled or exhausted team/customer locks
    // every descendant key out (fail closed).
    const chain = ctx.hierarchy?.checkChain(decision.key.teamId);
    if (chain && !chain.ok) {
      ctx.metrics.increment(`governance.denied.${chain.code}`);
      return errorResponse(
        chain.status,
        chain.message,
        "governance_error",
        undefined,
        chain.code,
      );
    }

    // Per-key provider/model scope: reject before any usage/budget is consumed.
    // Only POST requests invoke a model; GET (e.g. /v1/models discovery) is
    // never model-scoped. Unscoped keys skip this entirely (back-compat).
    if (req.method === "POST") {
      const denial = checkScope(decision.key, requestModel, ctx);
      if (denial) {
        ctx.metrics.increment(`governance.denied.${denial.code}`);
        return errorResponse(
          denial.status,
          denial.message,
          "governance_error",
          undefined,
          denial.code,
        );
      }
    }

    const key = decision.key;

    // Fleet-wide rate and token windows. `admit` above skipped the in-process
    // windows when this authority is attached, so exactly one of the two runs.
    // Placed before any usage reservation so a limited request consumes nothing.
    if (ctx.sharedRateLimit) {
      const denial = await enforceSharedLimits(ctx, key, estimatedTokens);
      if (denial) {
        return denial;
      }
    }

    // Resolve the authenticated hierarchy once. The preceding chain check has
    // already proved these references exist, so this snapshot is authoritative
    // for both request reservation and post-response cost attribution.
    const team = key.teamId ? ctx.hierarchy?.getTeam(key.teamId) : undefined;
    const customer = team?.customerId
      ? ctx.hierarchy?.getCustomer(team.customerId)
      : undefined;
    const subjects: BudgetSubject[] = [{
      kind: "virtual-key",
      id: key.id,
      name: key.name,
      budget: key.budget,
    }];
    if (team) {
      subjects.push({
        kind: "team",
        id: team.id,
        name: team.name,
        budget: team.budget,
      });
    }
    if (customer) {
      subjects.push({
        kind: "customer",
        id: customer.id,
        name: customer.name,
        budget: customer.budget,
      });
    }

    ctx.virtualKeys.recordUsage(key.id, false);
    ctx.hierarchy?.recordUsage(key.teamId, { team: false, customer: false });
    const releaseReservation = () => {
      ctx.virtualKeys.releaseRequest(key.id);
      ctx.hierarchy?.releaseRequest(key.teamId);
    };

    let schedules: ScheduledBudget[] = [];
    try {
      const scheduled = await ctx.budgetEpochs?.admit(subjects);
      if (scheduled && !scheduled.ok) {
        releaseReservation();
        ctx.metrics.increment(`governance.denied.${scheduled.code}`);
        return errorResponse(
          scheduled.status,
          scheduled.message,
          "governance_error",
          undefined,
          scheduled.code,
        );
      }
      schedules = scheduled?.schedules ?? [];
    } catch {
      // A scheduled budget must never open when its durable authority is down.
      releaseReservation();
      ctx.metrics.increment("governance.denied.budget_reservation_unavailable");
      return errorResponse(
        503,
        "Budget reservation is temporarily unavailable.",
        "governance_error",
        undefined,
        "budget_reservation_unavailable",
      );
    }
    const scheduledFor = (kind: BudgetEntityKind, id: string) =>
      schedules.find((schedule) =>
        schedule.kind === kind && schedule.id === id
      );
    const keySchedule = scheduledFor("virtual-key", key.id);
    const teamSchedule = team ? scheduledFor("team", team.id) : undefined;
    const customerSchedule = customer
      ? scheduledFor("customer", customer.id)
      : undefined;

    // Commit the reserved increment to persistence, but only for the counter
    // that actually enforces: a scheduled request budget owns its own durable
    // epoch counter, so the lifetime counter stays in-memory (display-only) there.
    if (keySchedule?.budget.maxRequests === undefined) {
      ctx.virtualKeys.persistUsage(key.id);
    }
    ctx.hierarchy?.persistUsage(key.teamId, {
      team: teamSchedule?.budget.maxRequests === undefined,
      customer: customerSchedule?.budget.maxRequests === undefined,
    });
    ctx.metrics.increment(`governance.allowed.${decision.key.name}`);

    // Run dispatch inside the key's allowlist so failover / client-supplied
    // fallbacks can never reach an out-of-scope provider or model (the admission
    // checkScope above only validates the primary target).
    const scope = dispatchScopeFor(key);

    setRequestTenant(req, {
      virtualKeyId: key.id,
      virtualKeyName: key.name,
      teamId: team?.id,
      teamName: team?.name,
      customerId: customer?.id,
      customerName: customer?.name,
      dispatchScoped: scope !== null,
    });

    const response = scope
      ? await targetScope.run(scope, () => next(req))
      : await next(req);

    // Cache hits never reached a provider: re-charging their stored usage
    // block would double-bill the key and inflate cost metrics.
    if (response.headers.get("x-frosty-cache") === "hit") {
      return response;
    }

    const account = (
      model: string,
      prompt: number,
      completion: number,
      cached = 0,
      cacheCreation = 0,
    ) => {
      const cost = ctx.pricing?.costMicroUsd(model, {
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
        cache_creation_tokens: cacheCreation,
        prompt_tokens_total: prompt,
      });
      if (cost) {
        ctx.virtualKeys.recordCost(
          key.id,
          cost,
          keySchedule?.budget.maxCostUsd === undefined,
        );
        ctx.hierarchy?.recordCost(key.teamId, cost, {
          team: teamSchedule?.budget.maxCostUsd === undefined,
          customer: customerSchedule?.budget.maxCostUsd === undefined,
        });
        for (const schedule of [keySchedule, teamSchedule, customerSchedule]) {
          if (schedule?.budget.maxCostUsd !== undefined) {
            // JSON paths can observe the result immediately; SSE completion is
            // passive, so both retain the established best-effort sink posture.
            void ctx.budgetEpochs?.recordCost(schedule, cost).catch(() => {
              ctx.metrics.increment("persistence.sink_failures");
            });
          }
        }
        ctx.metrics.increment("cost.micro_usd", cost);
      } else if (ctx.pricing && prompt + completion > 0) {
        // Unpriced model: real spend billed $0 — keep it observable.
        ctx.metrics.increment("cost.unpriced");
      }
      const actual = prompt + completion + cacheCreation;
      if (actual > estimatedTokens) {
        ctx.virtualKeys.recordTokens(
          decision.key.id,
          actual - estimatedTokens,
        );
      }
    };

    // Post-response accounting: $-cost and token reconciliation. JSON
    // completions carry usage directly; SSE streams are tapped (bounded
    // head/tail capture, bytes untouched) for the final usage block.
    const contentType = response.headers.get("Content-Type") ?? "";
    if (response.ok && contentType.includes("application/json")) {
      try {
        const body = await response.clone().json() as {
          model?: string;
          modelVersion?: string;
          usage?: UsageShape;
          usageMetadata?: UsageShape;
        };
        // A dialect surface reports usage under its own key: GenAI carries
        // `usageMetadata` and `modelVersion` at the top level. Reading only
        // `usage`/`model` silently bills those surfaces nothing.
        const usage = body?.usage ?? body?.usageMetadata;
        if (usage) {
          const n = normalizeUsage(usage);
          const { prompt, completion } = n;
          account(
            body.model ?? body.modelVersion ?? "",
            prompt,
            completion,
            n.cached,
            n.cacheCreation,
          );
        }
      } catch {
        // Non-JSON or unparsable body: no accounting.
      }
      return response;
    }
    if (
      response.ok && contentType.includes("text/event-stream") &&
      response.body
    ) {
      const tapped = tapSseTail(response.body, (text) => {
        const found = extractStreamUsage(text);
        if (found) {
          account(
            found.model,
            found.prompt,
            found.completion,
            found.cached,
            found.cacheCreation,
          );
        }
      });
      return new Response(tapped, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
}

/** Paths that earn their own metric label; everything else is "other". */
const KNOWN_ROOTS =
  /^\/(?:v1|api|genai|cohere|openai|openrouter|v1beta)\/|^\/(?:mcp|metrics|healthz)$|^\/$/;

/** Dialect roots admitted above whose labelled shapes are exactly DIALECT_SHAPES. */
const DIALECT_ROOTS = /^\/(?:openai|openrouter|v1beta)\//;

/** The only labels mintable under a dialect root; anything else is "other". */
const DIALECT_SHAPES = new Set([
  "/openai/deployments/:deployment/:op",
  "/openrouter/v1/:op",
  "/v1beta/models/:modelAction",
]);

/**
 * Cardinality-safe metric label for one request path: every :id segment
 * collapses and everything unrecognized buckets into "other", so
 * unauthenticated scanner traffic cannot mint a label series per unique path.
 */
function metricRoute(pathname: string): string {
  if (!KNOWN_ROOTS.test(pathname)) {
    return "other";
  }
  const route = pathname
    .replace(
      /^(\/api\/(?:providers|virtual-keys|teams|customers|mcp\/clients)\/)[^/]+/,
      "$1:id",
    )
    .replace(/^(\/v1\/batches\/)[^/]+/, "$1:id")
    .replace(/^(\/genai\/v1beta\/models\/)[^/]+/, "$1:modelAction")
    .replace(/^(\/v1beta\/models\/)[^/]+$/, "$1:modelAction")
    .replace(
      /^(\/openai\/deployments\/)[^/]+\/(?:chat\/completions|[^/]+)$/,
      "$1:deployment/:op",
    )
    .replace(/^(\/openrouter\/v1\/)(?:chat\/completions|[^/]+)$/, "$1:op");
  return DIALECT_ROOTS.test(route) && !DIALECT_SHAPES.has(route)
    ? "other"
    : route;
}

/**
 * Enforces the fleet-wide rate and token windows for one key. Returns a 429
 * response when limited, or undefined to continue.
 *
 * A store that cannot answer denies with 503, matching how a broken durable
 * budget authority already behaves: a limit nobody can evaluate is not a limit
 * that has been passed.
 */
async function enforceSharedLimits(
  ctx: AppContext,
  key: VirtualKey,
  // REQUIRED, deliberately not defaulted. A default silently under-counted the
  // token window to 1 unit per request for every fleet deployment; see
  // decision-log 77.
  estimatedTokens: number,
): Promise<Response | undefined> {
  const limiter = ctx.sharedRateLimit;
  if (!limiter) {
    return undefined;
  }
  const windows: Array<
    {
      scope: string;
      max: number;
      windowMs: number;
      amount: number;
      code: string;
      message: string;
    }
  > = [];
  if (key.rateLimit) {
    windows.push({
      scope: "requests",
      max: key.rateLimit.maxRequests,
      windowMs: key.rateLimit.windowMs,
      amount: 1,
      code: "rate_limited",
      message: `Virtual key "${key.name}" is rate limited.`,
    });
  }
  if (key.tokenLimit) {
    windows.push({
      scope: "tokens",
      max: key.tokenLimit.maxTokens,
      windowMs: key.tokenLimit.windowMs,
      amount: Math.max(1, estimatedTokens),
      code: "token_limited",
      message: `Virtual key "${key.name}" exceeded its token limit.`,
    });
  }
  for (const window of windows) {
    const verdict = await limiter.admit({
      scope: window.scope,
      id: key.id,
      max: window.max,
      windowMs: window.windowMs,
      amount: window.amount,
    });
    if (verdict === "admitted") {
      continue;
    }
    if (verdict === "unavailable") {
      ctx.metrics.increment("governance.denied.rate_limit_unavailable");
      return errorResponse(
        503,
        "Rate limiting is temporarily unavailable.",
        "governance_error",
        undefined,
        "rate_limit_unavailable",
      );
    }
    ctx.metrics.increment(`governance.denied.${window.code}`);
    const response = errorResponse(
      429,
      window.message,
      "governance_error",
      undefined,
      window.code,
    );
    response.headers.set(
      "Retry-After",
      String(Math.ceil(limiter.retryAfterMs(window.windowMs) / 1000)),
    );
    return response;
  }
  return undefined;
}

/** Route-level latency/status observation for /metrics. */
export function metricsMiddleware(
  ctx: AppContext,
): (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response> {
  return async (req, next) => {
    const start = performance.now();
    const startedAt = Date.now();
    const connection = ctx.concurrency?.open();
    let response: Response;
    try {
      ctx.concurrency?.enterDispatch();
      try {
        response = await next(req);
      } finally {
        ctx.concurrency?.exitDispatch();
      }
    } catch (error) {
      connection?.close();
      throw error;
    }
    response = trackResponseLifetime(response, connection);
    const route = metricRoute(new URL(req.url).pathname);
    ctx.metrics.observe(route, response.status, performance.now() - start);
    const inbound = parseTraceparent(req.headers.get("traceparent"));
    ctx.otel?.record({
      name: `${req.method} ${route}`,
      startMs: startedAt,
      endMs: Date.now(),
      traceId: inbound?.traceId,
      attributes: {
        "http.route": route,
        "http.response.status_code": response.status,
      },
      error: response.status >= 500,
    });
    return response;
  };
}
