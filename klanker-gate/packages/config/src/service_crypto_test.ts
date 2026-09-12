// ConfigService <-> ConfigCrypto wiring: encrypt-on-write / decrypt-on-read at
// the persistence boundary, the opt-in/backward-compat guarantee, lazy
// migration, the unchanged public views, export/import transparency, and the
// fail-closed boot gate. Verification plan §7.2-§7.4.

import { assert, assertEquals } from "@std/assert";
import { ConfigService } from "./service.ts";
import { ConfigCrypto, ConfigCryptoError } from "./crypto.ts";
import { redactProviderAccount } from "../../contracts/src/config.ts";
import { publicVirtualKey } from "../../governance/src/virtual_keys.ts";
import type { ProviderAccountConfig } from "../../contracts/src/mod.ts";

const SENTINEL = "frosty.enc.v1:";

function rawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Production two-phase boot wiring: open store, derive crypto, attach it. */
async function openEncrypted(
  path: string | undefined,
  key: string,
): Promise<ConfigService> {
  const svc = await ConfigService.open(path);
  svc.setCrypto(await ConfigCrypto.fromEnv(svc.raw(), { key }));
  return svc;
}

function fullProvider(id = "x"): ProviderAccountConfig {
  return {
    id,
    type: "bedrock",
    apiKey: "sk-secret",
    awsAccessKeyId: "AKIA-PUBLIC",
    awsSecretAccessKey: "aws-secret",
    awsSessionToken: "aws-session",
    serviceAccountJson: '{"private_key":"pk"}',
    proxyUrl: "http://user:pass@proxy:8080",
    enabled: true,
    models: ["m"],
    priority: 0,
    proxy: { proxyPassword: "proxy-pw", noProxy: [".private"] },
    network: {
      caCertPem: "-----BEGIN CERT-----",
      extraHeaders: [{ name: "X-Api-Key", value: "header-secret" }],
    },
  };
}

// -------------------------------------------- C-MIG-2 encrypt-on-next-write

Deno.test("C-MIG-2 upsert writes envelopes at rest; reads return plaintext", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    await svc.upsertProvider(fullProvider());

    // Raw KV shows ciphertext for every secret, plaintext for metadata.
    const raw = await svc.raw().get<Record<string, unknown>>([
      "config",
      "providers",
      "x",
    ]);
    assert(String(raw!.apiKey).startsWith(SENTINEL));
    assert(String(raw!.awsSecretAccessKey).startsWith(SENTINEL));
    assert(String(raw!.serviceAccountJson).startsWith(SENTINEL));
    assert(String(raw!.proxyUrl).startsWith(SENTINEL));
    assert(
      String((raw!.proxy as Record<string, string>).proxyPassword).startsWith(
        SENTINEL,
      ),
    );
    assert(
      String((raw!.network as Record<string, string>).caCertPem).startsWith(
        SENTINEL,
      ),
    );
    assert(
      String(
        (raw!.network as { extraHeaders: Array<{ value: string }> })
          .extraHeaders[0].value,
      ).startsWith(SENTINEL),
    );
    assertEquals(raw!.id, "x"); // metadata untouched
    assertEquals(raw!.awsAccessKeyId, "AKIA-PUBLIC"); // identifier untouched
    assertEquals(raw!.models, ["m"]);

    // Service reads decrypt transparently.
    const got = await svc.getProvider("x");
    assertEquals(got, fullProvider());
    const all = await svc.loadAll();
    assertEquals(all.providers[0], fullProvider());
  } finally {
    svc.close();
  }
});

// -------------------------------------------- C-MIG-1 legacy plaintext coexist

Deno.test("C-MIG-1 legacy plaintext record reads back with the key enabled", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    // Simulate a pre-encryption record written straight to KV (no sentinel).
    await svc.raw().set(
      ["config", "providers", "legacy"],
      fullProvider("legacy"),
    );
    const got = await svc.getProvider("legacy");
    assertEquals(got, fullProvider("legacy")); // returned unchanged
  } finally {
    svc.close();
  }
});

Deno.test("global proxy secrets are encrypted at rest and decrypt on read", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    const proxy = {
      proxyUrl: "https://proxy.internal:8443",
      proxyUsername: "operator",
      proxyPassword: "secret",
      noProxy: [".private.example"],
    };
    await svc.setGlobalProxy(proxy);
    const raw = await svc.raw().get<Record<string, unknown>>([
      "config",
      "global-proxy",
    ]);
    assert(String(raw!.proxyUrl).startsWith(SENTINEL));
    assert(String(raw!.proxyUsername).startsWith(SENTINEL));
    assert(String(raw!.proxyPassword).startsWith(SENTINEL));
    assert(String((raw!.noProxy as string[])[0]).startsWith(SENTINEL));
    assertEquals(await svc.getGlobalProxy(), proxy);
  } finally {
    svc.close();
  }
});

// ------------------------------------------ C-COMPAT-1 unset key = plaintext

Deno.test("C-COMPAT-1 no crypto => byte-identical plaintext, no crypto record", async () => {
  const svc = await ConfigService.open(":memory:"); // no setCrypto
  try {
    await svc.upsertProvider(fullProvider());
    const raw = await svc.raw().get<Record<string, unknown>>([
      "config",
      "providers",
      "x",
    ]);
    assertEquals(raw!.apiKey, "sk-secret"); // plaintext at rest, exactly as today
    assertEquals(await ConfigCrypto.isEnabled(svc.raw()), false); // no record created
    assertEquals(await svc.getProvider("x"), fullProvider());
  } finally {
    svc.close();
  }
});

// --------------------------------------------- persistence across a restart

