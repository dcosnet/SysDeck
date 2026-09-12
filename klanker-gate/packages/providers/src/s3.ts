import { ProviderError } from "./client.ts";
import { signRequest } from "./sigv4.ts";

/** RFC 3986 strict encoding (encodeURIComponent leaves !'()* unencoded). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Escapes each segment of an S3 key individually so "/" survives while every
 * other special character is percent-encoded exactly once — the form both the
 * wire URL and the S3-mode SigV4 canonical URI expect. */
export function escapeS3Key(key: string): string {
  if (key === "") {
    return "";
  }
  return key.split("/").map(encodeRfc3986).join("/");
}

/**
 * Validates an S3 bucket name before it is interpolated into a request host.
 * Without this, a caller-supplied `?bucket=` / `s3://bucket/key` value such as
 * `attacker.com/` parses (via `new URL`) to an attacker-controlled HOST, so a
 * SigV4-signed request — carrying the account access-key id, STS session
 * token, and any upload body — would be sent off-account (SSRF + token/body
 * exfiltration). Rejecting anything outside AWS's bucket-name grammar keeps the
 * bucket a path-safe label that can only ever prefix `.s3.<region>...`.
 */
export function assertValidBucket(bucket: string): void {
  // AWS bucket naming: 3-63 chars, lowercase alnum / dot / hyphen, must start
  // and end alphanumeric. This structurally excludes `/`, `@`, `:`, `%`, so no
  // host-truncation payload (e.g. `attacker.com/`) can pass.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ProviderError(
      400,
      "Bad Request",
      `invalid S3 bucket name: ${JSON.stringify(bucket)}`,
    );
  }
  // AWS also forbids IP-address-formatted bucket names; reject them so a value
  // like `169.254.169.254` can never be used to probe cloud metadata ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bucket)) {
    throw new ProviderError(
      400,
      "Bad Request",
      `S3 bucket name must not be an IP address: ${JSON.stringify(bucket)}`,
    );
  }
}

/** Parses an S3 URI (`s3://bucket/key`) or a bare bucket name. */
export function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith("s3://")) {
    const rest = uri.slice("s3://".length);
    const idx = rest.indexOf("/");
    if (idx < 0) {
      return { bucket: rest, key: "" };
    }
    return { bucket: rest.slice(0, idx), key: rest.slice(idx + 1) };
  }
  // Assume it's just a bucket name (Go parity).
  return { bucket: uri, key: "" };
}

export interface S3ObjectSummary {
  key: string;
  size: number;
  /** RFC3339 timestamp string as returned on the wire. */
  lastModified?: string;
}

export interface S3ListResult {
  contents: S3ObjectSummary[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

/** Unescapes the XML entities S3 emits in `<Key>` values. */
function unescapeXml(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g,
    (match, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      const code = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      // Out-of-range code points would make String.fromCodePoint throw a
      // RangeError and reject the whole listing; leave those entities literal.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        return match;
      }
      return String.fromCodePoint(code);
    },
  );
}

/** Extracts the text of the first `<tag>…</tag>` occurrence, or undefined. */
function scanTag(block: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = block.indexOf(open);
  if (start < 0) {
    return undefined;
  }
  const from = start + open.length;
  const end = block.indexOf(`</${tag}>`, from);
  if (end < 0) {
    return undefined;
  }
  return block.slice(from, end);
}

/**
 * Redacts an S3 error body before it is surfaced to a gateway client. S3's
 * `SignatureDoesNotMatch` response echoes the full `StringToSign`,
 * `CanonicalRequest`, and `AWSAccessKeyId` used to sign the request — internals
 * that must never reach a caller. We keep only the human-useful `<Code>` and
 * `<Message>` (e.g. `AccessDenied`, `NoSuchKey`) and drop everything else. A
 * body with no recognizable `<Code>` collapses to a generic status string, so
 * an unexpected/compatible-service body can't leak fields either.
 */
export function redactS3ErrorBody(body: string, status: number): string {
  const code = scanTag(body, "Code");
  if (!code) {
    return `s3 request failed with status ${status}`;
  }
  const message = scanTag(body, "Message");
  return message
    ? `<Error><Code>${code}</Code><Message>${message}</Message></Error>`
    : `<Error><Code>${code}</Code></Error>`;
}

/**
 * Parses an S3 ListObjectsV2 response body. JSON is tried first (some
 * S3-compatible services return JSON); otherwise the XML is scanned with the
 * same pragmatic string matching the Go port uses — no XML parser needed for
 * the four fields we consume (IsTruncated, NextContinuationToken, and the
 * Key/Size/LastModified of each Contents block).
 */
