import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertValidBucket,
  escapeS3Key,
  parseS3ListResponse,
  parseS3Uri,
  redactS3ErrorBody,
  S3Client,
} from "./s3.ts";
import { ProviderError } from "./client.ts";

// m1 regression: an S3 SignatureDoesNotMatch body echoes StringToSign /
// CanonicalRequest / AWSAccessKeyId. redactS3ErrorBody must strip those and
// keep only Code + Message.
Deno.test("s3: redactS3ErrorBody drops signed-request internals", () => {
  const raw = `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code>` +
    `<Message>The request signature we calculated does not match.</Message>` +
    `<AWSAccessKeyId>AKIAEXAMPLESECRETID</AWSAccessKeyId>` +
    `<StringToSign>AWS4-HMAC-SHA256 20260716T</StringToSign>` +
    `<CanonicalRequest>GET /key</CanonicalRequest>` +
    `<StringToSignBytes>41 57 53 34</StringToSignBytes></Error>`;
  const out = redactS3ErrorBody(raw, 403);
  assertStringIncludes(out, "SignatureDoesNotMatch");
  assertStringIncludes(out, "does not match");
  for (
    const leak of [
      "AKIAEXAMPLESECRETID",
      "StringToSign",
      "CanonicalRequest",
      "StringToSignBytes",
    ]
  ) {
    assert(!out.includes(leak), `leaked ${leak}`);
  }
  // An unrecognized body collapses to a generic status string.
  assertEquals(
    redactS3ErrorBody("<html>oops</html>", 500),
    "s3 request failed with status 500",
  );
});

Deno.test("s3: getObject error surfaces a redacted body", async () => {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    fetchImpl: (() =>
      Promise.resolve(
        new Response(
          `<Error><Code>AccessDenied</Code><Message>denied</Message>` +
            `<AWSAccessKeyId>AKIALEAK</AWSAccessKeyId></Error>`,
          { status: 403 },
        ),
      )) as typeof fetch,
  });
  const err = await assertRejects(
    () => client.getObject("my-bucket", "k"),
    ProviderError,
  );
  assert(!String((err as ProviderError).body).includes("AKIALEAK"));
});

// C1 regression: a host-injection bucket must never reach fetch. A caller-
// supplied `?bucket=attacker.com/` would otherwise make `new URL` treat
// attacker.com as the host and ship the SigV4-signed request (access-key id +
// session token + body) off-account.
Deno.test("s3: assertValidBucket rejects host-injection and malformed names", () => {
  for (
    const bad of [
      // Host-truncation payloads (need /, @, or :) — the C1 exploit shapes.
      "attacker.com/",
      "burp.attacker.com/",
      "bucket/../other",
      "a@b",
      "bucket:9000",
      "s3://other/key",
      // IP-formatted names (AWS forbids; blocks metadata-range probing).
      "169.254.169.254",
      // Malformed per AWS grammar.
      "UPPER",
      "ab",
      "x".repeat(64),
    ]
  ) {
    assertThrows(
      () => assertValidBucket(bad),
      ProviderError,
      undefined,
      `expected reject: ${bad}`,
    );
  }
  // Well-formed names pass.
  for (const ok of ["my-bucket", "frosty.batch.out", "a1b2c3"]) {
    assertValidBucket(ok);
  }
});

Deno.test("s3: an injected bucket never reaches fetch", async () => {
  let called = false;
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    fetchImpl: () => {
      called = true;
      return Promise.resolve(new Response("should-not-happen"));
    },
  });
  await assertRejects(
    () => client.getObject("attacker.com/", "k"),
    ProviderError,
  );
  assert(!called, "fetch must not run for an invalid bucket");
});

const creds = {
  accessKeyId: "AKID",
  secretAccessKey: "secret",
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
}

/** Mock fetch recording every call and answering via the handler. */
function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response,
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return Promise.resolve(handler(String(input), init));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

Deno.test("s3: parseS3Uri splits bucket/key and accepts bare bucket names", () => {
  assertEquals(parseS3Uri("s3://my-bucket/a/b/c.jsonl"), {
    bucket: "my-bucket",
    key: "a/b/c.jsonl",
  });
  assertEquals(parseS3Uri("s3://my-bucket"), { bucket: "my-bucket", key: "" });
  assertEquals(parseS3Uri("s3://my-bucket/"), { bucket: "my-bucket", key: "" });
  assertEquals(parseS3Uri("just-a-bucket"), {
    bucket: "just-a-bucket",
    key: "",
  });
});

Deno.test("s3: escapeS3Key encodes per segment, preserving slashes", () => {
  assertEquals(escapeS3Key("a b/c:d/e.jsonl"), "a%20b/c%3Ad/e.jsonl");
  assertEquals(escapeS3Key("plain/key.jsonl"), "plain/key.jsonl");
  // RFC 3986 strict: characters encodeURIComponent leaves bare are encoded.
  assertEquals(escapeS3Key("a!b'c(d)e*f"), "a%21b%27c%28d%29e%2Af");
  assertEquals(escapeS3Key(""), "");
});

