import type { MCPToolCatalogEntry } from "../registry.ts";
import { type BindingLevel, generateFiles } from "./codegen.ts";

// Code Mode — VFS assembly (design §2.3). Wraps the pure codegen with a
// per-file byte size + sha256 so the UI and tests can assert stability. This is
// the exact structure returned by `GET /api/mcp/codemode/vfs`.

export type { BindingLevel };

/** One file in the VFS tree returned to the UI. */
export interface CodeModeVfsFile {
  /** Sanitized VFS path (`servers/<id>.py` or `tools/<qualified>.py`). */
  path: string;
  /** Owning MCP client id (data field for the UI to map). */
  server: string;
  /** Raw tool names bound in this module. */
  tools: string[];
  /** UTF-8 byte length of `source`. */
  sizeBytes: number;
  /** sha256 of `source` — determinism assertion / cache key. */
  sha256: string;
  /** Inert stub text for the read-only preview pane. */
  source: string;
}

/** The VFS tree + rendered stubs. `generatedAt` is ALWAYS null (§2.3): */
/** determinism over freshness, so identical catalogs snapshot identically. */
export interface CodeModeVfs {
  bindingLevel: BindingLevel;
  files: CodeModeVfsFile[];
  generatedAt: null;
}

/**
 * Normalizes the `?binding=` query param. Accepts both the short spellings
 * (`server`/`tool`) and the canonical ones (`server-level`/`tool-level`);
 * anything else (including absent) defaults to the safer `server-level`.
 */
export function normalizeBinding(raw: string | null | undefined): BindingLevel {
  const value = (raw ?? "").toLowerCase();
  if (value === "tool" || value === "tool-level") {
    return "tool-level";
  }
  return "server-level";
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds the full VFS structure for a catalog + binding level. Pure over the
 * catalog: it reads no env, no secrets, and executes nothing.
 */
export async function buildVfs(
  catalog: MCPToolCatalogEntry[],
  binding: BindingLevel,
): Promise<CodeModeVfs> {
  const generated = generateFiles(catalog, binding);
  const files: CodeModeVfsFile[] = [];
  for (const file of generated) {
    files.push({
      path: file.path,
      server: file.server,
      tools: file.tools,
      sizeBytes: new TextEncoder().encode(file.source).byteLength,
      sha256: await sha256Hex(file.source),
      source: file.source,
    });
  }
  return { bindingLevel: binding, files, generatedAt: null };
}
