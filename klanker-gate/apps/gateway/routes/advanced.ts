import {
  EmbeddingRequestSchema,
  type ImageGenerationRequest,
  ImageGenerationRequestSchema,
  MAX_IMAGE_N,
  MAX_MEDIA_INFLIGHT_BYTES,
  MAX_TRANSCRIPTION_JSON_BYTES,
  MEDIA_BYTES_PER_IMAGE,
  type ProviderCapability,
  SpeechRequestSchema,
} from "../../../packages/contracts/src/mod.ts";
import {
  errorResponse,
  GatewayError,
  type Router,
} from "../../../packages/core/src/mod.ts";
import {
  ProviderError,
  type ResolvedTarget,
  targetScope,
} from "../../../packages/providers/src/mod.ts";
import {
  clampCount,
  clampSeconds,
  type CounterSink,
  type MediaUnits,
  mergeRequestStatus,
  mergeRequestTokens,
  mergeRequestUnits,
  normalizeUsage,
  type RequestDispatch,
  setRequestDispatch,
  type UsageShape,
} from "../../../packages/telemetry/src/usage.ts";
import type { AppContext } from "../context.ts";
import {
  dispatchDetached,
  dispatchThenDetach,
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  readCappedBytes,
  rebuild,
  validationErrorResponse,
} from "./helpers.ts";

/** The three media surfaces. Used both to register the routes and to gate the
 * unit readers, so a path change cannot desync the gate from the route. */
const IMAGES_PATH = "/v1/images/generations";
const SPEECH_PATH = "/v1/audio/speech";
const TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";

function requireCapability(
  target: ResolvedTarget,
  capability: keyof ProviderCapability,
  what: string,
): void {
  if (!target.capabilities[capability]) {
    throw new GatewayError(
      400,
      `Provider "${target.providerId}" does not support ${what}.`,
      "invalid_request_error",
    );
  }
}

/** Routes by provider prefix in the model, else default-provider rules. */
function targetFromModel(ctx: AppContext, model: string): ResolvedTarget {
  return ctx.providers.resolve(model);
}

/** Routes multipart/list endpoints by ?provider= or the default provider. */
function targetFromQuery(ctx: AppContext, req: Request): ResolvedTarget {
  const provider = new URL(req.url).searchParams.get("provider");
  const target = provider
    ? ctx.providers.accountTarget(provider)
    : ctx.providers.resolve("");
  // A provider-scoped virtual key must not read files/batches from an
  // out-of-scope account via ?provider= (these data-plane paths carry no model,
  // so only the provider allowlist applies).
  const scope = targetScope.getStore();
  if (scope?.providers && !scope.providers.has(target.providerId)) {
    throw new GatewayError(
      403,
      `Virtual key is not permitted to use provider "${target.providerId}".`,
      "governance_error",
      undefined,
      "provider_not_permitted",
    );
  }
  return target;
}

