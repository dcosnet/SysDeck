import { errorResponse, GatewayError, gatewayErrorResponse } from "./errors.ts";

export type Middleware = (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response>;

export function applyMiddleware(
  handler: (req: Request) => Promise<Response>,
  middlewares: Middleware[],
): (req: Request) => Promise<Response> {
  return middlewares.reduceRight<(req: Request) => Promise<Response>>(
    (nextHandler, middleware) => {
      return (req: Request) => middleware(req, nextHandler);
    },
    handler,
  );
}

/** Headers that describe a body the rebuilding layer is no longer holding, and
 * must therefore be dropped whenever a `Response` is rebuilt around a body.
 *
 * `Content-Encoding`: Deno's `fetch` decompresses transparently but KEEPS the
 * header; a rebuild loses the internal already-decoded flag, so the header
 * becomes an instruction the client acts on and fails.
 * `Content-Length`: a provider's value describes the ENCODED bytes.
 * `Transfer-Encoding`: hop-by-hop; the serving runtime owns framing.
 *
 * Match lowercased. Nothing in this repository sets any of the three on a
 * response it builds, so dropping them is a no-op for every known-length body -
 * `Deno.serve` re-derives the length. See TODO.md D-REBUILD-HEADERS for the
 * three rebuild sites, why the fix belongs at the serving boundary, and the
 * accepted `serveDir` consequence. */
export const REBUILT_BODY_HEADERS: ReadonlySet<string> = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

export interface RequestLogEntry {
  ts: string;
  level: "info" | "error";
  message: string;
  requestId: string;
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
}

export function makeRequestLogger(
  sink?: (entry: RequestLogEntry) => void,
): Middleware {
  return async (req, next) => {
    const start = performance.now();
    const requestId = crypto.randomUUID();
    const path = new URL(req.url).pathname;

    // Clone the request to modify headers, as incoming request headers are immutable
    const newReq = new Request(req, {
      headers: new Headers(req.headers),
    });
    newReq.headers.set("x-request-id", requestId);

    console.log(`[${requestId}] ${newReq.method} ${newReq.url}`);

    try {
      const response = await next(newReq);
      const durationMs = performance.now() - start;
      console.log(
        `[${requestId}] ${response.status} ${newReq.method} ${newReq.url} - ${
          durationMs.toFixed(2)
        }ms`,
      );
      sink?.({
        ts: new Date().toISOString(),
        level: "info",
        message: `${response.status} ${newReq.method} ${path}`,
        requestId,
        method: newReq.method,
        path,
        status: response.status,
        durationMs: Math.round(durationMs * 100) / 100,
      });
      // Explicitly copy headers to allow setting new ones since next() might
      // return a frozen Response - a fetch() Response IS immutable. Framing
      // headers are dropped: this rebuild replaces the body object, so any
      // header describing the previous one is now false
      // (TODO.md D-REBUILD-HEADERS).
      const newHeaders = new Headers();
      for (const [name, value] of response.headers) {
        if (!REBUILT_BODY_HEADERS.has(name.toLowerCase())) {
          newHeaders.set(name, value);
        }
      }
      newHeaders.set("x-request-id", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      const durationMs = performance.now() - start;
      console.error(
        `[${requestId}] ERROR ${newReq.method} ${newReq.url} - ${
          durationMs.toFixed(2)
        }ms`,
        error,
      );
      sink?.({
        ts: new Date().toISOString(),
        level: "error",
        message: `ERROR ${newReq.method} ${path}: ${String(error)}`,
        requestId,
        method: newReq.method,
        path,
        durationMs: Math.round(durationMs * 100) / 100,
      });
      throw error;
    }
  };
}

export const requestLogger: Middleware = makeRequestLogger();

export const errorHandler: Middleware = async (req, next) => {
  try {
    return await next(req);
  } catch (error) {
    if (error instanceof GatewayError) {
      return gatewayErrorResponse(error);
    }
    console.error("Unhandled error:", error);
    return errorResponse(500, "Internal Server Error", "internal_error");
  }
};
