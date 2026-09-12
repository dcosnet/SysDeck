import { z } from "zod";
import { LineSplitterStream } from "../../core/src/mod.ts";

export const MCPTransportSchema = z.enum([
  "auto",
  "streamable-http",
  "http-sse",
  "stdio",
]);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

export const MCPClientConfigSchema = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true),
  headers: z.record(z.string(), z.string()).optional(),
  transport: MCPTransportSchema.default("http-sse"),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  /** stdio transport: executable + args of the local MCP server. */
  command: z.array(z.string()).min(1).optional(),
  /**
   * Allowlist of RAW (unprefixed) tool names this client may expose. When set
   * and non-empty, tools not listed are hidden from the catalog and rejected
   * by the executor. Unset or empty = expose every synced tool (default).
   */
  toolsToExecute: z.array(z.string()).optional(),
  /**
   * Allowlist of RAW (unprefixed) tool names permitted to auto-execute
   * without side-effect confirmation. When set and non-empty it REPLACES the
   * readOnlyHint heuristic: only listed tools skip the confirmation gate, and
   * everything else fails closed. Unset or empty = fall back to the
   * readOnlyHint annotation (default).
   */
  toolsToAutoExecute: z.array(z.string()).optional(),
}).refine(
  (c) => c.transport === "stdio" ? !!c.command?.length : !!c.url,
  {
    message:
      "stdio transport requires `command`; HTTP transports require `url`.",
  },
);
export type MCPClientConfig = z.infer<typeof MCPClientConfigSchema>;

/**
 * Safe control-plane projection of an MCP client configuration. Connection
 * headers, stdio arguments, and URL user-info can all carry credentials, so
 * they remain server-side. Header names are retained so an operator can
 * replace a stored value without first exposing it.
 */
export interface MCPClientPublicConfig
  extends Omit<MCPClientConfig, "headers" | "command" | "url"> {
  url?: string;
  headerNames: string[];
  hasCommand: boolean;
  hasUrlCredentials: boolean;
}

export function redactMCPClientConfig(
  config: MCPClientConfig,
): MCPClientPublicConfig {
  let url = config.url;
  let hasUrlCredentials = false;
  if (url) {
    const parsed = new URL(url);
    hasUrlCredentials = parsed.username.length > 0 ||
      parsed.password.length > 0;
    if (hasUrlCredentials) {
      parsed.username = "";
      parsed.password = "";
      url = parsed.href;
    }
  }
  const { headers: _headers, command: _command, ...publicConfig } = config;
  return {
    ...publicConfig,
    ...(url ? { url } : {}),
    headerNames: Object.keys(config.headers ?? {}),
    hasCommand: (config.command?.length ?? 0) > 0,
    hasUrlCredentials,
  };
}

export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class MCPError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = "MCPError";
  }
}

interface SSEEvent {
  event: string;
  data: string;
}

/** Parses an SSE byte stream into events (event name + joined data lines). */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const lines = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new LineSplitterStream());
  let event = "message";
  let data: string[] = [];
  for await (const line of lines) {
    if (line === "") {
      if (data.length > 0) {
        yield { event, data: data.join("\n") };
      }
      event = "message";
      data = [];
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
    // Comments (:) and other fields are ignored.
  }
  if (data.length > 0) {
    yield { event, data: data.join("\n") };
  }
}

interface Pending {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MCPClient {
  private nextId = 1;
  tools: MCPToolInfo[] = [];
  lastSyncAt?: string;
  /** Transport in effect after auto-negotiation. */
  resolvedTransport?: Exclude<MCPTransport, "auto">;

  private sessionId?: string;
  private channelAbort?: AbortController;
  private channelPump?: Promise<void>;
  private postUrl?: Promise<string>;
  private pending = new Map<number, Pending>();
  private proc?: Deno.ChildProcess;
  private stdinWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private stdoutPump?: Promise<void>;

  constructor(
    public config: MCPClientConfig,
    private fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (config.transport !== "auto") {
      this.resolvedTransport = config.transport;
    }
  }

  private baseHeaders(): Record<string, string> {
    return { ...this.config.headers };
  }

  private requireUrl(): string {
    if (!this.config.url) {
      throw new MCPError(
        `MCP server "${this.config.id}" has no URL configured.`,
      );
    }
    return this.config.url;
  }

