import {
  errorResponse,
  type Middleware,
} from "../../../packages/core/src/mod.ts";

/**
 * Hosts allowed to reach the admin API by default. Ports are matched
 * permissively (the docker image is reached at localhost:8080). Extend via
 * FROSTY_ALLOWED_HOSTS.
 */
export const DEFAULT_ADMIN_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
] as const;

/**
 * Builds the Host allow-list: the localhost defaults plus any comma-separated
 * `host` or `host:port` entries from FROSTY_ALLOWED_HOSTS (case-insensitive).
 */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const hosts = new Set<string>(DEFAULT_ADMIN_HOSTS);
  for (const entry of (raw ?? "").split(",")) {
    const host = entry.trim().toLowerCase();
    if (host) {
      hosts.add(host);
    }
  }
  return hosts;
}

/** Reads FROSTY_ALLOWED_HOSTS defensively (missing --allow-env → defaults). */
export function allowedHostsFromEnv(): Set<string> {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("FROSTY_ALLOWED_HOSTS") ?? undefined;
  } catch {
    raw = undefined; // env not readable: fall back to localhost defaults
  }
  return parseAllowedHosts(raw);
}

/** Request scheme, honoring a reverse proxy's X-Forwarded-Proto. */
function forwardedProto(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0].trim().toLowerCase();
  }
  return "http";
}

/** Normalized `scheme://host[:port]` (default ports dropped), or null. */
function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True when the Host header's host part is on the allow-list (port-agnostic). */
function isHostAllowed(hostHeader: string, allowedHosts: Set<string>): boolean {
  const lower = hostHeader.toLowerCase();
  // Exact match first: covers both bare hosts and explicit host:port entries.
  if (allowedHosts.has(lower)) {
    return true;
  }
  // Port-agnostic match on the hostname alone (strip port; keep IPv6 brackets).
  let hostname: string;
  try {
    hostname = new URL(`http://${lower}`).hostname;
  } catch {
    hostname = lower.startsWith("[")
      ? lower.slice(0, lower.indexOf("]") + 1)
      : lower.split(":")[0];
  }
  if (allowedHosts.has(hostname)) {
    return true;
  }
  // Treat [::1] and ::1 as interchangeable.
  return allowedHosts.has(hostname.replace(/^\[|\]$/g, ""));
}

/**
 * The layered admin-request check. Returns a canonical error Response when the
 * request must be blocked, or null to allow it. Pure (no env/IO) so it can be
 * unit-tested directly. Intended for state-changing /api/* requests only.
 */
export function assertAdminRequestOrigin(
  req: Request,
  allowedHosts: Set<string>,
): Response | null {
  const hostHeader = req.headers.get("host");

  if (hostHeader && !isHostAllowed(hostHeader, allowedHosts)) {
    return errorResponse(
      403,
      `Host "${hostHeader}" is not an allowed admin host.`,
      "forbidden_host",
    );
  }

  const secFetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site" || secFetchSite === "cross-origin") {
    return errorResponse(
      403,
      "Cross-site admin API request rejected.",
      "cross_site_denied",
    );
  }
  const origin = req.headers.get("origin");
  if (origin && hostHeader) {
    // Derive the request's own origin from Host (+ forwarded scheme) and
    // require the browser-supplied Origin to match it exactly.
    const expected = safeOrigin(`${forwardedProto(req)}://${hostHeader}`);
    const actual = safeOrigin(origin);
    if (expected === null || actual === null || expected !== actual) {
      return errorResponse(
        403,
        "Cross-origin admin API request rejected.",
        "cross_site_denied",
      );
    }
  }

  const contentType = req.headers.get("content-type");
  if (contentType !== null) {
    const mediaType = contentType.split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return errorResponse(
        415,
        "Admin API mutations require Content-Type: application/json.",
        "unsupported_media_type",
      );
    }
  }

  return null;
}

/**
 * Middleware wrapper (RR-3): applies {@link assertAdminRequestOrigin} to
 * state-changing /api/* requests only, before the admin-token check. Everything
 * else (GET/HEAD, /healthz, UI, inference surfaces) passes straight through.
 */
export function adminOriginGuard(allowedHosts: Set<string>): Middleware {
  return async (req, next) => {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) {
      const rejection = assertAdminRequestOrigin(req, allowedHosts);
      if (rejection) {
        return rejection;
      }
    }
    return await next(req);
  };
}
