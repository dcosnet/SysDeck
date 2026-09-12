// Extended advanced-API routes through the real handler: Files retrieve/
// delete/content and Batches list/cancel: rawProxy passthrough with
// capability enforcement. Companion to advanced_apis_test.ts.

import { assert, assertEquals } from "@std/assert";
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
import { jsonResponse, MockProvider } from "../../packages/testing/src/mod.ts";
import {
  BatchListResponseSchema,
  BatchResponseSchema,
  FileDeleteResponseSchema,
  FileObjectSchema,
} from "../../packages/contracts/src/mod.ts";

const base = "http://gateway.test";

function makeContext(mockUrl: string): AppContext {
  return {
    providers: new ProviderManager([
      {
        id: "openai",
        type: "openai",
        apiKey: "sk-adv",
        baseUrl: mockUrl,
        enabled: true,
        models: ["gpt-4o"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "anthropic",
        type: "anthropic",
        apiKey: "sk-ant",
        baseUrl: mockUrl,
        enabled: true,
        models: ["claude-x"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
      {
        id: "cohere",
        type: "cohere",
        apiKey: "co-adv",
        baseUrl: mockUrl,
        enabled: true,
        models: ["command-r"],
        priority: 0,
        retry: { maxRetries: 0 },
      },
    ], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

// Distinct paths per operation because MockCall records path (not method).
const mock = new MockProvider((call) => {
  switch (call.path) {
    case "/files/file-ret":
      return jsonResponse({
        id: "file-ret",
        object: "file",
        bytes: 42,
        created_at: 10,
        filename: "results.jsonl",
        purpose: "batch",
        status: "processed",
      });
    case "/files/file-ret/content":
      return new Response('{"custom_id":"a","response":{}}\n', {
        headers: { "Content-Type": "application/jsonl" },
      });
    case "/files/file-del":
      return jsonResponse({ id: "file-del", object: "file", deleted: true });
    case "/batches":
      return jsonResponse({
        object: "list",
        data: [{
          id: "batch-1",
          object: "batch",
          input_file_id: "file-ret",
          endpoint: "/v1/chat/completions",
          status: "completed",
          request_counts: { total: 2, completed: 2, failed: 0 },
        }],
        has_more: false,
        last_id: "batch-1",
      });
    case "/batches/batch-1/cancel":
      return jsonResponse({
        id: "batch-1",
        object: "batch",
        input_file_id: "file-ret",
        endpoint: "/v1/chat/completions",
        status: "cancelling",
      });
    case "/batches/batch-1/results":
      return new Response(
        '{"custom_id":"a","response":{"status_code":200}}\n',
        {
          headers: { "Content-Type": "application/jsonl" },
        },
      );
    default:
      return jsonResponse({ error: `unexpected path ${call.path}` }, 500);
  }
});

Deno.test("extended advanced APIs: files retrieve/delete/content, batches list/cancel", async (t) => {
  const handler = createHandler(makeContext(mock.url));

  try {
    await t.step("GET /v1/files/:id retrieves a file object", async () => {
      const res = await handler(
        new Request(`${base}/v1/files/file-ret?provider=openai`),
      );
      assertEquals(res.status, 200);
      const parsed = FileObjectSchema.safeParse(await res.json());
      assert(parsed.success);
      assertEquals(mock.calls.at(-1)!.path, "/files/file-ret");
    });

    await t.step("GET /v1/files/:id/content returns raw bytes", async () => {
      const res = await handler(
        new Request(`${base}/v1/files/file-ret/content?provider=openai`),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), "application/jsonl");
      assert((await res.text()).includes("custom_id"));
      assertEquals(mock.calls.at(-1)!.path, "/files/file-ret/content");
    });

    await t.step("DELETE /v1/files/:id deletes a file", async () => {
      const res = await handler(
        new Request(`${base}/v1/files/file-del?provider=openai`, {
          method: "DELETE",
        }),
      );
      assertEquals(res.status, 200);
      const parsed = FileDeleteResponseSchema.safeParse(await res.json());
      assert(parsed.success);
      if (parsed.success) {
        assertEquals(parsed.data.deleted, true);
      }
      assertEquals(mock.calls.at(-1)!.path, "/files/file-del");
    });

    await t.step("GET /v1/batches lists batches", async () => {
      const res = await handler(
        new Request(`${base}/v1/batches?provider=openai`),
      );
      assertEquals(res.status, 200);
      const parsed = BatchListResponseSchema.safeParse(await res.json());
      assert(parsed.success);
      if (parsed.success) {
        assertEquals(parsed.data.data[0].request_counts?.completed, 2);
      }
      assertEquals(mock.calls.at(-1)!.path, "/batches");
    });

    await t.step("POST /v1/batches/:id/cancel cancels a batch", async () => {
      const res = await handler(
        new Request(`${base}/v1/batches/batch-1/cancel?provider=openai`, {
          method: "POST",
        }),
      );
      assertEquals(res.status, 200);
      const parsed = BatchResponseSchema.safeParse(await res.json());
      assert(parsed.success);
      if (parsed.success) {
        assertEquals(parsed.data.status, "cancelling");
      }
      assertEquals(mock.calls.at(-1)!.path, "/batches/batch-1/cancel");
    });

    await t.step(
      "GET /v1/batches/:id/results proxies batch output bytes",
      async () => {
        const res = await handler(
          new Request(`${base}/v1/batches/batch-1/results?provider=openai`),
        );
        assertEquals(res.status, 200);
        assertEquals(res.headers.get("Content-Type"), "application/jsonl");
        assert((await res.text()).includes("custom_id"));
        assertEquals(mock.calls.at(-1)!.path, "/batches/batch-1/results");
      },
    );

    await t.step(
      "capability enforced: files rejected for cohere",
      async () => {
        const res = await handler(
          new Request(`${base}/v1/files/file-ret?provider=cohere`),
        );
        assertEquals(res.status, 400);
        assert((await res.json()).error.message.includes("does not support"));
      },
    );
  } finally {
    await mock.close();
  }
});
