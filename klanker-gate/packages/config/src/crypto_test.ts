// Crypto core: the whole security surface. Mirrors the design's verification
// plan (§7) — round-trip, wrong-key, AAD/location binding, nonce uniqueness,
// migration passthrough, the fail-closed boot matrix, KEK rotation, and the
// no-secret-in-error guarantee. All tests use in-memory KV / injected DEKs.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ConfigCrypto, ConfigCryptoError, DecryptError } from "./crypto.ts";
import type { StateKey } from "./store.ts";
import { MemoryStateStore } from "./store_memory.ts";

/** A fresh, valid raw-32-byte base64 KEK source (the preferred env form). */
function rawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function dek() {
  return crypto.getRandomValues(new Uint8Array(32));
}

const PROV_X: StateKey = ["config", "providers", "x"];
const PROV_Y: StateKey = ["config", "providers", "y"];

// --------------------------------------------------------- C-RT-1 round-trip

Deno.test("C-RT-1 round-trips every secret shape", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const shapes = [
    "sk-short",
    JSON.stringify({ type: "service_account", private_key: "x".repeat(4096) }),
    "üñíçödé-🔐-secret",
    "", // empty passes through unencrypted
  ];
  for (const plain of shapes) {
    const env = await c.encryptString(PROV_X, "apiKey", plain);
    if (plain === "") {
      assertEquals(env, ""); // empty secret is not a secret
    } else {
      assert(c.isEnvelope(env), "non-empty secret must become an envelope");
      assertStringIncludes(env, "frosty.enc.v1:");
    }
    assertEquals(await c.decryptString(PROV_X, "apiKey", env), plain);
  }
});

// ------------------------------------------------------ C-WRONG-1 wrong key

Deno.test("C-WRONG-1 wrong DEK fails closed (never returns plaintext)", async () => {
  const a = await ConfigCrypto.fromRawDek(dek());
  const b = await ConfigCrypto.fromRawDek(dek());
  const env = await a.encryptString(PROV_X, "apiKey", "sk-secret");
  await assertRejects(
    () => b.decryptString(PROV_X, "apiKey", env),
    DecryptError,
  );
});

// --------------------------------------------------- C-AAD-1 location binding

Deno.test("C-AAD-1 rejects a value moved to another record or field", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const env = await c.encryptString(PROV_X, "apiKey", "sk-secret");

  // Correct location still decrypts.
  assertEquals(await c.decryptString(PROV_X, "apiKey", env), "sk-secret");
  // Lifted into another record (X -> Y): reject.
  await assertRejects(
    () => c.decryptString(PROV_Y, "apiKey", env),
    DecryptError,
  );
  // Moved cross-field within the same record: reject.
  await assertRejects(
    () => c.decryptString(PROV_X, "awsSecretAccessKey", env),
    DecryptError,
  );
});

// -------------------------------------------------- C-IV-1 nonce uniqueness

Deno.test("C-IV-1 same plaintext yields distinct non-deterministic envelopes", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const envs = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const env = await c.encryptString(PROV_X, "apiKey", "same-value");
    envs.add(env);
    assertEquals(await c.decryptString(PROV_X, "apiKey", env), "same-value");
  }
  assertEquals(envs.size, 50); // no deterministic-equality leakage
});

// ---------------------------------------------------- C-PATH-1 path binding

Deno.test("C-PATH-1 envelopes do not cross-decrypt between key paths", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const atX = await c.encryptString(PROV_X, "apiKey", "sk-secret");
  const atY = await c.encryptString(PROV_Y, "apiKey", "sk-secret");
  assertNotEquals(atX, atY);
  await assertRejects(
    () => c.decryptString(PROV_Y, "apiKey", atX),
    DecryptError,
  );
  await assertRejects(
    () => c.decryptString(PROV_X, "apiKey", atY),
    DecryptError,
  );
});

// ------------------------------------------------ C-MIG-1 plaintext readable

Deno.test("C-MIG-1 legacy plaintext (no sentinel) reads back unchanged", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  // A real credential can never begin with the sentinel.
  assertEquals(
    await c.decryptString(PROV_X, "apiKey", "sk-legacy-plain"),
    "sk-legacy-plain",
  );
  assertEquals(await c.decryptString(PROV_X, "apiKey", ""), "");
});

// ---------------------------------------------------- record-level transforms

