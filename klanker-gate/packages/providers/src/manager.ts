import type {
  Fallback,
  GlobalProxyConfig,
  ProviderAccountConfig,
  ProviderAccountPublic,
  ProviderCapability,
  ProviderName,
} from "../../contracts/src/mod.ts";
import {
  ProviderRegistry,
  redactProviderAccount,
} from "../../contracts/src/mod.ts";
import { GatewayError } from "../../core/src/mod.ts";
import type { IProviderAdapter } from "./types.ts";
import {
  ProviderClient,
  type RetryOptions,
  supportsProxyHttpClient,
} from "./client.ts";
import { OpenAIAdapter } from "./openai.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { AzureOpenAIAdapter } from "./azure.ts";
import { GeminiAdapter } from "./gemini.ts";
import { CohereAdapter } from "./cohere.ts";
import { BedrockAdapter } from "./bedrock.ts";
import { VertexAdapter } from "./vertex.ts";
import { ElevenLabsAdapter } from "./elevenlabs.ts";
import { HuggingFaceAdapter } from "./huggingface.ts";
import { OPENAI_COMPAT_BASE_URLS } from "./openai_compat.ts";

export interface ResolvedTarget {
  providerId: string;
  type: ProviderName;
  adapter: IProviderAdapter;
  /** Model name with any provider prefix stripped. */
  model: string;
  capabilities: ProviderCapability;
  /** Internal account configuration used by post-response governance billing. */
  account?: ProviderAccountConfig;
  /**
   * Set when a per-provider budget tracker is attached: records one dispatched
   * request against this account's windowed request counter. dispatchWithFallback
   * invokes it per attempt so only the accounts actually dispatched to are
   * billed. Undefined (no tracker) = zero behavior change.
   */
  recordRequest?: () => void;
}

interface ProviderEntry {
  config: ProviderAccountConfig;
  adapter: IProviderAdapter;
  client: ProviderClient;
}

/**
 * Structural view of the per-provider budget tracker the manager consults
 * during selection. Kept as an interface (not a governance import) so the
 * providers package carries no dependency on governance; ProviderBudgetTracker
 * satisfies it structurally and context.ts wires the two together.
 */
export interface ProviderBudgetGuard {
  /** Read-only admission check; ok=false skips the account in selection. */
  check(config: ProviderAccountConfig): { ok: boolean };
  /** Records one dispatched request against the account's request window. */
  recordRequest(config: ProviderAccountConfig): void;
}

/**
 * Maps an account config onto provider-client options. Honored here from the
 * 6-tab Network group: maxRetries/backoffs + extraHeaders, the per-request
 * timeout (network.timeoutSec), the streaming idle timeout
 * (network.streamIdleTimeoutSec), and the custom CA (network.caCertPem, wired
 * into Deno.createHttpClient's caCerts). Proxy basic-auth credentials are
 * honored too. Network fields win over the legacy `retry` object when both are
 * present.
 *
 * network.skipTlsVerify is forwarded but NOT enforceable: Deno.createHttpClient
 * has no per-client insecure/skip-verify option (verified against Deno 2.9), so
 * the client surfaces a warning instead of silently ignoring it. NoProxy
 * bypass patterns can be set per provider; otherwise the selected global
 * proxy rules apply, then the client considers FROSTY_NO_PROXY. The remaining Network
 * fields (maxConnectionsPerHost, enforceHttp2) stay persisted-only — see
 * contracts/config.ts field docs.
 */
export function clientOptionsFor(
  config: ProviderAccountConfig,
  globalProxy?: GlobalProxyConfig,
): RetryOptions {
  const net = config.network;
  const proxy = config.proxyUrl === undefined ? globalProxy : undefined;
  return {
    maxRetries: net?.maxRetries ?? config.retry?.maxRetries,
    initialDelayMs: net?.initialBackoffMs ?? config.retry?.initialDelayMs,
    maxDelayMs: net?.maxBackoffMs ?? config.retry?.maxDelayMs,
    proxyUrl: config.proxyUrl ?? proxy?.proxyUrl,
    proxyUsername: config.proxy?.proxyUsername ?? proxy?.proxyUsername,
    proxyPassword: config.proxy?.proxyPassword ?? proxy?.proxyPassword,
    noProxy: config.proxy?.noProxy ?? proxy?.noProxy,
    extraHeaders: net?.extraHeaders,
    requestTimeoutMs: net?.timeoutSec !== undefined
      ? Math.round(net.timeoutSec * 1000)
      : undefined,
    streamIdleTimeoutMs: net?.streamIdleTimeoutSec !== undefined
      ? Math.round(net.streamIdleTimeoutSec * 1000)
      : undefined,
    caCertPem: net?.caCertPem,
    skipTlsVerify: net?.skipTlsVerify,
  };
}

