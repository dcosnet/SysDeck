import { assert, assertEquals } from "@std/assert";
import type { MCPToolCatalogEntry } from "../registry.ts";
import { qualifyToolName } from "../registry.ts";
import { buildVfs } from "./vfs.ts";
import {
  generateFiles,
  generateFilesTs,
  sanitizeIdentifier,
} from "./codegen.ts";

// Code Mode VFS/codegen — the LIVE surface. These prove it (1) is deterministic,
// (2) leaks no secret fields, and (3) neutralizes hostile tool names/descriptions
// (design §5.1: S-VFS-1..4).

function entry(
  clientId: string,
  name: string,
  extra: Partial<MCPToolCatalogEntry> = {},
): MCPToolCatalogEntry {
  return {
    clientId,
    name,
    qualifiedName: qualifyToolName(clientId, name),
    ...extra,
  };
}

const CATALOG: MCPToolCatalogEntry[] = [
  entry("calculator", "add", {
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  }),
  entry("calculator", "subtract", {
    description: "Subtract b from a.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a"],
    },
  }),
  entry("weather", "forecast", {
    description: "Forecast for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }),
];

// ---------------------------------------------------------------- S-VFS-1
Deno.test("S-VFS-1 codegen is deterministic (byte-identical + stable sha256)", async () => {
  const a = await buildVfs(CATALOG, "server-level");
  const b = await buildVfs(CATALOG, "server-level");
  assertEquals(a, b); // deep equality incl. per-file sha256 and source
  // Stable ordering: servers sorted by clientId.
  assertEquals(a.files.map((f) => f.server), ["calculator", "weather"]);
  // generatedAt is always null (determinism over freshness).
  assertEquals(a.generatedAt, null);
  // sha256 is 64 lowercase hex chars.
  for (const f of a.files) {
    assert(/^[0-9a-f]{64}$/.test(f.sha256), `bad sha256: ${f.sha256}`);
    assertEquals(f.sizeBytes, new TextEncoder().encode(f.source).byteLength);
  }
});

Deno.test("S-VFS-1 shuffled catalog ⇒ identical output (no iteration-order dep)", async () => {
  const shuffled = [CATALOG[2], CATALOG[0], CATALOG[1]];
  assertEquals(
    await buildVfs(shuffled, "server-level"),
    await buildVfs(CATALOG, "server-level"),
  );
});

// ---------------------------------------------------------------- S-VFS-2
Deno.test("S-VFS-2 no secret ever appears in generated output", async () => {
  // codegen receives ONLY catalog entries; it has no parameter through which
  // config.headers / Deno.env / KV could arrive. Set env + a header-shaped
  // sentinel and assert neither can surface.
  const priorKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "SENTINEL_ENV_XYZ");
  try {
    const vfs = await buildVfs(CATALOG, "server-level");
    const blob = JSON.stringify(vfs);
    assert(!blob.includes("SENTINEL_ENV_XYZ"));
    assert(!blob.includes("Authorization"));
    assert(!blob.includes("Bearer"));
  } finally {
    if (priorKey === undefined) {
      Deno.env.delete("OPENAI_API_KEY");
    } else {
      Deno.env.set("OPENAI_API_KEY", priorKey);
    }
  }
});

