import { signRequest } from "./sigv4.ts";

export type AwsCredentialSource =
  | "static"
  | "env"
  | "profile"
  | "imds"
  | "ecs"
  | "sts-web-identity"
  | "sts-assume-role";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch ms when these expire; undefined for long-lived (env/profile/static)
   * credentials. The provider still applies a soft TTL to those so rotated
   * file/env values are re-read. */
  expiration?: number;
  /** Which source produced these credentials (diagnostics + tests). */
  source: AwsCredentialSource;
}

export interface AwsCredentialResolverOptions {
  region?: string;
  /** Injectable env reader (defaults to a permission-guarded Deno.env.get). */
  env?: (name: string) => string | undefined;
  /** Injectable file reader (defaults to Deno.readTextFile). */
  readTextFile?: (path: string) => Promise<string>;
  /** Injectable fetch for metadata/STS (defaults to a raw, short-timeout
   * fetch — deliberately NOT the retrying provider client, which would make an
   * off-EC2 IMDS probe hang for the full request timeout). */
  fetchImpl?: typeof fetch;
  /** Home directory override for ~/.aws resolution (tests). */
  homeDir?: string;
}

// Link-local metadata endpoints (fixed by AWS).
const IMDS_BASE = "http://169.254.169.254";
const ECS_BASE = "http://169.254.170.2";

// Short timeouts so an unreachable metadata service fails fast and the chain
// moves on, instead of stalling a request.
const IMDS_TIMEOUT_MS = 1000;
const ECS_TIMEOUT_MS = 2000;
const STS_TIMEOUT_MS = 5000;

const REFRESH_MARGIN_MS = 60_000;
const SOFT_TTL_MS = 300_000;

function defaultEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function defaultReadTextFile(path: string): Promise<string> {
  return Deno.readTextFile(path);
}

/** A fetch with a bounded timeout, so metadata probes cannot hang a request. */
function timedFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const composed = init.signal ? init.signal : AbortSignal.timeout(timeoutMs);
  return fetchImpl(input, { ...init, signal: composed });
}

interface Resolved {
  env: (name: string) => string | undefined;
  readTextFile: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  region: string;
  homeDir?: string;
}

function resolveDeps(opts: AwsCredentialResolverOptions): Resolved {
  const env = opts.env ?? defaultEnv;
  return {
    env,
    readTextFile: opts.readTextFile ?? defaultReadTextFile,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    region: opts.region ?? env("AWS_REGION") ?? env("AWS_DEFAULT_REGION") ??
      "us-east-1",
    homeDir: opts.homeDir,
  };
}

// --- Source 1: environment variables ----------------------------------------

function fromEnv(d: Resolved): AwsCredentials | undefined {
  const accessKeyId = d.env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = d.env("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: d.env("AWS_SESSION_TOKEN") ?? undefined,
    source: "env",
  };
}

// --- Source 2: shared config / credentials file (profile) -------------------