export function buildAdapter(
  config: ProviderAccountConfig,
  client: ProviderClient = new ProviderClient(clientOptionsFor(config)),
): IProviderAdapter {
  switch (config.type) {
    case "openai":
      // Only real OpenAI has the native /responses/input_tokens counter.
      return new OpenAIAdapter(
        config.apiKey ?? "",
        config.baseUrl,
        client,
        true,
      );
    case "anthropic":
    case "anthropic-compatible":
      // Generic Anthropic-wire endpoint: same adapter, user-supplied baseUrl.
      return new AnthropicAdapter(
        config.apiKey ?? "",
        undefined,
        config.baseUrl,
        client,
        config.betaHeaders?.overrides,
      );
    case "azure":
      return new AzureOpenAIAdapter(
        config.apiKey ?? "",
        config.endpoint ?? "",
        config.apiVersion,
        client,
      );
    case "gemini":
      return new GeminiAdapter(config.apiKey ?? "", config.baseUrl, client);
    case "openrouter":
      return new OpenAIAdapter(
        config.apiKey ?? "",
        config.baseUrl ?? "https://openrouter.ai/api/v1",
        client,
      );
    case "cohere":
      return new CohereAdapter(config.apiKey ?? "", config.baseUrl, client);
    case "bedrock":
      return new BedrockAdapter({
        region: config.awsRegion ?? "us-east-1",
        accessKeyId: config.awsAccessKeyId ?? "",
        secretAccessKey: config.awsSecretAccessKey ?? "",
        sessionToken: config.awsSessionToken,
        endpoint: config.baseUrl,
        fetchImpl: client.fetch,
        batchRoleArn: config.awsBatchRoleArn,
        batchOutputS3Uri: config.awsBatchOutputS3Uri,
        s3Bucket: config.awsS3Bucket,
        s3Prefix: config.awsS3Prefix,
      });
    case "vertex":
      return new VertexAdapter({
        projectId: config.projectId ?? "",
        location: config.location ?? "us-central1",
        serviceAccountJson: config.serviceAccountJson ?? "{}",
        baseUrl: config.baseUrl,
        client,
      });
    case "elevenlabs":
      // The client itself, not `client.fetch`: that getter is fetchWithRetry, so
      // it turned one caller request into up to four paid speech/transcription
      // renders. The adapter picks fetchGuarded off it instead.
      return new ElevenLabsAdapter(
        config.apiKey ?? "",
        config.baseUrl,
        client,
      );
    case "huggingface":
      return new HuggingFaceAdapter(
        config.apiKey ?? "",
        config.baseUrl ?? OPENAI_COMPAT_BASE_URLS.huggingface,
        client,
      );
    default:
      // OpenAI-wire-compatible vendors (groq, mistral, ollama, …).
      return new OpenAIAdapter(
        config.apiKey ?? "",
        config.baseUrl ?? OPENAI_COMPAT_BASE_URLS[config.type],
        client,
      );
  }
}

export class ProviderManager {
  private accounts = new Map<string, ProviderEntry>();
  private roundRobin = new Map<string, number>();
  // Smooth weighted-round-robin state per model, used only when a tier has
  // non-uniform weights. Uniform/unset weights stay on the roundRobin counter
  // above so selection is byte-identical to the pre-weight behavior.
  private swrrState = new Map<string, { sig: string; current: number[] }>();
  private globalProxy?: GlobalProxyConfig;

  constructor(
    configs: ProviderAccountConfig[] = [],
    private defaultProvider?: string,
    /** Optional per-provider budget/rate tracker; absent = no limits (today). */
    private budgets?: ProviderBudgetGuard,
    globalProxy?: GlobalProxyConfig,
    private proxySupported: () => boolean = supportsProxyHttpClient,
  ) {
    if (globalProxy && !this.proxySupported()) {
      throw new GatewayError(
        409,
        "Global proxy configuration requires Deno.createHttpClient support.",
      );
    }
    this.globalProxy = globalProxy;
    for (const config of configs) {
      this.upsert(config);
    }
  }

  private makeEntry(config: ProviderAccountConfig): ProviderEntry {
    const client = new ProviderClient(
      clientOptionsFor(config, this.globalProxy),
    );
    return { config, adapter: buildAdapter(config, client), client };
  }

  /** Effective load-balancing weight: explicit `weight`, else 1 (uniform). */
  private static weightOf(config: ProviderAccountConfig): number {
    return config.weight ?? 1;
  }

  /** True when the account is within its per-provider budget (or untracked). */
  private withinBudget(config: ProviderAccountConfig): boolean {
    return !this.budgets || this.budgets.check(config).ok;
  }

