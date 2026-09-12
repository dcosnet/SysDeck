import { assert, assertEquals, assertRejects } from "@std/assert";
import { MCPRegistry } from "./registry.ts";
import { MCPError } from "./client.ts";

/** Scripted MCP server speaking JSON-RPC over fetch. */
function mcpFetch(
  tools: Array<Record<string, unknown>>,
  onCall?: (name: string, args: unknown) => string,
): typeof fetch {
  return (_input, init) => {
    const body = JSON.parse(String(init?.body));
    let result: unknown;
    switch (body.method) {
      case "initialize":
        result = { protocolVersion: "2025-06-18", capabilities: {} };
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        result = {
          content: [{
            type: "text",
            text: onCall
              ? onCall(body.params.name, body.params.arguments)
              : "ok",
          }],
        };
        break;
      default:
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "method not found" },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

/** Scripted multi-server MCP: dispatches by URL host so each id answers on
 * its own endpoint and echoes which server ran the call. */
function routingFetch(
  servers: Record<string, Array<Record<string, unknown>>>,
): typeof fetch {
  return (input, init) => {
    const host = new URL(String(input)).host;
    const short = host.split(".")[0];
    const body = JSON.parse(String(init?.body));
    let result: unknown;
    switch (body.method) {
      case "initialize":
        result = { protocolVersion: "2025-06-18", capabilities: {} };
        break;
      case "tools/list":
        result = { tools: servers[host] ?? [] };
        break;
      case "tools/call":
        result = {
          content: [{ type: "text", text: `${short}:${body.params.name}` }],
        };
        break;
      default:
        result = {};
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

const READ_TOOL = {
  name: "read_notes",
  description: "Read notes",
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = { name: "delete_notes", description: "Delete notes" };

Deno.test("sync populates the tool catalog per client", async () => {
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
    }],
    mcpFetch([READ_TOOL, WRITE_TOOL]),
  );
  const summary = await registry.syncAll();
  assertEquals(summary, { notes: 2 });

  const catalog = registry.toolCatalog();
  assertEquals(catalog.map((t) => t.name), ["read_notes", "delete_notes"]);
  assertEquals(catalog[0].clientId, "notes");
  // Raw `name` is preserved; the collision-free qualified name is additive.
  assertEquals(catalog.map((t) => t.qualifiedName), [
    "notes__read_notes",
    "notes__delete_notes",
  ]);
  assert(registry.get("notes")?.lastSyncAt);
});

Deno.test("disabled clients are skipped by sync and catalog", async () => {
  const registry = new MCPRegistry(
    [{
      id: "off",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: false,
    }],
    mcpFetch([READ_TOOL]),
  );
  assertEquals(await registry.syncAll(), {});
  assertEquals(registry.toolCatalog(), []);
});

Deno.test("executor exposes synced tools with fail-closed side effects", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
    }],
    mcpFetch([READ_TOOL, WRITE_TOOL], (name, args) => {
      calls.push({ name, args });
      return `ran ${name}`;
    }),
  );
  await registry.syncAll();
  const executor = registry.executor();

  assertEquals(executor.has("read_notes"), true);
  assertEquals(executor.has("unknown_tool"), false);
  // readOnlyHint: true is the ONLY way to skip confirmation
  assertEquals(executor.isSideEffect("read_notes"), false);
  assertEquals(executor.isSideEffect("delete_notes"), true);
  assertEquals(executor.isSideEffect("unknown_tool"), true);

  const result = await executor.execute("read_notes", { q: "x" });
  assertEquals(result, "ran read_notes");
  assertEquals(calls[0], { name: "read_notes", args: { q: "x" } });

  await assertRejects(() => executor.execute("unknown_tool", {}));
});

Deno.test("tool errors surface as MCPError", async () => {
  const errorFetch: typeof fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const result = body.method === "tools/call"
      ? { content: [{ type: "text", text: "boom" }], isError: true }
      : body.method === "tools/list"
      ? { tools: [WRITE_TOOL] }
      : {};
    return Promise.resolve(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  };
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
    }],
    errorFetch,
  );
  await registry.syncAll();
  const err = await assertRejects(
    () => registry.executor().execute("delete_notes", {}),
    MCPError,
  );
  assertEquals(err.message, "boom");
});

