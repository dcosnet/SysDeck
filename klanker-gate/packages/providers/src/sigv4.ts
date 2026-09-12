export interface SigV4Input {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Request payload. Bytes are hashed directly; strings are UTF-8 encoded
   * first (byte-identical for the same content). */
  body: string | Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Injectable clock for deterministic tests. */
  date?: Date;
}

const encoder = new TextEncoder();

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  return await sha256HexBytes(encoder.encode(data));
}

async function hmac(
  key: Uint8Array | ArrayBuffer,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** AWS requires byte/code-point order, not locale order. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    pairs.push([encodeRfc3986(name), encodeRfc3986(value)]);
  }
  pairs.sort((a, b) =>
    a[0] === b[0] ? byteCompare(a[1], b[1]) : byteCompare(a[0], b[0])
  );
  return pairs.map(([n, v]) => `${n}=${v}`).join("&");
}

/**
 * Canonical URI for non-S3 services: each path segment is URI-encoded TWICE
 * per the SigV4 spec, so a Bedrock model id sent as `%3A` on the wire must
 * canonicalize to `%253A`. "/" passes through unchanged.
 */
export function canonicalUri(path: string): string {
  if (path === "" || path === "/") {
    return "/";
  }
  return path
    .split("/")
    .map((segment) => encodeRfc3986(encodeRfc3986(decodeURIComponent(segment))))
    .join("/");
}

/** Encodes a single path segment exactly once for the S3 canonical URI:
 * existing %XX escapes are preserved (uppercased) — never decoded and
 * re-encoded — while any remaining literal byte outside the RFC 3986
 * unreserved set is percent-encoded. */
function singleEncodeSegment(segment: string): string {
  return segment.replace(
    /%[0-9A-Fa-f]{2}|[^]/gu,
    (m) => (m.length === 3 ? m.toUpperCase() : encodeRfc3986(m)),
  );
}

/**
 * Canonical URI for S3: unlike the double-encoding non-S3 rule above, S3
 * signs the wire path with each segment encoded exactly ONCE. A key sent as
 * `a%20b` canonicalizes to `a%20b` (not `a%2520b`); literal specials that
 * slipped through un-encoded are single-encoded. "/" passes through.
 */
export function canonicalUriS3(path: string): string {
  if (path === "" || path === "/") {
    return "/";
  }
  return path.split("/").map(singleEncodeSegment).join("/");
}

/**
 * Signs the request and returns the full header set to send (input headers
 * plus host, x-amz-date, optional session token, and Authorization).
 * When `service === "s3"` the S3 signing profile applies: the canonical URI
 * is single-encoded (see canonicalUriS3) and the payload hash is also sent
 * as the mandatory `x-amz-content-sha256` header.
 */
export async function signRequest(
  input: SigV4Input,
): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const date = input.date ?? new Date();
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const dateStamp = amzDate.slice(0, 8);
  const isS3 = input.service === "s3";
  const payloadHash = await sha256HexBytes(
    typeof input.body === "string" ? encoder.encode(input.body) : input.body,
  );

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amzDate,
  };
  if (isS3) {
    headers["x-amz-content-sha256"] = payloadHash;
  }
  if (input.sessionToken) {
    headers["x-amz-security-token"] = input.sessionToken;
  }

  const sortedNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lowerHeaders = new Map(
    Object.entries(headers).map(([n, v]) => [n.toLowerCase(), v.trim()]),
  );
  const canonicalHeaders = sortedNames
    .map((n) => `${n}:${lowerHeaders.get(n)}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    isS3 ? canonicalUriS3(url.pathname) : canonicalUri(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(
    encoder.encode(`AWS4${input.secretAccessKey}`),
    dateStamp,
  );
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = [...new Uint8Array(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