/** Minimal INI reader: `[section]` headers + `key = value`, `#`/`;` comments. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || section === "") {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (out[section] ??= {})[key] = value;
  }
  return out;
}

function homeDir(d: Resolved): string | undefined {
  return d.homeDir ?? d.env("HOME") ?? d.env("USERPROFILE") ?? undefined;
}

async function fromProfile(d: Resolved): Promise<AwsCredentials | undefined> {
  const profile = d.env("AWS_PROFILE") ?? "default";
  const home = homeDir(d);
  const credsPath = d.env("AWS_SHARED_CREDENTIALS_FILE") ??
    (home ? `${home}/.aws/credentials` : undefined);
  const configPath = d.env("AWS_CONFIG_FILE") ??
    (home ? `${home}/.aws/config` : undefined);

  // Credentials file sections are the bare profile name; config file sections
  // are `[profile <name>]` (except `[default]`).
  const search: Array<{ path: string; section: string }> = [];
  if (credsPath) {
    search.push({ path: credsPath, section: profile });
  }
  if (configPath) {
    search.push({
      path: configPath,
      section: profile === "default" ? "default" : `profile ${profile}`,
    });
  }

  for (const { path, section } of search) {
    let ini: Record<string, Record<string, string>>;
    try {
      ini = parseIni(await d.readTextFile(path));
    } catch {
      continue; // missing/unreadable file -> try the next location
    }
    const s = ini[section];
    if (s?.aws_access_key_id && s?.aws_secret_access_key) {
      return {
        accessKeyId: s.aws_access_key_id,
        secretAccessKey: s.aws_secret_access_key,
        sessionToken: s.aws_session_token ?? undefined,
        source: "profile",
      };
    }
  }
  return undefined;
}

// --- Shared shape for IMDS/ECS/STS JSON credential documents -----------------

interface AwsCredentialDocument {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  Token?: string;
  Expiration?: string;
  Code?: string;
}

function fromDocument(
  doc: AwsCredentialDocument,
  source: AwsCredentialSource,
): AwsCredentials | undefined {
  if (!doc.AccessKeyId || !doc.SecretAccessKey) {
    return undefined;
  }
  return {
    accessKeyId: doc.AccessKeyId,
    secretAccessKey: doc.SecretAccessKey,
    sessionToken: doc.Token ?? undefined,
    expiration: doc.Expiration ? Date.parse(doc.Expiration) : undefined,
    source,
  };
}

// --- Source 3: EC2 Instance Metadata Service (IMDSv2) ------------------------

async function fromImds(d: Resolved): Promise<AwsCredentials | undefined> {
  // IMDSv2: obtain a session token, then read the role and its credentials.
  const tokenRes = await timedFetch(
    d.fetchImpl,
    `${IMDS_BASE}/latest/api/token`,
    {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    },
    IMDS_TIMEOUT_MS,
  );
  if (!tokenRes.ok) {
    return undefined;
  }
  const token = (await tokenRes.text()).trim();
  const tokenHeader = { "x-aws-ec2-metadata-token": token };

  const roleRes = await timedFetch(
    d.fetchImpl,
    `${IMDS_BASE}/latest/meta-data/iam/security-credentials/`,
    { headers: tokenHeader },
    IMDS_TIMEOUT_MS,
  );
  if (!roleRes.ok) {
    return undefined;
  }
  const role = (await roleRes.text()).trim().split("\n")[0];
  if (!role) {
    return undefined;
  }

  const credsRes = await timedFetch(
    d.fetchImpl,
    `${IMDS_BASE}/latest/meta-data/iam/security-credentials/${role}`,
    { headers: tokenHeader },
    IMDS_TIMEOUT_MS,
  );
  if (!credsRes.ok) {
    return undefined;
  }
  return fromDocument(await credsRes.json() as AwsCredentialDocument, "imds");
}

// --- Source 4: ECS/EKS container credential endpoint ------------------------

async function fromEcs(d: Resolved): Promise<AwsCredentials | undefined> {
  const relative = d.env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
  const full = d.env("AWS_CONTAINER_CREDENTIALS_FULL_URI");
  const url = relative ? `${ECS_BASE}${relative}` : full;
  if (!url) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  // Authorization is a raw token env or a token file (EKS pod identity).
  const authToken = d.env("AWS_CONTAINER_AUTHORIZATION_TOKEN");
  const authTokenFile = d.env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE");
  if (authToken) {
    headers["Authorization"] = authToken;
  } else if (authTokenFile) {
    try {
      headers["Authorization"] = (await d.readTextFile(authTokenFile)).trim();
    } catch {
      // missing token file -> send unauthenticated (matches SDK best-effort)
    }
  }
  const res = await timedFetch(d.fetchImpl, url, { headers }, ECS_TIMEOUT_MS);
  if (!res.ok) {
    return undefined;
  }
  return fromDocument(await res.json() as AwsCredentialDocument, "ecs");
}

// --- Source 5: STS AssumeRoleWithWebIdentity (env-driven, unsigned) ----------

function stsEndpoint(region: string): string {
  return `https://sts.${region}.amazonaws.com/`;
}

/** Extracts a tag's text from an STS XML response (offline-unverifiable). */
function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

function fromStsXml(
  xml: string,
  source: AwsCredentialSource,
): AwsCredentials | undefined {
  const accessKeyId = xmlTag(xml, "AccessKeyId");
  const secretAccessKey = xmlTag(xml, "SecretAccessKey");
  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }
  const expiration = xmlTag(xml, "Expiration");
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: xmlTag(xml, "SessionToken"),
    expiration: expiration ? Date.parse(expiration) : undefined,
    source,
  };
}