  /**
   * Chooses the head index of the load-balancing tier for this turn.
   *
   * Uniform weights (the default, including no weights set) take the legacy
   * round-robin counter, so distribution is byte-identical to the pre-weight
   * behavior. Non-uniform weights use smooth weighted round-robin (SWRR), which
   * degenerates to plain round-robin when all weights are equal, so higher-
   * weight accounts receive proportionally more traffic. `advance=false` peeks
   * without consuming a turn (failover enumeration).
   */
  private selectHead(
    model: string,
    tier: ProviderAccountConfig[],
    advance: boolean,
  ): number {
    const weights = tier.map(ProviderManager.weightOf);
    const uniform = weights.every((w) => w === weights[0]);
    if (uniform) {
      const turn = this.roundRobin.get(model) ?? 0;
      if (advance) {
        this.roundRobin.set(model, turn + 1);
      }
      return turn % tier.length;
    }
    const sig = tier.map((c, i) => `${c.id}:${weights[i]}`).join(",");
    let state = this.swrrState.get(model);
    if (!state || state.sig !== sig) {
      state = { sig, current: weights.map(() => 0) };
      this.swrrState.set(model, state);
    }
    // Peek on a copy so failover enumeration never consumes a turn.
    const current = advance ? state.current : state.current.slice();
    const total = weights.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let i = 0; i < weights.length; i++) {
      current[i] += weights[i];
      if (current[i] > current[best]) {
        best = i;
      }
    }
    current[best] -= total;
    return best;
  }

  /** Enabled accounts advertising a model, priority-ordered with weighted
   * round-robin rotation inside the top priority tier, the load-balancing pool.
   * Over-budget accounts are dropped so load-balancing and failover skip them.
   * `advanceTurn` consumes a rotation turn; readers that only enumerate
   * failover candidates must pass false so one request rotates once. */
  private pool(model: string, advanceTurn = true): ProviderAccountConfig[] {
    const advertising = this.list().filter(
      (c) => c.enabled && c.models.includes(model) && this.withinBudget(c),
    );
    if (advertising.length <= 1) {
      return advertising;
    }
    advertising.sort((a, b) => a.priority - b.priority);
    const topPriority = advertising[0].priority;
    const tier = advertising.filter((c) => c.priority === topPriority);
    const rest = advertising.filter((c) => c.priority !== topPriority);
    const head = this.selectHead(model, tier, advanceTurn);
    const rotated = tier.slice(head).concat(tier.slice(0, head));
    return rotated.concat(rest);
  }

  upsert(config: ProviderAccountConfig): void {
    this.accounts.get(config.id)?.client.close();
    this.accounts.set(config.id, this.makeEntry(config));
  }

  /**
   * Rebuilds all provider clients before swapping them into service. A global
   * proxy is refused when Deno cannot construct HTTP clients, avoiding a
   * configuration state that claims to enforce egress but actually uses fetch.
   */
  configureGlobalProxy(config: GlobalProxyConfig | undefined): void {
    if (config && !this.proxySupported()) {
      throw new GatewayError(
        409,
        "Global proxy configuration requires Deno.createHttpClient support.",
      );
    }
    const previous = this.globalProxy;
    this.globalProxy = config ? structuredClone(config) : undefined;
    const replacement = new Map<string, ProviderEntry>();
    try {
      for (const account of this.accounts.values()) {
        replacement.set(account.config.id, this.makeEntry(account.config));
      }
    } catch (error) {
      for (const entry of replacement.values()) entry.client.close();
      this.globalProxy = previous;
      throw error;
    }
    const old = this.accounts;
    this.accounts = replacement;
    for (const entry of old.values()) entry.client.close();
  }

  getGlobalProxy(): GlobalProxyConfig | undefined {
    return this.globalProxy ? structuredClone(this.globalProxy) : undefined;
  }

  remove(id: string): boolean {
    this.accounts.get(id)?.client.close();
    return this.accounts.delete(id);
  }

  get(id: string): ProviderAccountConfig | undefined {
    return this.accounts.get(id)?.config;
  }

  list(): ProviderAccountConfig[] {
    return [...this.accounts.values()].map((a) => a.config);
  }

  /** Browser-safe listing: every secret replaced with a presence flag via the
   * canonical redaction (shared with the admin route so they never drift). */
  listPublic(): ProviderAccountPublic[] {
    return this.list().map(redactProviderAccount);
  }

  setDefaultProvider(id: string | undefined): void {
    this.defaultProvider = id;
  }

  getDefaultProvider(): string | undefined {
    return this.defaultProvider;
  }

  /** Aggregated model catalog for /v1/models, ids prefixed `account/model`. */
  models(): Array<{ id: string; object: "model"; owned_by: string }> {
    const out: Array<{ id: string; object: "model"; owned_by: string }> = [];
    for (const { config } of this.accounts.values()) {
      if (!config.enabled) {
        continue;
      }
      for (const model of config.models) {
        out.push({
          id: `${config.id}/${model}`,
          object: "model",
          owned_by: config.id,
        });
      }
    }
    return out;
  }

  private targetFor(accountId: string, model: string): ResolvedTarget {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      throw new GatewayError(
        404,
        `Unknown provider "${accountId}".`,
        "invalid_request_error",
        "model",
      );
    }
    if (!entry.config.enabled) {
      throw new GatewayError(
        400,
        `Provider "${accountId}" is disabled.`,
        "invalid_request_error",
        "model",
      );
    }
    const config = entry.config;
    return {
      providerId: accountId,
      type: config.type,
      adapter: entry.adapter,
      model,
      capabilities: ProviderRegistry[config.type],
      account: config,
      recordRequest: this.budgets
        ? () => this.budgets!.recordRequest(config)
        : undefined,
    };
  }

  /** Direct account lookup for endpoints routed by provider id. */
  accountTarget(id: string, model = ""): ResolvedTarget {
    return this.targetFor(id, model);
  }

  /**
   * Best-effort provider id for a model WITHOUT advancing the round-robin turn
   * or throwing. Telemetry uses this after the fact to label a request; it must
   * not perturb the load-balancing rotation that resolve()/resolveChain() drive.
   */
  tryProviderId(model: string): string | undefined {
    try {
      const slash = model.indexOf("/");
      if (slash > 0 && this.accounts.has(model.slice(0, slash))) {
        return model.slice(0, slash);
      }
      if (this.defaultProvider && this.accounts.has(this.defaultProvider)) {
        return this.defaultProvider;
      }
      const enabled = this.list().filter((c) => c.enabled);
      if (enabled.length === 1) {
        return enabled[0].id;
      }
      // advanceTurn=false: read the current rotation head without consuming it.
      return this.pool(model, false)[0]?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * `openai/gpt-4o` routes to account `openai` with model `gpt-4o`.
   * Unprefixed models use the default provider, the single enabled account,
   * or round-robin load balancing across accounts advertising the model.
   */
  resolve(model: string): ResolvedTarget {
    const slash = model.indexOf("/");
    if (slash > 0) {
      const accountId = model.slice(0, slash);
      if (this.accounts.has(accountId)) {
        return this.targetFor(accountId, model.slice(slash + 1));
      }
    }

    if (this.defaultProvider) {
      return this.targetFor(this.defaultProvider, model);
    }

    const enabled = this.list().filter((c) => c.enabled);
    if (enabled.length === 1) {
      return this.targetFor(enabled[0].id, model);
    }
    if (enabled.length === 0) {
      throw new GatewayError(
        503,
        "No providers are configured. Add one via /api/providers.",
        "provider_error",
      );
    }

    const pool = this.pool(model);
    if (pool.length > 0) {
      return this.targetFor(pool[0].id, model);
    }

    // An empty pool when accounts DO advertise the model means every one of
    // them is over its per-provider budget/rate limit — a distinct, retriable
    // condition from an unroutable model.
    if (
      this.budgets &&
      this.list().some((c) => c.enabled && c.models.includes(model))
    ) {
      throw new GatewayError(
        429,
        `All providers advertising model "${model}" are over their configured ` +
          `budget or rate limit.`,
        "provider_error",
        undefined,
        "provider_budget_exhausted",
      );
    }

    throw new GatewayError(
      400,
      `Model "${model}" has no provider prefix, no default provider is set, ` +
        `and no configured provider advertises it. Use "<provider>/<model>" ` +
        `or configure a default provider.`,
      "invalid_request_error",
      "model",
    );
  }

  /**
   * Primary target, explicit fallbacks, then automatic failover across the
   * remaining accounts that advertise the same model.
   */
  resolveChain(model: string, fallbacks: Fallback[] = []): ResolvedTarget[] {
    const primary = this.resolve(model);
    const chain = [primary];
    for (const fb of fallbacks) {
      try {
        chain.push(this.targetFor(fb.provider, fb.model ?? primary.model));
      } catch {
        // Skip unknown/disabled fallback targets rather than failing the request.
      }
    }
    for (const candidate of this.pool(primary.model, false)) {
      if (!chain.some((t) => t.providerId === candidate.id)) {
        try {
          chain.push(this.targetFor(candidate.id, primary.model));
        } catch {
          // skip
        }
      }
    }
    return chain;
  }
}
