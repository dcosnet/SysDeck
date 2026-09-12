// Same-origin UI serving: the gateway serves the built SPA and its assets
// alongside the API with no CORS involvement.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";

const distUrl = new URL("../../apps/control-ui/dist", import.meta.url);
let distPath: string | undefined;
try {
  if (Deno.statSync(distUrl).isDirectory) {
    distPath = fromFileUrl(distUrl);
  }
} catch {
  distPath = undefined;
}

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
    uiRoot: distPath,
  };
}

Deno.test({
  name: "e2e: gateway serves the control UI same-origin",
  ignore: !distPath, // run `deno task build-ui` first
  fn: async (t) => {
    const server = Deno.serve(
      { port: 0, onListen: () => {} },
      createHandler(makeContext()),
    );
    const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

    try {
      let assetPath = "";

      await t.step("/ serves index.html", async () => {
        const res = await fetch(`${base}/`);
        assertEquals(res.status, 200);
        assert(res.headers.get("Content-Type")?.includes("text/html"));
        const html = await res.text();
        assert(html.includes("Klanker Gateway Manager"));
        const match = html.match(/src="(\/assets\/[^"]+\.js)"/);
        assert(match, "index.html references a bundled asset");
        assetPath = match[1];
      });

      await t.step("bundled assets are served", async () => {
        const res = await fetch(`${base}${assetPath}`);
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });

      await t.step("unknown SPA routes fall back to index.html", async () => {
        const res = await fetch(`${base}/some/client/route`);
        assertEquals(res.status, 200);
        assert((await res.text()).includes("Klanker Gateway Manager"));
      });

      await t.step("API routes still win over static serving", async () => {
        const res = await fetch(`${base}/v1/models`);
        assertEquals(res.status, 200);
        assertEquals((await res.json()).object, "list");

        const missing = await fetch(`${base}/api/providers/nope`, {
          method: "DELETE",
        });
        assertEquals(missing.status, 404);
        const body = await missing.json();
        assertEquals(typeof body.error.message, "string");
      });

      await t.step("log stream is live SSE", async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/api/logs/stream`, {
          signal: controller.signal,
        });
        assertEquals(res.headers.get("Content-Type"), "text/event-stream");
        // trigger a request so the stream has something to say
        const health = await fetch(`${base}/healthz`);
        await health.body?.cancel();
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        assert(new TextDecoder().decode(value).startsWith("data: "));
        controller.abort();
        await reader.cancel().catch(() => {});
      });
    } finally {
      await server.shutdown();
    }
  },
});
