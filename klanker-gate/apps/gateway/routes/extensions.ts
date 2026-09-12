import {
  MCPClientConfigSchema,
  redactMCPClientConfig,
} from "../../../packages/mcp/src/client.ts";
import { errorResponse, type Router } from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import {
  jsonResponse,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";

function clientView(ctx: AppContext, id: string) {
  const client = ctx.mcp.get(id);
  if (!client) {
    return undefined;
  }
  return {
    ...redactMCPClientConfig(client.config),
    toolCount: client.tools.length,
    lastSyncAt: client.lastSyncAt,
  };
}

export function registerExtensionRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/mcp/clients", () => {
    return jsonResponse({
      clients: ctx.mcp.list().map((c) => clientView(ctx, c.config.id)),
    });
  });

  router.post("/api/mcp/clients", async (req) => {
    const parsed = MCPClientConfigSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    // Policy rejections (e.g. stdio while disallowed) are client errors,
    // not 500s — and must never reach the persistent store.
    try {
      ctx.mcp.upsert(parsed.data);
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    await ctx.config?.upsertMCPClient(parsed.data);
    return jsonResponse(clientView(ctx, parsed.data.id), 201);
  });

  router.put("/api/mcp/clients/:id", async (req, match) => {
    const id = match.pathname.groups.id!;
    const existing = ctx.mcp.get(id);
    if (!existing) {
      return errorResponse(404, `Unknown MCP client "${id}".`);
    }
    const patch = await parseJsonBody(req);
    const merged = MCPClientConfigSchema.safeParse({
      ...existing.config,
      ...(patch as Record<string, unknown>),
      id,
    });
    if (!merged.success) {
      return validationErrorResponse(merged.error);
    }
    try {
      ctx.mcp.upsert(merged.data);
    } catch (error) {
      return errorResponse(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    await ctx.config?.upsertMCPClient(merged.data);
    return jsonResponse(clientView(ctx, id));
  });

  router.delete("/api/mcp/clients/:id", async (_req, match) => {
    const id = match.pathname.groups.id!;
    if (!ctx.mcp.get(id)) {
      return errorResponse(404, `Unknown MCP client "${id}".`);
    }
    ctx.mcp.remove(id);
    await ctx.config?.deleteMCPClient(id);
    return new Response(null, { status: 204 });
  });

  router.post("/api/mcp/clients/:id/sync", async (_req, match) => {
    const id = match.pathname.groups.id!;
    const client = ctx.mcp.get(id);
    if (!client) {
      return errorResponse(404, `Unknown MCP client "${id}".`);
    }
    try {
      const tools = await client.sync();
      return jsonResponse({ id, tools: tools.length });
    } catch {
      // Upstream MCP responses can reflect credentials supplied in a client
      // header or URL. Do not project their text to the control plane.
      return errorResponse(502, "MCP sync failed.");
    }
  });

  router.post("/api/mcp/sync", async () => {
    try {
      return jsonResponse({ synced: await ctx.mcp.syncAll() });
    } catch {
      return errorResponse(502, "MCP sync failed.");
    }
  });

  router.get("/api/mcp/tools", () => {
    return jsonResponse({ tools: ctx.mcp.toolCatalog() });
  });

  // On-demand health sweep across all configured MCP servers; the interval
  // monitor (FROSTY_MCP_HEALTH_INTERVAL_MS) keeps these fresh in the
  // background when enabled.
  router.get("/api/mcp/health", async () => {
    const health = await ctx.mcpMonitor?.checkAll() ?? [];
    return jsonResponse({ health });
  });

  router.get("/api/plugins", () => {
    return jsonResponse({ plugins: ctx.plugins.list() });
  });

  router.delete("/api/cache", async () => {
    const cleared = (await ctx.cache?.clear()) ?? 0;
    await ctx.invalidation?.publishCacheClear();
    return jsonResponse({ cleared });
  });

  router.delete("/api/cache/by-key", async (req) => {
    const request = await parseJsonBody(req) as Record<string, unknown>;
    const deleted = (await ctx.cache?.deleteEntry(request)) ?? false;
    await ctx.invalidation?.publishCacheKey(request);
    return jsonResponse({ deleted });
  });

  /** Source-compatible targeted invalidation for the cache entry created by a
   * gateway request. The global /api middleware supplies admin auth and origin
   * protection before this handler executes. */
  router.delete("/api/cache/clear/:requestId", async (_req, match) => {
    const requestId = match.pathname.groups.requestId!;
    try {
      const deleted = await ctx.cache?.deleteByRequestId(requestId) ?? false;
      await ctx.invalidation?.publishRequestId(requestId);
      return jsonResponse({ deleted });
    } catch {
      return errorResponse(502, "Failed to clear the cache entry.");
    }
  });
}