  // ---------------------------------------------------------------- rpc core

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request = { jsonrpc: "2.0" as const, id, method, params };
    const message = await this.send(request, id);
    if (message.error) {
      throw new MCPError(message.error.message, message.error.code);
    }
    return message.result;
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  private async notify(method: string): Promise<void> {
    const body = { jsonrpc: "2.0" as const, method };
    try {
      if (this.resolvedTransport === "stdio") {
        this.ensureProcess();
        await this.stdinWriter!.write(
          new TextEncoder().encode(JSON.stringify(body) + "\n"),
        );
      } else if (this.resolvedTransport === "http-sse") {
        const target = await this.channelEndpoint();
        const response = await this.fetchImpl(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.baseHeaders(),
          },
          body: JSON.stringify(body),
        });
        await response.body?.cancel();
      } else {
        const response = await this.fetchImpl(this.requireUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
            ...this.baseHeaders(),
          },
          body: JSON.stringify(body),
        });
        await response.body?.cancel();
      }
    } catch {
      // Notifications are best-effort by contract.
    }
  }

  private async send(
    request: Record<string, unknown>,
    id: number,
  ): Promise<JsonRpcMessage> {
    if (this.resolvedTransport === "stdio") {
      return await this.sendStdio(request, id);
    }
    if (this.resolvedTransport === "http-sse") {
      return await this.sendLegacy(request, id);
    }
    try {
      const message = await this.sendStreamable(request, id);
      this.resolvedTransport = "streamable-http";
      return message;
    } catch (error) {
      const fallbackEligible = this.config.transport === "auto" &&
        this.resolvedTransport === undefined &&
        error instanceof MCPError &&
        (error.code === 404 || error.code === 405);
      if (!fallbackEligible) {
        throw error;
      }
      this.resolvedTransport = "http-sse";
      return await this.sendLegacy(request, id);
    }
  }

  // ------------------------------------------------- streamable-http (2025)

  // ---------------------------------------------------------------- stdio

  /** Spawns the local MCP server and pumps stdout lines to pending calls. */
  private ensureProcess(): void {
    if (this.proc) {
      return;
    }
    const [cmd, ...args] = this.config.command!;
    this.proc = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    this.stdinWriter = this.proc.stdin.getWriter();
    this.stdoutPump = (async () => {
      try {
        const lines = this.proc!.stdout
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new LineSplitterStream());
        for await (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const message = JSON.parse(line) as JsonRpcMessage;
            if (typeof message.id === "number") {
              const pending = this.pending.get(message.id);
              if (pending) {
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                pending.resolve(message);
              }
            }
          } catch {
            // Non-JSON server chatter is ignored.
          }
        }
      } catch {
        // Stream error: fall through to rejection below.
      }
      const reason = new MCPError(
        `MCP stdio server "${this.config.id}" exited.`,
      );
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(reason);
      }
    })();
  }

  private async sendStdio(
    request: Record<string, unknown>,
    id: number,
  ): Promise<JsonRpcMessage> {
    this.ensureProcess();
    const answer = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MCPError(
            `MCP server "${this.config.id}" did not answer request ${id} ` +
              `within ${this.config.requestTimeoutMs}ms.`,
          ),
        );
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.stdinWriter!.write(
        new TextEncoder().encode(JSON.stringify(request) + "\n"),
      );
    } catch (error) {
      // The caller gets THIS error; the registered entry must not linger
      // and later reject a promise nobody awaits (process-killing
      // unhandled rejection).
      this.discardPending(id);
      throw error;
    }
    return await answer;
  }

  /** Drops a pending entry and marks its promise handled. */
  private discardPending(id: number): void {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ jsonrpc: "2.0", id }); // settle; result is unused
    }
  }

  private async sendStreamable(
    request: Record<string, unknown>,
    id: number,
  ): Promise<JsonRpcMessage> {
    const response = await this.fetchImpl(this.requireUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...this.baseHeaders(),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      if (response.status === 404) {
        // Spec (2025-03-26): a 404 on a session-bearing request means the
        // session died server-side — drop it so re-initialization starts
        // clean instead of echoing the dead id forever.
        this.sessionId = undefined;
      }
      const text = await response.text();
      throw new MCPError(
        `MCP server "${this.config.id}" returned ${response.status}: ${text}`,
        response.status,
      );
    }
    const session = response.headers.get("Mcp-Session-Id");
    if (session) {
      this.sessionId = session;
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (!response.body) {
        throw new MCPError(
          `MCP server "${this.config.id}" sent an empty SSE response.`,
        );
      }
      // The POST body is an event stream: notifications may precede the
      // response; resolve on the message whose id matches ours.
      for await (const event of sseEvents(response.body)) {
        if (event.event !== "message") {
          continue;
        }
        try {
          const message = JSON.parse(event.data) as JsonRpcMessage;
          if (message.id === id) {
            return message;
          }
        } catch {
          // Ignore non-JSON keep-alives.
        }
      }
      throw new MCPError(
        `MCP server "${this.config.id}" closed the SSE response without ` +
          `answering request ${id}.`,
      );
    }

    return await response.json() as JsonRpcMessage;
  }

  // ------------------------------------------------------- http-sse (legacy)

  /** Opens the GET event channel once; resolves the POST endpoint URL. */
  private ensureChannel(): Promise<string> {
    if (this.postUrl) {
      return this.postUrl;
    }
    this.channelAbort = new AbortController();
    let resolveEndpoint!: (url: string) => void;
    let rejectEndpoint!: (error: Error) => void;
    this.postUrl = new Promise<string>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    // Mark handled: if the pump rejects a channel nobody is awaiting any
    // more (e.g. a deadline raced past it), the rejection must not become
    // a process-killing unhandled rejection. Real awaiters still see it.
    this.postUrl.catch(() => {});

    this.channelPump = (async () => {
      try {
        const response = await this.fetchImpl(this.requireUrl(), {
          headers: {
            "Accept": "text/event-stream",
            ...this.baseHeaders(),
          },
          signal: this.channelAbort!.signal,
        });
        if (!response.ok || !response.body) {
          throw new MCPError(
            `MCP server "${this.config.id}" SSE channel returned ` +
              `${response.status}.`,
            response.status,
          );
        }
        for await (const event of sseEvents(response.body)) {
          if (event.event === "endpoint") {
            const announced = new URL(event.data, this.requireUrl());
            const configured = new URL(this.requireUrl());
            if (announced.origin !== configured.origin) {
              throw new MCPError(
                `MCP server "${this.config.id}" announced an endpoint on a ` +
                  `different origin (${announced.origin}); refusing (SSRF guard).`,
              );
            }
            resolveEndpoint(announced.href);
            continue;
          }
          if (event.event !== "message") {
            continue;
          }
          try {
            const message = JSON.parse(event.data) as JsonRpcMessage;
            if (typeof message.id === "number") {
              const pending = this.pending.get(message.id);
              if (pending) {
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                pending.resolve(message);
              }
            }
          } catch {
            // Ignore non-JSON events.
          }
        }
        throw new MCPError(
          `MCP server "${this.config.id}" closed the SSE channel.`,
        );
      } catch (error) {
        const reason = error instanceof Error
          ? error
          : new MCPError(String(error));
        rejectEndpoint(reason);
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(reason);
        }
        this.postUrl = undefined; // allow reconnect on the next call
      }
    })();

    return this.postUrl;
  }

  /**
   * ensureChannel with a deadline: a server that accepts the GET but never
   * announces an `endpoint` event (e.g. a streamable-http-only server, or a
   * buffering proxy) must fail within requestTimeoutMs — not hang boot,
   * sync, and health checks forever.
   */
  private async channelEndpoint(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ensureChannel(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MCPError(
                  `MCP server "${this.config.id}" did not announce an SSE ` +
                    `endpoint within ${this.config.requestTimeoutMs}ms.`,
                ),
              ),
            this.config.requestTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      // Tear down the half-open channel so the next call reconnects.
      this.channelAbort?.abort();
      this.postUrl = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendLegacy(
    request: Record<string, unknown>,
    id: number,
  ): Promise<JsonRpcMessage> {
    const target = await this.channelEndpoint();
    const answer = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MCPError(
            `MCP server "${this.config.id}" did not answer request ${id} ` +
              `within ${this.config.requestTimeoutMs}ms.`,
          ),
        );
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.baseHeaders(),
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // The caller receives THIS error; the registered entry must not
      // linger and later reject a promise nobody awaits.
      this.discardPending(id);
      throw error;
    }
    await response.body?.cancel();
    if (!response.ok) {
      this.discardPending(id);
      throw new MCPError(
        `MCP server "${this.config.id}" rejected the request with ` +
          `${response.status}.`,
        response.status,
      );
    }
    return await answer;
  }

  // ------------------------------------------------------------- public API

  /** initialize + tools/list; refreshes the local tool catalog. */
  async sync(): Promise<MCPToolInfo[]> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "frosty-gateway", version: "0.9.0" },
    });
    await this.notify("notifications/initialized");
    const result = await this.rpc("tools/list", {}) as {
      tools?: MCPToolInfo[];
    };
    this.tools = result.tools ?? [];
    this.lastSyncAt = new Date().toISOString();
    return this.tools;
  }

  /** tools/call; returns the concatenated text content blocks. */
  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.rpc("tools/call", {
      name,
      arguments: args ?? {},
    }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
    if (result.isError) {
      throw new MCPError(text || `tool "${name}" reported an error`);
    }
    return text;
  }

  /**
   * Closes the legacy SSE channel and/or the stdio child process and
   * rejects in-flight requests.
   */
  async dispose(): Promise<void> {
    this.channelAbort?.abort();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new MCPError("client disposed"));
    }
    this.postUrl = undefined;
    try {
      await this.channelPump;
    } catch {
      // The pump's own error path already rejected everything.
    }
    this.channelPump = undefined;

    if (this.proc) {
      try {
        await this.stdinWriter?.close();
      } catch {
        // Already closed by a dead child.
      }
      try {
        this.proc.kill();
      } catch {
        // Already exited.
      }
      await this.proc.status;
      await this.stdoutPump;
      this.proc = undefined;
      this.stdinWriter = undefined;
      this.stdoutPump = undefined;
    }
  }
}
