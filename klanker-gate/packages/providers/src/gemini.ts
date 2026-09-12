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
import { detectAudioMimeType, pcmToWav } from "./audio.ts";
import {
  bareResourceId,
  buildBatchCreateBody,
  decodeBase64ToBytes,
  encodeBytesToBase64,
  GEMINI_BATCH_ACTIVE_STATES,
  type GeminiBatchJob,
  type GeminiBatchResultLine,
  type GeminiFile,
  type GeminiGenerateContentResponse,
  mapBatchResultLine,
  mapGeminiBatch,
  mapGeminiFile,
  qualifyResourceId,
} from "./gemini_advanced.ts";

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

/** Throws the frosty ProviderError convention for a non-OK upstream reply. */
async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(response.status, response.statusText, text);
  }
}

function jsonBody(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Gemini through Google's OpenAI-compatible endpoint. */
export class GeminiAdapter implements IProviderAdapter {
  constructor(
    private apiKey: string,
    private baseUrl: string =
      "https://generativelanguage.googleapis.com/v1beta/openai",
    private client: ProviderClient = new ProviderClient(),
  ) {}

  async chatCompletions(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(req),
        signal: context?.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new ProviderError(response.status, response.statusText, body);
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

  /**
   * Embeddings via Google's OpenAI-compatible /embeddings surface. The body
   * and response are already OpenAI-shaped, so this forwards verbatim (the
   * same contract as OpenAIAdapter.embeddings).
   */
  async embeddings(req: unknown, context?: ProviderContext): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(req),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }

  /**
   * Native image generation via Google Imagen. The OpenAI-compat base
   * (".../v1beta/openai") is reduced to the native base (".../v1beta") — the
   * same derivation as countTokens — and the model's `:predict` verb is called
   * with the API key in x-goog-api-key. The OpenAI-shaped request is mapped to
   * Imagen instances/parameters and the base64 predictions to `b64_json`.
   */
  async generateImage(
    req: ImageGenerationRequest,
    context?: ProviderContext,
  ): Promise<ImageGenerationResponse> {
    const nativeBase = this.baseUrl.replace(/\/openai\/?$/, "");
    const model = resolveImagenModel(req.model);
    // fetchGuarded: an image render is paid work, so a retried 429/5xx is spend
    // the caller never asked for.
    const response = await this.client.fetchGuarded(
      `${nativeBase}/models/${encodeURIComponent(model)}:predict`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(buildImagenPredictBody(req)),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as { predictions?: ImagenPrediction[] };
    return mapImagenResponse(body.predictions ?? []);
  }

  /**
   * Native token pre-flight via the generativelanguage models:countTokens
   * endpoint. The OpenAI-compat base (".../v1beta/openai") is reduced to the
   * native base (".../v1beta"); auth is the API key in x-goog-api-key.
   */
  async countTokens(
    req: ChatCompletionRequest,
    context?: ProviderContext,
  ): Promise<{ input_tokens: number; estimated: boolean }> {
    const nativeBase = this.baseUrl.replace(/\/openai\/?$/, "");
    const model = req.model.replace(/^models\//, "");
    const contents = req.messages
      .filter((m) => m.role !== "function")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: contentText(m.content) }],
      }));
    const response = await this.client.fetchWithRetry(
      `${nativeBase}/models/${encodeURIComponent(model)}:countTokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({ contents }),
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    const body = await response.json() as { totalTokens?: number };
    return { input_tokens: body.totalTokens ?? 0, estimated: false };
  }

  /**
   * Translating passthrough for the native (non-OpenAI-compat) Gemini
   * surfaces: /audio/speech and /audio/transcriptions ride models/*:
   * generateContent, /files* the Files API (plain multipart upload — no
   * resumable protocol), /batches* the Batch API. Auth is x-goog-api-key on
   * the native base (the ElevenLabs translation precedent).
   */
  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/audio/speech") {
      return await this.speech(req, context);
    }
    if (path === "/audio/transcriptions") {
      return await this.transcribe(req, context);
    }
    if (path === "/files" || path.startsWith("/files/")) {
      return await this.filesProxy(path, req, context);
    }
    if (path === "/batches" || path.startsWith("/batches/")) {
      return await this.batchesProxy(path, req, context);
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `Gemini passthrough supports /audio/*, /files* and /batches* only, ` +
        `got "${path}".`,
    );
  }

  /** Native base per the generateImage/countTokens derivation. */
  private nativeBase(): string {
    return this.baseUrl.replace(/\/openai\/?$/, "");
  }

  private nativeHeaders(json: boolean): Record<string, string> {
    return json
      ? { "Content-Type": "application/json", "x-goog-api-key": this.apiKey }
      : { "x-goog-api-key": this.apiKey };
  }

  /**
   * TTS via generateContent with responseModalities AUDIO. Gemini returns raw
   * PCM (s16le, 24 kHz, mono); by default (and for response_format "wav")
   * it is wrapped in a RIFF/WAVE container so the reply is self-describing —
   * "pcm" returns the raw bytes. Anything else is a 400.
   */
  private async speech(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const body = await req.json() as {
      model?: string;
      input?: string;
      voice?: string;
      response_format?: string;
    };
    const format = body.response_format;
    if (format && format !== "wav" && format !== "pcm") {
      throw new ProviderError(
        400,
        "Bad Request",
        `gemini supports only wav/pcm response_format, got "${format}".`,
      );
    }
    const model = (body.model ?? "").replace(/^models\//, "");
    const generationConfig: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
    };
    if (body.voice) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: body.voice } },
      };
    }
    // fetchGuarded: synthesising speech is paid work, so a retried 429/5xx is
    // spend the caller never asked for.
    const response = await this.client.fetchGuarded(
      `${this.nativeBase()}/models/${encodeURIComponent(model)}` +
        `:generateContent`,
      {
        method: "POST",
        headers: this.nativeHeaders(true),
        body: JSON.stringify({
          contents: [{ parts: [{ text: body.input ?? "" }] }],
          generationConfig,
        }),
        signal: context?.signal,
      },
    );
    await ensureOk(response);
    const result = await response.json() as GeminiGenerateContentResponse;
    // Gemini TTS is token-priced while OpenAI TTS is character-priced, and this
    // reply is audio bytes - no JSON body an accounting site could sniff. Report
    // the usage block rather than dropping it; the route bounds the numbers.
    const reported = result.usageMetadata;
    if (reported && context?.onUsage) {
      context.onUsage({
        prompt: reported.promptTokenCount,
        completion: reported.candidatesTokenCount,
        total: reported.totalTokenCount,
      });
    }
    const chunks: Uint8Array[] = [];
    for (const part of result.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && (inline.mimeType ?? "").startsWith("audio/")) {
        chunks.push(decodeBase64ToBytes(inline.data));
      }
    }
    const pcm = concatBytes(chunks);
    if (format === "pcm") {
      return new Response(pcm, { headers: { "Content-Type": "audio/pcm" } });
    }
    // pcmToWav's declared Uint8Array is ArrayBuffer-backed (fresh allocation);
    // the assertion just narrows it to what BodyInit requires.
    return new Response(pcmToWav(pcm) as Uint8Array<ArrayBuffer>, {
      headers: { "Content-Type": "audio/wav" },
    });
  }

  /**
   * STT via generateContent: the multipart file is inlined (sniffed MIME +
   * base64) after the prompt part, and the reply is mapped to the OpenAI
   * transcription JSON shape.
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
        "gemini transcription requires a multipart `file` field.",
      );
    }
    const model = String(form.get("model") ?? "").replace(/^models\//, "");
    if (!model) {
      throw new ProviderError(
        400,
        "Bad Request",
        "gemini transcription requires a `model` field.",
      );
    }
    const promptField = form.get("prompt");
    const prompt = typeof promptField === "string" && promptField !== ""
      ? promptField
      : "Generate a transcript of the speech.";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    if (bytes.length > 0) {
      parts.push({
        inlineData: {
          mimeType: detectAudioMimeType(bytes),
          data: encodeBytesToBase64(bytes),
        },
      });
    }
    // fetchGuarded: transcription is paid work, and the inlined audio makes a
    // retry an expensive re-upload as well as unrequested spend.
    const response = await this.client.fetchGuarded(
      `${this.nativeBase()}/models/${encodeURIComponent(model)}` +
        `:generateContent`,
      {
        method: "POST",
        headers: this.nativeHeaders(true),
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: context?.signal,
      },
    );
    await ensureOk(response);
    const result = await response.json() as GeminiGenerateContentResponse;
    const text = (result.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    const out: Record<string, unknown> = { text };
    if (text !== "") {
      out.task = "transcribe";
      const usage = result.usageMetadata;
      out.usage = {
        type: "tokens",
        input_tokens: usage?.promptTokenCount ?? 0,
        output_tokens: usage?.candidatesTokenCount ?? 0,
        total_tokens: usage?.totalTokenCount ?? 0,
      };
    }
    return jsonBody(out);
  }

  private async filesProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const method = req.method.toUpperCase();
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 3 && segments[2] === "content") {
      // Go-exact behavior: the consumer Files API has no download endpoint.
      throw new ProviderError(
        400,
        "Bad Request",
        "Gemini Files API doesn't support direct content download. " +
          "Use the file URI in your requests instead.",
      );
    }
    if (segments.length === 1 && method === "POST") {
      return await this.uploadFile(req, context);
    }
    if (segments.length === 1 && method === "GET") {
      return await this.listFiles(req, context);
    }
    if (segments.length === 2 && method === "GET") {
      return await this.retrieveFile(segments[1], context);
    }
    if (segments.length === 2 && method === "DELETE") {
      return await this.deleteFile(segments[1], context);
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `unsupported gemini files operation: ${method} ${path}`,
    );
  }

  private async uploadFile(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new ProviderError(
        400,
        "Bad Request",
        "gemini file upload requires a multipart `file` field.",
      );
    }
    const purpose = String(form.get("purpose") ?? "");
    const filename = file instanceof File ? file.name : "";
    // Plain multipart (no resumable protocol, no X-Goog-Upload-* headers):
    // a `metadata` JSON field naming the display name, then the raw bytes.
    const upload = new FormData();
    upload.append(
      "metadata",
      JSON.stringify({
        file: { displayName: filename },
      }),
    );
    upload.append("file", file, filename || "file.bin");
    const uploadBase = this.nativeBase().replace("/v1beta", "/upload/v1beta");
    const response = await this.client.fetchWithRetry(`${uploadBase}/files`, {
      method: "POST",
      headers: this.nativeHeaders(false),
      body: upload,
      signal: context?.signal,
    });
    await ensureOk(response);
    // Upload responses are wrapped in {"file": {...}}; get/list are not.
    const wrapper = await response.json() as { file?: GeminiFile };
    return jsonBody(mapGeminiFile(wrapper.file ?? {}, purpose));
  }

  private async listFiles(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/files${listQuery(req)}`,
      { headers: this.nativeHeaders(false), signal: context?.signal },
    );
    await ensureOk(response);
    const body = await response.json() as {
      files?: GeminiFile[];
      nextPageToken?: string;
    };
    const out: Record<string, unknown> = {
      object: "list",
      data: (body.files ?? []).map((f) => mapGeminiFile(f, "vision")),
      has_more: !!body.nextPageToken,
    };
    if (body.nextPageToken) out.last_id = body.nextPageToken;
    return jsonBody(out);
  }

  private async retrieveFile(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/${qualifyResourceId(id, "files/")}`,
      { headers: this.nativeHeaders(false), signal: context?.signal },
    );
    await ensureOk(response);
    const file = await response.json() as GeminiFile;
    return jsonBody(mapGeminiFile(file, "vision"));
  }

  private async deleteFile(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/${qualifyResourceId(id, "files/")}`,
      {
        method: "DELETE",
        headers: this.nativeHeaders(false),
        signal: context?.signal,
      },
    );
    await ensureOk(response);
    await response.body?.cancel();
    return jsonBody({
      id: bareResourceId(id, "files/"),
      object: "file",
      deleted: true,
    });
  }

  private async batchesProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const method = req.method.toUpperCase();
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.length === 1 && method === "POST") {
      return await this.createBatch(req, context);
    }
    if (segments.length === 1 && method === "GET") {
      return await this.listBatches(req, context);
    }
    if (segments.length === 2 && method === "GET") {
      return await this.retrieveBatch(segments[1], context);
    }
    if (
      segments.length === 3 && segments[2] === "cancel" && method === "POST"
    ) {
      return await this.cancelBatch(segments[1], context);
    }
    if (
      segments.length === 3 && segments[2] === "results" && method === "GET"
    ) {
      return await this.batchResults(segments[1], context);
    }
    throw new ProviderError(
      400,
      "Bad Request",
      `unsupported gemini batches operation: ${method} ${path}`,
    );
  }

  private async createBatch(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const raw = await req.json();
    const { model, payload } = buildBatchCreateBody(raw);
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/models/${
        encodeURIComponent(model.replace(/^models\//, ""))
      }:batchGenerateContent`,
      {
        method: "POST",
        headers: this.nativeHeaders(true),
        body: JSON.stringify(payload),
        signal: context?.signal,
      },
    );
    await ensureOk(response);
    const job = await response.json() as GeminiBatchJob;
    const body = raw as { input_file_id?: unknown; endpoint?: unknown };
    return jsonBody(mapGeminiBatch(job, {
      inputFileId: typeof body.input_file_id === "string"
        ? body.input_file_id
        : undefined,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
    }));
  }

  private async listBatches(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/batches${listQuery(req)}`,
      { headers: this.nativeHeaders(false), signal: context?.signal },
    );
    // Batch listing may be unavailable on the consumer API: an empty list is
    // the documented reply for 404/405, not an error (Go parity).
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel();
      return jsonBody({ object: "list", data: [] });
    }
    await ensureOk(response);
    const body = await response.json() as {
      operations?: GeminiBatchJob[];
      nextPageToken?: string;
    };
    const out: Record<string, unknown> = {
      object: "list",
      data: (body.operations ?? []).map((op) => mapGeminiBatch(op)),
      has_more: !!body.nextPageToken,
    };
    if (body.nextPageToken) out.last_id = body.nextPageToken;
    return jsonBody(out);
  }

  /** Raw native batch job fetch shared by retrieve and results. */
  private async fetchBatchJob(
    id: string,
    context?: ProviderContext,
  ): Promise<GeminiBatchJob> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/${qualifyResourceId(id, "batches/")}`,
      { headers: this.nativeHeaders(false), signal: context?.signal },
    );
    await ensureOk(response);
    return await response.json() as GeminiBatchJob;
  }

  private async retrieveBatch(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    return jsonBody(mapGeminiBatch(await this.fetchBatchJob(id, context)));
  }

  private async cancelBatch(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const response = await this.client.fetchWithRetry(
      `${this.nativeBase()}/${qualifyResourceId(id, "batches/")}:cancel`,
      {
        method: "POST",
        headers: this.nativeHeaders(true),
        signal: context?.signal,
      },
    );
    await ensureOk(response);
    await response.body?.cancel();
    return jsonBody({
      id: bareResourceId(id, "batches/"),
      object: "batch",
      status: "cancelling",
      cancelling_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Batch results as OpenAI-style output JSONL. File-based jobs download the
   * results file from the /download base with :download?alt=media; inline
   * jobs map dest.inlinedResponses directly.
   */
  private async batchResults(
    id: string,
    context?: ProviderContext,
  ): Promise<Response> {
    const job = await this.fetchBatchJob(id, context);
    const state = job.metadata?.state ?? "";
    if ((GEMINI_BATCH_ACTIVE_STATES as readonly string[]).includes(state)) {
      throw new ProviderError(
        400,
        "Bad Request",
        `batch ${id} is still processing (state: ${state}), ` +
          `results not yet available`,
      );
    }
    const lines: Array<Record<string, unknown>> = [];
    if (job.dest?.fileName) {
      const downloadBase = this.nativeBase().replace(
        "/v1beta",
        "/download/v1beta",
      );
      const download = await this.client.fetchWithRetry(
        `${downloadBase}/${qualifyResourceId(job.dest.fileName, "files/")}` +
          `:download?alt=media`,
        { headers: this.nativeHeaders(false), signal: context?.signal },
      );
      await ensureOk(download);
      for (const line of (await download.text()).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: GeminiBatchResultLine;
        try {
          parsed = JSON.parse(trimmed) as GeminiBatchResultLine;
        } catch {
          continue; // Go skips (and only logs) unparseable result lines.
        }
        lines.push(mapBatchResultLine(parsed, lines.length));
      }
    } else if (job.dest?.inlinedResponses?.length) {
      job.dest.inlinedResponses.forEach((entry, i) => {
        lines.push(mapBatchResultLine(entry, i));
      });
    }
    if (
      lines.length === 0 &&
      (state === "BATCH_STATE_SUCCEEDED" || state === "BATCH_STATE_FAILED")
    ) {
      lines.push({
        custom_id: "info",
        response: {
          status_code: 200,
          body: {
            message:
              `Batch completed with state: ${state}. No results available.`,
          },
        },
      });
    }
    const body = lines.map((l) => JSON.stringify(l)).join("\n");
    return new Response(lines.length > 0 ? `${body}\n` : body, {
      headers: { "Content-Type": "application/jsonl" },
    });
  }
}

/** Maps the gateway's ?limit=/&after= list params to pageSize/pageToken. */
function listQuery(req: Request): string {
  const params = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  const limit = params.get("limit");
  if (limit) query.set("pageSize", limit);
  const after = params.get("after");
  if (after) query.set("pageToken", after);
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}