export function parseS3ListResponse(body: string): S3ListResult {
  try {
    const parsed = JSON.parse(body) as {
      contents?: Array<
        { key?: unknown; size?: unknown; lastModified?: unknown }
      >;
      isTruncated?: unknown;
      nextContinuationToken?: unknown;
    };
    if (Array.isArray(parsed?.contents) && parsed.contents.length > 0) {
      const result: S3ListResult = {
        contents: parsed.contents
          .map((c) => ({
            key: typeof c.key === "string" ? c.key : "",
            size: Number(c.size ?? 0),
            ...(typeof c.lastModified === "string"
              ? { lastModified: c.lastModified }
              : {}),
          }))
          .filter((c) => c.key !== ""),
        isTruncated: parsed.isTruncated === true,
      };
      if (
        typeof parsed.nextContinuationToken === "string" &&
        parsed.nextContinuationToken !== ""
      ) {
        result.nextContinuationToken = parsed.nextContinuationToken;
      }
      return result;
    }
  } catch {
    // Not JSON — fall through to the XML scan.
  }

  const result: S3ListResult = { contents: [], isTruncated: false };
  if (body.includes("<IsTruncated>true</IsTruncated>")) {
    result.isTruncated = true;
  }
  const token = scanTag(body, "NextContinuationToken");
  if (token !== undefined && token !== "") {
    result.nextContinuationToken = token;
  }

  let rest = body;
  while (true) {
    const start = rest.indexOf("<Contents>");
    if (start < 0) {
      break;
    }
    const end = rest.indexOf("</Contents>", start);
    if (end < 0) {
      break;
    }
    const block = rest.slice(start, end + "</Contents>".length);
    rest = rest.slice(end + "</Contents>".length);

    const key = scanTag(block, "Key");
    if (key === undefined || key === "") {
      continue;
    }
    const size = Number(scanTag(block, "Size") ?? 0);
    const lastModified = scanTag(block, "LastModified");
    result.contents.push({
      key: unescapeXml(key),
      size: Number.isFinite(size) ? size : 0,
      ...(lastModified ? { lastModified } : {}),
    });
  }
  return result;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ClientOptions {
  region: string;
  /** Static credentials or an async resolver (the Bedrock adapter passes its
   * credential-chain resolver here). */
  credentials: S3Credentials | (() => Promise<S3Credentials>);
  fetchImpl?: typeof fetch;
}

export interface ListObjectsV2Options {
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export class S3Client {
  private fetchImpl: typeof fetch;

  constructor(private options: S3ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async credentials(): Promise<S3Credentials> {
    const creds = this.options.credentials;
    return typeof creds === "function" ? await creds() : creds;
  }

  private bucketUrl(bucket: string): string {
    // Choke point: every method builds its URL here, so validating the bucket
    // once closes host-injection for all of them (put/get/head/delete/list).
    assertValidBucket(bucket);
    return `https://${bucket}.s3.${this.options.region}.amazonaws.com`;
  }

  /** SigV4-signs (service "s3") and executes one buffered request. */
  private async signedFetch(
    method: string,
    url: string,
    body: string | Uint8Array = "",
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const creds = await this.credentials();
    const headers = await signRequest({
      method,
      url,
      headers: extraHeaders,
      body,
      region: this.options.region,
      service: "s3",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    return await this.fetchImpl(url, {
      method,
      headers,
      body: body.length > 0 ? body as BodyInit : undefined,
      signal,
    });
  }

  /** Uploads a whole object (buffered; no multipart upload). */
  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType = "application/octet-stream",
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.bucketUrl(bucket)}/${escapeS3Key(key)}`;
    const response = await this.signedFetch(
      "PUT",
      url,
      body,
      { "content-type": contentType },
      signal,
    );
    if (response.status !== 200 && response.status !== 201) {
      const text = await response.text();
      throw new ProviderError(
        response.status,
        response.statusText,
        redactS3ErrorBody(text, response.status),
      );
    }
    await response.body?.cancel();
  }

  /** Fetches an object; the returned Response carries body + headers. */
  async getObject(
    bucket: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.bucketUrl(bucket)}/${escapeS3Key(key)}`;
    const response = await this.signedFetch("GET", url, "", {}, signal);
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(
        response.status,
        response.statusText,
        redactS3ErrorBody(text, response.status),
      );
    }
    return response;
  }

  /** HEADs an object; the returned Response carries the metadata headers. */
  async headObject(
    bucket: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.bucketUrl(bucket)}/${escapeS3Key(key)}`;
    const response = await this.signedFetch("HEAD", url, "", {}, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(
        response.status,
        response.statusText,
        `S3 HEAD failed with status ${response.status}`,
      );
    }
    return response;
  }

  /** Deletes an object (S3 answers 204 No Content; 200 is tolerated). */
  async deleteObject(
    bucket: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.bucketUrl(bucket)}/${escapeS3Key(key)}`;
    const response = await this.signedFetch("DELETE", url, "", {}, signal);
    if (response.status !== 204 && response.status !== 200) {
      const text = await response.text();
      throw new ProviderError(
        response.status,
        response.statusText,
        redactS3ErrorBody(text, response.status),
      );
    }
    await response.body?.cancel();
  }

  /** Lists one page of objects under a prefix (single-key pagination). */
  async listObjectsV2(
    bucket: string,
    options: ListObjectsV2Options = {},
    signal?: AbortSignal,
  ): Promise<S3ListResult> {
    const params = new URLSearchParams();
    params.set("list-type", "2");
    params.set("prefix", options.prefix ?? "");
    if (options.maxKeys !== undefined && options.maxKeys > 0) {
      params.set("max-keys", String(options.maxKeys));
    }
    if (options.continuationToken) {
      params.set("continuation-token", options.continuationToken);
    }
    const url = `${this.bucketUrl(bucket)}/?${params.toString()}`;
    const response = await this.signedFetch("GET", url, "", {}, signal);
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        response.status,
        response.statusText,
        redactS3ErrorBody(text, response.status),
      );
    }
    return parseS3ListResponse(text);
  }
}
