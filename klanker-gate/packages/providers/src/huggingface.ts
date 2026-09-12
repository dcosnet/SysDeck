import type {
  ChatCompletionRequest,
  CompletionRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";
import { OpenAIAdapter } from "./openai.ts";
import { detectAudioMimeType } from "./audio.ts";

/**
 * Splits a HuggingFace model id into (inference provider, model). Go parity:
 * zero slashes is invalid; exactly one slash is a bare hub id routed by the
 * `auto` policy; more than one slash splits on the FIRST slash.
 */
export function splitModelProvider(
  model: string,
): { provider: string; model: string } {
  const slashes = model.split("/").length - 1;
  if (slashes === 0) {
    throw new ProviderError(
      400,
      "Bad Request",
      `invalid model name format: ${model}`,
    );
  }
  if (slashes === 1) {
    return { provider: "auto", model };
  }
  const cut = model.indexOf("/");
  return { provider: model.slice(0, cut), model: model.slice(cut + 1) };
}

/** One prepared image-generation call: native-base path + JSON body. */
export interface HfImageCall {
  provider: string;
  path: string;
  body: Record<string, unknown>;
}

/** Parses "WxH" into integers; undefined for "auto" or anything unparseable. */
function parseSize(
  size: string | undefined,
): { width: number; height: number } | undefined {
  if (!size || size.toLowerCase() === "auto") return undefined;
  const parts = size.split("x");
  if (parts.length !== 2) return undefined;
  const width = Number.parseInt(parts[0], 10);
  const height = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width, height };
}

/**
 * Maps the canonical image request to the provider-specific wire under the
 * native router base. Unknown providers (including bare `auto` ids) are a
 * 400: image generation needs one of hf-inference/fal-ai/nebius/together.
 */
export function buildHfImageRequest(req: ImageGenerationRequest): HfImageCall {
  const { provider, model } = splitModelProvider(req.model ?? "");
  switch (provider) {
    case "hf-inference":
      return {
        provider,
        path: `/hf-inference/models/${model}`,
        body: { inputs: req.prompt },
      };
    case "fal-ai": {
      const body: Record<string, unknown> = { prompt: req.prompt };
      if (req.n !== undefined) body.num_images = req.n;
      const size = parseSize(req.size);
      if (size) body.image_size = size;
      if (req.negativePrompt !== undefined) {
        body.negative_prompt = req.negativePrompt;
      }
      if (req.seed !== undefined) body.seed = req.seed;
      if (req.response_format === "b64_json") body.sync_mode = true;
      return { provider, path: `/fal-ai/${model}`, body };
    }
    case "nebius": {
      const body: Record<string, unknown> = { model, prompt: req.prompt };
      if (req.size && req.size.toLowerCase() !== "auto") {
        const size = parseSize(req.size);
        if (!size) {
          throw new ProviderError(
            400,
            "Bad Request",
            `invalid size format: expected "WIDTHxHEIGHT", got "${req.size}"`,
          );
        }
        body.width = size.width;
        body.height = size.height;
      }
      if (req.response_format !== undefined) {
        body.response_format = req.response_format;
      }
      if (req.seed !== undefined) body.seed = req.seed;
      if (req.negativePrompt !== undefined) {
        body.negative_prompt = req.negativePrompt;
      }
      return { provider, path: "/nebius/v1/images/generations", body };
    }
    case "together": {
      const body: Record<string, unknown> = { prompt: req.prompt, model };
      if (req.size !== undefined) body.size = req.size;
      if (req.n !== undefined) body.n = req.n;
      if (req.response_format !== undefined) {
        // together spells inline delivery "base64", not "b64_json".
        body.response_format = req.response_format === "b64_json"
          ? "base64"
          : req.response_format;
      }
      return { provider, path: "/together/v1/images/generations", body };
    }
    default:
      throw new ProviderError(
        400,
        "Bad Request",
        `unsupported inference provider for image generation: ${provider}`,
      );
  }
}

