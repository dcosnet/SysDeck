import type { StateKey, StateStore } from "./store.ts";

/** Wire discriminator + version for an encrypted string leaf. */
const ENVELOPE_PREFIX = "frosty.enc.v1:";
/** KV location of the wrapped-DEK bootstrap record (the "encryption enabled" signal). */
const DEK_KEY: StateKey = ["config", "crypto", "dek"];
/** Fixed AAD for the DEK wrap (binds the wrapped DEK to its role). */
const WRAP_AAD = "frosty.dek.wrap.v1";
/** Fixed AAD + known constant for the boot canary (verifies the key before serving). */
const CANARY_AAD = "frosty.canary.v1";
const CANARY_PLAINTEXT = "frosty.canary.v1.ok";
/** OWASP-2023 PBKDF2-HMAC-SHA256 work factor for passphrase-derived KEKs. */
const PBKDF2_ITERATIONS = 600_000;
/** AAD field separator (unit separator, never appears in a KV key or field path). */
const AAD_SEP = "\x1f";
/** AAD structural version (re-binds ciphertext across a future format bump). */
const AAD_VERSION = "1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Deno's lib types bare `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which
// WebCrypto's BufferSource params reject. Every buffer we create is genuinely
// ArrayBuffer-backed (never SharedArrayBuffer), so we pin the byte type.
type Bytes = Uint8Array<ArrayBuffer>;

// --------------------------------------------------------------- error types

/**
 * Boot/setup failure (fail-closed). Message names FROSTY_ENCRYPTION_KEY but
 * NEVER its value, the DEK, or any secret.
 */
export class ConfigCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigCryptoError";
  }
}

/**
 * Per-field decrypt failure (wrong key, tampered ciphertext, or AAD/location
 * mismatch). Carries only a record-kind label + field path — never plaintext,
 * ciphertext, key, or IV. This is the fail-closed signal for a single value.
 */
export class DecryptError extends Error {
  constructor(kind: string, fieldPath: string) {
    super(
      `config decrypt failed for ${kind} field "${fieldPath}" ` +
        `(wrong key, tampered ciphertext, or location mismatch)`,
    );
    this.name = "DecryptError";
  }
}

// ---------------------------------------------------------- SECRET_FIELDS set

export type RecordKind =
  | "provider"
  | "virtualKey"
  | "mcpClient"
  | "globalProxy";

/**
 * Single source of truth for which string leaves are encrypted at rest, keyed
 * by record kind. This set MUST stay in lockstep with the redaction boundaries:
 *   * provider  <-> redactProviderAccount  (packages/contracts/src/config.ts)
 *   * virtualKey <-> publicVirtualKey       (packages/governance/src/virtual_keys.ts)
 * If a secret field is added to redaction, add its path here too (and vice
 * versa) — the two are deliberately the same set so at-rest encryption and the
 * public views can never drift.
 *
 * Path grammar: "field" (top level), "group.field" (one level of nesting),
 * "group.*" (every string leaf in a map/list) and paths with an interior
 * wildcard such as "network.extraHeaders.*.value". Header names stay visible;
 * each value is encrypted.
 */
export const SECRET_FIELDS: Record<RecordKind, readonly string[]> = {
  // Exactly the set redactProviderAccount strips. awsAccessKeyId is an
  // identifier (kept in the public view), so it stays plaintext by design.
  provider: [
    "apiKey",
    "awsSecretAccessKey",
    "awsSessionToken",
    "serviceAccountJson",
    "proxyUrl",
    "proxy.proxyPassword",
    "proxy.noProxy.*",
    "network.caCertPem",
    "network.extraHeaders.*.value",
  ],
  // Bearer secret; publicVirtualKey reduces it to a 6-char hint.
  virtualKey: ["token"],
  // MCP-server auth: every header value. Header names are not secret.
  mcpClient: ["headers.*"],
  // Every global proxy field can disclose routing or credentials. The public
  // route returns status metadata only, so encryption follows that boundary.
  globalProxy: ["proxyUrl", "proxyUsername", "proxyPassword", "noProxy.*"],
};

