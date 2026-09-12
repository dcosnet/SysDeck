export class ProviderError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
  ) {
    super(`Provider Error ${status}: ${statusText}`);
    this.name = "ProviderError";
  }
}

/** Default per-request timeout (ms) when neither the account nor the
 * FROSTY_HTTP_TIMEOUT_MS env override sets one. High enough that it never
 * regresses a healthy call; it only rescues a genuinely hung upstream. Mirrors
 * Bifrost's 60s ReadTimeout, doubled for headroom (core/network/http.go). */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Egress proxy for this account's upstream calls (http/https/socks5). */
  proxyUrl?: string;
  /** Basic-auth for the egress proxy; applied only when proxyUrl is set. */
  proxyUsername?: string;
  proxyPassword?: string;
  /** Operator headers added to every upstream request. Adapter-set headers
   * (auth, content-type) take precedence, so these are purely additive. */
  extraHeaders?: Array<{ name: string; value: string }>;
  /** Per-request timeout (ms) for RESPONSE ESTABLISHMENT (headers / first byte)
   * and for NON-streaming body reads. Streaming responses are exempt from this
   * cap so it can never truncate an SSE stream (see streamIdleTimeoutMs).
   * Precedence: this value, else env FROSTY_HTTP_TIMEOUT_MS, else 120000.
   * `0` disables the timeout entirely (byte-identical to the pre-timeout path). */
  requestTimeoutMs?: number;
  /** Idle (inter-chunk) timeout (ms) applied ONLY to streaming responses: the
   * stream aborts if no chunk arrives within this window, but there is no total
   * cap. Unset (default) means streams are never timed out. */
  streamIdleTimeoutMs?: number;
  /** NoProxy patterns: hosts that bypass the egress proxy. Merged with the
   * env FROSTY_NO_PROXY comma list. Supports `*`, `.suffix`, `*.suffix`, exact. */
  noProxy?: string[];
  /** PEM-encoded CA certificate(s) used to verify upstream TLS. Enforced via
   * Deno.createHttpClient({ caCerts }). */
  caCertPem?: string;
  /** Request to skip upstream TLS verification. NOTE: Deno's createHttpClient
   * exposes no per-client insecure/skip-verify option (verified against Deno
   * 2.9), so this cannot be honored per-account and is surfaced as a warning
   * rather than silently ignored. The only Deno mechanism is the process-global
   * `--unsafely-ignore-certificate-errors` startup flag. */
  skipTlsVerify?: boolean;
}

interface ProxyHttpClient {
  close?: () => void;
}

/** Options passed to the native HTTP client factory. Both keys are optional so
 * the same factory builds proxy clients, custom-CA clients, or both at once. */
interface HttpClientOptions {
  proxy?: {
    url: string;
    basicAuth?: { username: string; password: string };
  };
  caCerts?: string[];
}

type HttpClientFactory = (options: HttpClientOptions) => ProxyHttpClient;

/** Deno.createHttpClient when the runtime exposes it; proxy/CA no-op otherwise. */
const defaultHttpClientFactory = (Deno as unknown as {
  createHttpClient?: HttpClientFactory;
}).createHttpClient;

/** Whether this runtime can enforce a configured proxy instead of silently
 * falling back to direct fetch. Global proxy activation requires this signal. */
export function supportsProxyHttpClient(): boolean {
  return typeof defaultHttpClientFactory === "function";
}

/** Deno.env.get guarded for contexts without --allow-env (returns undefined). */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Splits a comma list (e.g. FROSTY_NO_PROXY) into trimmed, non-empty entries. */
function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True when `host` matches a single NoProxy `pattern`. Ported verbatim from
 * Bifrost's shouldBypassProxy (core/network/http.go):
 *   - "*"            matches every host
 *   - exact host     matches that host only
 *   - ".example.com" matches example.com and any subdomain
 *   - "*.example.com" matches subdomains only (not example.com itself)
 */
function matchesNoProxyPattern(host: string, pattern: string): boolean {
  host = host.trim().toLowerCase();
  pattern = pattern.trim().toLowerCase();
  if (pattern.length === 0) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (pattern === host) {
    return true;
  }
  // ".example.com" matches example.com and all subdomains.
  if (pattern.startsWith(".")) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(pattern);
  }
  // "*.example.com" matches subdomains only.
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // keep the dot -> ".example.com"
    return host.endsWith(suffix);
  }
  return false;
}

/** True when `host` matches ANY NoProxy pattern (proxy should be bypassed). */
export function shouldBypassProxy(host: string, patterns: string[]): boolean {
  if (host.length === 0) {
    return false;
  }
  for (const pattern of patterns) {
    if (matchesNoProxyPattern(host, pattern)) {
      return true;
    }
  }
  return false;
}