Deno.test("client-namespaced names route identically-named tools without collision", async () => {
  // Two servers BOTH expose a tool literally named "search".
  const registry = new MCPRegistry(
    [
      {
        id: "alpha",
        url: "http://alpha.test/rpc",
        transport: "streamable-http",
        enabled: true,
      },
      {
        id: "beta",
        url: "http://beta.test/rpc",
        transport: "streamable-http",
        enabled: true,
      },
    ],
    routingFetch({
      "alpha.test": [{ name: "search", annotations: { readOnlyHint: true } }],
      "beta.test": [{ name: "search", annotations: { readOnlyHint: true } }],
    }),
  );
  await registry.syncAll();

  const catalog = registry.toolCatalog();
  // Raw names collide (that is the bug); qualified names disambiguate.
  assertEquals(catalog.map((t) => t.name), ["search", "search"]);
  assertEquals(catalog.map((t) => t.qualifiedName).sort(), [
    "alpha__search",
    "beta__search",
  ]);

  const executor = registry.executor();
  assertEquals(executor.has("alpha__search"), true);
  assertEquals(executor.has("beta__search"), true);
  // Each qualified name reaches ITS OWN server, not the first match.
  assertEquals(await executor.execute("alpha__search", {}), "alpha:search");
  assertEquals(await executor.execute("beta__search", {}), "beta:search");
});

Deno.test("single-server raw-name calls still resolve (backward compatible)", async () => {
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
    }],
    mcpFetch([READ_TOOL], (name) => `ran ${name}`),
  );
  await registry.syncAll();
  const executor = registry.executor();
  // Raw name (pre-namespacing callers) and qualified name both work.
  assertEquals(await executor.execute("read_notes", {}), "ran read_notes");
  assertEquals(
    await executor.execute("notes__read_notes", {}),
    "ran read_notes",
  );
});

Deno.test("toolDefinitions advertises qualified names as function tools", async () => {
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
    }],
    mcpFetch([READ_TOOL, WRITE_TOOL]),
  );
  await registry.syncAll();

  const defs = registry.toolDefinitions();
  assertEquals(defs.map((d) => d.function.name), [
    "notes__read_notes",
    "notes__delete_notes",
  ]);
  assertEquals(defs[0].type, "function");
  // A tool with no inputSchema still gets a valid JSON-Schema object.
  assertEquals(defs[0].function.parameters, { type: "object" });
});

Deno.test("toolsToExecute allowlist hides and blocks unlisted tools", async () => {
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
      toolsToExecute: ["read_notes"],
    }],
    mcpFetch([READ_TOOL, WRITE_TOOL]),
  );
  await registry.syncAll();

  // Only the allowlisted tool is exposed in the catalog and definitions.
  assertEquals(registry.toolCatalog().map((t) => t.name), ["read_notes"]);
  assertEquals(registry.toolDefinitions().map((d) => d.function.name), [
    "notes__read_notes",
  ]);

  const executor = registry.executor();
  assertEquals(executor.has("read_notes"), true);
  assertEquals(executor.has("notes__read_notes"), true);
  assertEquals(executor.has("delete_notes"), false); // filtered out
  assertEquals(executor.has("notes__delete_notes"), false);
  await assertRejects(() => executor.execute("delete_notes", {}));
});

Deno.test("toolsToAutoExecute replaces the readOnlyHint side-effect gate", async () => {
  const registry = new MCPRegistry(
    [{
      id: "notes",
      url: "http://mcp.test/rpc",
      transport: "streamable-http",
      enabled: true,
      toolsToAutoExecute: ["delete_notes"],
    }],
    mcpFetch([READ_TOOL, WRITE_TOOL]),
  );
  await registry.syncAll();
  const executor = registry.executor();

  // The write tool is explicitly cleared to auto-run (no confirmation)...
  assertEquals(executor.isSideEffect("delete_notes"), false);
  assertEquals(executor.isSideEffect("notes__delete_notes"), false);
  // ...while read_notes, though readOnly, is NOT listed and now fails closed.
  assertEquals(executor.isSideEffect("read_notes"), true);
});