// --------------------------------------------------------------- base64 utils

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function binaryToBytes(binary: string): Bytes {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Standard base64 (used for the internal DEK record blobs + env raw-key decode). */
function b64encode(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}
function b64decode(value: string): Bytes {
  return binaryToBytes(atob(value));
}

/** base64url without padding (used for the on-value envelope payload). */
function b64urlEncode(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
function b64urlDecode(value: string): Bytes {
  const std = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  return b64decode(std + pad);
}

// ------------------------------------------------------------------ KDF + DEK

interface KdfRaw {
  name: "raw";
}
interface KdfPbkdf2 {
  name: "PBKDF2-SHA256";
  iterations: number;
  salt: string; // base64
}
type KdfParams = KdfRaw | KdfPbkdf2;

interface GcmBlob {
  alg?: "A256GCM";
  iv: string; // base64
  ct: string; // base64 (ciphertext || 16-byte tag)
}

interface DekRecord {
  v: 1;
  kdf: KdfParams;
  wrap: GcmBlob;
  canary: { iv: string; ct: string };
  createdAt: string;
}

/** A base64 value of EXACTLY 32 bytes is used raw as the KEK (preferred form). */
function looksLikeRaw32(envValue: string): boolean {
  try {
    return b64decode(envValue).length === 32;
  } catch {
    return false;
  }
}

/** Decides the KDF for a fresh enable: raw-32 preferred, else PBKDF2 + salt. */
function detectKdf(envKey: string): KdfParams {
  if (looksLikeRaw32(envKey)) return { name: "raw" };
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)));
  return { name: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt };
}

/** Derives the 256-bit KEK from the env key per the persisted KDF params. */
async function deriveKek(envKey: string, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.name === "raw") {
    const raw = b64decode(envKey);
    if (raw.length !== 32) {
      throw new ConfigCryptoError(
        "FROSTY_ENCRYPTION_KEY is not a 32-byte base64 key for this store.",
      );
    }
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(envKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64decode(kdf.salt),
      iterations: kdf.iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Imports raw DEK bytes as a non-extractable AES-GCM key for field ops. */
function importDek(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

async function wrapDek(kek: CryptoKey, dek: Bytes): Promise<GcmBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(WRAP_AAD) },
      kek,
      dek,
    ),
  );
  return { alg: "A256GCM", iv: b64encode(iv), ct: b64encode(ct) };
}

/** Unwraps the DEK; throws (caught by fromEnv => fail-closed) on a wrong KEK. */
async function unwrapDek(kek: CryptoKey, wrap: GcmBlob): Promise<Bytes> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64decode(wrap.iv),
      additionalData: encoder.encode(WRAP_AAD),
    },
    kek,
    b64decode(wrap.ct),
  );
  return new Uint8Array(plain);
}

async function makeCanary(
  dekKey: CryptoKey,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(CANARY_AAD) },
      dekKey,
      encoder.encode(CANARY_PLAINTEXT),
    ),
  );
  return { iv: b64encode(iv), ct: b64encode(ct) };
}

async function verifyCanary(
  dekKey: CryptoKey,
  canary: { iv: string; ct: string },
): Promise<boolean> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: b64decode(canary.iv),
        additionalData: encoder.encode(CANARY_AAD),
      },
      dekKey,
      b64decode(canary.ct),
    );
    return decoder.decode(new Uint8Array(plain)) === CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Record-kind label for error messages (never a secret): e.g. "config/providers". */
function kindLabel(kvKeyPath: StateKey): string {
  return kvKeyPath.slice(0, 2).map(String).join("/") || "config";
}

// --------------------------------------------------------------- ConfigCrypto

type FieldOp = (
  kvKeyPath: StateKey,
  fieldPath: string,
  value: string,
) => Promise<string>;

/**
 * Envelope-encryption engine for config secrets. Construct via {@link fromEnv}
 * (production boot) or {@link fromRawDek} (tests / advanced key injection).
 *
 * Only the imported DEK key is retained on the instance — the raw DEK bytes are
 * deliberately NOT held after unwrap (less key material in memory). KEK rotation
 * ({@link rotateKek}) re-unwraps the DEK from the record with the old key, so it
 * needs no retained raw bytes and touches only the wrapped-DEK record.
 */
export class ConfigCrypto {
  private constructor(private readonly dekKey: CryptoKey) {}