// ---------------------------------------------------------------- S-VFS-3
Deno.test("S-VFS-3 hostile tool names/descriptions are neutralized", () => {
  const hostile: MCPToolCatalogEntry[] = [
    entry("../../etc", "add(); import os; os.system('x')", {
      description: '"""; import os; os.system("pwned")  # `backtick` */ end',
      inputSchema: {
        type: "object",
        properties: {
          "evil param": { type: "string" },
          'a"b': { type: "number" },
        },
        required: ["evil param"],
      },
    }),
    entry("svr", "‮OVERRIDE", {
      description: "</script><img src=x onerror=alert(1)>",
    }),
    entry("svr", "x".repeat(500), { description: "long name" }),
  ];

  const files = generateFiles(hostile, "server-level");
  const allSource = files.map((f) => f.source).join("\n");

  // (a) Every function identifier matches the allowlist regex.
  const idRe = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const defMatches = [...allSource.matchAll(/^def ([^(]+)\(/gm)];
  assert(defMatches.length >= 3);
  for (const m of defMatches) {
    assert(idRe.test(m[1]), `bad identifier: ${JSON.stringify(m[1])}`);
  }

  // (b) VFS paths contain no traversal — every segment is a safe identifier.
  for (const f of files) {
    assert(!f.path.includes(".."), `traversal in path: ${f.path}`);
    assert(!f.path.includes("\\"), `backslash in path: ${f.path}`);
    const segs = f.path.split("/");
    assertEquals(segs[0], "servers");
    assert(/^[A-Za-z_][A-Za-z0-9_]{0,63}\.py$/.test(segs[1]), f.path);
  }

  // (c) Every untrusted token appears ONLY inside a JSON-encoded string literal
  //     (a docstring, the dispatch qualifiedName arg, or a dict key), never as
  //     bare code. We never emit triple-quotes. Strip all double-quoted string
  //     literals and assert the remaining "code skeleton" is free of injected
  //     tokens: if a token had broken out of a literal it would survive here.
  assert(!allSource.includes('"""'), "unescaped triple-quote terminator");
  const codeSkeleton = allSource.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (
    const token of [
      "os.system",
      "import os",
      "</script>",
      "onerror",
      "alert(1)",
      "pwned",
    ]
  ) {
    assert(
      !codeSkeleton.includes(token),
      `token escaped its string literal: ${token}`,
    );
  }

  // (d) Dispatch target is always the SERVER-constructed qualifiedName. Names
  //     are length-clamped (memory-amplification guard) to the 64-char bound
  //     before entering output; the target is still the gateway-constructed
  //     qualifiedName (never an attacker-echoed field), now of the clamped name.
  for (const e of hostile) {
    const clampedName = e.name.length > 64 ? e.name.slice(0, 64) : e.name;
    const q = qualifyToolName(e.clientId, clampedName);
    assert(
      allSource.includes(`__frosty_call(${JSON.stringify(q)}`),
      `missing server-constructed dispatch for ${q}`,
    );
  }
});

// M2 memory-amplification guard: a hostile server cannot inflate `GET /vfs`.
Deno.test("S-VFS-3 over-long name/description are length-clamped", () => {
  const files = generateFiles(
    [
      entry("svr", "n".repeat(5000), {
        description: "d".repeat(50_000),
        inputSchema: {
          type: "object",
          properties: { ["p".repeat(5000)]: { type: "x".repeat(5000) } },
          required: [],
        },
      }),
    ],
    "server-level",
  );
  const src = files[0].source;
  // No untrusted field survives at anywhere near its original length.
  assert(!src.includes("n".repeat(65)), "tool name not clamped");
  assert(!src.includes("d".repeat(2001)), "description not clamped");
  assert(!src.includes("p".repeat(65)), "param name not clamped");
  assert(!src.includes("x".repeat(65)), "type label not clamped");
  // Whole module stays small despite ~65KB of hostile input.
  assert(src.length < 4000, `amplified output: ${src.length} bytes`);
});

// M2: the SAME injection discipline holds on the EXECUTABLE TypeScript SDK path
// (design §5.2) — the SDK the model actually authors against, not just the
// Python display preview.
Deno.test("S-VFS-3 (TS SDK) hostile names/descriptions are neutralized on the executable path", () => {
  const hostile: MCPToolCatalogEntry[] = [
    entry("../../etc", "add(); import os; os.system('x')", {
      description: '"""; import os; os.system("pwned")  # `backtick` */ end',
      inputSchema: {
        type: "object",
        properties: {
          "evil param": { type: "string" },
          'a"b': { type: "number" },
        },
        required: ["evil param"],
      },
    }),
    entry("svr", "‮OVERRIDE", {
      description: "</script><img src=x onerror=alert(1)>",
    }),
    entry("svr", "x".repeat(500), { description: "long name" }),
  ];

  for (const binding of ["server-level", "tool-level"] as const) {
    const files = generateFilesTs(hostile, binding);
    const allSource = files.map((f) => f.source).join("\n");
    const idRe = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

    // (a) Every emitted identifier (export const / function / method) is a safe
    //     allowlist identifier — untrusted names never reach a code position.
    const idMatches = [
      ...allSource.matchAll(/^export const ([A-Za-z_][A-Za-z0-9_]*) =/gm),
      ...allSource.matchAll(/^export function ([A-Za-z_][A-Za-z0-9_]*)\(/gm),
      ...allSource.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\(args:/gm),
    ];
    assert(idMatches.length >= 3, `binding ${binding}: too few identifiers`);
    for (const m of idMatches) {
      assert(idRe.test(m[1]), `bad identifier: ${JSON.stringify(m[1])}`);
    }

    // (b) VFS paths carry no traversal — every segment is a safe identifier.
    for (const f of files) {
      assert(!f.path.includes(".."), `traversal in path: ${f.path}`);
      assert(!f.path.includes("\\"), `backslash in path: ${f.path}`);
      const segs = f.path.split("/");
      assert(segs[0] === "servers" || segs[0] === "tools", f.path);
      assert(/^[A-Za-z_][A-Za-z0-9_]{0,63}\.ts$/.test(segs[1]), f.path);
    }

    // (c) Untrusted tokens appear ONLY inside double-quoted string literals.
    //     Strip every literal; nothing injected may survive in the skeleton.
    const skeleton = allSource.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (
      const token of [
        "os.system",
        "import os",
        "</script>",
        "onerror",
        "alert(1)",
        "pwned",
      ]
    ) {
      assert(
        !skeleton.includes(token),
        `binding ${binding}: token escaped its literal: ${token}`,
      );
    }

    // (d) Dispatch target is always the SERVER-constructed qualifiedName (of the
    //     clamped name), JSON-encoded — never an attacker-echoed field.
    for (const e of hostile) {
      const clampedName = e.name.length > 64 ? e.name.slice(0, 64) : e.name;
      const q = qualifyToolName(e.clientId, clampedName);
      assert(
        allSource.includes(`__frostyCall(${JSON.stringify(q)}`),
        `binding ${binding}: missing server-constructed dispatch for ${q}`,
      );
    }
  }
});

Deno.test("S-VFS-3 (TS SDK) over-long name/description/params are length-clamped", () => {
  const files = generateFilesTs(
    [
      entry("svr", "n".repeat(5000), {
        description: "d".repeat(50_000),
        inputSchema: {
          type: "object",
          properties: { ["p".repeat(5000)]: { type: "x".repeat(5000) } },
          required: [],
        },
      }),
    ],
    "server-level",
  );
  const src = files[0].source;
  assert(!src.includes("n".repeat(65)), "tool name not clamped");
  assert(!src.includes("d".repeat(2001)), "description not clamped");
  assert(!src.includes("p".repeat(65)), "param name not clamped");
  assert(!src.includes("x".repeat(65)), "type label not clamped");
  assert(src.length < 5000, `amplified output: ${src.length} bytes`);
});

Deno.test("S-VFS-3 (TS SDK) is deterministic (byte-identical across runs)", () => {
  const a = generateFilesTs(CATALOG, "server-level");
  const b = generateFilesTs(CATALOG, "server-level");
  assertEquals(a, b);
  assertEquals(a.map((f) => f.path), [
    "servers/calculator.ts",
    "servers/weather.ts",
  ]);
});

Deno.test("S-VFS-3 sanitizeIdentifier always yields a valid identifier", () => {
  const idRe = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  for (
    const raw of ["", "9lives", "../../x", "a b c", "‮RTL", "µ", "x".repeat(200)]
  ) {
    assert(
      idRe.test(sanitizeIdentifier(raw)),
      `failed for ${JSON.stringify(raw)}`,
    );
  }
});

// ---------------------------------------------------------------- S-VFS-4
Deno.test("S-VFS-4 server-level: one module per client with all its tools", async () => {
  const vfs = await buildVfs(CATALOG, "server-level");
  assertEquals(vfs.bindingLevel, "server-level");
  assertEquals(vfs.files.map((f) => f.path), [
    "servers/calculator.py",
    "servers/weather.py",
  ]);
  const calc = vfs.files.find((f) => f.server === "calculator")!;
  assertEquals(calc.tools, ["add", "subtract"]);
  assert(calc.source.includes("def add("));
  assert(calc.source.includes("def subtract("));
});

Deno.test("S-VFS-4 tool-level: one module per qualified tool", async () => {
  const vfs = await buildVfs(CATALOG, "tool-level");
  assertEquals(vfs.bindingLevel, "tool-level");
  assertEquals(vfs.files.map((f) => f.path).sort(), [
    "tools/calculator__add.py",
    "tools/calculator__subtract.py",
    "tools/weather__forecast.py",
  ]);
  for (const f of vfs.files) {
    assertEquals(f.tools.length, 1);
  }
});

Deno.test("S-VFS-4 hidden tools never appear (catalog is the sole input)", async () => {
  // toolCatalog() already applies enabled + toolsToExecute; a hidden tool is
  // simply absent from the input, so it cannot appear in the VFS.
  const vfs = await buildVfs([CATALOG[0]], "server-level");
  const src = vfs.files.map((f) => f.source).join("\n");
  assert(src.includes("def add("));
  assert(!src.includes("def subtract("));
  assert(!src.includes("forecast"));
});
