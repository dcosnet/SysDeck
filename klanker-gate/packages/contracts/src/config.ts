import { z } from "zod";

// Control-plane configuration contracts. Shared verbatim by the gateway config
// service and the control UI so both fail at compile time when they drift.

export const ProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "azure",
  "gemini",
  "openrouter",
  // Wave-3 breadth: OpenAI-wire-compatible vendors served by the OpenAI
  // adapter with vendor base URLs…
  "groq",
  "mistral",
  "ollama",
  "xai",
  "perplexity",
  "cerebras",
  "nebius",
  "sgl",
  "parasail",
  "huggingface",
  // …and native adapters.
  "cohere",
  "bedrock",
  "vertex",
  "elevenlabs",
  // Generic env-configurable endpoints (user-supplied base URL).
  "openai-compatible",
  "anthropic-compatible",
  "lmstudio",
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

/**
 * Per-provider configuration groups backing the reference's 6-tab provider
 * panel (Network / Proxy / Performance / Governance / Beta headers /
 * Debugging). Every group and every field is OPTIONAL and additive: provider
 * configs written before these existed still parse unchanged.
 *
 * Fields marked "persisted only (enforced:false)" are stored and surfaced for
 * the UI but not yet acted on — see docs in admin/manager and the delivery
 * table. Flags must never lie about behavior, so anything needing deep
 * transport plumbing is explicitly NOT wired yet.
 */

/** One operator-supplied header added to every upstream request. */
export const ProviderExtraHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});
export type ProviderExtraHeader = z.infer<typeof ProviderExtraHeaderSchema>;

/** Browser-safe header metadata. Header values can carry credentials, so the
 * control plane exposes only the name and whether a value is configured. */
export const ProviderExtraHeaderPublicSchema = ProviderExtraHeaderSchema.omit({
  value: true,
}).extend({
  hasValue: z.boolean(),
});
export type ProviderExtraHeaderPublic = z.infer<
  typeof ProviderExtraHeaderPublicSchema
>;

/** Network tab. maxRetries/initialBackoffMs/maxBackoffMs + extraHeaders are
 * honored via the shared provider client; the rest are persisted only. */
export const ProviderNetworkConfigSchema = z.object({
  /** Honored: bounds request establishment + non-stream body reads via the
   * shared provider client (else env FROSTY_HTTP_TIMEOUT_MS, default 120s; 0
   * disables). Never total-caps an in-progress SSE stream. */
  timeoutSec: z.number().positive().optional(),
  /** Honored: inter-chunk IDLE timeout applied to SSE streams (reset per chunk),
   * never a total cap. Absent = stream handed back untouched. */
  streamIdleTimeoutSec: z.number().positive().optional(),
  /** Honored: maps onto the provider client's retry count. */
  maxRetries: z.number().int().nonnegative().optional(),
  /** Honored: initial retry backoff (ms). */
  initialBackoffMs: z.number().int().nonnegative().optional(),
  /** Honored: maximum retry backoff (ms). */
  maxBackoffMs: z.number().int().nonnegative().optional(),
  /** Persisted only (enforced:false): Deno fetch exposes no per-host pool cap. */
  maxConnectionsPerHost: z.number().int().positive().optional(),
  /** Persisted only (enforced:false): needs an HTTP/2-only transport client. */
  enforceHttp2: z.boolean().optional(),
  /** Honored: added to every upstream request (adapter-set headers win). */
  extraHeaders: z.array(ProviderExtraHeaderSchema).optional(),
  /** Persisted only (enforced:false): needs a TLS-relaxed transport client. */
  skipTlsVerify: z.boolean().optional(),
  /** Honored: loaded as a custom CA via Deno.createHttpClient({caCerts}) on the
   * provider client. Treated as a secret in redacted views (see hasCaCert). */
  caCertPem: z.string().optional(),
});
export type ProviderNetworkConfig = z.infer<typeof ProviderNetworkConfigSchema>;

const NoProxyPatternSchema = z.string().min(1).max(255).refine(
  (value) =>
    value === "*" || /^(?:\*\.|\.)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value),
  "No-proxy entries must be *, an exact host, .suffix, or *.suffix.",
);

