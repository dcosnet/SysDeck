import type {
  ChatCompletionRequest,
  CompletionRequest,
} from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  createSSEResponse,
  NormalizationPipeline,
} from "../../core/src/mod.ts";
import { OpenAIStreamTransformer } from "./openai.ts";

export class AzureOpenAIAdapter implements IProviderAdapter {
  constructor(
    private apiKey: string,
    private endpoint: string,
    private apiVersion: string = "2024-02-15-preview",
    private client: ProviderClient = new ProviderClient(),
  ) {
    this.endpoint = this.endpoint.replace(/\/$/, "");
  }

  private async post(
    deployment: string,
    path: string,
    body: unknown,
    context?: ProviderContext,
  ): Promise<Response> {
    // Azure addresses the deployment in the URL, not the model payload field.
    // The caller passes the deployment name in `model`.
    const url = `${this.endpoint}/openai/deployments/${deployment}${path}` +
      `?api-version=${this.apiVersion}`;
    const response = await this.client.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: context?.signal,
    });

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
    const response = await this.post(
      req.model,
      "/chat/completions",
      req,
      context,
    );
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
    const deployment = (req as { model?: string }).model ?? "";
    return this.post(deployment, "/embeddings", req, context);
  }

  async completions(
    req: CompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.post(req.model, "/completions", req, context);
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

  /** Files/batches live at the account scope; the rest address a deployment. */
  private static ACCOUNT_SCOPED = [/^\/files(\/|$)?/, /^\/batches(\/|$)?/];

  private async deploymentFor(path: string, req: Request): Promise<string> {
    const fromQuery = new URL(req.url).searchParams.get("model");
    if (fromQuery) {
      return fromQuery;
    }
    const contentType = req.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.clone().json().catch(() => ({})) as {
        model?: unknown;
      };
      if (typeof body.model === "string" && body.model.length > 0) {
        return body.model;
      }
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `Azure passthrough for "${path}" needs a deployment: pass body.model ` +
        `or a ?model= query parameter.`,
    );
  }

  /**
   * Long-tail passthrough (images, audio, files, batches). Maps OpenAI-style
   * paths onto Azure's URL scheme: account-scoped for files/batches,
   * deployment-scoped otherwise, always with api-version + api-key.
   */
  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const accountScoped = AzureOpenAIAdapter.ACCOUNT_SCOPED.some((p) =>
      p.test(path)
    );
    const base = accountScoped
      ? `${this.endpoint}/openai${path}`
      : `${this.endpoint}/openai/deployments/${await this
        .deploymentFor(path, req)}${path}`;
    const url = `${base}?api-version=${this.apiVersion}`;

    const headers = new Headers();
    const contentType = req.headers.get("Content-Type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    headers.set("api-key", this.apiKey);
    // fetchGuarded, not a bare fetch and not fetchWithRetry: the media surfaces
    // on this path (images, speech, transcription) are paid work, so a retry is
    // spend the caller did not ask for, and multipart bodies are not replayable
    // anyway. What a bare fetch was missing is the establishment timeout - a
    // provider that accepts the connection and never answers held a media
    // in-flight reservation with nothing to reclaim it.
    const response = await this.client.fetchGuarded(url, {
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
}