/** Base64-encodes raw bytes (chunked so large images don't blow the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Maps a provider image response to the canonical shape. hf-inference returns
 * raw image bytes (pass the `Uint8Array`); fal-ai wraps `{images: [...]}`;
 * nebius/together are already OpenAI-shaped `{data: [...]}`.
 */
export function mapHfImageResponse(
  provider: string,
  payload: unknown,
): ImageGenerationResponse {
  const created = Math.floor(Date.now() / 1000);
  if (provider === "hf-inference") {
    return {
      created,
      data: [{ b64_json: bytesToBase64(payload as Uint8Array) }],
    };
  }
  const images = provider === "fal-ai"
    ? (payload as { images?: unknown[] }).images
    : (payload as { data?: unknown[] }).data;
  return {
    created,
    data: (images ?? []).map((img) => {
      const { url, b64_json } = img as { url?: string; b64_json?: string };
      return {
        ...(url !== undefined ? { url } : {}),
        ...(b64_json !== undefined ? { b64_json } : {}),
      };
    }),
  };
}

/**
 * Guards the TTS second-GET against SSRF. The audio URL comes from the
 * upstream (federated, third-party) response, so a malicious model/provider
 * could return `http://169.254.169.254/...` or a loopback/private address and
 * have the gateway fetch it unauthenticated and stream the body back. Require
 * https and reject any host that resolves to a literal loopback, link-local,
 * or private address (or the well-known metadata hostnames). Callers must also
 * pass `redirect: "manual"` so a 3xx to a blocked host cannot bypass this.
 */
export function assertSafeAudioUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(502, "Bad Gateway", "invalid upstream audio URL");
  }
  if (url.protocol !== "https:") {
    throw new ProviderError(
      502,
      "Bad Gateway",
      `refusing non-https upstream audio URL: ${url.protocol}`,
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":") || !/[a-z]/.test(host)) {
    throw new ProviderError(
      502,
      "Bad Gateway",
      "refusing IP-literal upstream audio host",
    );
  }
  // Named hosts that resolve to internal endpoints.
  if (
    host === "localhost" || host.endsWith(".localhost") ||
    host === "metadata.google.internal"
  ) {
    throw new ProviderError(502, "Bad Gateway", "blocked upstream audio host");
  }
  // Residual (documented): a public DNS name that resolves to an internal
  // address is not caught here (the check is on the host string, not the
  // resolved IP); https + TLS certificate validation blunts response exfil.
  return url;
}

/**
 * True when an IP address string is in a range the gateway must never fetch:
 * loopback, RFC1918 private, link-local (169.254/16 cloud metadata), CGNAT
 * (100.64/10 — Alibaba metadata lives here), benchmarking (198.18/15), and the
 * IPv6 loopback / link-local / unique-local ranges. IPv4-mapped/compat IPv6
 * (`::ffff:a.b.c.d` in dotted or hex form) is unwrapped and re-checked as IPv4.
 * This is the resolved-address check behind the DNS-rebind guard.
 */