Deno.test("encrypted config survives a service restart on the same store", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.kv`;
  const key = rawKey();
  try {
    const first = await openEncrypted(path, key);
    await first.upsertProvider(fullProvider());
    first.close();

    const second = await openEncrypted(path, key);
    const loaded = await second.loadAll();
    // Raw is still ciphertext; the loaded view is plaintext.
    const raw = await second.raw().get<Record<string, unknown>>([
      "config",
      "providers",
      "x",
    ]);
    second.close();

    assert(String(raw!.apiKey).startsWith(SENTINEL));
    assertEquals(loaded.providers[0], fullProvider());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ------------------------------------------------ C-PUB-1 public view unchanged

Deno.test("C-PUB-1 redacted provider view is byte-identical ± encryption", async () => {
  const plain = await ConfigService.open(":memory:");
  const enc = await openEncrypted(":memory:", rawKey());
  try {
    await plain.upsertProvider(fullProvider());
    await enc.upsertProvider(fullProvider());

    const rPlain = redactProviderAccount((await plain.loadAll()).providers[0]);
    const rEnc = redactProviderAccount((await enc.loadAll()).providers[0]);
    assertEquals(rEnc, rPlain); // golden: identical public output

    // No envelope ever reaches the public view.
    assert(!JSON.stringify(rEnc).includes(SENTINEL));
    // But the value AT REST is encrypted (proves redaction runs post-decrypt).
    const raw = await enc.raw().get<Record<string, unknown>>([
      "config",
      "providers",
      "x",
    ]);
    assert(String(raw!.apiKey).startsWith(SENTINEL));
  } finally {
    plain.close();
    enc.close();
  }
});

Deno.test("C-PUB-1 virtual-key public view + token round-trip", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    const vk = {
      id: "k1",
      name: "n",
      token: "vk-bearer-secret",
      enabled: true,
    };
    await svc.upsertVirtualKey({ ...vk, usedRequests: 0, usedCostMicroUsd: 0 });

    const raw = await svc.raw().get<Record<string, unknown>>([
      "governance",
      "virtual-keys",
      "k1",
    ]);
    assert(String(raw!.token).startsWith(SENTINEL)); // encrypted at rest

    const [loaded] = await svc.listVirtualKeys();
    assertEquals(loaded.token, "vk-bearer-secret"); // plaintext in memory
    const pub = publicVirtualKey(loaded);
    assertEquals(pub.tokenHint, "…cret"); // last-4 hint, no token body, no envelope
    assert(!JSON.stringify(pub).includes(SENTINEL));
  } finally {
    svc.close();
  }
});

Deno.test("MCP client header values encrypt at rest; list returns plaintext", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    await svc.upsertMCPClient({
      id: "m1",
      url: "https://mcp.example",
      headers: { Authorization: "Bearer xyz" },
      enabled: true,
      transport: "http-sse",
      requestTimeoutMs: 30_000,
    });
    const raw = await svc.raw().get<Record<string, unknown>>([
      "mcp",
      "clients",
      "m1",
    ]);
    assert(
      String((raw!.headers as Record<string, string>).Authorization).startsWith(
        SENTINEL,
      ),
    );

    const [loaded] = await svc.listMCPClients();
    assertEquals(loaded.headers?.Authorization, "Bearer xyz");
  } finally {
    svc.close();
  }
});

// --------------------------------------------- C-EXPORT-1 export/import round

Deno.test("C-EXPORT-1 export redacts/reveals; import re-persists encrypted", async () => {
  const svc = await openEncrypted(":memory:", rawKey());
  try {
    await svc.upsertProvider(fullProvider());

    const redacted = await svc.exportConfig(false);
    // M1 fix: a redacted export must strip ALL provider secrets (not just
    // apiKey) via the canonical redaction - none of the AWS/GCP/proxy/cert
    // secret VALUES may appear, and no ciphertext sentinel either.
    const redactedJson = JSON.stringify(redacted);
    for (
      const leak of [
        "sk-secret",
        "aws-secret",
        "aws-session",
        "proxy-pw",
        "user:pass",
        "BEGIN CERT",
        "private_key",
        SENTINEL,
      ]
    ) {
      assert(!redactedJson.includes(leak), `redacted export leaked "${leak}"`);
    }
    const rp = redacted.config.providers[0] as Record<string, unknown>;
    assertEquals(rp.apiKey, undefined);
    assertEquals(rp.hasApiKey, true);
    assertEquals(rp.awsAccessKeyId, "AKIA-PUBLIC"); // identifier kept, not secret
    const full = await svc.exportConfig(true);
    assertEquals(full.config.providers[0].apiKey, "sk-secret"); // decrypted plaintext

    // Re-import into a fresh encrypted store: persisted values are ciphertext,
    // the loaded view is plaintext again.
    const twin = await openEncrypted(":memory:", rawKey());
    await twin.importConfig(full);
    const raw = await twin.raw().get<Record<string, unknown>>([
      "config",
      "providers",
      "x",
    ]);
    assert(String(raw!.apiKey).startsWith(SENTINEL));
    assertEquals((await twin.loadAll()).providers[0].apiKey, "sk-secret");
    twin.close();
  } finally {
    svc.close();
  }
});

// ------------------------------------------------- boot fail-closed (service)

Deno.test("boot refuses when encrypted data exists but the key is gone", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.kv`;
  try {
    const first = await openEncrypted(path, rawKey());
    await first.upsertProvider(fullProvider());
    first.close();

    // Reopen the same store and derive crypto with NO key -> fail closed.
    const svc = await ConfigService.open(path);
    let threw = false;
    try {
      await ConfigCrypto.fromEnv(svc.raw(), { key: undefined });
    } catch (error) {
      threw = error instanceof ConfigCryptoError;
    }
    svc.close();
    assert(threw, "expected fail-closed ConfigCryptoError");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
