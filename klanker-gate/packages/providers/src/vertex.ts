import type {
  ChatCompletionRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import {
  createSSEResponse,
  NormalizationPipeline,
} from "../../core/src/mod.ts";
import { OpenAIStreamTransformer } from "./openai.ts";
import {
  buildImagenPredictBody,
  type ImagenPrediction,
  mapImagenResponse,
  resolveImagenModel,
} from "./imagen.ts";
import {
  fetchMetadataToken,
  isServiceAccountJson,
  loadAdcServiceAccount,
} from "./gcp_credentials.ts";

export interface VertexOptions {
  projectId: string;
  location: string;
  /** Stringified service-account JSON ({client_email, private_key, ...}). */
  serviceAccountJson: string;
  /** Endpoint override for tests. */
  baseUrl?: string;
  /** Token endpoint override for tests. */
  tokenUrl?: string;
  client?: ProviderClient;
  fetchImpl?: typeof fetch;
  /** Injectable env reader for ADC (defaults to a guarded Deno.env.get). */
  env?: (name: string) => string | undefined;
  /** Injectable file reader for ADC (defaults to Deno.readTextFile). */
  readTextFile?: (path: string) => Promise<string>;
}

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Flattens OpenAI message content (string or parts array) to plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

interface VertexEmbeddingPrediction {
  embeddings?: {
    values?: number[];
    statistics?: { token_count?: number };
  };
}

export class VertexAdapter implements IProviderAdapter {
  private client: ProviderClient;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(private options: VertexOptions) {
    // Token exchange and chat share one client so proxy+retry cover both.
    this.client = options.client ??
      new ProviderClient(
        {},
        options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      );
  }

  private baseUrl(): string {
    return (this.options.baseUrl ??
      `https://${this.options.location}-aiplatform.googleapis.com`)
      .replace(/\/$/, "");
  }

  private env(name: string): string | undefined {
    if (this.options.env) {
      return this.options.env(name);
    }
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  }

  /**
   * OAuth access token, cached with a 60s margin. The account's service-account
   * JSON is the DEFAULT source; when it carries no usable SA, Application
   * Default Credentials take over: the GOOGLE_APPLICATION_CREDENTIALS SA file
   * (reusing the JWT exchange), then the GCE/Cloud Run metadata server.
   */
  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.value;
    }
    // 1. Account SA JSON (default), else ADC file (GOOGLE_APPLICATION_CREDENTIALS).
    let saJson: string | undefined = this.options.serviceAccountJson;
    if (!isServiceAccountJson(saJson)) {
      saJson = await loadAdcServiceAccount({
        env: (n) => this.env(n),
        readTextFile: this.options.readTextFile,
      });
    }
    if (saJson && isServiceAccountJson(saJson)) {
      return await this.exchangeServiceAccount(saJson);
    }
    // 2. GCE / Cloud Run metadata server (ADC final fallback). Uses a raw
    //    short-timeout fetch so an off-GCE probe fails fast.
    const metadata = await fetchMetadataToken({
      env: (n) => this.env(n),
      fetchImpl: this.options.fetchImpl,
    });
    this.cachedToken = {
      value: metadata.token,
      expiresAt: Date.now() + metadata.expiresIn * 1000,
    };
    return metadata.token;
  }

  /** Signs a service-account JWT (RS256) and exchanges it for an access token. */
  private async exchangeServiceAccount(saJson: string): Promise<string> {
    const sa = JSON.parse(saJson) as {
      client_email: string;
      private_key: string;
      token_uri?: string;
    };
    const tokenUrl = this.options.tokenUrl ?? sa.token_uri ??
      "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    }));
    const signingInput = `${header}.${claims}`;
    const keyData = pemToPkcs8(sa.private_key).slice();
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyData.buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    const jwt = `${signingInput}.${base64url(new Uint8Array(signature))}`;

    const response = await this.client.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as {
      access_token: string;
      expires_in?: number;
    };
    this.cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const token = await this.getToken();
    const url = `${this.baseUrl()}/v1/projects/${this.options.projectId}` +
      `/locations/${this.options.location}/endpoints/openapi/chat/completions`;
    const model = req.model.includes("/") ? req.model : `google/${req.model}`;
    const response = await this.client.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ ...req, model }),
      signal: context?.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
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

  /** Native google-publisher model URL for a verb (:predict, :countTokens). */
  private publisherUrl(model: string, verb: string): string {
    const bare = model.replace(/^google\//, "");
    return `${this.baseUrl()}/v1/projects/${this.options.projectId}` +
      `/locations/${this.options.location}` +
      `/publishers/google/models/${encodeURIComponent(bare)}:${verb}`;
  }

  /**
   * POST to a Vertex surface with the account's OAuth token.
   *
   * `transport` selects the fetch, and the default keeps every existing caller
   * byte-identical: `embeddings` and `countTokens` are cheap idempotent calls
   * that still want the retry. `"single"` is for paid generation, where a
   * retried 429/5xx is provider spend the caller did not request. Both arrive at
   * the same `!ok` -> ProviderError translation, so the error shape is one.
   */
  private async postWithToken(
    url: string,
    body: unknown,
    context?: ProviderContext,
    transport: "retry" | "single" = "retry",
  ): Promise<Response> {
    const token = await this.getToken();
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: context?.signal,
    };
    const response = transport === "single"
      ? await this.client.fetchGuarded(url, init)
      : await this.client.fetchWithRetry(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  /**
   * Embeddings via the native publishers/google models:predict surface. The
   * OpenAI-shaped {model,input} request is mapped to Vertex instances and the
   * predictions are mapped back to the OpenAI embeddings response shape.
   */
  async embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    const r = req as { model: string; input: string | string[] };
    const texts = Array.isArray(r.input) ? r.input : [r.input];
    const response = await this.postWithToken(
      this.publisherUrl(r.model, "predict"),
      { instances: texts.map((content) => ({ content })) },
      context,
    );
    const vertex = await response.json() as {
      predictions?: VertexEmbeddingPrediction[];
    };
    const predictions = vertex.predictions ?? [];
    let promptTokens = 0;
    const data = predictions.map((p, index) => {
      promptTokens += p.embeddings?.statistics?.token_count ?? 0;
      return {
        object: "embedding",
        index,
        embedding: p.embeddings?.values ?? [],
      };
    });
    const out = {
      object: "list",
      data,
      model: r.model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
    return new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Native image generation via Google Imagen on the publishers/google
   * models `:predict` surface, reusing the account's OAuth token — the same
   * transport as embeddings. The OpenAI-shaped request is mapped to Imagen
   * instances/parameters and the base64 predictions to `b64_json`.
   */
  async generateImage(
    req: ImageGenerationRequest,
    context?: ProviderContext,
  ): Promise<ImageGenerationResponse> {
    const model = resolveImagenModel(req.model);
    const response = await this.postWithToken(
      this.publisherUrl(model, "predict"),
      buildImagenPredictBody(req),
      context,
      "single",
    );
    const body = await response.json() as { predictions?: ImagenPrediction[] };
    return mapImagenResponse(body.predictions ?? []);
  }

  /** Native token pre-flight via the publishers/google models:countTokens
   * surface, reusing the account's OAuth token. */
  async countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    const contents = req.messages
      .filter((m) => m.role !== "function")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: contentText(m.content) }],
      }));
    const response = await this.postWithToken(
      this.publisherUrl(req.model, "countTokens"),
      { contents },
      context,
    );
    const body = await response.json() as { totalTokens?: number };
    return { input_tokens: body.totalTokens ?? 0, estimated: false };
  }
}