/** Proxy tab. proxyUrl stays top-level (backward-compat); these are additive.
 * proxyUsername/proxyPassword are honored via the proxy client's basic auth
 * when a proxyUrl is set. proxyPassword and noProxy rules are redacted from
 * browser responses (see hasProxyPassword/noProxyCount). */
export const ProviderProxyConfigSchema = z.object({
  /** Persisted only (enforced:false): the proxy protocol is taken from the
   * proxyUrl scheme; this is advisory. */
  proxyType: z.enum(["http", "https", "socks5"]).optional(),
  proxyUsername: z.string().optional(),
  proxyPassword: z.string().optional(),
  /** Honored: provider-specific bypass rules override the global rules. */
  noProxy: z.array(NoProxyPatternSchema).max(128).optional(),
});
export type ProviderProxyConfig = z.infer<typeof ProviderProxyConfigSchema>;

/**
 * A gateway-wide default for provider egress only. The proxy URL deliberately
 * rejects embedded userinfo: credentials have dedicated write-only fields, so
 * a browser response, diagnostic, or URL parser can never accidentally expose
 * them. Individual provider proxy settings override this default as a unit.
 */
const GlobalProxyUrlSchema = z.string().min(1).max(2048).superRefine(
  (value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !(["http:", "https:", "socks5:"] as string[]).includes(url.protocol)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Proxy URL must use http:, https:, or socks5:.",
        });
      }
      if (!url.hostname) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Proxy URL must include a host.",
        });
      }
      if (url.username || url.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Proxy URL must not contain credentials; use proxyUsername and proxyPassword.",
        });
      }
      if (url.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Proxy URL must not include a fragment.",
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Proxy URL must be an absolute URL.",
      });
    }
  },
);

export const GlobalProxyConfigSchema = z.object({
  proxyUrl: GlobalProxyUrlSchema,
  proxyUsername: z.string().min(1).max(256).optional(),
  proxyPassword: z.string().min(1).max(1024).optional(),
  noProxy: z.array(NoProxyPatternSchema).max(128).default([]),
}).superRefine((value, ctx) => {
  if (value.proxyPassword !== undefined && value.proxyUsername === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proxyUsername"],
      message: "proxyUsername is required when proxyPassword is set.",
    });
  }
});
export type GlobalProxyConfig = z.infer<typeof GlobalProxyConfigSchema>;

/** Browser-safe status for the global proxy: no URL, credentials, or bypass
 * rules are returned because all can reveal internal infrastructure. */
export const GlobalProxyPublicSchema = z.object({
  enabled: z.boolean(),
  proxyType: z.enum(["http", "https", "socks5"]).optional(),
  hasCredentials: z.boolean(),
  noProxyCount: z.number().int().nonnegative(),
});
export type GlobalProxyPublic = z.infer<typeof GlobalProxyPublicSchema>;

export function redactGlobalProxy(
  config: GlobalProxyConfig | undefined,
): GlobalProxyPublic {
  if (!config) {
    return { enabled: false, hasCredentials: false, noProxyCount: 0 };
  }
  return {
    enabled: true,
    proxyType: new URL(config.proxyUrl).protocol.slice(0, -1) as
      | "http"
      | "https"
      | "socks5",
    hasCredentials: config.proxyUsername !== undefined,
    noProxyCount: config.noProxy.length,
  };
}

/** Performance tab. Persisted only (enforced:false): a per-provider
 * concurrency limiter would live in the dispatch path (out of scope). */
export const ProviderPerformanceConfigSchema = z.object({
  maxConcurrentRequests: z.number().int().positive().optional(),
});
export type ProviderPerformanceConfig = z.infer<
  typeof ProviderPerformanceConfigSchema
>;

const ResetPeriodSchema = z.enum(["hourly", "daily", "weekly", "monthly"]);
export type ResetPeriod = z.infer<typeof ResetPeriodSchema>;

