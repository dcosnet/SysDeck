/** Max identifier length for the allowlist (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`). */
export const IDENT_MAX = 64;
/** Above this property count a schema degrades to a single opaque `args` param. */
export const MAX_PARAMS = 64;
/** Untrusted tool/param names are clamped to the identifier bound before use. */
export const MAX_TOOL_NAME = IDENT_MAX;
/** Untrusted descriptions are truncated so `GET /vfs` cannot be amplified. */
export const MAX_DESCRIPTION = 2000;
/** Untrusted JSON-Schema `type` labels are clamped before entering a docstring. */
export const MAX_TYPE_LABEL = 64;

/**
 * Truncates an untrusted string to a max length. A hostile MCP server controls
 * tool `name`/`description`/schema; without this a single multi-megabyte field
 * would let `GET /vfs` amplify a small catalog into a huge response. Applied
 * BEFORE sanitization/JSON-encoding, which still run on top.
 */
export function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Coerces an untrusted string to a valid identifier: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
 * Allowlist, not blocklist — every disallowed code point becomes `_`, a leading
 * digit is prefixed, and the result is capped. Collisions are resolved by the
 * caller (see {@link makeUniqueNamer}). Because only `[A-Za-z0-9_]` survive,
 * the output can never contain `.`/`/`/`\`, so it is also traversal-safe as a
 * path segment.
 */
export function sanitizeIdentifier(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += /[A-Za-z0-9_]/.test(ch) ? ch : "_";
  }
  if (out.length === 0) {
    out = "_";
  }
  if (/^[0-9]/.test(out)) {
    out = "_" + out;
  }
  if (out.length > IDENT_MAX) {
    out = out.slice(0, IDENT_MAX);
  }
  return out;
}

/**
 * Deterministic 32-bit FNV-1a hash (8 hex chars). Used only to disambiguate
 * identifier collisions — same input ⇒ same suffix, so output stays
 * byte-identical across runs.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stateful namer that guarantees unique, sanitized identifiers within a scope.
 * On collision it appends a deterministic short hash of `hashKey` (the original
 * qualified name), so the disambiguation is stable across runs.
 */
export function makeUniqueNamer(): (raw: string, hashKey: string) => string {
  const used = new Set<string>();
  return (raw, hashKey) => {
    const base = sanitizeIdentifier(raw);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const suffix = "_" + shortHash(hashKey);
    let candidate = base.slice(0, Math.max(1, IDENT_MAX - suffix.length)) +
      suffix;
    // Grow a numeric disambiguator, always truncating `base` to leave room for
    // it. The previous `(candidate + "0").slice(0, IDENT_MAX)` made no progress
    // once candidate hit IDENT_MAX, spinning forever on a hash collision.
    let n = 0;
    while (used.has(candidate)) {
      const tag = suffix + (++n).toString(36);
      candidate = base.slice(0, Math.max(1, IDENT_MAX - tag.length)) + tag;
    }
    used.add(candidate);
    return candidate;
  };
}
