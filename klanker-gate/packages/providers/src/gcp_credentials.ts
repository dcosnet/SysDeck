export interface GcpAdcOptions {
  /** Injectable env reader (defaults to a permission-guarded Deno.env.get). */
  env?: (name: string) => string | undefined;
  /** Injectable file reader (defaults to Deno.readTextFile). */
  readTextFile?: (path: string) => Promise<string>;
  /** Injectable fetch for the metadata server (defaults to a raw, short-timeout
   * fetch so an off-GCE probe fails fast instead of hanging a request). */
  fetchImpl?: typeof fetch;
}

export interface GcpAccessToken {
  token: string;
  /** Seconds until expiry, as reported by the token source. */
  expiresIn: number;
}

const METADATA_TIMEOUT_MS = 1000;

function defaultEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** True when a JSON string is a usable service account (signable JWT source). */
export function isServiceAccountJson(json: string | undefined): boolean {
  if (!json) {
    return false;
  }
  try {
    const sa = JSON.parse(json) as {
      client_email?: unknown;
      private_key?: unknown;
    };
    return typeof sa.client_email === "string" &&
      sa.client_email.length > 0 &&
      typeof sa.private_key === "string" &&
      sa.private_key.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads the GOOGLE_APPLICATION_CREDENTIALS file and returns its contents when
 * they are a valid service-account JSON, else undefined. The caller then feeds
 * the JSON into the existing SA-JWT exchange path.
 */
export async function loadAdcServiceAccount(
  opts: GcpAdcOptions = {},
): Promise<string | undefined> {
  const env = opts.env ?? defaultEnv;
  const path = env("GOOGLE_APPLICATION_CREDENTIALS");
  if (!path) {
    return undefined;
  }
  const readTextFile = opts.readTextFile ?? Deno.readTextFile;
  let contents: string;
  try {
    contents = await readTextFile(path);
  } catch {
    return undefined;
  }
  return isServiceAccountJson(contents) ? contents : undefined;
}

/**
 * Fetches an OAuth access token from the GCE / Cloud Run metadata server. The
 * `Metadata-Flavor: Google` header is mandatory; the host is overridable via
 * GCE_METADATA_HOST (matching the Google auth libraries).
 */
export async function fetchMetadataToken(
  opts: GcpAdcOptions = {},
): Promise<GcpAccessToken> {
  const env = opts.env ?? defaultEnv;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const host = env("GCE_METADATA_HOST") ?? "metadata.google.internal";
  const url =
    `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`;
  const res = await fetchImpl(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `GCE metadata token request failed: ${res.status} ${res.statusText}`,
    );
  }
  const body = await res.json() as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    throw new Error("GCE metadata token response missing access_token");
  }
  return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
}
