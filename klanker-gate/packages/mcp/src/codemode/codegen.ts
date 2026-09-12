import { type MCPToolCatalogEntry, qualifyToolName } from "../registry.ts";
import {
  clamp,
  makeUniqueNamer,
  MAX_DESCRIPTION,
  MAX_PARAMS,
  MAX_TOOL_NAME,
  MAX_TYPE_LABEL,
  sanitizeIdentifier,
  shortHash,
} from "./sanitize.ts";

export { sanitizeIdentifier, shortHash };

/** Binding level for the generated SDK. */
export type BindingLevel = "server-level" | "tool-level";

/** One generated, inert stub module in the virtual file system. */
export interface GeneratedFile {
  /** Sanitized VFS path (no `.`/`/`/`\` traversal in any segment). */
  path: string;
  /** Owning MCP client id (raw — a data field, never emitted into code). */
  server: string;
  /** Raw tool names bound in this module. */
  tools: string[];
  /** Python stub text. Inert: never executed while the executor is off. */
  source: string;
}

interface DerivedParam {
  rawName: string;
  required: boolean;
  typeLabel: string;
}

type Derived =
  | { mode: "named"; params: DerivedParam[] }
  | { mode: "opaque" };

/**
 * Reads ONLY `properties`/`required`/`type` from a JSON Schema, treating it as
 * opaque data (no `$ref` resolution, no network, no execution). Unknown,
 * non-object, or oversized schemas degrade to a single opaque `args` parameter
 * (design §2.3).
 */
function deriveParams(schema: Record<string, unknown> | undefined): Derived {
  if (!schema || typeof schema !== "object") {
    return { mode: "opaque" };
  }
  const type = schema["type"];
  if (typeof type === "string" && type !== "object") {
    return { mode: "opaque" };
  }
  const props = schema["properties"];
  if (!props || typeof props !== "object") {
    return { mode: "opaque" };
  }
  const propsObj = props as Record<string, unknown>;
  const names = Object.keys(propsObj);
  if (names.length > MAX_PARAMS) {
    return { mode: "opaque" };
  }
  const requiredRaw = schema["required"];
  const requiredSet = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((x): x is string => typeof x === "string")
      : [],
  );
  const params: DerivedParam[] = names.map((name) => {
    const prop = propsObj[name];
    const propType = prop && typeof prop === "object"
      ? (prop as Record<string, unknown>)["type"]
      : undefined;
    return {
      rawName: name,
      required: requiredSet.has(name),
      typeLabel: typeof propType === "string"
        ? clamp(propType, MAX_TYPE_LABEL)
        : "any",
    };
  });
  // Deterministic order: required first (alpha), then optional (alpha). Required
  // must precede optional so the generated Python signature stays valid.
  params.sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    return a.rawName < b.rawName ? -1 : a.rawName > b.rawName ? 1 : 0;
  });
  return { mode: "named", params };
}

/**
 * Renders one inert function stub. Untrusted `description`/param metadata are
 * emitted only inside a JSON-encoded docstring literal; the dispatch target is
 * the server-constructed `qualifiedName`, JSON-encoded.
 */
function renderFunction(entry: MCPToolCatalogEntry, funcName: string): string {
  // Untrusted `name`/`description` are length-capped BEFORE entering output so a
  // hostile MCP server cannot memory-amplify `GET /vfs`; sanitization and
  // JSON-encoding still run on top.
  const rawName = clamp(entry.name, MAX_TOOL_NAME);
  const qualified = qualifyToolName(entry.clientId, rawName);
  const derived = deriveParams(entry.inputSchema);
  const docLines: string[] = [];
  if (entry.description) {
    docLines.push(clamp(entry.description, MAX_DESCRIPTION));
  }

  let signature: string;
  let argsExpr: string;

  if (derived.mode === "opaque") {
    signature = "args=None";
    argsExpr = "args";
    docLines.push("", "Args: forwarded to the tool as a single object.");
  } else {
    const namer = makeUniqueNamer();
    const rendered = derived.params.map((p) => {
      const raw = clamp(p.rawName, MAX_TOOL_NAME);
      return {
        raw,
        safe: namer(raw, `${qualified}#${raw}`),
        required: p.required,
        typeLabel: p.typeLabel,
      };
    });
    const required = rendered.filter((p) => p.required);
    const optional = rendered.filter((p) => !p.required);
    signature = [
      ...required.map((p) => p.safe),
      ...optional.map((p) => `${p.safe}=None`),
    ].join(", ");
    const dictEntries = rendered.map((p) =>
      `${JSON.stringify(p.raw)}: ${p.safe}`
    );
    argsExpr = dictEntries.length ? `{${dictEntries.join(", ")}}` : "{}";
    if (rendered.length) {
      docLines.push("", "Args:");
      for (const p of rendered) {
        docLines.push(
          `  ${p.raw} (${p.typeLabel})${p.required ? "" : ", optional"}`,
        );
      }
    }
  }

  const docstring = JSON.stringify(docLines.join("\n"));
  return [
    `def ${funcName}(${signature}):`,
    `    ${docstring}`,
    `    return __frosty_call(${JSON.stringify(qualified)}, ${argsExpr})`,
  ].join("\n");
}

