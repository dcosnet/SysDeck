import type { ToolExecutor } from "../../core/src/mod.ts";
import {
  MCPClient,
  MCPClientConfigSchema,
  MCPError,
  type MCPToolInfo,
} from "./client.ts";
import type { z } from "zod";

/** Accepts pre-default input; the registry applies schema defaults. */
export type MCPClientConfigInput = z.input<typeof MCPClientConfigSchema>;

export interface MCPToolCatalogEntry extends MCPToolInfo {
  clientId: string;
  /**
   * Client-namespaced tool name (`<clientId>__<tool>`). `name` stays the raw
   * upstream name for backward compatibility; `qualifiedName` is the
   * collision-free identifier used to advertise and route a tool when two
   * servers expose the same raw name.
   */
  qualifiedName: string;
}

/** OpenAI-style function tool definition advertised to a model. */
export interface MCPToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Separator between a client id and a raw tool name in a qualified name. */
export const MCP_NAMESPACE_SEP = "__";

/** Builds the client-namespaced tool name (`<clientId>__<tool>`). */
export function qualifyToolName(clientId: string, toolName: string): string {
  return `${clientId}${MCP_NAMESPACE_SEP}${toolName}`;
}

export interface MCPRegistryOptions {
  /**
   * Permit stdio (subprocess) MCP servers. Off by default (decision D10):
   * spawning local processes is the highest-privilege MCP surface, so it is
   * opt-in via FROSTY_MCP_ALLOW_STDIO=1 and additionally needs --allow-run.
   */
  allowStdio?: boolean;
}

export class MCPRegistry {
  private clients = new Map<string, MCPClient>();

