import type {
  ChatCompletionRequest,
  CompletionRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "../../contracts/src/mod.ts";

export interface ProviderContext {
  signal?: AbortSignal;
  /**
   * Vendor-reported token usage for a surface whose canonical response cannot
   * carry it - a TTS reply is audio bytes, so there is no JSON body for an
   * accounting site to sniff. Values are provider-derived and UNVALIDATED here
   * by design: the route that supplies the callback is the trusted side and
   * bounds every number before it reaches accounting. `packages/providers`
   * gains no telemetry or governance import from this; it is a structural
   * interface, like the budget tracker.
   */
  onUsage?: (
    usage: { prompt?: number; completion?: number; total?: number },
  ) => void;
}

export interface IProviderAdapter {
  /**
   * Canonical chat entry point. Streaming requests resolve to a Response
   * whose body is normalized OpenAI-format SSE ending in `data: [DONE]`;
   * non-streaming requests resolve to a Response whose JSON body is a
   * canonical `chat.completion`.
   */
  chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response>;

  /**
   * Native legacy text completions. Absent means the provider has no native
   * surface; the gateway translates through chat for non-streaming requests.
   */
  completions?(
    req: CompletionRequest,
    context?: ProviderContext,
  ): Promise<Response>;

  /** Live model catalog from the provider, used by config model refresh. */
  listModels?(context?: ProviderContext): Promise<string[]>;

  /** Native embeddings surface. */
  embeddings?(req: unknown, context?: ProviderContext): Promise<Response>;

  /**
   * Native image generation. Absent means the provider has no first-class
   * image surface (the gateway then falls back to `rawProxy` for
   * OpenAI-wire providers). Present adapters translate the OpenAI-shaped
   * ImageGenerationRequest to their native surface (e.g. Google Imagen
   * `:predict`) and return the canonical ImageGenerationResponse.
   */
  generateImage?(
    req: ImageGenerationRequest,
    context?: ProviderContext,
  ): Promise<ImageGenerationResponse>;

  /**
   * Raw passthrough for OpenAI-compatible long-tail endpoints (files,
   * batches, audio, images): forwards the incoming request body verbatim
   * with provider auth. No retry — multipart bodies are not replayable.
   */
  rawProxy?(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response>;

  /**
   * Native token pre-flight. Absent means the gateway serves
   * /v1/count_tokens with a documented character-based estimate.
   */
  countTokens?(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }>;
}