function timeoutError(ms: number): DOMException {
  return new DOMException(
    `Provider request timed out after ${ms} ms`,
    "TimeoutError",
  );
}

function idleError(ms: number): DOMException {
  return new DOMException(
    `Provider stream idle for more than ${ms} ms`,
    "TimeoutError",
  );
}

/** SSE / streaming responses are exempt from the total request timeout. */
function isEventStream(contentType: string | null): boolean {
  if (contentType === null) return false;
  const ct = contentType.toLowerCase();
  // Bedrock converse-stream uses AWS eventstream framing, not text/event-stream,
  // but is equally a live stream: exempt it from the total cap (idle guard still
  // applies) so long generations are not truncated.
  return ct.includes("text/event-stream") ||
    ct.includes("vnd.amazon.eventstream");
}

/** Rebuilds a Response around a replacement body, preserving status + headers.
 * (Adapters never read response.url/type/redirected, verified across the
 * package, so the metadata dropped by the Response constructor is unused.) */
function withBody(
  response: Response,
  body: ReadableStream<Uint8Array>,
): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class ProviderClient {
  private maxRetries: number;
  private initialDelayMs: number;
  private maxDelayMs: number;
  private fetchImpl: typeof fetch;
  private extraHeaders?: Array<{ name: string; value: string }>;
  private requestTimeoutMs: number;
  private streamIdleTimeoutMs: number;
  private noProxy: string[];
  /** Proxy egress client (proxy + any custom CA); used for non-bypassed hosts. */
  private proxyClient?: ProxyHttpClient;
  /** Direct client carrying custom CA only (no proxy); used for bypassed hosts
   * and when a custom CA is set without a proxy. */
  private directClient?: ProxyHttpClient;

  constructor(
    options: RetryOptions = {},
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    httpClientFactory: HttpClientFactory | undefined = defaultHttpClientFactory,
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10000;
    this.extraHeaders = options.extraHeaders?.length
      ? options.extraHeaders
      : undefined;
    this.fetchImpl = fetchImpl;

    // Timeout budget: explicit option, else env override, else default. A
    // non-positive value disables the timeout so no wrapping happens at all.
    this.requestTimeoutMs = resolveTimeoutMs(options.requestTimeoutMs);
    this.streamIdleTimeoutMs =
      options.streamIdleTimeoutMs !== undefined && options.streamIdleTimeoutMs >
          0
        ? options.streamIdleTimeoutMs
        : 0;

    // NoProxy patterns: caller-supplied merged with the env comma list.
    this.noProxy = [
      ...(options.noProxy ?? []),
      ...splitCsv(readEnv("FROSTY_NO_PROXY")),
    ];

    const caCerts = options.caCertPem ? [options.caCertPem] : undefined;

    // skipTlsVerify is persisted but NOT enforceable per-client in Deno; warn
    // instead of pretending it took effect (see RetryOptions.skipTlsVerify).
    if (options.skipTlsVerify) {
      console.warn(
        "[providers] network.skipTlsVerify is set but Deno.createHttpClient " +
          "has no per-client TLS-skip option; upstream TLS is still verified. " +
          "Use the process-global --unsafely-ignore-certificate-errors flag if " +
          "you truly need this.",
      );
    }

    if (httpClientFactory) {
      // A malformed proxy URL or CA cert must NOT crash client construction
      // (that would 500 the admin API and brick gateway boot from a persisted
      // config). On failure we warn and degrade rather than throw.
      const tryCreate = (
        opts: HttpClientOptions,
        label: string,
      ): ProxyHttpClient | undefined => {
        try {
          return httpClientFactory(opts);
        } catch (err) {
          console.warn(
            `[providers] could not create ${label} HTTP client: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        }
      };

      if (options.proxyUrl) {
        // Proxy client also carries the custom CA so proxied TLS is verified
        // against it.
        const proxyBase: HttpClientOptions = {
          proxy: {
            url: options.proxyUrl,
            // Separate credential fields are merged into the proxy client's
            // basic auth; a proxyUrl with embedded userinfo still works too.
            ...(options.proxyUsername !== undefined
              ? {
                basicAuth: {
                  username: options.proxyUsername,
                  password: options.proxyPassword ?? "",
                },
              }
              : {}),
          },
        };
        if (caCerts) {
          // If proxy+CA fails (e.g. an unparseable cert), keep the proxy alive
          // by retrying without the CA rather than losing egress entirely.
          this.proxyClient = tryCreate({ ...proxyBase, caCerts }, "proxy") ??
            tryCreate(proxyBase, "proxy (CA dropped)");
        } else {
          this.proxyClient = tryCreate(proxyBase, "proxy");
        }
      }
      if (caCerts) {
        // Direct (no-proxy) client for NoProxy-bypassed hosts and the
        // proxy-less custom-CA case.
        this.directClient = tryCreate({ caCerts }, "custom-CA");
      }
    }
  }

  /** Merges the operator's extra headers under the request's own headers, so
   * adapter-managed headers (auth, content-type) always win. */
  private withExtraHeaders(init?: RequestInit): RequestInit | undefined {
    if (!this.extraHeaders) {
      return init;
    }
    const headers = new Headers();
    for (const { name, value } of this.extraHeaders) {
      headers.set(name, value);
    }
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    return { ...init, headers };
  }

  /** Hostname (no port) of a request target, for NoProxy matching. */
  private hostOf(input: RequestInfo | URL): string {
    try {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : String(input);
      return new URL(href).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  /** Selects the native HTTP client for a request: the proxy client unless the
   * host is NoProxy-bypassed, in which case the direct (CA-only) client or a
   * plain fetch (undefined) is used. */
  private clientFor(input: RequestInfo | URL): ProxyHttpClient | undefined {
    if (this.proxyClient) {
      if (
        this.noProxy.length > 0 &&
        shouldBypassProxy(this.hostOf(input), this.noProxy)
      ) {
        return this.directClient; // bypass -> direct (may be undefined)
      }
      return this.proxyClient;
    }
    return this.directClient; // CA-only client, or undefined for plain fetch
  }

  /** Composes the caller's AbortSignal with our timeout signal. */
  private static compose(
    caller: AbortSignal | undefined,
    timeout: AbortSignal,
  ): AbortSignal {
    if (!caller) {
      return timeout;
    }
    const anyFn = (AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }).any;
    if (typeof anyFn === "function") {
      return anyFn([caller, timeout]);
    }
    // Fallback for runtimes without AbortSignal.any (not Deno 2.9, but cheap).
    const ac = new AbortController();
    const linkFrom = (s: AbortSignal) => {
      if (s.aborted) {
        ac.abort(s.reason);
      } else {
        s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
      }
    };
    linkFrom(caller);
    linkFrom(timeout);
    return ac.signal;
  }

  /**
   * fetch wrapper enforcing: (1) the total timeout on response establishment,
   * (2) the total timeout on NON-streaming body reads, (3) the idle timeout on
   * streaming bodies (never a total cap), (4) NoProxy-aware client selection.
   */
  private async timedFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const client = this.clientFor(input);
    const callerSignal = init?.signal ?? undefined;
    const totalMs = this.requestTimeoutMs;

    const tc = new AbortController();
    const signal = ProviderClient.compose(callerSignal, tc.signal);

    let timedOut = false;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const armTotal = () => {
      if (totalMs > 0 && totalTimer === undefined && !tc.signal.aborted) {
        totalTimer = setTimeout(() => {
          timedOut = true;
          tc.abort(timeoutError(totalMs));
        }, totalMs);
      }
    };
    const clearTotal = () => {
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer);
        totalTimer = undefined;
      }
    };

    // Phase 1: establish the response (headers / first byte).
    armTotal();
    const reqInit: RequestInit & { client?: ProxyHttpClient } = {
      ...init,
      signal,
    };
    if (client) {
      reqInit.client = client;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(input, reqInit as RequestInit);
    } catch (err) {
      clearTotal();
      if (timedOut) {
        throw timeoutError(totalMs);
      }
      throw err;
    }
    // Headers are in: the establishment budget is spent.
    clearTotal();

    if (!response.body) {
      return response;
    }

    if (isEventStream(response.headers.get("content-type"))) {
      // Phase 2a (stream): NO total cap. Optional idle guard only.
      return this.guardStream(response);
    }

    // Phase 2b (non-stream): bound the full body read by a fresh total budget,
    // armed lazily on first read so an unconsumed body never leaks a timer.
    if (totalMs > 0) {
      return this.guardNonStreamBody(
        response,
        armTotal,
        clearTotal,
        () => timedOut,
      );
    }
    return response;
  }

  /** Wraps a streaming body with an inter-chunk idle timeout (if configured).
   * Never imposes a total cap, so a slow-but-alive stream is never truncated. */
  private guardStream(response: Response): Response {
    const idleMs = this.streamIdleTimeoutMs;
    if (idleMs <= 0) {
      // No idle budget: hand the stream back untouched (zero truncation risk).
      return response;
    }
    const reader = response.body!.getReader();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const guarded = new ReadableStream<Uint8Array>({
      pull: (controller) =>
        new Promise<void>((resolve) => {
          let settled = false;
          idleTimer = setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            const err = idleError(idleMs);
            reader.cancel(err).catch(() => {});
            controller.error(err);
            resolve();
          }, idleMs);
          reader.read().then(({ done, value }) => {
            if (settled) {
              return;
            }
            settled = true;
            clearIdle();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
            resolve();
          }).catch((err) => {
            if (settled) {
              return;
            }
            settled = true;
            clearIdle();
            controller.error(err);
            resolve();
          });
        }),
      cancel: (reason) => {
        clearIdle();
        return reader.cancel(reason);
      },
    });
    return withBody(response, guarded);
  }

  /** Wraps a non-streaming body so a stalled read is bounded by the total
   * timeout. The timer is armed on the first read and cleared on completion,
   * cancel, or error — an untouched body arms nothing. */
  private guardNonStreamBody(
    response: Response,
    armTotal: () => void,
    clearTotal: () => void,
    didTimeout: () => boolean,
  ): Response {
    const reader = response.body!.getReader();
    let started = false;
    const guarded = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!started) {
          started = true;
          armTotal();
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearTotal();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          clearTotal();
          controller.error(
            didTimeout() ? timeoutError(this.requestTimeoutMs) : err,
          );
        }
      },
      cancel: (reason) => {
        clearTotal();
        return reader.cancel(reason);
      },
    });
    return withBody(response, guarded);
  }

  /** Releases the proxy/CA HTTP clients, if any. No-op without them. */
  close(): void {
    this.proxyClient?.close?.();
    this.directClient?.close?.();
    this.proxyClient = undefined;
    this.directClient = undefined;
  }

  /** Retrying fetch with this client's proxy wiring, for adapters that sign
   * or shape requests themselves instead of calling fetchWithRetry. */
  get fetch(): typeof fetch {
    return (input, init) => this.fetchWithRetry(input, init);
  }

  /**
   * Single-attempt guarded fetch: this client's proxy/CA wiring, operator extra
   * headers, establishment timeout and non-stream body budget, with NO retry
   * loop at all - so there is no `maxRetries` to honour and nothing to
   * misconfigure to a non-zero value.
   *
   * For surfaces where a retry is unrequested provider SPEND: image generation,
   * speech and transcription. {@link fetchWithRetry} would turn one provider
   * 429 on `/v1/images/generations` into up to four paid attempts, and it has no
   * per-call override.
   *
   * Unlike {@link fetchWithRetry} this RETURNS a `!ok` response instead of
   * throwing, so the calling adapter stays the single authority on what a
   * provider error means.
   */
  fetchGuarded(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    return this.timedFetch(input, this.withExtraHeaders(init));
  }

  async fetchWithRetry(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let attempt = 0;
    let delay = this.initialDelayMs;
    const effInit = this.withExtraHeaders(init);

    while (true) {
      try {
        const response = await this.timedFetch(input, effInit);

        // Success or non-retriable client error
        if (response.ok || (response.status < 500 && response.status !== 429)) {
          return response;
        }

        if (attempt >= this.maxRetries) {
          const body = await response.text();
          throw new ProviderError(response.status, response.statusText, body);
        }

        // Check for Retry-After header
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const retryAfterMs = parseInt(retryAfter, 10) * 1000;
          if (!isNaN(retryAfterMs)) {
            // Clamp to our own ceiling: a hostile or misconfigured upstream
            // returning e.g. `Retry-After: 86400` must not pin the request in a
            // multi-hour sleep (the exponential branch is already clamped).
            delay = Math.min(this.maxDelayMs, retryAfterMs);
          }
        }

        // Discarded response: release the connection before retrying.
        await response.body?.cancel();
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw error;
        }
        // Caller-aborted requests and our own timeouts are terminal: do not
        // retry them (a retry would just burn another full timeout budget).
        if (
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          throw error;
        }
      }

      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Exponential backoff with jitter
      delay = Math.min(
        this.maxDelayMs,
        delay * 2 * (0.5 + Math.random()),
      );
    }
  }
}

/** Resolves the per-request timeout (ms): explicit option, else env override,
 * else the 120s default. `0`/negative disables it. Exported-adjacent logic kept
 * private; tests exercise it through the constructor. */
function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit > 0 ? explicit : 0;
  }
  const env = readEnv("FROSTY_HTTP_TIMEOUT_MS");
  if (env !== undefined && env.trim().length > 0) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed > 0 ? parsed : 0;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}