  constructor(
    configs: MCPClientConfigInput[] = [],
    private fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private options: MCPRegistryOptions = {},
  ) {
    for (const config of configs) {
      // Persisted configs must never brick boot: a client the current
      // policy rejects (e.g. stdio while disallowed) is skipped, not fatal.
      try {
        this.upsert(config);
      } catch (error) {
        const id = String((config as { id?: string }).id ?? "?");
        console.warn(
          `MCP client "${id}" skipped at load: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  upsert(config: MCPClientConfigInput): MCPClient {
    const parsed = MCPClientConfigSchema.parse(config);
    if (parsed.transport === "stdio" && !this.options.allowStdio) {
      throw new MCPError(
        `stdio MCP transport is disabled by default; set ` +
          `FROSTY_MCP_ALLOW_STDIO=1 (and run the gateway with --allow-run) ` +
          `to enable subprocess servers.`,
        403,
      );
    }
    this.clients.get(parsed.id)?.dispose().catch(() => {});
    const client = new MCPClient(parsed, this.fetchImpl);
    this.clients.set(parsed.id, client);
    return client;
  }

  remove(id: string): boolean {
    this.clients.get(id)?.dispose().catch(() => {});
    return this.clients.delete(id);
  }

  get(id: string): MCPClient | undefined {
    return this.clients.get(id);
  }

  list(): MCPClient[] {
    return [...this.clients.values()];
  }

  /**
   * Syncs every enabled client with per-client error isolation: one dead
   * server no longer blocks the rest. A failed client reports -1 (details
   * via /api/mcp/health).
   */
  async syncAll(): Promise<Record<string, number>> {
    const summary: Record<string, number> = {};
    for (const client of this.clients.values()) {
      if (!client.config.enabled) {
        continue;
      }
      try {
        summary[client.config.id] = (await client.sync()).length;
      } catch (error) {
        summary[client.config.id] = -1;
        console.error(
          `MCP sync failed for "${client.config.id}": ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return summary;
  }

  /**
   * True when the client's `toolsToExecute` allowlist permits this raw tool
   * name. An unset or empty allowlist exposes every tool (default behavior).
   */
  private isExposed(client: MCPClient, toolName: string): boolean {
    const allow = client.config.toolsToExecute;
    return !allow || allow.length === 0 || allow.includes(toolName);
  }

  /**
   * Whether a tool may auto-execute (skip the side-effect confirmation gate).
   * A non-empty `toolsToAutoExecute` allowlist is authoritative: only listed
   * tools auto-run; absent it, the readOnlyHint annotation decides (default).
   */
  private isAutoExecutable(client: MCPClient, tool: MCPToolInfo): boolean {
    const auto = client.config.toolsToAutoExecute;
    if (auto && auto.length > 0) {
      return auto.includes(tool.name);
    }
    return tool.annotations?.readOnlyHint === true;
  }

  /**
   * Aggregated tool catalog across enabled, synced clients. Each entry carries
   * both the raw `name` and the collision-free `qualifiedName`, and honors the
   * per-client `toolsToExecute` allowlist.
   */
  toolCatalog(): MCPToolCatalogEntry[] {
    const catalog: MCPToolCatalogEntry[] = [];
    for (const client of this.clients.values()) {
      if (!client.config.enabled) {
        continue;
      }
      for (const tool of client.tools) {
        if (!this.isExposed(client, tool.name)) {
          continue;
        }
        catalog.push({
          ...tool,
          clientId: client.config.id,
          qualifiedName: qualifyToolName(client.config.id, tool.name),
        });
      }
    }
    return catalog;
  }

  /**
   * OpenAI-style function tool definitions (using the collision-free
   * qualified names) to advertise the aggregated MCP catalog to a model.
   */
  toolDefinitions(): MCPToolDefinition[] {
    return this.toolCatalog().map((tool) => ({
      type: "function",
      function: {
        name: tool.qualifiedName,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object" },
      },
    }));
  }

  /**
   * Resolves a tool by either its client-namespaced name (unambiguous, even
   * when two servers expose the same raw name) or, as a fallback, its raw name
   * (first match, keeping single-server and pre-namespacing callers working).
   * The per-client `toolsToExecute` allowlist is enforced on both paths.
   */
  private findTool(
    name: string,
  ): { client: MCPClient; tool: MCPToolInfo } | undefined {
    // 1) Exact client-namespaced match. Constructing and comparing the full
    //    qualified name (rather than splitting on the separator) stays correct
    //    even when a client id or a raw tool name itself contains "__".
    for (const client of this.clients.values()) {
      if (!client.config.enabled) {
        continue;
      }
      for (const tool of client.tools) {
        if (!this.isExposed(client, tool.name)) {
          continue;
        }
        if (qualifyToolName(client.config.id, tool.name) === name) {
          return { client, tool };
        }
      }
    }
    // 2) Raw-name fallback (first match wins).
    for (const client of this.clients.values()) {
      if (!client.config.enabled) {
        continue;
      }
      const tool = client.tools.find((t) => t.name === name);
      if (tool && this.isExposed(client, tool.name)) {
        return { client, tool };
      }
    }
    return undefined;
  }

  /**
   * ToolExecutor over the synced MCP catalog. Tools resolve by qualified or
   * raw name; the upstream is always called with the RAW tool name. Tools are
   * side-effecting unless the per-client auto-execute policy clears them;
   * unknown tools fail closed behind the confirmation gate.
   */
  executor(): ToolExecutor {
    return {
      has: (name: string): boolean => this.findTool(name) !== undefined,
      isSideEffect: (name: string): boolean => {
        const found = this.findTool(name);
        return found ? !this.isAutoExecutable(found.client, found.tool) : true;
      },
      execute: (name: string, args: unknown): Promise<string> => {
        const found = this.findTool(name);
        if (!found) {
          return Promise.reject(new Error(`unknown MCP tool "${name}"`));
        }
        return found.client.callTool(found.tool.name, args);
      },
      // Atomic bind: the side-effect gate and the call must observe the
      // same client+tool even while catalogs re-sync (TOCTOU).
      resolve: (name: string) => {
        const found = this.findTool(name);
        if (!found) {
          return undefined;
        }
        const { client, tool } = found;
        return {
          isSideEffect: !this.isAutoExecutable(client, tool),
          execute: (args: unknown) => client.callTool(tool.name, args),
        };
      },
    };
  }
}
