import type { ProviderName } from "../../contracts/src/mod.ts";

// Vendors whose APIs speak the OpenAI wire format: served by the OpenAI
// adapter pointed at the vendor base URL. `baseUrl` on the account config
// overrides these defaults (e.g. a remote Ollama host).

export const OPENAI_COMPAT_BASE_URLS: Partial<Record<ProviderName, string>> = {
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  ollama: "http://localhost:11434/v1",
  xai: "https://api.x.ai/v1",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  nebius: "https://api.studio.nebius.ai/v1",
  sgl: "http://localhost:30000/v1",
  parasail: "https://api.parasail.io/v1",
  huggingface: "https://router.huggingface.co/v1",
  lmstudio: "http://localhost:1234/v1",
};

export function isOpenAICompat(type: ProviderName): boolean {
  return type in OPENAI_COMPAT_BASE_URLS;
}