/** Governance tab (per-provider budgets/limits). Enforced: the provider
 * manager consults a per-provider budget tracker (ProviderBudgetTracker,
 * packages/governance/src/provider_budgets.ts) during provider selection. An
 * account that has reached any configured limit is skipped in load-balancing
 * and failover (the request falls through to the next eligible provider), and
 * the request is rejected 429 when no eligible provider remains. Counters are
 * fixed windows keyed to each field's reset period (hourly/daily/weekly/
 * monthly; omit a period for a lifetime cap). Request counts accrue live on
 * the dispatch path; token/cost counts accrue on the same billing path that
 * meters virtual keys (recordTokens/recordCost — see the tracker docs and the
 * boot-wiring note). Accounts with no governance group are unlimited. */
export const ProviderGovernanceConfigSchema = z.object({
  budgetUsd: z.number().nonnegative().optional(),
  budgetResetPeriod: ResetPeriodSchema.optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  tokensResetPeriod: ResetPeriodSchema.optional(),
  maxRequests: z.number().int().nonnegative().optional(),
  requestsResetPeriod: ResetPeriodSchema.optional(),
});
export type ProviderGovernanceConfig = z.infer<
  typeof ProviderGovernanceConfigSchema
>;

/** Beta-headers tab. Honored by the Anthropic adapter: entries set to
 * "enabled" are joined into the `anthropic-beta` request header. Because the
 * gateway sets no default betas, "disabled"/"default" are currently inert. */
export const ProviderBetaHeadersConfigSchema = z.object({
  overrides: z.record(z.string(), z.enum(["default", "enabled", "disabled"]))
    .optional(),
});
export type ProviderBetaHeadersConfig = z.infer<
  typeof ProviderBetaHeadersConfigSchema
>;

/** Debugging tab. Persisted only (enforced:false): attaching raw req/resp to
 * the response envelope or the request log requires dispatch-path plumbing
 * (inference route + log store) that is out of scope. */
export const ProviderDebuggingConfigSchema = z.object({
  sendBackRawRequest: z.boolean().optional(),
  sendBackRawResponse: z.boolean().optional(),
  storeRawReqResp: z.boolean().optional(),
});
export type ProviderDebuggingConfig = z.infer<
  typeof ProviderDebuggingConfigSchema
>;

export const ProviderAccountConfigSchema = z.object({
  id: z.string().min(1),
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  /** Azure resource endpoint, e.g. https://my-resource.openai.azure.com */
  endpoint: z.string().optional(),
  /** Azure api-version query parameter */
  apiVersion: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Advertised model catalog; Azure entries are deployment names. */
  models: z.array(z.string()).default([]),
  /** Lower numbers are tried first when used as fallback targets. */
  priority: z.number().default(0),
  /** Optional weighted load-balancing within a priority tier: an account with
   * a higher weight receives proportionally more traffic via deterministic
   * weighted round-robin. Omitted or equal across a tier = plain round-robin
   * (today's behavior). */
  weight: z.number().positive().optional(),
  /** Upstream retry policy; defaults live in the provider client. Superseded by
   * network.{maxRetries,initialBackoffMs,maxBackoffMs} when those are set. */
  retry: z.object({
    maxRetries: z.number(),
    initialDelayMs: z.number().optional(),
    maxDelayMs: z.number().optional(),
  }).optional(),
  /** AWS Bedrock credentials/region. */
  awsRegion: z.string().optional(),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
  awsSessionToken: z.string().optional(),
  /** Bedrock batch: IAM role ARN passed as roleArn on CreateModelInvocationJob. */
  awsBatchRoleArn: z.string().optional(),
  /** Bedrock batch: default s3://bucket/prefix URI for batch job output. */
  awsBatchOutputS3Uri: z.string().optional(),
  /** Bedrock files: default S3 bucket (may be s3://bucket/prefix). */
  awsS3Bucket: z.string().optional(),
  /** Bedrock files: default key prefix inside awsS3Bucket. */
  awsS3Prefix: z.string().optional(),
  /** Vertex AI: GCP project/location + service-account JSON (stringified). */
  projectId: z.string().optional(),
  location: z.string().optional(),
  serviceAccountJson: z.string().optional(),
  /** Optional egress proxy URL for this account's upstream calls. */
  proxyUrl: z.string().optional(),
  // --- 6-tab provider panel groups (all optional, additive) ---
  network: ProviderNetworkConfigSchema.optional(),
  proxy: ProviderProxyConfigSchema.optional(),
  performance: ProviderPerformanceConfigSchema.optional(),
  governance: ProviderGovernanceConfigSchema.optional(),
  betaHeaders: ProviderBetaHeadersConfigSchema.optional(),
  debugging: ProviderDebuggingConfigSchema.optional(),
});
export type ProviderAccountConfig = z.infer<typeof ProviderAccountConfigSchema>;

