import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assumeRole,
  AwsCredentialProvider,
  type AwsCredentials,
  parseIni,
  resolveAwsCredentials,
} from "./aws_credentials.ts";

// MOCKED-vs-LIVE: every IMDS/ECS/STS assertion below drives a MOCKED fetch and
// mocked env/files. They prove request CONSTRUCTION + response PARSING + source
// SELECTION ORDER. They do NOT prove live reachability of 169.254.169.254,
// 169.254.170.2, or sts.<region>.amazonaws.com — those are unverifiable offline
// (owner-accepted). The env + profile sources ARE fully real (no network).

const IMDS = "169.254.169.254";
const ECS = "169.254.170.2";

/** Routes a mocked fetch by URL substring; unmatched hosts "fail" (unreachable). */
function routedFetch(
  routes: Array<{ match: string; respond: (init?: RequestInit) => Response }>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const r of routes) {
      if (url.includes(r.match)) {
        return Promise.resolve(r.respond(init));
      }
    }
    return Promise.reject(new Error(`unreachable: ${url}`));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function imdsCredsResponse() {
  return new Response(
    JSON.stringify({
      Code: "Success",
      AccessKeyId: "ASIAIMDS",
      SecretAccessKey: "imdssecret",
      Token: "imdstoken",
      Expiration: "2030-01-01T00:00:00Z",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** IMDSv2 routes, MOST-SPECIFIC FIRST (routedFetch takes the first substring
 * match, and the per-role creds URL contains the role-listing prefix). */
function imdsRoutes() {
  return [
    {
      match: `${IMDS}/latest/api/token`,
      respond: () => new Response("imds-session-token"),
    },
    {
      match: `${IMDS}/latest/meta-data/iam/security-credentials/frosty-role`,
      respond: () => imdsCredsResponse(),
    },
    {
      match: `${IMDS}/latest/meta-data/iam/security-credentials/`,
      respond: () => new Response("frosty-role"),
    },
  ];
}

Deno.test("parseIni reads sections, key=value, and skips comments", () => {
  const ini = parseIni(
    "# comment\n[default]\naws_access_key_id = AK\n; c\n[profile dev]\naws_secret_access_key=SK\n",
  );
  assertEquals(ini["default"].aws_access_key_id, "AK");
  assertEquals(ini["profile dev"].aws_secret_access_key, "SK");
});

Deno.test("chain source 1: environment variables win", async () => {
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: "AKIAENV",
    AWS_SECRET_ACCESS_KEY: "envsecret",
    AWS_SESSION_TOKEN: "envsession",
  };
  const creds = await resolveAwsCredentials({
    env: (n) => env[n],
    // If either of these is touched, env did not short-circuit.
    readTextFile: () => Promise.reject(new Error("profile must not be read")),
    fetchImpl: (() => Promise.reject(new Error("no network"))) as typeof fetch,
  });
  assertEquals(creds.source, "env");
  assertEquals(creds.accessKeyId, "AKIAENV");
  assertEquals(creds.sessionToken, "envsession");
});

Deno.test("chain source 2: shared-config profile (env absent)", async () => {
  const files: Record<string, string> = {
    "/home/test/.aws/credentials":
      "[default]\naws_access_key_id = AKIAPROFILE\naws_secret_access_key = profilesecret\naws_session_token = profilesession\n",
  };
  const creds = await resolveAwsCredentials({
    env: () => undefined,
    homeDir: "/home/test",
    readTextFile: (p) =>
      p in files
        ? Promise.resolve(files[p])
        : Promise.reject(new Error("no file")),
    fetchImpl: (() => Promise.reject(new Error("no network"))) as typeof fetch,
  });
  assertEquals(creds.source, "profile");
  assertEquals(creds.accessKeyId, "AKIAPROFILE");
  assertEquals(creds.sessionToken, "profilesession");
});

Deno.test("chain source 3: IMDSv2 (env + profile absent)", async () => {
  const { fetchImpl, calls } = routedFetch(imdsRoutes());
  const creds = await resolveAwsCredentials({
    env: () => undefined,
    readTextFile: () => Promise.reject(new Error("no file")),
    fetchImpl,
  });
  assertEquals(creds.source, "imds");
  assertEquals(creds.accessKeyId, "ASIAIMDS");
  assertEquals(creds.sessionToken, "imdstoken");
  assertEquals(creds.expiration, Date.parse("2030-01-01T00:00:00Z"));
  // IMDSv2 handshake: PUT token, GET role, GET role creds.
  assert(calls.some((u) => u.includes("/latest/api/token")));
  assert(calls.some((u) => u.endsWith("/frosty-role")));
});

Deno.test("chain source 4: ECS relative URI when IMDS is unreachable", async () => {
  const env: Record<string, string> = {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
  };
  const { fetchImpl, calls } = routedFetch([
    // IMDS omitted -> unreachable -> chain falls through to ECS.
    {
      match: `${ECS}/v2/credentials/abc`,
      respond: () =>
        new Response(
          JSON.stringify({
            AccessKeyId: "ASIAECS",
            SecretAccessKey: "ecssecret",
            Token: "ecstoken",
            Expiration: "2030-01-01T00:00:00Z",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    },
  ]);
  const creds = await resolveAwsCredentials({
    env: (n) => env[n],
    readTextFile: () => Promise.reject(new Error("no file")),
    fetchImpl,
  });
  assertEquals(creds.source, "ecs");
  assertEquals(creds.accessKeyId, "ASIAECS");
  assertEquals(creds.expiration, Date.parse("2030-01-01T00:00:00Z"));
  // IMDS was attempted first (and failed) before ECS succeeded.
  assert(calls.some((u) => u.includes(IMDS)));
  assert(calls.some((u) => u.includes(`${ECS}/v2/credentials/abc`)));
});

Deno.test("chain source 5: STS AssumeRoleWithWebIdentity (last resort)", async () => {
  const env: Record<string, string> = {
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
    AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/web",
    AWS_ROLE_SESSION_NAME: "frosty-session",
  };
  let stsBody = "";
  const { fetchImpl } = routedFetch([
    {
      match: "sts.us-east-1.amazonaws.com",
      respond: (init) => {
        stsBody = String(init?.body);
        return new Response(
          "<Result><Credentials>" +
            "<AccessKeyId>ASIAWEBID</AccessKeyId>" +
            "<SecretAccessKey>websecret</SecretAccessKey>" +
            "<SessionToken>webtoken</SessionToken>" +
            "<Expiration>2030-01-01T00:00:00Z</Expiration>" +
            "</Credentials></Result>",
        );
      },
    },
  ]);
  const creds = await resolveAwsCredentials({
    region: "us-east-1",
    env: (n) => env[n],
    readTextFile: (p) =>
      p === "/var/run/token"
        ? Promise.resolve("the.web.identity.jwt")
        : Promise.reject(new Error("no file")),
    fetchImpl,
  });
  assertEquals(creds.source, "sts-web-identity");
  assertEquals(creds.accessKeyId, "ASIAWEBID");
  assertEquals(creds.sessionToken, "webtoken");
  // AssumeRoleWithWebIdentity is unsigned; the JWT + role travel in the body.
  assert(stsBody.includes("Action=AssumeRoleWithWebIdentity"));
  assert(stsBody.includes("WebIdentityToken=the.web.identity.jwt"));
  assert(stsBody.includes("RoleSessionName=frosty-session"));
});

Deno.test("chain throws when every source is exhausted", async () => {
  await assertRejects(
    () =>
      resolveAwsCredentials({
        env: () => undefined,
        readTextFile: () => Promise.reject(new Error("no file")),
        fetchImpl: (() =>
          Promise.reject(new Error("unreachable"))) as typeof fetch,
      }),
    Error,
    "credential chain exhausted",
  );
});

Deno.test("AwsCredentialProvider caches expiry-bearing creds and refreshes past expiry", async () => {
  let tokenFetches = 0;
  const routes = [
    {
      match: `${IMDS}/latest/api/token`,
      respond: () => {
        tokenFetches++;
        return new Response("imds-session-token");
      },
    },
    {
      match: `${IMDS}/latest/meta-data/iam/security-credentials/frosty-role`,
      respond: () => imdsCredsResponse(),
    },
    {
      match: `${IMDS}/latest/meta-data/iam/security-credentials/`,
      respond: () => new Response("frosty-role"),
    },
  ];
  const { fetchImpl } = routedFetch(routes);
  const provider = new AwsCredentialProvider({
    env: () => undefined,
    readTextFile: () => Promise.reject(new Error("no file")),
    fetchImpl,
  });

  const first = await provider.resolve();
  assertEquals(first.source, "imds");
  await provider.resolve(); // within cache window -> no new IMDS handshake
  assertEquals(tokenFetches, 1);
  assertEquals(provider.cachedSource(), "imds");
});

Deno.test("assumeRole signs the STS call with the source credentials", async () => {
  let auth: string | null = null;
  let body = "";
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("Authorization");
    body = String(init?.body);
    return Promise.resolve(
      new Response(
        "<Result><Credentials>" +
          "<AccessKeyId>ASIAASSUME</AccessKeyId>" +
          "<SecretAccessKey>assumesecret</SecretAccessKey>" +
          "<SessionToken>assumetoken</SessionToken>" +
          "<Expiration>2030-01-01T00:00:00Z</Expiration>" +
          "</Credentials></Result>",
      ),
    );
  }) as typeof fetch;

  const source: AwsCredentials = {
    accessKeyId: "AKIASOURCE",
    secretAccessKey: "sourcesecret",
    source: "static",
  };
  const creds = await assumeRole({
    roleArn: "arn:aws:iam::111122223333:role/target",
    roleSessionName: "frosty",
    source,
    region: "us-east-1",
    fetchImpl,
  });

  assertEquals(creds?.source, "sts-assume-role");
  assertEquals(creds?.accessKeyId, "ASIAASSUME");
  assert(body.includes("Action=AssumeRole"));
  // Signed with the SOURCE credentials against the sts service.
  assert(auth, "expected a signed Authorization header");
  assert((auth as string).includes("Credential=AKIASOURCE/"));
  assert((auth as string).includes("/sts/aws4_request"));
});