async function fromWebIdentity(
  d: Resolved,
): Promise<AwsCredentials | undefined> {
  const tokenFile = d.env("AWS_WEB_IDENTITY_TOKEN_FILE");
  const roleArn = d.env("AWS_ROLE_ARN");
  if (!tokenFile || !roleArn) {
    return undefined;
  }
  let webIdentityToken: string;
  try {
    webIdentityToken = (await d.readTextFile(tokenFile)).trim();
  } catch {
    return undefined;
  }
  const sessionName = d.env("AWS_ROLE_SESSION_NAME") ?? "frosty-gateway";
  // AssumeRoleWithWebIdentity is UNSIGNED — the web-identity token is the proof.
  const params = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: webIdentityToken,
  });
  const res = await timedFetch(
    d.fetchImpl,
    stsEndpoint(d.region),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    STS_TIMEOUT_MS,
  );
  if (!res.ok) {
    return undefined;
  }
  return fromStsXml(await res.text(), "sts-web-identity");
}

/**
 * STS AssumeRole with EXISTING source credentials. Not part of the automatic
 * chain (that step is web-identity, which needs no source creds); exposed for
 * callers that hold base credentials and want a role's temporary credentials.
 * The STS call is SigV4-signed with the source credentials.
 */
export async function assumeRole(params: {
  roleArn: string;
  roleSessionName: string;
  source: AwsCredentials;
  region: string;
  durationSeconds?: number;
  externalId?: string;
  fetchImpl?: typeof fetch;
}): Promise<AwsCredentials | undefined> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const form = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: params.roleArn,
    RoleSessionName: params.roleSessionName,
  });
  if (params.durationSeconds !== undefined) {
    form.set("DurationSeconds", String(params.durationSeconds));
  }
  if (params.externalId !== undefined) {
    form.set("ExternalId", params.externalId);
  }
  const body = form.toString();
  const url = stsEndpoint(params.region);
  const headers = await signRequest({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    region: params.region,
    service: "sts",
    accessKeyId: params.source.accessKeyId,
    secretAccessKey: params.source.secretAccessKey,
    sessionToken: params.source.sessionToken,
  });
  const res = await timedFetch(
    fetchImpl,
    url,
    { method: "POST", headers, body },
    STS_TIMEOUT_MS,
  );
  if (!res.ok) {
    return undefined;
  }
  return fromStsXml(await res.text(), "sts-assume-role");
}

/**
 * Resolution order: env > profile > IMDS > ECS > STS web-identity. This follows
 * the owner's pinned order for this build; it differs from the AWS SDK default
 * (which places web-identity and ECS ahead of IMDS). Each source's request
 * shape follows the documented AWS contract. Throws when no source yields
 * credentials.
 */
export async function resolveAwsCredentials(
  opts: AwsCredentialResolverOptions = {},
): Promise<AwsCredentials> {
  const d = resolveDeps(opts);

  const envCreds = fromEnv(d);
  if (envCreds) {
    return envCreds;
  }
  const profileCreds = await fromProfile(d);
  if (profileCreds) {
    return profileCreds;
  }
  // IMDS/ECS/STS transports are unreachable outside AWS; a failed probe throws
  // (timeout/connection) — swallow it and fall through to the next source.
  try {
    const imds = await fromImds(d);
    if (imds) {
      return imds;
    }
  } catch { /* IMDS unreachable */ }
  try {
    const ecs = await fromEcs(d);
    if (ecs) {
      return ecs;
    }
  } catch { /* ECS endpoint unreachable */ }
  try {
    const sts = await fromWebIdentity(d);
    if (sts) {
      return sts;
    }
  } catch { /* STS unreachable */ }

  throw new Error(
    "AWS credential chain exhausted: no credentials from env, shared profile, " +
      "IMDS, ECS, or STS web-identity.",
  );
}

/**
 * Caches the last resolved credentials and refreshes them when they near
 * expiry. Env/profile/static credentials have no source expiry, so a soft TTL
 * lets rotated values be re-read without hammering the filesystem/env.
 */
export class AwsCredentialProvider {
  private cache?: AwsCredentials;
  private cachedUntil = 0;

  constructor(private opts: AwsCredentialResolverOptions = {}) {}

  async resolve(): Promise<AwsCredentials> {
    const now = Date.now();
    if (this.cache && now < this.cachedUntil) {
      return this.cache;
    }
    const fresh = await resolveAwsCredentials(this.opts);
    this.cache = fresh;
    this.cachedUntil = fresh.expiration !== undefined
      ? fresh.expiration - REFRESH_MARGIN_MS
      : now + SOFT_TTL_MS;
    return fresh;
  }

  /** Test/diagnostic hook: the source of the currently cached credentials. */
  cachedSource(): AwsCredentialSource | undefined {
    return this.cache?.source;
  }
}
