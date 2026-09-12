import { assert, assertEquals } from "@std/assert";
import { canonicalUri, canonicalUriS3, signRequest } from "./sigv4.ts";

// Official AWS Signature Version 4 test vector ("Task 1-4" worked example in
// the AWS General Reference sigv4 documentation). If canonicalization drifts,
// this exact signature stops matching.

Deno.test("sigv4: matches the official AWS doc test vector", async () => {
  const headers = await signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: "",
    region: "us-east-1",
    service: "iam",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: new Date("2015-08-30T12:36:00Z"),
  });

  assertEquals(headers["x-amz-date"], "20150830T123600Z");
  assertEquals(
    headers["Authorization"],
    "AWS4-HMAC-SHA256 " +
      "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-date, " +
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

Deno.test("sigv4: canonicalUri double-encodes segments, '/' passes through", () => {
  // Bedrock model ids carry ':' (%3A on the wire) -> %253A in the canonical.
  assertEquals(
    canonicalUri("/model/anthropic.claude-3%3A0/converse"),
    "/model/anthropic.claude-3%253A0/converse",
  );
  assertEquals(canonicalUri("/"), "/");
});

Deno.test("sigv4: session token joins the signed headers", async () => {
  const headers = await signRequest({
    method: "POST",
    url: "https://bedrock-runtime.eu-west-1.amazonaws.com/model/m/converse",
    headers: { "content-type": "application/json" },
    body: "{}",
    region: "eu-west-1",
    service: "bedrock",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    sessionToken: "session-token",
    date: new Date("2026-07-13T00:00:00Z"),
  });
  assertEquals(headers["x-amz-security-token"], "session-token");
  assert(
    headers["Authorization"].includes(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,",
    ),
  );
});

// --- S3 signing mode ---------------------------------------------------------

// Official AWS doc test vector for S3 SigV4 ("Example: GET Object" in the
// Amazon S3 REST authentication documentation). Pins the S3 profile: the
// canonical URI is single-encoded and x-amz-content-sha256 joins the signed
// headers automatically.
Deno.test("sigv4: S3 mode matches the official AWS S3 doc test vector", async () => {
  const headers = await signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    body: "",
    region: "us-east-1",
    service: "s3",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
  });

  assertEquals(headers["x-amz-date"], "20130524T000000Z");
  // Empty payload hash is emitted as the mandatory content header.
  assertEquals(
    headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    headers["Authorization"],
    "AWS4-HMAC-SHA256 " +
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

Deno.test("sigv4: canonicalUriS3 single-encodes, never decode-then-re-encode", () => {
  // Existing escapes (from escapeS3Key) are preserved verbatim, not doubled.
  assertEquals(
    canonicalUriS3("/bifrost-batch-input/a%20b%3Ac.jsonl"),
    "/bifrost-batch-input/a%20b%3Ac.jsonl",
  );
  // Literal specials that reached the path un-encoded are encoded once.
  assertEquals(
    canonicalUriS3("/pre fix/key:1.jsonl"),
    "/pre%20fix/key%3A1.jsonl",
  );
  assertEquals(canonicalUriS3("/"), "/");
  // Contrast: the non-S3 rule double-encodes the same input.
  assertEquals(
    canonicalUri("/bifrost-batch-input/a%20b%3Ac.jsonl"),
    "/bifrost-batch-input/a%2520b%253Ac.jsonl",
  );
});

Deno.test("sigv4: Uint8Array body signs byte-identically to the same string", async () => {
  const input = {
    method: "POST",
    url: "https://bedrock.us-east-1.amazonaws.com/model-invocation-job",
    headers: { "content-type": "application/json" },
    region: "us-east-1",
    service: "bedrock",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    date: new Date("2026-07-16T00:00:00Z"),
  };
  const asString = await signRequest({ ...input, body: '{"jobName":"j"}' });
  const asBytes = await signRequest({
    ...input,
    body: new TextEncoder().encode('{"jobName":"j"}'),
  });
  assertEquals(asBytes["Authorization"], asString["Authorization"]);
});

Deno.test("sigv4: non-S3 services do not gain x-amz-content-sha256", async () => {
  const headers = await signRequest({
    method: "POST",
    url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse",
    headers: { "content-type": "application/json" },
    body: "{}",
    region: "us-east-1",
    service: "bedrock",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    date: new Date("2026-07-16T00:00:00Z"),
  });
  assertEquals(headers["x-amz-content-sha256"], undefined);
});
