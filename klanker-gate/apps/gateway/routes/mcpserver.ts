import type { Router } from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function rpcResult(id: number | string, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

export function registerMCPServerRoutes(router: Router, ctx: AppContext): void {
  router.post("/mcp", async (req) => {
    let body: JsonRpcRequest;
    try {
      const parsed = await req.json() as unknown;
      if (Array.isArray(parsed)) {
        // 2025-06-18 removed batching; acknowledging a batch as a
        // notification would silently swallow real requests.
        return rpcError(
          null,
          -32600,
          "Batching is not supported (protocol 2025-06-18); send one " +
            "JSON-RPC object per request.",
        );
      }
      if (typeof parsed !== "object" || parsed === null) {
        return rpcError(null, -32600, "Invalid Request");
      }
      body = parsed as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    ctx.metrics.increment("requests.mcp_server");

    // Notifications get acknowledged without a body.
    if (body.id === undefined) {
      return new Response(null, { status: 202 });
    }

    switch (body.method) {
      case "initialize":
        return rpcResult(body.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "frosty-gateway", version: ctx.version },
        });

      case "tools/list":
        return rpcResult(body.id, {
          tools: ctx.mcp.toolCatalog().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: "object" },
            annotations: tool.annotations,
          })),
        });

      case "tools/call": {
        const name = String(body.params?.name ?? "");
        // Atomic bind: catalogs re-sync concurrently, so the side-effect
        // gate and the execution must observe ONE tool instance (TOCTOU).
        const resolved = ctx.toolExecutor.resolve?.(name) ??
          (ctx.toolExecutor.has(name)
            ? {
              isSideEffect: ctx.toolExecutor.isSideEffect(name),
              execute: (args: unknown) => ctx.toolExecutor.execute(name, args),
            }
            : undefined);
        if (!resolved) {
          return rpcError(body.id, -32602, `Unknown tool "${name}".`);
        }
        // Same side-effect posture as the inference tool loop: fail closed.
        const confirmed =
          req.headers.get("x-frosty-confirm-side-effects") === "true";
        if (resolved.isSideEffect && !confirmed) {
          return rpcError(
            body.id,
            -32000,
            `Tool "${name}" may have side effects; repeat the call with the ` +
              `x-frosty-confirm-side-effects: true header to allow it.`,
          );
        }
        try {
          const text = await resolved.execute(body.params?.arguments ?? {});
          return rpcResult(body.id, {
            content: [{ type: "text", text }],
            isError: false,
          });
        } catch (error) {
          return rpcResult(body.id, {
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            }],
            isError: true,
          });
        }
      }

      default:
        return rpcError(
          body.id,
          -32601,
          `Method "${body.method}" not found.`,
        );
    }
  });

  router.get("/mcp", () => {
    ctx.metrics.increment("requests.mcp_server");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(next) {
        next.enqueue(encoder.encode(
          'data: {"jsonrpc":"2.0","method":"connection/opened"}\n\n',
        ));
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });
}
