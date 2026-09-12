import type {
  ChatCompletionRequest,
  CompletionRequest,
} from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  type CanonicalChunk,
  createSSEResponse,
  NormalizationPipeline,
} from "../../core/src/mod.ts";

/**
 * Line-based passthrough for upstreams that already speak OpenAI SSE.
 * Re-parsing every event guarantees canonical framing, drops keep-alive
 * comments, and always terminates the client stream with `[DONE]`.
 */
export class OpenAIStreamTransformer
  extends TransformStream<string, CanonicalChunk> {
  constructor() {
    let doneSent = false;
    super({
      transform(line, controller) {
        if (!line.startsWith("data:")) {
          return;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          doneSent = true;
          controller.enqueue("[DONE]");
          return;
        }
        try {
          controller.enqueue(JSON.parse(data) as Record<string, unknown>);
        } catch {
          // Ignore malformed keep-alive fragments.
        }
      },
      flush(controller) {
        if (!doneSent) {
          controller.enqueue("[DONE]");
        }
      },
    });
  }
}

export class OpenAIAdapter implements IProviderAdapter {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1",
    private client: ProviderClient = new ProviderClient(),
    /**
     * Real OpenAI exposes a native token counter at /responses/input_tokens.
     * The OpenAI-wire vendors that reuse this adapter (groq, mistral, nebius,
     * …) do NOT, so the manager only sets this for the `openai` account; the
     * rest fall back to the documented chars/4 estimate.
     */
    private nativeCountTokens: boolean = false,
  ) {}

  private async post(
    path: string,
    body: unknown,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: context?.signal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.post("/chat/completions", req, context);
    if (req.stream && response.body) {
      return createSSEResponse(
        NormalizationPipeline.create(
          new OpenAIStreamTransformer(),
          response.body,
        ),
      );
    }
    return response;
  }

  async completions(
    req: CompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.post("/completions", req, context);
    if (req.stream && response.body) {
      return createSSEResponse(
        NormalizationPipeline.create(
          new OpenAIStreamTransformer(),
          response.body,
        ),
      );
    }
    return response;
  }

  embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    return this.post("/embeddings", req, context);
  }

  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const headers = new Headers();
    const contentType = req.headers.get("Content-Type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    // fetchGuarded, not fetchWithRetry: these are the paid media surfaces
    // (images, speech, transcription) plus non-replayable multipart bodies, so a
    // retry is unrequested provider spend. It still brings the client's proxy/CA
    // wiring, establishment timeout and body-read budget, which a bare fetch
    // here did not.
    const response = await this.client.fetchGuarded(`${this.baseUrl}${path}`, {
      method: req.method,
      headers,
      body: req.body,
      signal: context?.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  async listModels(context?: ProviderContext): Promise<string[]> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/models`,
      {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id);
  }

  /**
   * Token pre-flight. Real OpenAI (nativeCountTokens) uses the native
   * /responses/input_tokens counter; every other OpenAI-wire vendor returns
   * the same documented chars/4 estimate the gateway would otherwise apply,
   * so this never regresses a vendor that lacks the native endpoint.
   */
  async countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    if (!this.nativeCountTokens) {
      const chars = req.messages
        .map((m) => (typeof m.content === "string" ? m.content.length : 0))
        .reduce((a, b) => a + b, 0);
      return { input_tokens: Math.ceil(chars / 4), estimated: true };
    }
    const input = req.messages.map((m) => ({
      role: m.role === "tool" || m.role === "function" ? "user" : m.role,
      content: typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
        ? m.content
          .map((p) =>
            typeof (p as { text?: unknown }).text === "string"
              ? (p as { text: string }).text
              : ""
          )
          .join("")
        : "",
    }));
    const response = await this.post(
      "/responses/input_tokens",
      { model: req.model, input },
      context,
    );
    const body = await response.json() as { input_tokens?: number };
    return { input_tokens: body.input_tokens ?? 0, estimated: false };
  }
}
