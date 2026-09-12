import { ChatCompletionRequestSchema } from "./schemas.ts";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "azure"
  | "gemini"
  | "openrouter"
  | "groq"
  | "mistral"
  | "ollama"
  | "xai"
  | "perplexity"
  | "cerebras"
  | "nebius"
  | "sgl"
  | "parasail"
  | "huggingface"
  | "cohere"
  | "bedrock"
  | "vertex"
  | "elevenlabs"
  // Generic env-configurable endpoints: user supplies the base URL (and an
  // optional key) to point a shared adapter at any compatible server.
  | "openai-compatible"
  | "anthropic-compatible"
  | "lmstudio";

export interface ProviderCapability {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsEmbeddings: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsFiles: boolean;
  authRequirements: string[];
}

export const ProviderRegistry: Record<ProviderName, ProviderCapability> = {
  openai: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: true,
    supportsAudio: true,
    supportsFiles: true,
    authRequirements: ["OPENAI_API_KEY"],
  },
  anthropic: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: true,
    supportsAudio: false,
    // AnthropicAdapter.rawProxy translates /files + /batches to the native
    // Files API (files-api-2025-04-14 beta) and Message Batches API.
    supportsFiles: true,
    authRequirements: ["ANTHROPIC_API_KEY"],
  },
  azure: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: true,
    supportsAudio: true,
    supportsFiles: true,
    authRequirements: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  },
  gemini: {
    supportsStreaming: true,
    supportsTools: true,
    // GeminiAdapter.embeddings() proxies Google's OpenAI-compatible
    // /embeddings surface (see gemini.ts).
    supportsEmbeddings: true,
    // GeminiAdapter.generateImage() calls Google Imagen on the native
    // generativelanguage models `:predict` surface with the API key.
    supportsImages: true,
    // GeminiAdapter.rawProxy translates /audio/* to native :generateContent
    // (TTS via responseModalities AUDIO + PCM->WAV, STT via inlineData).
    supportsAudio: true,
    // GeminiAdapter.rawProxy translates /files + /batches to the native
    // Files/Batch APIs (upload/download base rewrites, batchGenerateContent).
    supportsFiles: true,
    authRequirements: ["GEMINI_API_KEY"],
  },
  openrouter: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: true,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["OPENROUTER_API_KEY"],
  },
  groq: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: false,
    supportsAudio: true, // whisper transcription endpoint
    supportsFiles: false,
    authRequirements: ["GROQ_API_KEY"],
  },
  mistral: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: false,
    // OpenAI-wire /audio/transcriptions passthrough (Voxtral); groq precedent.
    supportsAudio: true,
    supportsFiles: false,
    authRequirements: ["MISTRAL_API_KEY"],
  },
  ollama: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: [], // local daemon; no key
  },
  xai: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: true,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["XAI_API_KEY"],
  },
  perplexity: {
    supportsStreaming: true,
    // Resolves to OpenAIAdapter, which forwards `tools` verbatim on the
    // OpenAI wire; Perplexity's Sonar models accept function tools.
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["PERPLEXITY_API_KEY"],
  },
  cerebras: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["CEREBRAS_API_KEY"],
  },
  nebius: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    // OpenAIAdapter.rawProxy forwards /images/generations on the OpenAI
    // wire; Nebius AI Studio serves image models there.
    supportsImages: true,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["NEBIUS_API_KEY"],
  },
  sgl: {
    supportsStreaming: true,
    // OpenAIAdapter forwards `tools`; SGLang supports OpenAI function calling.
    supportsTools: true,
    // OpenAIAdapter.embeddings posts /embeddings; SGLang serves it for
    // embedding models.
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: [], // self-hosted SGLang; no key
  },
  parasail: {
    supportsStreaming: true,
    // OpenAIAdapter forwards `tools` verbatim; Parasail's OpenAI-compatible
    // serverless endpoint accepts function tools.
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["PARASAIL_API_KEY"],
  },
  huggingface: {
    supportsStreaming: true,
    supportsTools: false,
    supportsEmbeddings: true,
    // HuggingFaceAdapter.generateImage routes hf-inference/fal-ai/nebius/
    // together image backends behind the canonical images surface.
    supportsImages: true,
    // HuggingFaceAdapter.rawProxy: TTS (hf-inference pipeline) + STT
    // (hf-inference raw-binary, fal-ai data-URI).
    supportsAudio: true,
    supportsFiles: false,
    authRequirements: ["HF_TOKEN"],
  },
  cohere: {
    supportsStreaming: true,
    // CohereAdapter translates OpenAI tools/tool_calls/tool results to the
    // Cohere v2 chat shape and back (non-streaming and streaming).
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["COHERE_API_KEY"],
  },
  bedrock: {
    // BedrockAdapter decodes converse-stream's AWS vnd.amazon.eventstream
    // frames into canonical OpenAI SSE chunks (see eventstream.ts).
    supportsStreaming: true,
    // BedrockAdapter maps OpenAI tools -> Converse toolConfig and Converse
    // toolUse blocks -> OpenAI tool_calls (streaming and non-streaming).
    supportsTools: true,
    // BedrockAdapter.embeddings() rides the native InvokeModel (`:invoke`)
    // surface: Titan (amazon.titan-embed-*) + Cohere-on-Bedrock (cohere.embed-*).
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    // BedrockAdapter.rawProxy: batches via Model Invocation Jobs on the
    // bedrock control plane, files emulated on S3 (s3.ts over sigv4).
    supportsFiles: true,
    authRequirements: [
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ],
  },
  vertex: {
    supportsStreaming: true,
    supportsTools: true,
    // VertexAdapter.embeddings() calls the native publishers/google
    // models :predict surface with the account's OAuth token.
    supportsEmbeddings: true,
    // VertexAdapter.generateImage() calls Google Imagen on the same
    // publishers/google models `:predict` surface with the OAuth token.
    supportsImages: true,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: [
      "VERTEX_PROJECT_ID",
      "VERTEX_LOCATION",
      "VERTEX_SERVICE_ACCOUNT_JSON",
    ],
  },
  elevenlabs: {
    supportsStreaming: false,
    supportsTools: false,
    supportsEmbeddings: false,
    supportsImages: false,
    supportsAudio: true,
    supportsFiles: false,
    authRequirements: ["ELEVENLABS_API_KEY"],
  },
  "openai-compatible": {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["OPENAI_COMPAT_BASE_URL"], // base URL required; key optional
  },
  "anthropic-compatible": {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: false,
    supportsImages: true,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: ["ANTHROPIC_COMPAT_BASE_URL"], // base URL required; key optional
  },
  lmstudio: {
    supportsStreaming: true,
    supportsTools: true,
    supportsEmbeddings: true,
    supportsImages: false,
    supportsAudio: false,
    supportsFiles: false,
    authRequirements: [], // local server; base URL defaults, key optional
  },
};

export function parseChatCompletionRequest(data: unknown) {
  return ChatCompletionRequestSchema.safeParse(data);
}

export function getProviderCapabilities(
  providerName: ProviderName,
): ProviderCapability | undefined {
  return ProviderRegistry[providerName];
}