/** Fixed, untrusted-free module header. `safeServer` is already sanitized. */
function moduleHeader(path: string, safeServer: string): string {
  return [
    `# Code Mode SDK — ${path}`,
    `# Server: ${safeServer}`,
    "# Generated from the gateway MCP catalog. This stub is inert metadata: it",
    "# is never executed while the Code Mode executor is disabled",
    "# (FROSTY_CODE_MODE=off). `__frosty_call(qualified_name, args)` is provided",
    "# by the sandbox broker at runtime; it is not defined here.",
    "",
  ].join("\n");
}

function groupByClient(
  catalog: MCPToolCatalogEntry[],
): Map<string, MCPToolCatalogEntry[]> {
  const groups = new Map<string, MCPToolCatalogEntry[]>();
  for (const entry of catalog) {
    const list = groups.get(entry.clientId) ?? [];
    list.push(entry);
    groups.set(entry.clientId, list);
  }
  return groups;
}

/** server-level: one module per client, one function per exposed tool. */
function generateServerLevel(catalog: MCPToolCatalogEntry[]): GeneratedFile[] {
  const groups = groupByClient(catalog);
  const clientIds = [...groups.keys()].sort();
  const fileNamer = makeUniqueNamer();
  const files: GeneratedFile[] = [];
  for (const clientId of clientIds) {
    const entries = [...groups.get(clientId)!].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    const safeServer = fileNamer(clientId, clientId);
    const path = `servers/${safeServer}.py`;
    const funcNamer = makeUniqueNamer();
    const body = entries
      .map((entry) => {
        const name = clamp(entry.name, MAX_TOOL_NAME);
        return renderFunction(
          entry,
          funcNamer(name, qualifyToolName(entry.clientId, name)),
        );
      })
      .join("\n\n\n");
    files.push({
      path,
      server: clientId,
      tools: entries.map((e) => clamp(e.name, MAX_TOOL_NAME)),
      source: moduleHeader(path, safeServer) + "\n" + body + "\n",
    });
  }
  return files;
}

/** tool-level: one module per qualified tool, keyed collision-free on it. */
function generateToolLevel(catalog: MCPToolCatalogEntry[]): GeneratedFile[] {
  const entries = [...catalog].sort((a, b) => {
    const qa = qualifyToolName(a.clientId, a.name);
    const qb = qualifyToolName(b.clientId, b.name);
    return qa < qb ? -1 : qa > qb ? 1 : 0;
  });
  const fileNamer = makeUniqueNamer();
  return entries.map((entry) => {
    const name = clamp(entry.name, MAX_TOOL_NAME);
    const qualified = qualifyToolName(entry.clientId, name);
    const safeBase = fileNamer(qualified, qualified);
    const path = `tools/${safeBase}.py`;
    const funcNamer = makeUniqueNamer();
    const body = renderFunction(entry, funcNamer(name, qualified));
    return {
      path,
      server: entry.clientId,
      tools: [name],
      source: moduleHeader(path, safeBase) + "\n" + body + "\n",
    };
  });
}

/**
 * Deterministically generates the inert Python stub modules for a catalog. Same
 * catalog ⇒ byte-identical output (stable ordering, no timestamps, no random
 * ids). Python stays the DISPLAY/preview artifact (design §5.2); the executable
 * path uses the TypeScript emission below.
 */
export function generateFiles(
  catalog: MCPToolCatalogEntry[],
  binding: BindingLevel,
): GeneratedFile[] {
  return binding === "tool-level"
    ? generateToolLevel(catalog)
    : generateServerLevel(catalog);
}

interface TsRenderedTool {
  /** Sanitized method identifier (code position). */
  safeMethod: string;
  /** Gateway-constructed dispatch target (JSON-encoded into a literal). */
  qualified: string;
  /** Fixed param type — untrusted param NAMES appear only as quoted keys. */
  paramsType: string;
  /** JSON-encoded doc string; all untrusted text is confined to this literal. */
  doc: string;
}

/** Renders one TS tool binding, mirroring the Python renderer's derivations. */
function renderToolTs(
  entry: MCPToolCatalogEntry,
  methodName: string,
): TsRenderedTool {
  const rawName = clamp(entry.name, MAX_TOOL_NAME);
  const qualified = qualifyToolName(entry.clientId, rawName);
  const derived = deriveParams(entry.inputSchema);
  const docLines: string[] = [];
  if (entry.description) {
    docLines.push(clamp(entry.description, MAX_DESCRIPTION));
  }

  let paramsType: string;
  if (derived.mode === "opaque") {
    paramsType = "Record<string, unknown>";
    docLines.push("", "Args: forwarded to the tool as a single object.");
  } else {
    const namer = makeUniqueNamer();
    const rendered = derived.params.map((p) => {
      const raw = clamp(p.rawName, MAX_TOOL_NAME);
      return {
        raw,
        safe: namer(raw, `${qualified}#${raw}`),
        required: p.required,
        typeLabel: p.typeLabel,
      };
    });
    // Untrusted param names appear ONLY as JSON-encoded (quoted) object keys; the
    // value type is a fixed `unknown` so no untrusted `type` label enters code.
    const fields = rendered.map((p) =>
      `${JSON.stringify(p.raw)}${p.required ? "" : "?"}: unknown`
    );
    paramsType = fields.length
      ? `{ ${fields.join("; ")} }`
      : "Record<string, unknown>";
    if (rendered.length) {
      docLines.push("", "Args:");
      for (const p of rendered) {
        docLines.push(
          `  ${p.raw} (${p.typeLabel})${p.required ? "" : ", optional"}`,
        );
      }
    }
  }

  return {
    safeMethod: methodName,
    qualified,
    paramsType,
    doc: JSON.stringify(docLines.join("\n")),
  };
}