export function isBlockedIp(ip: string): boolean {
  let host = ip.toLowerCase().replace(/%.*$/, "").replace(/^\[|\]$/g, "");
  const v4FromHextets = (hi: number, lo: number) =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const dotted = host.match(
    /(?:^::(?:ffff:)?|^64:ff9b::(?:ffff:)?)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (dotted) host = dotted[1];
  const hex = host.match(
    /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (hex) host = v4FromHextets(parseInt(hex[1], 16), parseInt(hex[2], 16));
  const sixToFour = host.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) {
    host = v4FromHextets(
      parseInt(sixToFour[1], 16),
      parseInt(sixToFour[2], 16),
    );
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (host === "::1" || host === "::") return true;
  if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(host)) return true; // unique-local fc00::/7
  return false;
}

/** DNS resolver seam (defaults to Deno.resolveDns; injectable for tests). */
export type DnsResolver = (
  host: string,
  recordType: "A" | "AAAA",
) => Promise<string[]>;

const defaultDnsResolver: DnsResolver = (host, recordType) =>
  Deno.resolveDns(host, recordType);

/** Go-parity content-type normalization for raw audio uploads. */
function normalizeAudioContentType(contentType: string): string {
  if (!contentType) return "audio/mpeg";
  const t = contentType.trim().toLowerCase();
  if (t.startsWith("audio/")) {
    return t === "audio/mp3" ? "audio/mpeg" : t;
  }
  return "audio/mpeg";
}

export class HuggingFaceAdapter implements IProviderAdapter {
  /** OpenAI-wire router surface (/v1): chat, completions, embeddings, ... */
  private inner: OpenAIAdapter;

  /**
   * One transport for every surface: the shared provider client. The audio paths
   * used to take a separate bare `fetchImpl`, which meant they had no
   * establishment timeout at all - a router that accepted the connection and
   * never answered held a media in-flight reservation with nothing to reclaim it.
   * Tests inject at the client (`new ProviderClient(opts, fetchImpl)`) so the real
   * transport is what they exercise.
   */
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://router.huggingface.co/v1",
    private client: ProviderClient = new ProviderClient(),
    /** DNS resolver for the TTS SSRF guard; injectable for tests. */
    private resolveDnsImpl: DnsResolver = defaultDnsResolver,
  ) {
    this.baseUrl = this.baseUrl.replace(/\/$/, "");
    this.inner = new OpenAIAdapter(this.apiKey, this.baseUrl, this.client);
  }

  /** Native router base: the OpenAI-compatible base with `/v1` stripped. */
  private nativeBase(): string {
    return this.baseUrl.replace(/\/v1\/?$/, "");
  }

  /**
   * DNS-rebind guard for the TTS second-GET: resolve the (already IP-literal-
   * rejected) host and refuse if any resolved A/AAAA address is in a blocked
   * range, or if it cannot be resolved at all (fail-closed). Residual TOCTOU:
   * the address could change between this check and the fetch; https + TLS
   * certificate validation blunts response exfiltration in that window.
   */
  private async assertResolvedHostSafe(hostname: string): Promise<void> {
    const ips: string[] = [];
    for (const recordType of ["A", "AAAA"] as const) {
      try {
        ips.push(...await this.resolveDnsImpl(hostname, recordType));
      } catch {
        // NXDOMAIN for one record family is normal; keep the other.
      }
    }
    if (ips.length === 0) {
      throw new ProviderError(
        502,
        "Bad Gateway",
        "cannot resolve upstream audio host",
      );
    }
    for (const ip of ips) {
      if (isBlockedIp(ip)) {
        throw new ProviderError(
          502,
          "Bad Gateway",
          "upstream audio host resolves to a blocked address",
        );
      }
    }
  }

  chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    return this.inner.chatCompletions(req, context);
  }

  completions(
    req: CompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    return this.inner.completions(req, context);
  }

  embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    return this.inner.embeddings(req, context);
  }

  listModels(context?: ProviderContext): Promise<string[]> {
    return this.inner.listModels(context);
  }

  countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    return this.inner.countTokens(req, context);
  }

  /**
   * Native image generation on the router (no /v1). The model id selects the
   * inference provider branch; hf-inference answers with raw image bytes,
   * every other branch with provider-shaped JSON.
   */
  async generateImage(
    req: ImageGenerationRequest,
    context?: ProviderContext,
  ): Promise<ImageGenerationResponse> {
    const call = buildHfImageRequest(req);
    // fetchGuarded: an image render is paid work, so a retried 429/5xx is spend
    // the caller never asked for (gemini.generateImage precedent).
    const response = await this.client.fetchGuarded(
      `${this.nativeBase()}${call.path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(call.body),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    if (call.provider === "hf-inference") {
      return mapHfImageResponse(
        call.provider,
        new Uint8Array(await response.arrayBuffer()),
      );
    }
    return mapHfImageResponse(call.provider, await response.json());
  }

  /**
   * Audio endpoints are translated to the native router wire; every other
   * path keeps the wrapped adapter's OpenAI-wire passthrough (today's
   * behavior, unchanged). No retry on any branch.
   */
  rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/audio/speech") {
      return this.speech(req, context);
    }
    if (path === "/audio/transcriptions") {
      return this.transcribe(req, context);
    }
    return this.inner.rawProxy(path, req, context);
  }

  /**
   * TTS via the hf-inference text-to-speech pipeline. The pipeline answers
   * with an envelope pointing at a hosted audio URL, which is fetched with a
   * second, unauthenticated GET (Go parity) and streamed back with the
   * envelope's content type (fallback audio/mpeg).
   */
  private async speech(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const body = await req.json() as { model: string; input: string };
    const { provider, model } = splitModelProvider(body.model);
    if (provider !== "hf-inference") {
      throw new ProviderError(
        400,
        "Bad Request",
        `unsupported inference provider for speech: ${provider}`,
      );
    }
    const response = await this.client.fetchGuarded(
      `${this.nativeBase()}/hf-inference/models/${model}/pipeline/text-to-speech`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ text: body.input, provider, model }),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const envelope = await response.json() as {
      audio?: { url?: string; content_type?: string };
    };
    const audioUrl = envelope.audio?.url;
    if (!audioUrl) {
      throw new ProviderError(
        502,
        "Bad Gateway",
        "huggingface speech response did not include an audio URL",
      );
    }
    const safeUrl = assertSafeAudioUrl(audioUrl);
    await this.assertResolvedHostSafe(safeUrl.hostname);
    const audio = await this.client.fetchGuarded(safeUrl.toString(), {
      signal: context?.signal,
      redirect: "manual",
    });
    if (!audio.ok) {
      const text = await audio.text();
      throw new ProviderError(audio.status, audio.statusText, text);
    }
    return new Response(audio.body, {
      status: 200,
      headers: {
        "Content-Type": envelope.audio?.content_type || "audio/mpeg",
      },
    });
  }

  /**
   * STT. hf-inference takes the raw audio bytes as the request body with a
   * sniffed Content-Type; fal-ai takes a base64 data-URI (and rejects WAV).
   * The `{text, chunks}` reply is mapped to OpenAI `{text, segments}`.
   */
  private async transcribe(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new ProviderError(
        400,
        "Bad Request",
        "transcription requires a `file` form field",
      );
    }
    const modelField = form.get("model");
    const { provider, model } = splitModelProvider(
      typeof modelField === "string" ? modelField : "",
    );
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      throw new ProviderError(
        400,
        "Bad Request",
        "transcription request audio file cannot be empty",
      );
    }
    const contentType = normalizeAudioContentType(detectAudioMimeType(bytes));

    let response: Response;
    if (provider === "hf-inference") {
      response = await this.client.fetchGuarded(
        `${this.nativeBase()}/hf-inference/models/${model}`,
        {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "Authorization": `Bearer ${this.apiKey}`,
          },
          body: bytes,
          signal: context?.signal,
        },
      );
    } else if (provider === "fal-ai") {
      if (contentType === "audio/wav") {
        throw new ProviderError(
          400,
          "Bad Request",
          "fal-ai provider does not support audio/wav format; please use a " +
            "different format like mp3 or ogg",
        );
      }
      response = await this.client.fetchGuarded(
        `${this.nativeBase()}/fal-ai/${model}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            audio_url: `data:${contentType};base64,${bytesToBase64(bytes)}`,
          }),
          signal: context?.signal,
        },
      );
    } else {
      throw new ProviderError(
        400,
        "Bad Request",
        `unsupported inference provider for transcription: ${provider}`,
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const payload = await response.json() as {
      text?: string;
      chunks?: Array<{ text?: string; timestamp?: number[] }>;
    };
    const out: {
      text: string;
      segments?: Array<
        { id: number; start: number; end: number; text: string }
      >;
    } = { text: payload.text ?? "" };
    if (payload.chunks?.length) {
      const segments: NonNullable<typeof out.segments> = [];
      for (const chunk of payload.chunks) {
        // A segment needs a [start, end] pair; chunks without one are dropped.
        if (!chunk.timestamp || chunk.timestamp.length < 2) continue;
        segments.push({
          id: segments.length,
          start: chunk.timestamp[0],
          end: chunk.timestamp[1],
          text: chunk.text ?? "",
        });
      }
      if (segments.length > 0) {
        out.segments = segments;
      }
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
