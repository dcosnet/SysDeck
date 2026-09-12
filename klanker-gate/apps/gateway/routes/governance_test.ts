import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../main.ts";
import { type AppContext, NullToolExecutor, VERSION } from "../context.ts";
import { ProviderManager } from "../../../packages/providers/src/mod.ts";
import { Metrics } from "../../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../../packages/plugins/src/lifecycle.ts";

function makeContext(): AppContext {
  return {
    providers: new ProviderManager([]),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

const base = "http://gateway.test";
const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.test("virtual key description round-trips through create, update, and list", async () => {
  const ctx = makeContext();
  const handler = createHandler(ctx);

  const createRes = await handler(
    new Request(`${base}/api/virtual-keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "ci-key",
        description: "CI pipeline access",
      }),
    }),
  );
  assertEquals(createRes.status, 201);
  const created = await createRes.json();
  assertEquals(created.description, "CI pipeline access");
  assert(typeof created.token === "string"); // full token returned once
  assert(typeof created.tokenHint === "string");

  // Persisted in the manager with the description.
  assertEquals(
    ctx.virtualKeys.get(created.id)?.description,
    "CI pipeline access",
  );

  const updateRes = await handler(
    new Request(`${base}/api/virtual-keys/${created.id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "Updated note" }),
    }),
  );
  assertEquals(updateRes.status, 200);
  const updated = await updateRes.json();
  assertEquals(updated.description, "Updated note");
  assertEquals(updated.name, "ci-key"); // untouched fields preserved

  const listRes = await handler(new Request(`${base}/api/virtual-keys`));
  const list = await listRes.json();
  assertEquals(list.virtualKeys[0].description, "Updated note");
  // The public listing never exposes the raw token.
  assert(!("token" in list.virtualKeys[0]));
});

Deno.test("virtual key description is optional (backward-compatible)", async () => {
  const handler = createHandler(makeContext());
  const res = await handler(
    new Request(`${base}/api/virtual-keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "no-desc" }),
    }),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.description, undefined);
});