Deno.test("encryptRecord/decryptRecord cover every provider secret field", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const provider = {
    id: "x",
    type: "bedrock",
    apiKey: "sk-secret",
    awsAccessKeyId: "AKIA-PUBLIC", // identifier: stays plaintext by design
    awsSecretAccessKey: "aws-secret",
    awsSessionToken: "aws-session",
    serviceAccountJson: '{"private_key":"pk"}',
    proxyUrl: "http://user:pass@proxy:8080",
    models: ["m"],
    enabled: true,
    priority: 0,
    proxy: { proxyPassword: "proxy-pw", noProxy: [".private"] },
    network: {
      caCertPem: "-----BEGIN CERT-----",
      extraHeaders: [{ name: "X-Api-Key", value: "header-secret" }],
    },
  };
  const enc = await c.encryptRecord("provider", PROV_X, provider);

  // Every secret leaf is now an envelope; non-secrets untouched.
  for (
    const f of [
      "apiKey",
      "awsSecretAccessKey",
      "awsSessionToken",
      "serviceAccountJson",
      "proxyUrl",
    ]
  ) {
    assert(
      c.isEnvelope((enc as Record<string, unknown>)[f] as string),
      `${f} must be encrypted`,
    );
  }
  assert(c.isEnvelope((enc.proxy as { proxyPassword: string }).proxyPassword));
  assert(c.isEnvelope((enc.proxy as { noProxy: string[] }).noProxy[0]));
  assert(c.isEnvelope((enc.network as { caCertPem: string }).caCertPem));
  assert(c.isEnvelope(
    (enc.network as { extraHeaders: Array<{ value: string }> }).extraHeaders[0]
      .value,
  ));
  assertEquals(enc.awsAccessKeyId, "AKIA-PUBLIC"); // identifier untouched
  assertEquals(enc.id, "x");
  assertEquals(enc.models, ["m"]);

  // Source object is not mutated (transform returns a new object).
  assertEquals(provider.apiKey, "sk-secret");

  // Full decrypt restores the original.
  const dec = await c.decryptRecord("provider", PROV_X, enc);
  assertEquals(dec, provider);
});

Deno.test("virtualKey token and MCP header VALUES encrypt; names stay visible", async () => {
  const c = await ConfigCrypto.fromRawDek(dek());
  const vkKey: StateKey = ["governance", "virtual-keys", "k1"];
  const vk = { id: "k1", name: "n", token: "vk-bearer-secret", enabled: true };
  const encVk = await c.encryptRecord("virtualKey", vkKey, vk);
  assert(c.isEnvelope(encVk.token));
  assertEquals(
    (await c.decryptRecord("virtualKey", vkKey, encVk)).token,
    "vk-bearer-secret",
  );

  const mcpKey: StateKey = ["mcp", "clients", "m1"];
  const mcp = {
    id: "m1",
    headers: { Authorization: "Bearer xyz", "X-Api-Key": "k" },
    enabled: true,
  };
  const encMcp = await c.encryptRecord("mcpClient", mcpKey, mcp);
  const headers = encMcp.headers as Record<string, string>;
  assert(c.isEnvelope(headers["Authorization"]));
  assert(c.isEnvelope(headers["X-Api-Key"]));
  // Header names (map keys) are NOT secret and remain visible.
  assertEquals(Object.keys(headers).sort(), ["Authorization", "X-Api-Key"]);
  assertEquals(
    (await c.decryptRecord("mcpClient", mcpKey, encMcp)).headers,
    mcp.headers,
  );
});

// --------------------------------------------- fail-closed boot matrix (§4.4)

Deno.test("C-COMPAT-1 unset key + no record => plaintext mode, no record written", async () => {
  const store = new MemoryStateStore();
  try {
    const c = await ConfigCrypto.fromEnv(store, { key: undefined });
    assertEquals(c, undefined); // plaintext path
    assertEquals(await ConfigCrypto.isEnabled(store), false);
    assertEquals(await store.get(["config", "crypto", "dek"]), null);
  } finally {
    store.close();
  }
});

Deno.test("enable on a fresh store writes the crypto record and encrypts", async () => {
  const store = new MemoryStateStore();
  const key = rawKey();
  try {
    const c = await ConfigCrypto.fromEnv(store, { key });
    assert(c !== undefined);
    assertEquals(await ConfigCrypto.isEnabled(store), true);
    // Re-open with the SAME key: finds the record, unwraps, canary OK.
    const c2 = await ConfigCrypto.fromEnv(store, { key });
    assert(c2 !== undefined);
    // Both instances share the persisted DEK -> cross-decrypt works.
    const env = await c!.encryptString(PROV_X, "apiKey", "sk-secret");
    assertEquals(await c2!.decryptString(PROV_X, "apiKey", env), "sk-secret");
  } finally {
    store.close();
  }
});