Deno.test("s3: parseS3ListResponse scans XML (truncation, token, entities)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>out-bucket</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok-123</NextContinuationToken>
  <Contents>
    <Key>results/j1/records.jsonl.out</Key>
    <Size>2048</Size>
    <LastModified>2026-07-16T10:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>results/j1/a &amp; b.jsonl</Key>
    <Size>17</Size>
  </Contents>
</ListBucketResult>`;
  const parsed = parseS3ListResponse(xml);
  assertEquals(parsed.isTruncated, true);
  assertEquals(parsed.nextContinuationToken, "tok-123");
  assertEquals(parsed.contents, [
    {
      key: "results/j1/records.jsonl.out",
      size: 2048,
      lastModified: "2026-07-16T10:00:00.000Z",
    },
    { key: "results/j1/a & b.jsonl", size: 17 },
  ]);
});

Deno.test("s3: parseS3ListResponse tries JSON first (S3-compatible services)", () => {
  const json = JSON.stringify({
    contents: [
      { key: "k1.jsonl", size: 10, lastModified: "2026-07-16T10:00:00Z" },
    ],
    isTruncated: true,
    nextContinuationToken: "next",
  });
  const parsed = parseS3ListResponse(json);
  assertEquals(parsed.contents, [
    { key: "k1.jsonl", size: 10, lastModified: "2026-07-16T10:00:00Z" },
  ]);
  assertEquals(parsed.isTruncated, true);
  assertEquals(parsed.nextContinuationToken, "next");
});

Deno.test("s3: parseS3ListResponse yields an empty result for empty XML", () => {
  const parsed = parseS3ListResponse(
    `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
  );
  assertEquals(parsed, { contents: [], isTruncated: false });
});

Deno.test("S3Client.putObject uses virtual-hosted URLs, escaped keys, and S3 signing", async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    new Response("", { status: 200 })
  );
  const client = new S3Client({
    region: "us-east-1",
    credentials: creds,
    fetchImpl,
  });
  await client.putObject(
    "my-bucket",
    "pre fix/file:1.jsonl",
    new TextEncoder().encode("{}"),
    "application/jsonl",
  );

  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://my-bucket.s3.us-east-1.amazonaws.com/pre%20fix/file%3A1.jsonl",
  );
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].headers.get("content-type"), "application/jsonl");
  // S3 mode: payload hash rides x-amz-content-sha256 and is signed.
  const contentSha = calls[0].headers.get("x-amz-content-sha256");
  assert(contentSha && contentSha.length === 64, String(contentSha));
  const auth = calls[0].headers.get("Authorization") ?? "";
  assert(auth.includes("/us-east-1/s3/aws4_request"), auth);
  assert(auth.includes("x-amz-content-sha256"), auth);
});

Deno.test("S3Client.listObjectsV2 maps prefix/max-keys/continuation-token", async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a.jsonl</Key><Size>1</Size></Contents></ListBucketResult>`,
      { status: 200 },
    )
  );
  const client = new S3Client({
    region: "eu-west-1",
    credentials: creds,
    fetchImpl,
  });
  const result = await client.listObjectsV2("bkt", {
    prefix: "base/in",
    maxKeys: 25,
    continuationToken: "tok",
  });

  const url = new URL(calls[0].url);
  assertEquals(url.origin, "https://bkt.s3.eu-west-1.amazonaws.com");
  assertEquals(url.searchParams.get("list-type"), "2");
  assertEquals(url.searchParams.get("prefix"), "base/in");
  assertEquals(url.searchParams.get("max-keys"), "25");
  assertEquals(url.searchParams.get("continuation-token"), "tok");
  assertEquals(result.contents, [{ key: "a.jsonl", size: 1 }]);
  assertEquals(result.isTruncated, false);
});

Deno.test("S3Client.deleteObject tolerates 204 and 200; errors otherwise", async () => {
  const ok = new S3Client({
    region: "us-east-1",
    credentials: creds,
    fetchImpl: (() =>
      Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch,
  });
  await ok.deleteObject("bkt", "k.jsonl"); // no throw

  const failing = new S3Client({
    region: "us-east-1",
    credentials: creds,
    fetchImpl: (() =>
      Promise.resolve(
        new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
          statusText: "Forbidden",
        }),
      )) as typeof fetch,
  });
  const err = await assertRejects(
    () => failing.deleteObject("bkt", "k.jsonl"),
    ProviderError,
  );
  assertEquals(err.status, 403);
  assert(err.body.includes("AccessDenied"));
});

Deno.test("S3Client.getObject surfaces non-OK bodies as ProviderError", async () => {
  const client = new S3Client({
    region: "us-east-1",
    credentials: creds,
    fetchImpl: (() =>
      Promise.resolve(
        new Response("<Error><Code>NoSuchKey</Code></Error>", {
          status: 404,
          statusText: "Not Found",
        }),
      )) as typeof fetch,
  });
  const err = await assertRejects(
    () => client.getObject("bkt", "missing.jsonl"),
    ProviderError,
  );
  assertEquals(err.status, 404);
  assert(err.body.includes("NoSuchKey"));
});

Deno.test("S3Client resolves credentials lazily via an async provider", async () => {
  let resolved = 0;
  const { calls, fetchImpl } = recordingFetch(() =>
    new Response("data", { status: 200 })
  );
  const client = new S3Client({
    region: "us-east-1",
    credentials: () => {
      resolved++;
      return Promise.resolve({
        accessKeyId: "AKIACHAIN",
        secretAccessKey: "chain-secret",
        sessionToken: "chain-token",
      });
    },
    fetchImpl,
  });
  const res = await client.getObject("bkt", "k.jsonl");
  assertEquals(await res.text(), "data");
  assertEquals(resolved, 1);
  const auth = calls[0].headers.get("Authorization") ?? "";
  assert(auth.includes("Credential=AKIACHAIN/"), auth);
  assertEquals(calls[0].headers.get("x-amz-security-token"), "chain-token");
});