function jsonForward(path: string, body: unknown): Request {
  return new Request(`http://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requireRawProxy(target: ResolvedTarget) {
  if (!target.adapter.rawProxy) {
    throw new GatewayError(
      400,
      `Provider "${target.providerId}" has no passthrough surface for this endpoint.`,
      "invalid_request_error",
    );
  }
  return target.adapter.rawProxy.bind(target.adapter);
}

// ---------------------------------------------------------------------------
// Media accounting: the in-flight byte budget, the quantity readers, and the
// one dispatcher that writes the channel.

/**
 * Bytes reserved across every media body read in flight in THIS process.
 * Reserved pessimistically at the per-response cap before the provider is
 * dispatched to, and held until the read finishes, so a mid-read crossing is
 * structurally impossible. Because the hold spans the provider's generation
 * latency it is also the media path's only concurrency bound.
 */
let mediaInflightBytes = 0;

/**
 * Bytes currently reserved. Nothing in production reads this; it exists so the
 * `finally` release is observable, since a reservation that leaks on one exit
 * path degrades into a permanent 429 and nothing else would show it.
 */
export function mediaInflightReserved(): number {
  return mediaInflightBytes;
}

type MediaReservation =
  | { ok: true; bytes: number }
  | { ok: false; response: Response };

/**
 * Bytes ONE response on this surface may be buffered into, which is also the
 * reservation it takes. Zero means the surface is not buffered at all: a TTS
 * reply streams straight through, so it needs no cap and takes no reservation.
 *
 * `sampleCount` before `n`, matching `imagen.ts`. `Math.min` is defence in
 * depth, not the bound - the bound is the schema's `.max(MAX_IMAGE_N)`, which
 * every caller of this function has already applied.
 */
function mediaReservationBytes(
  pathname: string,
  body?: ImageGenerationRequest,
): number {
  if (pathname === IMAGES_PATH) {
    const requested = clampCount(body?.sampleCount ?? body?.n ?? 1) || 1;
    return Math.min(requested, MAX_IMAGE_N) * MEDIA_BYTES_PER_IMAGE;
  }
  if (pathname === TRANSCRIPTIONS_PATH) {
    return MAX_TRANSCRIPTION_JSON_BYTES;
  }
  return 0;
}

/**
 * Takes `bytes` from the process budget, or refuses with the house 429. The
 * refusal happens before the provider is reached, so nothing was spent and
 * there is nothing to bill. Fail-closed: over budget denies.
 */
function reserveMediaInflight(
  bytes: number,
  counters: CounterSink,
): MediaReservation {
  if (bytes <= 0) {
    return { ok: true, bytes: 0 };
  }
  if (mediaInflightBytes + bytes > MAX_MEDIA_INFLIGHT_BYTES) {
    counters.increment("media.inflight_rejected");
    const response = errorResponse(
      429,
      "Too many concurrent media responses in flight; retry.",
      "governance_error",
      undefined,
      "media_inflight",
    );
    // Set in place, as the governance rate-limit denial does. A rebuild would
    // mint a second Response for a header the first one can already carry.
    response.headers.set("Retry-After", "1");
    return { ok: false, response };
  }
  mediaInflightBytes += bytes;
  return { ok: true, bytes };
}

/** Releases a reservation. Runs in a `finally`, so every exit path - return,
 * abort, throw, and the over-cap read - gives the bytes back. */
function releaseMediaInflight(reservation: MediaReservation): void {
  if (reservation.ok) {
    mediaInflightBytes -= reservation.bytes;
  }
}

/**
 * Units the provider's parsed body proves it delivered, gated on the PATHNAME
 * and never on the body's shape: `/v1/embeddings` answers with `data: []` too,
 * so a shape-driven count would bill embeddings as images.
 */
export function countUnits(pathname: string, body: unknown): MediaUnits {
  if (pathname === IMAGES_PATH) {
    const data = (body as { data?: unknown } | undefined)?.data;
    return Array.isArray(data) ? { imageCount: clampCount(data.length) } : {};
  }
  if (pathname === TRANSCRIPTIONS_PATH) {
    const parsed = body as
      | { usage?: { seconds?: unknown }; duration?: unknown }
      | undefined;
    // `usage.seconds` first: a body can carry it without carrying `duration`,
    // so taking it first strictly increases the priced population.
    const seconds = clampSeconds(parsed?.usage?.seconds) ??
      clampSeconds(parsed?.duration);
    return seconds === undefined ? {} : { audioSeconds: seconds };
  }
  return {};
}

/**
 * The response body's own token usage, through the one shared normalizer, so a
 * media surface that bills on tokens as well as units is counted from the same
 * parse as its units.
 *
 * An all-zero result is reported as ABSENT rather than as zeros: a body that
 * carries no token fields must not become a billed zero (decision-log 56), and
 * a genuinely zero-token response prices identically either way.
 */
export function tokensFrom(
  body: unknown,
): RequestDispatch["tokens"] | undefined {
  const carrier = body as
    | { usage?: UsageShape; usageMetadata?: UsageShape }
    | undefined;
  const usage = carrier?.usage ?? carrier?.usageMetadata;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const n = normalizeUsage(usage);
  if (n.prompt + n.completion + n.cached + n.cacheCreation === 0) {
    return undefined;
  }
  return {
    prompt: n.prompt,
    completion: n.completion,
    cached: n.cached,
    cacheCreation: n.cacheCreation,
  };
}

/** Parses buffered provider bytes, or undefined when they are not JSON - a
 * transcription can legitimately answer `text`, `srt` or `vtt`. The bytes reach
 * the client either way, so this must never throw. */
function safeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Records the provider's own status, from whichever shape it arrived in, and
 * reports whether a provider was reached at all.
 *
 * `rawProxy` is the single `!ok` authority: it THROWS a ProviderError rather
 * than returning a `!ok` Response, and every `generateImage` adapter does the
 * same. So on a provider error the status arrives as the error, never as
 * `upstream.status`, and a route that read only `upstream.status` would leave a
 * provider 400 indistinguishable from a refused connection - which is exactly
 * the discrimination the write gate depends on.
 *
 * Residual: an adapter that raises ProviderError from its OWN request validation
 * (azure with no deployment, gemini with an unsupported response_format) records
 * a status no provider produced. It cannot cause an over-bill, because no
 * quantity is ever written on this path.
 */
function recordProviderStatus(
  ctx: AppContext,
  req: Request,
  error: unknown,
): boolean {
  if (!(error instanceof ProviderError)) {
    return false;
  }
  if (!mergeRequestStatus(req, error.status)) {
    ctx.metrics.increment("accounting.status_dropped");
  }
  return true;
}

/**
 * Dispatches a buffered media surface and writes the accounting channel.
 *
 * The write gate is the whole point: `units` and `tokens` reach the channel only
 * once the provider's response headers are in hand AND `upstream.ok`. A gate at
 * the read site could not do this - `mapDispatchError` returns a Response
 * carrying the PROVIDER's status, so a provider 400 and a gateway 400 are
 * indistinguishable there, and a refused connection produces no Response at
 * all. This site knows the provider's status exactly, from `upstream.status` on
 * the success path and from the thrown ProviderError otherwise.
 */
async function dispatchBufferedMedia(
  ctx: AppContext,
  req: Request,
  pathname: string,
  target: ResolvedTarget,
  reservationBytes: number,
  dispatch: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const reservation = reserveMediaInflight(reservationBytes, ctx.metrics);
  if (!reservation.ok) {
    return reservation.response;
  }
  let headersSeen = false;
  try {
    setRequestDispatch(
      req,
      { providerId: target.providerId, model: target.model },
      ctx.metrics,
    );
    const upstream = await dispatchThenDetach(req, dispatch);
    headersSeen = true;
    if (!mergeRequestStatus(req, upstream.status)) {
      // A dropped status is a silently unbilled row; keep it observable.
      ctx.metrics.increment("accounting.status_dropped");
    }
    if (!upstream.ok) {
      return upstream; // no units, no tokens: no provider work was delivered
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(upstream.body, reservation.bytes);
    } catch (error) {
      if (error instanceof GatewayError && error.status === 413) {
        // readCappedBytes' 413 describes a REQUEST body. An over-cap PROVIDER
        // response is a provider-contract violation, so it must not reach the
        // client as a client error - and the row stays unbilled (status
        // recorded, no units, no tokens) and counted.
        ctx.metrics.increment("media.body_cap_exceeded");
        return errorResponse(
          502,
          `Provider response exceeded the ${reservation.bytes}-byte buffer ` +
            `limit for this surface.`,
          "provider_error",
          undefined,
          "media_body_cap_exceeded",
        );
      }
      throw error;
    }
    const parsed = safeJson(bytes);
    mergeRequestUnits(req, countUnits(pathname, parsed));
    mergeRequestTokens(req, tokensFrom(parsed));
    // readCappedBytes always merges into a fresh `new Uint8Array(total)`, which
    // is ArrayBuffer-backed; the assertion only narrows it to what BodyInit
    // requires (the same narrowing gemini.ts does for pcmToWav).
    return rebuild(upstream, bytes as Uint8Array<ArrayBuffer>);
  } catch (error) {
    const reached = recordProviderStatus(ctx, req, error);
    if (!headersSeen && !reached && req.signal.aborted) {
      ctx.metrics.increment("media.abort_pre_headers");
    }
    return mapDispatchError(error);
  } finally {
    releaseMediaInflight(reservation);
  }
}

export function registerAdvancedRoutes(router: Router, ctx: AppContext): void {
  router.post("/v1/embeddings", async (req) => {
    const parsed = EmbeddingRequestSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.embeddings");
    try {
      const target = targetFromModel(ctx, parsed.data.model);
      requireCapability(target, "supportsEmbeddings", "embeddings");
      if (!target.adapter.embeddings) {
        throw new GatewayError(
          400,
          `Provider "${target.providerId}" has no embeddings adapter.`,
        );
      }
      return await target.adapter.embeddings(
        { ...parsed.data, model: target.model },
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post(IMAGES_PATH, async (req) => {
    const parsed = ImageGenerationRequestSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.images");
    // True once the native adapter has been called. Scopes the pre-dispatch
    // abort counter below to that branch: the rawProxy branch counts its own
    // inside dispatchBufferedMedia, and mapDispatchError rethrows an AbortError
    // through here, so an unscoped increment would count it twice.
    let nativeDispatched = false;
    try {
      const target = parsed.data.model
        ? targetFromModel(ctx, parsed.data.model)
        : targetFromQuery(ctx, req);
      requireCapability(target, "supportsImages", "image generation");
      const body = parsed.data.model
        ? { ...parsed.data, model: target.model }
        : parsed.data;
      // Native image adapters (e.g. Google Imagen `:predict`) translate the
      // request themselves; OpenAI-wire providers (OpenAI, Nebius) keep the
      // byte-identical rawProxy passthrough.
      if (target.adapter.generateImage) {
        const generate = target.adapter.generateImage.bind(target.adapter);
        setRequestDispatch(
          req,
          { providerId: target.providerId, model: target.model },
          ctx.metrics,
        );
        nativeDispatched = true;
        // dispatchDetached, not dispatchThenDetach: this adapter resolves only
        // after it has read and parsed the provider's whole body, so there is
        // no header boundary here for the route to detach at. Keeping the
        // client's abort live would cancel a render the provider has already
        // performed - the images would be charged and none of them counted.
        const result = await dispatchDetached(
          req,
          (signal) => generate(body, { signal }),
        );
        // Every generateImage adapter throws ProviderError on a non-2xx, so a
        // resolved call IS the evidence a provider was reached and delivered.
        // The typed return cannot carry the exact code, so 200 stands for it.
        // No reservation: the adapter buffers its own JSON, so there is no
        // gateway-side capped read for a reservation to bound.
        mergeRequestStatus(req, 200);
        mergeRequestUnits(req, countUnits(IMAGES_PATH, result));
        mergeRequestTokens(req, tokensFrom(result));
        return jsonResponse(result);
      }
      const proxy = requireRawProxy(target);
      return await dispatchBufferedMedia(
        ctx,
        req,
        IMAGES_PATH,
        target,
        mediaReservationBytes(IMAGES_PATH, parsed.data),
        (signal) =>
          proxy(
            "/images/generations",
            jsonForward("/images/generations", body),
            { signal },
          ),
      );
    } catch (error) {
      // The native generateImage branch dispatches inside this try, and its
      // adapters throw ProviderError on a non-2xx, so this is where that
      // branch's provider status is recovered. dispatchBufferedMedia records
      // its own and never lets a ProviderError escape, so there is no overlap.
      const reached = recordProviderStatus(ctx, req, error);
      if (nativeDispatched && !reached && req.signal.aborted) {
        // The only abort this branch can still throw on is one that had already
        // landed at entry, so no provider was reached and no quantity exists.
        ctx.metrics.increment("media.abort_pre_headers");
      }
      return mapDispatchError(error);
    }
  });

  router.post(SPEECH_PATH, async (req) => {
    const parsed = SpeechRequestSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.speech");
    // Request-side quantity, so it is free and complete before dispatch - but it
    // stays in a LOCAL until the provider's headers prove a provider was
    // reached. Code points, not UTF-16 units: `[...s].length` counts an
    // astral-plane character once.
    const characterCount = clampCount([...parsed.data.input].length);
    // Gemini TTS is token-priced and answers with audio bytes, so its usage
    // block arrives through this callback rather than through a JSON body. The
    // numbers are provider-derived; the route bounds them here.
    let reported: RequestDispatch["tokens"] | undefined;
    const onUsage = (usage: { prompt?: number; completion?: number }): void => {
      reported = {
        prompt: clampCount(usage.prompt),
        completion: clampCount(usage.completion),
        cached: 0,
        cacheCreation: 0,
      };
    };
    let headersSeen = false;
    try {
      const target = targetFromModel(ctx, parsed.data.model);
      requireCapability(target, "supportsAudio", "text-to-speech");
      const proxy = requireRawProxy(target);
      setRequestDispatch(
        req,
        { providerId: target.providerId, model: target.model },
        ctx.metrics,
      );
      const upstream = await dispatchThenDetach(req, (signal) =>
        proxy(
          "/audio/speech",
          jsonForward("/audio/speech", { ...parsed.data, model: target.model }),
          { signal, onUsage },
        ));
      headersSeen = true;
      if (!mergeRequestStatus(req, upstream.status)) {
        ctx.metrics.increment("accounting.status_dropped");
      }
      if (upstream.ok) {
        mergeRequestUnits(req, { characterCount });
        mergeRequestTokens(req, reported);
      }
      // No buffering, no decode, no rebuild, no reservation: the provider's
      // audio stream is returned untouched.
      return upstream;
    } catch (error) {
      const reached = recordProviderStatus(ctx, req, error);
      if (!headersSeen && !reached && req.signal.aborted) {
        ctx.metrics.increment("media.abort_pre_headers");
      }
      return mapDispatchError(error);
    }
  });

  // Multipart passthrough: routed by ?provider= or the default provider.
  router.post(TRANSCRIPTIONS_PATH, async (req) => {
    ctx.metrics.increment("requests.transcriptions");
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsAudio", "transcription");
      const proxy = requireRawProxy(target);
      return await dispatchBufferedMedia(
        ctx,
        req,
        TRANSCRIPTIONS_PATH,
        target,
        mediaReservationBytes(TRANSCRIPTIONS_PATH),
        (signal) => proxy("/audio/transcriptions", req, { signal }),
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/v1/files", async (req) => {
    ctx.metrics.increment("requests.files");
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "file APIs");
      return await requireRawProxy(target)("/files", req, {
        signal: req.signal,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.get("/v1/files", async (req) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "file APIs");
      return await requireRawProxy(target)("/files", req, {
        signal: req.signal,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Retrieve the raw bytes/results of a file (e.g. a batch output_file_id).
  // Registered before /v1/files/:id so the 4-segment path wins its own match.
  router.get("/v1/files/:id/content", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "file APIs");
      return await requireRawProxy(target)(
        `/files/${match.pathname.groups.id}/content`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.get("/v1/files/:id", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "file APIs");
      return await requireRawProxy(target)(
        `/files/${match.pathname.groups.id}`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.delete("/v1/files/:id", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "file APIs");
      return await requireRawProxy(target)(
        `/files/${match.pathname.groups.id}`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/v1/batches", async (req) => {
    ctx.metrics.increment("requests.batches");
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "batch APIs");
      return await requireRawProxy(target)("/batches", req, {
        signal: req.signal,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.get("/v1/batches/:id", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "batch APIs");
      return await requireRawProxy(target)(
        `/batches/${match.pathname.groups.id}`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Provider-specific batch result stream. Keep this before the generic batch
  // retrieval route so `/results` is not mistaken for a batch id.
  router.get("/v1/batches/:id/results", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "batch APIs");
      return await requireRawProxy(target)(
        `/batches/${match.pathname.groups.id}/results`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.get("/v1/batches", async (req) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "batch APIs");
      return await requireRawProxy(target)("/batches", req, {
        signal: req.signal,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/v1/batches/:id/cancel", async (req, match) => {
    try {
      const target = targetFromQuery(ctx, req);
      requireCapability(target, "supportsFiles", "batch APIs");
      return await requireRawProxy(target)(
        `/batches/${match.pathname.groups.id}/cancel`,
        req,
        { signal: req.signal },
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });
}