Deno.test("C-FAIL-1 encrypted data present + key absent => refuse to boot", async () => {
  const store = new MemoryStateStore();
  try {
    await ConfigCrypto.fromEnv(store, { key: rawKey() }); // enable
    await assertRejects(
      () => ConfigCrypto.fromEnv(store, { key: undefined }),
      ConfigCryptoError,
      "FROSTY_ENCRYPTION_KEY is not set",
    );
  } finally {
    store.close();
  }
});

Deno.test("C-WRONG-1(boot) wrong key + existing record => refuse to boot", async () => {
  const store = new MemoryStateStore();
  try {
    await ConfigCrypto.fromEnv(store, { key: rawKey() }); // enable under key A
    await assertRejects(
      () => ConfigCrypto.fromEnv(store, { key: rawKey() }), // key B
      ConfigCryptoError,
      "does not match this store",
    );
  } finally {
    store.close();
  }
});

Deno.test("passphrase (PBKDF2) KEK enables and re-derives across boots", async () => {
  const store = new MemoryStateStore();
  const key = "correct horse battery staple"; // not 32 raw bytes -> PBKDF2
  try {
    const c = await ConfigCrypto.fromEnv(store, { key });
    const env = await c!.encryptString(PROV_X, "apiKey", "sk-secret");
    const c2 = await ConfigCrypto.fromEnv(store, { key }); // re-derive w/ stored salt
    assertEquals(await c2!.decryptString(PROV_X, "apiKey", env), "sk-secret");
    // Wrong passphrase against the same store still fails closed.
    await assertRejects(
      () => ConfigCrypto.fromEnv(store, { key: "wrong passphrase entirely" }),
      ConfigCryptoError,
    );
  } finally {
    store.close();
  }
});

// -------------------------------------------------------- C-ROT-1 KEK rotation

Deno.test("C-ROT-1 KEK rotation rewraps the DEK; data reads under the new key only", async () => {
  const store = new MemoryStateStore();
  const k1 = rawKey();
  const k2 = rawKey();
  try {
    const c1 = await ConfigCrypto.fromEnv(store, { key: k1 });
    const env = await c1!.encryptString(PROV_X, "apiKey", "sk-secret");
    const recordBefore = await store.get(["config", "crypto", "dek"]);

    await ConfigCrypto.rotateKek(store, k1, k2);

    // The wrapped-DEK record changed...
    assertNotEquals(await store.get(["config", "crypto", "dek"]), recordBefore);
    // ...but existing ciphertext (encrypted under the unchanged DEK) still reads
    // under the NEW key, and the OLD key no longer opens the store.
    const cNew = await ConfigCrypto.fromEnv(store, { key: k2 });
    assertEquals(await cNew!.decryptString(PROV_X, "apiKey", env), "sk-secret");
    await assertRejects(
      () => ConfigCrypto.fromEnv(store, { key: k1 }),
      ConfigCryptoError,
    );
    // Rotating with a wrong old key aborts without touching the record.
    await assertRejects(
      () => ConfigCrypto.rotateKek(store, rawKey(), rawKey()),
      ConfigCryptoError,
    );
  } finally {
    store.close();
  }
});

// ------------------------------------------------------ C-LOG-1 no-secret-leak

Deno.test("C-LOG-1 decrypt error carries no plaintext, ciphertext, or key", async () => {
  const a = await ConfigCrypto.fromRawDek(dek());
  const b = await ConfigCrypto.fromRawDek(dek());
  const secret = "sk-super-secret-plaintext-value";
  const env = await a.encryptString(PROV_X, "apiKey", secret);
  try {
    await b.decryptString(PROV_X, "apiKey", env);
    throw new Error("expected DecryptError");
  } catch (error) {
    assert(error instanceof DecryptError);
    const msg = error.message;
    assert(!msg.includes(secret), "plaintext leaked in error");
    assert(
      !msg.includes(env.slice("frosty.enc.v1:".length)),
      "ciphertext leaked",
    );
    // Useful, non-secret context is present.
    assertStringIncludes(msg, "apiKey");
    assertStringIncludes(msg, "config/providers");
  }
});