  /**
   * Boot entry point. Runs the fail-closed matrix:
   *   key unset + no record   => undefined (plaintext mode = today's behavior)
   *   key unset + record       => THROW (encrypted data, no key)
   *   key set  + record        => derive/unwrap/canary; THROW on mismatch
   *   key set  + no record     => enable: generate DEK, write wrapped-DEK + canary
   *
   * Pass `env` explicitly (tests) to bypass Deno.env; omit it in production.
   */
  static async fromEnv(
    store: StateStore,
    env?: { key?: string },
  ): Promise<ConfigCrypto | undefined> {
    const rawKey = env === undefined
      ? Deno.env.get("FROSTY_ENCRYPTION_KEY")
      : env.key;
    const key = (rawKey ?? "").trim();
    const record = await store.get<DekRecord>(DEK_KEY);

    if (!key) {
      if (record) {
        // Encrypted data present but the key is gone: never guess, never
        // downgrade to plaintext. One-way door.
        throw new ConfigCryptoError(
          "Encrypted config present but FROSTY_ENCRYPTION_KEY is not set. " +
            "Restore the key to boot (the store cannot be read without it).",
        );
      }
      return undefined; // opt-in: byte-identical plaintext path
    }

    if (record) {
      let dekRaw: Bytes;
      try {
        const kek = await deriveKek(key, record.kdf);
        dekRaw = await unwrapDek(kek, record.wrap);
      } catch {
        throw new ConfigCryptoError(
          "FROSTY_ENCRYPTION_KEY does not match this store (or the crypto " +
            "record is corrupt). Refusing to serve.",
        );
      }
      const dekKey = await importDek(dekRaw);
      if (!(await verifyCanary(dekKey, record.canary))) {
        throw new ConfigCryptoError(
          "FROSTY_ENCRYPTION_KEY does not match this store (canary check " +
            "failed). Refusing to serve.",
        );
      }
      return new ConfigCrypto(dekKey);
    }

    // Fresh enable on a store with no crypto record yet.
    const kdf = detectKdf(key);
    if (kdf.name !== "raw" && key.length < 16) {
      // Warn (do not fail) on a weak passphrase — never echo the value.
      console.warn(
        "FROSTY_ENCRYPTION_KEY is a short passphrase (<16 chars). Prefer a " +
          "32-byte base64 key: `openssl rand -base64 32`.",
      );
    }
    const kek = await deriveKek(key, kdf);
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const dekKey = await importDek(dekRaw);
    const record2: DekRecord = {
      v: 1,
      kdf,
      wrap: await wrapDek(kek, dekRaw),
      canary: await makeCanary(dekKey),
      createdAt: new Date().toISOString(),
    };
    await store.set(DEK_KEY, record2);
    return new ConfigCrypto(dekKey);
  }

  /** Builds a crypto bound to a known 32-byte DEK (tests / advanced injection). */
  static async fromRawDek(dek: Bytes): Promise<ConfigCrypto> {
    if (dek.length !== 32) {
      throw new ConfigCryptoError("DEK must be exactly 32 bytes.");
    }
    return new ConfigCrypto(await importDek(dek));
  }

  /** True when this store has encryption enabled (a crypto record exists). */
  static async isEnabled(store: StateStore): Promise<boolean> {
    return (await store.get<DekRecord>(DEK_KEY)) !== null;
  }

  /**
   * KEK rotation (offline, cheap): unwrap the DEK with the old key, rewrap with
   * the new key, and rewrite ONLY the wrapped-DEK record. No data record is
   * touched — this is the envelope payoff (the DEK, and thus every ciphertext,
   * is unchanged). Throws if the old key does not match.
   */
  static async rotateKek(
    store: StateStore,
    oldKey: string,
    newKey: string,
  ): Promise<void> {
    const record = await store.get<DekRecord>(DEK_KEY);
    if (!record) {
      throw new ConfigCryptoError("No crypto record to rotate.");
    }
    let dekRaw: Bytes;
    try {
      const oldKek = await deriveKek(oldKey.trim(), record.kdf);
      dekRaw = await unwrapDek(oldKek, record.wrap);
    } catch {
      throw new ConfigCryptoError(
        "FROSTY_ENCRYPTION_KEY_OLD does not match this store; rotation aborted.",
      );
    }
    const newKdf = detectKdf(newKey.trim());
    const newKek = await deriveKek(newKey.trim(), newKdf);
    // DEK (hence canary) is unchanged; only kdf + wrap change.
    await store.set(
      DEK_KEY,
      {
        ...record,
        kdf: newKdf,
        wrap: await wrapDek(newKek, dekRaw),
      } satisfies DekRecord,
    );
  }

  // ----------------------------------------------------------- string leaves

  /** True if a stored string is a versioned envelope (vs legacy plaintext). */
  isEnvelope(value: string): boolean {
    return value.startsWith(ENVELOPE_PREFIX);
  }

