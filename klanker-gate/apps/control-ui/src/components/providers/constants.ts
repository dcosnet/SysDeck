import type { ProviderAccountConfig } from "../../api";

export type ProviderType = ProviderAccountConfig["type"];

/** Every wire type the gateway can route to (contract order). */
export const PROVIDER_TYPES: ProviderType[] = [
  "openai",
  "anthropic",
  "azure",
  "gemini",
  "openrouter",
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
  "cohere",
  "bedrock",
  "vertex",
  "elevenlabs",
  "openai-compatible",
  "anthropic-compatible",
  "lmstudio",
];

/** Cloud providers whose auth is credential-based, not a single API key. */
export const CLOUD_TYPES: ReadonlySet<ProviderType> = new Set([
  "bedrock",
  "vertex",
]);

/**
 * Bring-your-own wire types: the ones that need an operator-supplied base URL
 * and render the "CUSTOM" chip in the provider list (taste + spec).
 */
export const CUSTOM_TYPES: ReadonlySet<ProviderType> = new Set([
  "openai-compatible",
  "anthropic-compatible",
  "lmstudio",
]);

/** Human labels for the wire types (title-cased, provider identities preserved). */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral AI",
  ollama: "Ollama",
  xai: "xAI",
  perplexity: "Perplexity",
  cerebras: "Cerebras",
  nebius: "Nebius",
  sgl: "SGLang",
  parasail: "Parasail",
  huggingface: "HuggingFace",
  cohere: "Cohere",
  bedrock: "AWS Bedrock",
  vertex: "Vertex AI",
  elevenlabs: "Elevenlabs",
  "openai-compatible": "OpenAI-compatible",
  "anthropic-compatible": "Anthropic-compatible",
  lmstudio: "LM Studio",
};

/** True when a config's type is a bring-your-own (custom) provider. */
export function isCustomProvider(type: ProviderType): boolean {
  return CUSTOM_TYPES.has(type);
}

/** Base formats offered in the Add Custom Provider modal (wire compatibility). */
export const CUSTOM_BASE_FORMATS: { value: ProviderType; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic-compatible", label: "Anthropic-compatible" },
  { value: "lmstudio", label: "LM Studio" },
];

/**
 * One-click vendor catalog for the "Add provider" gallery. Every preset maps to
 * a real backend wire `type`; picking one prefills the add form (suggested id +
 * type + default base URL). `key` doubles as the suggested account id AND the
 * brand-logo key, so the list icon resolves the vendor logo from the account id
 * (see provider-logos.tsx). `needsExtraConfig` marks vendors that require more
 * than an API key (Azure endpoint, cloud credentials) so the gallery routes them
 * to the full form rather than implying a one-field add.
 */