/** Redacted network group: certificate and header values are write-only. */
export const ProviderNetworkPublicSchema = ProviderNetworkConfigSchema.omit({
  caCertPem: true,
  extraHeaders: true,
}).extend({
  extraHeaders: z.array(ProviderExtraHeaderPublicSchema).optional(),
});
export type ProviderNetworkPublic = z.infer<typeof ProviderNetworkPublicSchema>;
/** Redacted proxy group: password and bypass rules are write-only. */
export const ProviderProxyPublicSchema = ProviderProxyConfigSchema.omit({
  proxyPassword: true,
  noProxy: true,
}).extend({
  noProxyCount: z.number().int().nonnegative(),
});
export type ProviderProxyPublic = z.infer<typeof ProviderProxyPublicSchema>;

/** Redacted variant safe for the browser: secrets replaced by presence flags.
 * proxyUrl may embed credentials (http://user:pass@host), hence hasProxy;
 * proxy.proxyPassword -> hasProxyPassword; network.caCertPem -> hasCaCert. */
export const ProviderAccountPublicSchema = ProviderAccountConfigSchema.omit({
  apiKey: true,
  awsSecretAccessKey: true,
  awsSessionToken: true,
  serviceAccountJson: true,
  proxyUrl: true,
  network: true,
  proxy: true,
}).extend({
  hasApiKey: z.boolean(),
  hasCloudCredentials: z.boolean().optional(),
  hasProxy: z.boolean().optional(),
  hasProxyPassword: z.boolean().optional(),
  hasCaCert: z.boolean().optional(),
  network: ProviderNetworkPublicSchema.optional(),
  proxy: ProviderProxyPublicSchema.optional(),
});
export type ProviderAccountPublic = z.infer<typeof ProviderAccountPublicSchema>;

/**
 * Canonical redaction: full account config -> browser-safe public view. Used by
 * both the admin route responses and the provider manager listing so they can
 * never drift. Secrets (apiKey, cloud creds, proxyUrl, proxy.proxyPassword,
 * network.caCertPem/header values, and proxy bypass rules) are dropped and
 * replaced by presence metadata.
 */
export function redactProviderAccount(
  config: ProviderAccountConfig,
): ProviderAccountPublic {
  const {
    apiKey,
    awsSecretAccessKey,
    awsSessionToken: _awsSessionToken,
    serviceAccountJson,
    proxyUrl,
    network,
    proxy,
    ...rest
  } = config;

  let redactedNetwork: ProviderNetworkPublic | undefined;
  if (network) {
    const { caCertPem: _caCertPem, extraHeaders, ...net } = network;
    redactedNetwork = {
      ...net,
      ...(extraHeaders
        ? {
          extraHeaders: extraHeaders.map(({ name, value }) => ({
            name,
            hasValue: value.length > 0,
          })),
        }
        : {}),
    };
  }
  let redactedProxy: ProviderProxyPublic | undefined;
  if (proxy) {
    const { proxyPassword: _proxyPassword, noProxy, ...px } = proxy;
    redactedProxy = { ...px, noProxyCount: noProxy?.length ?? 0 };
  }

  return {
    ...rest,
    ...(redactedNetwork ? { network: redactedNetwork } : {}),
    ...(redactedProxy ? { proxy: redactedProxy } : {}),
    hasApiKey: Boolean(apiKey),
    hasCloudCredentials: Boolean(awsSecretAccessKey || serviceAccountJson),
    hasProxy: Boolean(proxyUrl),
    hasProxyPassword: Boolean(proxy?.proxyPassword),
    hasCaCert: Boolean(network?.caCertPem),
  };
}

export const GatewayConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  providers: z.array(ProviderAccountConfigSchema).default([]),
}).strict();
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const ConfigExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  config: GatewayConfigSchema,
});
export type ConfigExport = z.infer<typeof ConfigExportSchema>;
