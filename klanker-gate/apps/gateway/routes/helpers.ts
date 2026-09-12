import type { ZodError } from "zod";
import {
  errorResponse,
  GatewayError,
  gatewayErrorResponse,
  REBUILT_BODY_HEADERS,
  SideEffectDeniedError,
  ToolLoopExceededError,
} from "../../../packages/core/src/mod.ts";
import {
  AllProvidersFailedError,
  ProviderError,
} from "../../../packages/providers/src/mod.ts";

/**
 * Upper bound on a JSON request body the gateway will buffer. Guards against
 * memory-amplification DoS (an unbounded POST buffered into a string). Generous
 * enough for large multimodal JSON (base64 image/audio parts); binary uploads
 * flow through their own routes, not this JSON path.
 */
export const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Reads a body stream into one buffer, aborting past `maxBytes` (413
 * GatewayError). Takes the stream rather than a `Request` so the same capped
 * read serves a provider `Response` body; a caller that must not surface a 413
 * (an over-cap provider response is a provider-contract violation, not a client
 * error) catches and remaps it.
 */
export async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Deliberately not awaited. The condition is SPLIT, not any one shape:
      // on any body split from a stream the cancel promise settles only once
      // every branch cancels, so awaiting here hangs the 413 forever. That
      // covers `.tee()` AND `.clone()` - a clone of a stream-sourced body is a
      // tee underneath - which is what makes this load-bearing on a live path
      // today: `governance.ts` pre-auth-reads `req.clone()`. An unsplit stream
      // and a buffered-body clone both resolve, which is why measuring only
      // those two makes an awaited cancel look safe.
      reader.cancel().catch(() => {});
      throw new GatewayError(
        413,
        "Request body exceeds the maximum allowed size.",
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Reads a request body into text, aborting past `maxBytes` (413 GatewayError). */
export async function readCappedText(
  req: Request,
  maxBytes: number,
): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GatewayError(
      413,
      "Request body exceeds the maximum allowed size.",
    );
  }
  // Decoded once, from the merged buffer, so a multibyte character split across
  // chunk boundaries survives.
  return new TextDecoder().decode(await readCappedBytes(req.body, maxBytes));
}

/**
 * Runs `dispatch` with the client's abort forwarded to the provider ONLY until
 * it settles. Detachment happens in the same frame the dispatch settles in, so
 * no caller-side `await` can widen the window: from the return onward the body
 * read is the gateway's obligation, not the client's option.
 *
 * The pre-listener guard is load-bearing. `addEventListener("abort", ...)` never
 * fires on a signal that already fired, so without it a fully abandoned request
 * still dispatches at full provider cost. `AbortSignal.any` reports an
 * already-aborted input correctly but has no un-link API, and severing the link
 * the instant the dispatch settles is the whole point of this helper.
 */
export async function dispatchThenDetach(
  req: Request,
  dispatch: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const ac = new AbortController();
  if (req.signal.aborted) ac.abort(req.signal.reason);
  const forward = () => ac.abort(req.signal.reason);
  req.signal.addEventListener("abort", forward, { once: true });
  try {
    return await dispatch(ac.signal);
  } finally {
    req.signal.removeEventListener("abort", forward);
  }
}

/**
 * Runs `dispatch` with the client's abort visible only as its already-aborted
 * state at entry: an abandoned request still never reaches the provider, but an
 * abort landing after that severs nothing.
 *
 * For a dispatch whose settle point is NOT the provider's header boundary. A
 * native `generateImage` adapter owns its own fetch and resolves only once it
 * has read and parsed the whole body, so {@link dispatchThenDetach} would keep
 * the client's abort live across the render as well as the read. On an image
 * render that window is work the provider has already performed and will charge
 * for, so forwarding the abort there discards the billing record rather than the
 * spend.
 */
export function dispatchDetached<T>(
  req: Request,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  if (req.signal.aborted) ac.abort(req.signal.reason);
  return dispatch(ac.signal);
}

/**
 * Rebuilds `upstream` around an already-buffered body, dropping the headers that
 * describe the body it no longer holds ({@link REBUILT_BODY_HEADERS}) and
 * keeping every other provider header - `openai-organization`, `x-request-id`
 * and the `x-ratelimit-*` family reach the client today and must continue to.
 *
 * A denylist, not an allowlist: an allowlist would silently drop those. The
 * trade is that a future provider header this rebuild also invalidates is
 * inherited rather than caught.
 */
export function rebuild(upstream: Response, body: BodyInit): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!REBUILT_BODY_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  return carryGatewayHeaders(
    upstream,
    new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }),
  );
}

export async function parseJsonBody(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  let text: string;
  try {
    text = await readCappedText(req, maxBytes);
  } catch (error) {
    if (error instanceof GatewayError) throw error; // preserve the 413
    throw new GatewayError(400, "Request body must be valid JSON.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, "Request body must be valid JSON.");
  }
}

export function validationErrorResponse(error: ZodError): Response {
  const issues = error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return errorResponse(
    400,
    `Invalid request: ${issues}`,
    "invalid_request_error",
    error.issues[0]?.path.join(".") || undefined,
  );
}

/**
 * Carries the gateway's own response markers across an edge translation. A
 * dialect route rebuilds the response body, and `x-frosty-cache` is not
 * cosmetic: governance reads it to exempt a cache hit from cost accounting,
 * so dropping it double-bills every hit on that surface.
 */
export function carryGatewayHeaders(from: Response, to: Response): Response {
  for (const name of ["x-frosty-cache", "x-frosty-cache-type"]) {
    const value = from.headers.get(name);
    if (value !== null) {
      to.headers.set(name, value);
    }
  }
  return to;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Maps dispatch-path failures onto the canonical error envelope. */
export function mapDispatchError(error: unknown): Response {
  if (error instanceof GatewayError) {
    return gatewayErrorResponse(error);
  }
  if (error instanceof SideEffectDeniedError) {
    return errorResponse(403, error.message, "side_effect_denied");
  }
  if (error instanceof ToolLoopExceededError) {
    return errorResponse(500, error.message, "tool_loop_error");
  }
  if (error instanceof AllProvidersFailedError) {
    return errorResponse(
      502,
      error.message,
      "provider_error",
      undefined,
      "all_providers_failed",
    );
  }
  if (error instanceof ProviderError) {
    // Contract errors from the provider pass through with their own status.
    try {
      JSON.parse(error.body);
      return new Response(error.body, {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return errorResponse(error.status, error.message, "provider_error");
    }
  }
  throw error; // let the errorHandler middleware produce the 500 envelope
}