export interface ProviderPreset {
  key: string;
  displayName: string;
  type: ProviderType;
  baseUrl?: string;
  needsExtraConfig?: boolean;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // First-party / hosted (the wire type carries the brand identity).
  { key: "openai", displayName: "OpenAI", type: "openai" },
  { key: "anthropic", displayName: "Anthropic", type: "anthropic" },
  {
    key: "azure",
    displayName: "Azure OpenAI",
    type: "azure",
    needsExtraConfig: true,
    hint: "Needs endpoint + API version",
  },
  { key: "gemini", displayName: "Google Gemini", type: "gemini" },
  {
    key: "openrouter",
    displayName: "OpenRouter",
    type: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    key: "groq",
    displayName: "Groq",
    type: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    key: "mistral",
    displayName: "Mistral AI",
    type: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    key: "xai",
    displayName: "xAI (Grok)",
    type: "xai",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    key: "perplexity",
    displayName: "Perplexity",
    type: "perplexity",
    baseUrl: "https://api.perplexity.ai",
  },
  {
    key: "cerebras",
    displayName: "Cerebras",
    type: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
  },
  { key: "cohere", displayName: "Cohere", type: "cohere" },
  { key: "huggingface", displayName: "Hugging Face", type: "huggingface" },
  { key: "elevenlabs", displayName: "ElevenLabs", type: "elevenlabs" },
  { key: "nebius", displayName: "Nebius", type: "nebius" },
  { key: "parasail", displayName: "Parasail", type: "parasail" },
  {
    key: "bedrock",
    displayName: "AWS Bedrock",
    type: "bedrock",
    needsExtraConfig: true,
    hint: "Needs AWS credentials",
  },
  {
    key: "vertex",
    displayName: "Google Vertex AI",
    type: "vertex",
    needsExtraConfig: true,
    hint: "Needs a service account",
  },
  // OpenAI-wire vendors (need an operator-supplied base URL).
  {
    key: "zai",
    displayName: "Z.ai (GLM)",
    type: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
  },
  {
    key: "minimax",
    displayName: "MiniMax",
    type: "openai-compatible",
    baseUrl: "https://api.minimax.io/v1",
  },
  {
    key: "moonshot",
    displayName: "Moonshot (Kimi)",
    type: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
  },
  {
    key: "deepseek",
    displayName: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    key: "together",
    displayName: "Together AI",
    type: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
  },
  {
    key: "fireworks",
    displayName: "Fireworks AI",
    type: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  {
    key: "deepinfra",
    displayName: "DeepInfra",
    type: "openai-compatible",
    baseUrl: "https://api.deepinfra.com/v1/openai",
  },
  {
    key: "vllm",
    displayName: "vLLM",
    type: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    hint: "Self-hosted",
  },
  // Local runtimes.
  {
    key: "lmstudio",
    displayName: "LM Studio",
    type: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    hint: "Local",
  },
  {
    key: "ollama",
    displayName: "Ollama",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    hint: "Local",
  },
];

/** Governance reset-period options (contract enum). */
export const RESET_PERIODS: { value: string; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

/** Proxy transport options (advisory; the scheme in proxyUrl is authoritative). */
export const PROXY_TYPES: {
  value: "http" | "https" | "socks5";
  label: string;
}[] = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
];

/** Beta-header override options (contract enum). */
export const BETA_OVERRIDES: {
  value: "default" | "enabled" | "disabled";
  label: string;
}[] = [
  { value: "default", label: "Default" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

export interface BetaHeaderDef {
  prefix: string;
  description: string;
}

/**
 * Known Anthropic beta-header prefixes shown in the Beta Headers tab. Operators
 * can add custom prefixes; overrides persist to betaHeaders.overrides.
 */
export const KNOWN_BETA_HEADERS: BetaHeaderDef[] = [
  { prefix: "computer-use-", description: "Computer use client tool" },
  {
    prefix: "structured-outputs-",
    description: "Strict tool validation and output_format",
  },
  {
    prefix: "advanced-tool-use-",
    description: "defer_loading, input_examples, allowed_callers",
  },
  { prefix: "mcp-client-", description: "MCP connector support" },
  {
    prefix: "prompt-caching-scope-",
    description: "Prompt caching scope control",
  },
  { prefix: "compact-", description: "Server-side context compaction" },
  {
    prefix: "context-management-",
    description: "Context editing (clear_tool_uses, clear_thinking)",
  },
  { prefix: "files-api-", description: "Files API support" },
  {
    prefix: "interleaved-thinking-",
    description: "Interleaved thinking between tool calls",
  },
  { prefix: "skills-", description: "Agent Skills" },
  {
    prefix: "context-1m-",
    description: "1M context window (beta for Sonnet 4.5/4)",
  },
  {
    prefix: "fast-mode-",
    description: "Fast mode (Opus 4.6 research preview)",
  },
  {
    prefix: "redact-thinking-",
    description: "Redact thinking blocks in responses",
  },
];

export interface RequestTypeDef {
  key: string;
  label: string;
}

/**
 * The endpoints a custom provider may advertise (Add Custom Provider grid).
 * Toggled client-side; the create payload records only the base fields the
 * config contract supports, so these read as capability hints (honest surface).
 */
export const REQUEST_TYPES: RequestTypeDef[] = [
  { key: "listModels", label: "List Models" },
  { key: "speechStream", label: "Speech Stream" },
  { key: "textCompletion", label: "Text Completion" },
  { key: "transcription", label: "Transcription" },
  { key: "textCompletionStream", label: "Text Completion Stream" },
  { key: "transcriptionStream", label: "Transcription Stream" },
  { key: "chatCompletion", label: "Chat Completion" },
  { key: "imageGeneration", label: "Image Generation" },
  { key: "chatCompletionStream", label: "Chat Completion Stream" },
  { key: "imageGenerationStream", label: "Image Generation Stream" },
  { key: "responses", label: "Responses" },
  { key: "imageEdit", label: "Image Edit" },
  { key: "responsesStream", label: "Responses Stream" },
  { key: "imageEditStream", label: "Image Edit Stream" },
  { key: "embedding", label: "Embedding" },
  { key: "imageVariation", label: "Image Variation" },
  { key: "speech", label: "Speech" },
  { key: "countTokens", label: "Count Tokens" },
];
