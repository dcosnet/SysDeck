import { z } from "zod";

/** The five operator setting groups, in display order. */
export const SETTINGS_GROUPS = [
  "security",
  "compatibility",
  "performance",
  "caching",
  "mcp",
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** Provenance of an effective field value, surfaced to the UI per field. */
export const SettingSourceSchema = z.enum(["default", "env", "override"]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

export const SecuritySettingsSchema = z.object({
  passwordProtectEnabled: z.boolean().default(false),
  passwordUsername: z.string().default(""),
  disableInferenceAuth: z.boolean().default(false),
  enforceVirtualKeys: z.boolean().default(false),
  allowedOrigins: z.array(z.string()).default([]),
  allowedHeaders: z.array(z.string()).default([]),
  requiredHeaders: z.array(z.string()).default([]),
  whitelistedRoutes: z.array(z.string()).default([]),
});
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/** PUT input for security: every field optional, plus the write-only password. */
export const SecuritySettingsInputSchema = SecuritySettingsSchema.partial()
  .extend({ password: z.string().optional() });
export type SecuritySettingsInput = z.infer<typeof SecuritySettingsInputSchema>;

/** Effective (public) security view: no password, but a presence marker. */
export type SecuritySettingsPublic = SecuritySettings & {
  hasPassword: boolean;
};

// --- compatibility ----------------------------------------------------------

export const CompatibilitySettingsSchema = z.object({
  convertTextToChat: z.boolean().default(false),
  convertChatToResponses: z.boolean().default(false),
  dropUnsupportedParams: z.boolean().default(false),
  convertUnsupportedParameterValues: z.boolean().default(false),
});
export type CompatibilitySettings = z.infer<typeof CompatibilitySettingsSchema>;

// --- performance ------------------------------------------------------------

export const PerformanceSettingsSchema = z.object({
  initialPoolSize: z.number().int().nonnegative().default(5000),
  maxRequestBodySizeMb: z.number().int().positive().default(100),
});
export type PerformanceSettings = z.infer<typeof PerformanceSettingsSchema>;

// --- caching ----------------------------------------------------------------

export const CachingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  embeddingProvider: z.string().default(""),
  embeddingModel: z.string().default("text-embedding-3-small"),
  ttlSeconds: z.number().int().positive().default(300),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
  dimension: z.number().int().positive().default(1536),
  conversationHistoryThreshold: z.number().int().nonnegative().default(3),
  excludeSystemPrompt: z.boolean().default(false),
  cacheByModel: z.boolean().default(false),
  cacheByProvider: z.boolean().default(false),
});
export type CachingSettings = z.infer<typeof CachingSettingsSchema>;

// --- mcp --------------------------------------------------------------------

export const McpSettingsSchema = z.object({
  maxAgentDepth: z.number().int().positive().default(10),
  toolExecutionTimeoutSec: z.number().int().positive().default(30),
  toolSyncIntervalMin: z.number().int().positive().default(10),
  disableAutoToolInjection: z.boolean().default(false),
  externalServerUrl: z.string().default(""),
  externalClientUrl: z.string().default(""),
});
export type McpSettings = z.infer<typeof McpSettingsSchema>;

export const SettingsUpdateSchema = z.object({
  security: SecuritySettingsInputSchema.optional(),
  compatibility: CompatibilitySettingsSchema.partial().optional(),
  performance: PerformanceSettingsSchema.partial().optional(),
  caching: CachingSettingsSchema.partial().optional(),
  mcp: McpSettingsSchema.partial().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/**
 * Persisted per-group override shape. Mirrors {@link SettingsUpdateSchema} but
 * the security override carries only the derived `hasPassword` marker — never
 * the password itself (it is dropped before persistence).
 */
export const SecurityOverrideSchema = SecuritySettingsSchema.partial()
  .extend({ hasPassword: z.boolean().optional() });
export type SecurityOverride = z.infer<typeof SecurityOverrideSchema>;

export const SettingsOverridesSchema = z.object({
  security: SecurityOverrideSchema.optional(),
  compatibility: CompatibilitySettingsSchema.partial().optional(),
  performance: PerformanceSettingsSchema.partial().optional(),
  caching: CachingSettingsSchema.partial().optional(),
  mcp: McpSettingsSchema.partial().optional(),
});
export type SettingsOverrides = z.infer<typeof SettingsOverridesSchema>;

// --- pure defaults (no env) -------------------------------------------------
// Every field carries a `.default()`, so parsing an empty object yields the
// full default group. The env layer is applied at request time in the route.

export const DEFAULT_SECURITY: SecuritySettings = SecuritySettingsSchema.parse(
  {},
);
export const DEFAULT_COMPATIBILITY: CompatibilitySettings =
  CompatibilitySettingsSchema.parse({});
export const DEFAULT_PERFORMANCE: PerformanceSettings =
  PerformanceSettingsSchema
    .parse({});
export const DEFAULT_CACHING: CachingSettings = CachingSettingsSchema.parse({});
export const DEFAULT_MCP: McpSettings = McpSettingsSchema.parse({});

/** Per-field source map for a group (e.g. { ttlSeconds: "env", ... }). */
export type GroupSources<T> = { [K in keyof T]: SettingSource };

/** One group's response block: effective values plus per-field provenance. */
export interface SettingsGroupView<T> {
  values: T;
  /** Keyed by field name; every field of `values` is present. */
  sources: Record<string, SettingSource>;
}

/** Full GET /api/settings response shape (built in the route). */
export interface SettingsResponse {
  settings: {
    security: SettingsGroupView<SecuritySettingsPublic>;
    compatibility: SettingsGroupView<CompatibilitySettings>;
    performance: SettingsGroupView<PerformanceSettings>;
    caching: SettingsGroupView<CachingSettings>;
    mcp: SettingsGroupView<McpSettings>;
  };
  /** Per-field "<group>.<field>" -> whether the gateway actively enforces it. */
  enforcement: Record<string, boolean>;
}
