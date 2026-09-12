import type { ChatCompletionRequest } from "../../contracts/src/mod.ts";
import type { IProviderAdapter, ProviderContext } from "./types.ts";
import { ProviderClient, ProviderError } from "./client.ts";

// ElevenLabs: text-to-speech only. The gateway's OpenAI-style
// POST /v1/audio/speech body is translated to the ElevenLabs wire
// (voice in the URL, text/model_id in the body, xi-api-key auth).

/** OpenAI response_format -> ElevenLabs output_format. Values ElevenLabs
 * does not know are omitted rather than forwarded verbatim. */
const OUTPUT_FORMATS: Record<string, string> = {
  mp3: "mp3_44100_128",
  opus: "opus_48000_128",
  pcm: "pcm_44100",
  wav: "pcm_44100",
};

export class ElevenLabsAdapter implements IProviderAdapter {
  /**
   * The shared provider client, as every other adapter takes it. It used to be a
   * bare `fetchImpl`, which the manager satisfied with `client.fetch` - i.e.
   * {@link ProviderClient.fetchWithRetry} - so one caller request cost up to four
   * paid ElevenLabs renders. Both surfaces here now use `fetchGuarded`: same
   * proxy/CA wiring and establishment timeout, no retry.
   */
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.elevenlabs.io",
    private client: ProviderClient = new ProviderClient(),
  ) {
    this.baseUrl = this.baseUrl.replace(/\/$/, "");
  }

  chatCompletions(
    _req: ChatCompletionRequest,
    _context?: ProviderContext,
  ): Promise<Response> {
    return Promise.reject(
      new ProviderError(
        400,
        "Bad Request",
        "ElevenLabs is a speech provider; it has no chat surface.",
      ),
    );
  }

  async rawProxy(
    path: string,
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    if (path === "/audio/transcriptions") {
      return await this.transcribe(req, context);
    }
    if (path !== "/audio/speech") {
      throw new ProviderError(
        400,
        "Bad Request",
        `ElevenLabs passthrough supports /audio/speech and ` +
          `/audio/transcriptions only, got "${path}".`,
      );
    }
    const body = await req.json() as {
      model: string;
      input: string;
      voice?: string;
      response_format?: string;
    };
    if (!body.voice) {
      throw new ProviderError(
        400,
        "Bad Request",
        "ElevenLabs speech requires a voice id in the `voice` field.",
      );
    }
    const outputFormat = body.response_format
      ? OUTPUT_FORMATS[body.response_format]
      : undefined;
    const query = outputFormat ? `?output_format=${outputFormat}` : "";
    const response = await this.client.fetchGuarded(
      `${this.baseUrl}/v1/text-to-speech/${
        encodeURIComponent(body.voice)
      }${query}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify({ text: body.input, model_id: body.model }),
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
   * Scribe speech-to-text. The incoming multipart body (file, model_id, …) is
   * streamed through verbatim to /v1/speech-to-text with xi-api-key auth; the
   * caller-supplied Content-Type carries the multipart boundary. No retry,
   * since multipart bodies are not replayable.
   */
  private async transcribe(
    req: Request,
    context?: ProviderContext,
  ): Promise<Response> {
    const headers = new Headers();
    const contentType = req.headers.get("Content-Type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    headers.set("xi-api-key", this.apiKey);
    const response = await this.client.fetchGuarded(
      `${this.baseUrl}/v1/speech-to-text`,
      {
        method: "POST",
        headers,
        body: req.body,
        signal: context?.signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(response.status, response.statusText, text);
    }
    return response;
  }
}