/** Fixed, untrusted-free TS module header. Line comments only (no block comment). */
function moduleHeaderTs(path: string, safeName: string): string {
  return [
    `// Code Mode SDK (TypeScript) — ${path}`,
    `// Server: ${safeName}`,
    "// The SDK the model authors against. At runtime the sandbox worker injects",
    "// the executable equivalents as `sdk.<server>.<tool>` (server-grouped, same",
    "// sanitized names) and `__frostyCall(qualifiedName, args)` is provided by the",
    "// broker on the main isolate. This text is inert: never eval'd or imported.",
    "",
  ].join("\n");
}

/** server-level TS: one module per client exporting an `sdk.<server>` object. */
function generateServerLevelTs(
  catalog: MCPToolCatalogEntry[],
): GeneratedFile[] {
  const groups = groupByClient(catalog);
  const clientIds = [...groups.keys()].sort();
  const fileNamer = makeUniqueNamer();
  const files: GeneratedFile[] = [];
  for (const clientId of clientIds) {
    const entries = [...groups.get(clientId)!].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    const safeServer = fileNamer(clientId, clientId);
    const path = `servers/${safeServer}.ts`;
    const methodNamer = makeUniqueNamer();
    const rendered = entries.map((entry) => {
      const name = clamp(entry.name, MAX_TOOL_NAME);
      return renderToolTs(
        entry,
        methodNamer(name, qualifyToolName(entry.clientId, name)),
      );
    });
    const methods = rendered
      .map((r) =>
        `  ${r.safeMethod}(args: ${r.paramsType}): Promise<string> {\n` +
        `    return __frostyCall(${JSON.stringify(r.qualified)}, args);\n` +
        `  },`
      )
      .join("\n");
    const docs = rendered
      .map((r) => `  ${JSON.stringify(r.safeMethod)}: ${r.doc},`)
      .join("\n");
    const source = [
      moduleHeaderTs(path, safeServer),
      `export const ${safeServer} = {`,
      methods,
      `};`,
      "",
      "/** Tool docs (inert data — untrusted text lives only in these literals). */",
      "export const descriptions: Record<string, string> = {",
      docs,
      "};",
      "",
    ].join("\n");
    files.push({
      path,
      server: clientId,
      tools: entries.map((e) => clamp(e.name, MAX_TOOL_NAME)),
      source,
    });
  }
  return files;
}

/** tool-level TS: one module per qualified tool exporting a single function. */
function generateToolLevelTs(catalog: MCPToolCatalogEntry[]): GeneratedFile[] {
  const entries = [...catalog].sort((a, b) => {
    const qa = qualifyToolName(a.clientId, a.name);
    const qb = qualifyToolName(b.clientId, b.name);
    return qa < qb ? -1 : qa > qb ? 1 : 0;
  });
  const fileNamer = makeUniqueNamer();
  return entries.map((entry) => {
    const name = clamp(entry.name, MAX_TOOL_NAME);
    const qualified = qualifyToolName(entry.clientId, name);
    const safeBase = fileNamer(qualified, qualified);
    const path = `tools/${safeBase}.ts`;
    const methodNamer = makeUniqueNamer();
    const r = renderToolTs(entry, methodNamer(name, qualified));
    const source = [
      moduleHeaderTs(path, safeBase),
      `export function ${r.safeMethod}(args: ${r.paramsType}): Promise<string> {`,
      `  return __frostyCall(${JSON.stringify(r.qualified)}, args);`,
      `}`,
      "",
      "/** Tool doc (inert data — untrusted text lives only in this literal). */",
      `export const description: string = ${r.doc};`,
      "",
    ].join("\n");
    return { path, server: entry.clientId, tools: [name], source };
  });
}

/**
 * Deterministically generates the inert TypeScript SDK modules — the executable
 * authoring surface (design §5.2). Same catalog ⇒ byte-identical output. Reuses
 * the exact clamp/sanitizeIdentifier/MAX_* of the Python path (M2), so a hostile
 * field cannot be neutralized for display yet amplify or inject on this path.
 */
export function generateFilesTs(
  catalog: MCPToolCatalogEntry[],
  binding: BindingLevel,
): GeneratedFile[] {
  return binding === "tool-level"
    ? generateToolLevelTs(catalog)
    : generateServerLevelTs(catalog);
}
