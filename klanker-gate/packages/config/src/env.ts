import type { ProviderAccountConfig } from "../../contracts/src/mod.ts";

// Environment bootstrap: seeds provider accounts from well-known variables.
// KV-persisted configuration (config service) overrides these at boot.

const DEFAULT_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  // Azure model entries are user-specific deployment names.
  azure: [],
  openrouter: [],
};

export function loadProvidersFromEnv(): ProviderAccountConfig[] {
  const configs: ProviderAccountConfig[] = [];

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (openaiKey) {
    configs.push({
      id: "openai",
      type: "openai",
      apiKey: openaiKey,
      enabled: true,
      models: DEFAULT_MODELS.openai,
      priority: 0,
    });
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    configs.push({
      id: "anthropic",
      type: "anthropic",
      apiKey: anthropicKey,
      enabled: true,
      models: DEFAULT_MODELS.anthropic,
      priority: 0,
    });
  }

  const azureKey = Deno.env.get("AZURE_OPENAI_API_KEY");
  const azureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  if (azureKey && azureEndpoint) {
    configs.push({
      id: "azure",
      type: "azure",
      apiKey: azureKey,
      endpoint: azureEndpoint,
      apiVersion: Deno.env.get("AZURE_OPENAI_API_VERSION") ?? undefined,
      enabled: true,
      models: (Deno.env.get("AZURE_OPENAI_DEPLOYMENTS") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      priority: 0,
    });
  }

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (geminiKey) {
    configs.push({
      id: "gemini",
      type: "gemini",
      apiKey: geminiKey,
      enabled: true,
      models: DEFAULT_MODELS.gemini,
      priority: 0,
    });
  }

  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openrouterKey) {
    configs.push({
      id: "openrouter",
      type: "openrouter",
      apiKey: openrouterKey,
      enabled: true,
      models: DEFAULT_MODELS.openrouter,
      priority: 0,
    });
  }

  const openaiCompatBase = Deno.env.get("OPENAI_COMPAT_BASE_URL");
  if (openaiCompatBase) {
    const model = Deno.env.get("OPENAI_COMPAT_DEFAULT_MODEL");
    configs.push({
      id: "openai-compatible",
      type: "openai-compatible",
      apiKey: Deno.env.get("OPENAI_COMPAT_API_KEY") ?? "",
      baseUrl: openaiCompatBase,
      enabled: true,
      models: model ? [model] : [],
      priority: 0,
    });
  }

  const anthropicCompatBase = Deno.env.get("ANTHROPIC_COMPAT_BASE_URL");
  if (anthropicCompatBase) {
    const model = Deno.env.get("ANTHROPIC_COMPAT_DEFAULT_MODEL");
    configs.push({
      id: "anthropic-compatible",
      type: "anthropic-compatible",
      apiKey: Deno.env.get("ANTHROPIC_COMPAT_API_KEY") ?? "",
      baseUrl: anthropicCompatBase,
      enabled: true,
      models: model ? [model] : [],
      priority: 0,
    });
  }

  // LM Studio: local by default, so either a base URL or a model enables it.
  const lmstudioBase = Deno.env.get("LMSTUDIO_BASE_URL");
  const lmstudioModel = Deno.env.get("LMSTUDIO_DEFAULT_MODEL");
  if (lmstudioBase || lmstudioModel) {
    configs.push({
      id: "lmstudio",
      type: "lmstudio",
      apiKey: Deno.env.get("LMSTUDIO_API_KEY") ?? "",
      baseUrl: lmstudioBase ?? "http://localhost:1234/v1",
      enabled: true,
      models: lmstudioModel ? [lmstudioModel] : [],
      priority: 0,
    });
  }

  // OpenAI-wire-compatible vendors: presence of the key (or base URL for
  // keyless local daemons) enables the account.
  const compat: Array<
    [ProviderAccountConfig["type"], string, string[]]
  > = [
    ["groq", "GROQ_API_KEY", ["llama-3.3-70b-versatile"]],
    ["mistral", "MISTRAL_API_KEY", ["mistral-large-latest"]],
    ["xai", "XAI_API_KEY", ["grok-3"]],
    ["perplexity", "PERPLEXITY_API_KEY", ["sonar-pro"]],
    ["cerebras", "CEREBRAS_API_KEY", ["llama-3.3-70b"]],
    ["nebius", "NEBIUS_API_KEY", []],
    ["parasail", "PARASAIL_API_KEY", []],
    ["huggingface", "HF_TOKEN", []],
    ["cohere", "COHERE_API_KEY", ["command-r-plus"]],
    ["elevenlabs", "ELEVENLABS_API_KEY", ["eleven_multilingual_v2"]],
  ];
  for (const [type, envKey, models] of compat) {
    const key = Deno.env.get(envKey);
    if (key) {
      configs.push({
        id: type,
        type,
        apiKey: key,
        enabled: true,
        models,
        priority: 0,
      });
    }
  }

  const ollamaBase = Deno.env.get("OLLAMA_BASE_URL");
  if (ollamaBase) {
    configs.push({
      id: "ollama",
      type: "ollama",
      baseUrl: ollamaBase,
      enabled: true,
      models: (Deno.env.get("OLLAMA_MODELS") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      priority: 0,
    });
  }

  const awsKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (awsKey && awsSecret) {
    configs.push({
      id: "bedrock",
      type: "bedrock",
      awsRegion: Deno.env.get("AWS_REGION") ?? "us-east-1",
      awsAccessKeyId: awsKey,
      awsSecretAccessKey: awsSecret,
      awsSessionToken: Deno.env.get("AWS_SESSION_TOKEN") ?? undefined,
      enabled: true,
      models: (Deno.env.get("BEDROCK_MODELS") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      priority: 0,
    });
  }

  const vertexProject = Deno.env.get("VERTEX_PROJECT_ID");
  const vertexSa = Deno.env.get("VERTEX_SERVICE_ACCOUNT_JSON");
  if (vertexProject && vertexSa) {
    configs.push({
      id: "vertex",
      type: "vertex",
      projectId: vertexProject,
      location: Deno.env.get("VERTEX_LOCATION") ?? "us-central1",
      serviceAccountJson: vertexSa,
      enabled: true,
      models: (Deno.env.get("VERTEX_MODELS") ?? "gemini-2.5-pro")
        .split(",").map((s) => s.trim()).filter(Boolean),
      priority: 0,
    });
  }

  return configs;
}

export function defaultProviderFromEnv(): string | undefined {
  return Deno.env.get("FROSTY_DEFAULT_PROVIDER") ?? undefined;
}