  /**
   * Encrypts one string leaf into a `frosty.enc.v1:` envelope. Empty strings
   * pass through unchanged (an empty secret is not a secret). AAD binds the
   * ciphertext to (kvKeyPath, fieldPath, version) so it cannot be lifted to
   * another record or field.
   */
  async encryptString(
    kvKeyPath: StateKey,
    fieldPath: string,
    plaintext: string,
  ): Promise<string> {
    if (plaintext === "") return "";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: this.aad(kvKeyPath, fieldPath),
        },
        this.dekKey,
        encoder.encode(plaintext),
      ),
    );
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv, 0);
    packed.set(ct, iv.length);
    return ENVELOPE_PREFIX + b64urlEncode(packed);
  }

  /**
   * Decrypts one string leaf. A legacy plaintext value (no sentinel) is returned
   * unchanged (lazy-migration read path). A real envelope that fails GCM auth —
   * wrong key, tampered ciphertext, or a mismatched location (AAD) — throws
   * {@link DecryptError}; it NEVER returns ciphertext or falls back to plaintext.
   */
  async decryptString(
    kvKeyPath: StateKey,
    fieldPath: string,
    value: string,
  ): Promise<string> {
    if (!this.isEnvelope(value)) return value; // legacy plaintext, unchanged
    let plain: ArrayBuffer;
    try {
      const packed = b64urlDecode(value.slice(ENVELOPE_PREFIX.length));
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: packed.subarray(0, 12),
          additionalData: this.aad(kvKeyPath, fieldPath),
        },
        this.dekKey,
        packed.subarray(12),
      );
    } catch {
      throw new DecryptError(kindLabel(kvKeyPath), fieldPath);
    }
    return decoder.decode(new Uint8Array(plain));
  }

  private aad(kvKeyPath: StateKey, fieldPath: string): Bytes {
    return encoder.encode(
      JSON.stringify(kvKeyPath) + AAD_SEP + fieldPath + AAD_SEP + AAD_VERSION,
    );
  }

  // ---------------------------------------------------------- record leaves

  /** Encrypts every SECRET_FIELDS leaf in a record (returns a new object). */
  encryptRecord<T>(
    kind: RecordKind,
    kvKeyPath: StateKey,
    record: T,
  ): Promise<T> {
    return this.transform(
      kind,
      kvKeyPath,
      record,
      (p, f, v) => this.encryptString(p, f, v),
    );
  }

  /** Decrypts every SECRET_FIELDS leaf in a record (returns a new object). */
  decryptRecord<T>(
    kind: RecordKind,
    kvKeyPath: StateKey,
    record: T,
  ): Promise<T> {
    return this.transform(
      kind,
      kvKeyPath,
      record,
      (p, f, v) => this.decryptString(p, f, v),
    );
  }

  private async transform<T>(
    kind: RecordKind,
    kvKeyPath: StateKey,
    record: T,
    op: FieldOp,
  ): Promise<T> {
    const clone = structuredClone(record) as Record<string, unknown>;
    for (const spec of SECRET_FIELDS[kind]) {
      await applySpec(clone, kvKeyPath, spec, op);
    }
    return clone as T;
  }
}

/**
 * Applies a field op to the leaf(s) named by one SECRET_FIELDS path spec.
 * Wildcards can traverse record keys or array indices. Only string leaves are
 * touched; missing/undefined/non-string fields are skipped, so optional
 * secrets and legacy records are handled uniformly.
 */
async function applySpec(
  record: Record<string, unknown>,
  kvKeyPath: StateKey,
  spec: string,
  op: FieldOp,
): Promise<void> {
  const parts = spec.split(".");
  async function visit(
    value: unknown,
    index: number,
    path: string,
  ): Promise<unknown> {
    if (index === parts.length) {
      return typeof value === "string"
        ? await op(kvKeyPath, path, value)
        : value;
    }
    if (!value || typeof value !== "object") return value;
    const container = value as Record<string, unknown>;
    const segment = parts[index];
    if (segment === "*") {
      for (const key of Object.keys(container)) {
        container[key] = await visit(
          container[key],
          index + 1,
          path ? `${path}.${key}` : key,
        );
      }
      return value;
    }
    if (segment in container) {
      container[segment] = await visit(
        container[segment],
        index + 1,
        path ? `${path}.${segment}` : segment,
      );
    }
    return value;
  }
  await visit(record, 0, "");
}
