// MCP transport family (wave-2): streamable-http with JSON and SSE response
// bodies, legacy HTTP+SSE channel, auto-negotiation fallback, timeouts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  MCPClient,
  MCPClientConfigSchema,
  MCPError,
} from "../../packages/mcp/src/client.ts";

const TOOLS = [{
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
}];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

function rpcResult(id: number, method: string): Record<string, unknown> {
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18" } };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "echoed!" }] },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } };
}

function clientConfig(url: string, overrides: Record<string, unknown> = {}) {
  return MCPClientConfigSchema.parse({ id: "t", url, ...overrides });
}

Deno.test("streamable-http: JSON responses + session id echo", async () => {
  const sessions: Array<string | null> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json() as RpcRequest;
    sessions.push(req.headers.get("Mcp-Session-Id"));
    if (body.id === undefined) {
      return new Response(null, { status: 202 }); // notification
    }
    return Response.json(rpcResult(body.id, body.method), {
      headers: { "Mcp-Session-Id": "sess-42" },
    });
  });
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

  try {
    const client = new MCPClient(clientConfig(url, { transport: "auto" }));
    const tools = await client.sync();
    assertEquals(tools.map((t) => t.name), ["echo"]);
    assertEquals(await client.callTool("echo", { x: 1 }), "echoed!");
    assertEquals(client.resolvedTransport, "streamable-http");
    // First request has no session; every later one echoes the server's id.
    assertEquals(sessions[0], null);
    assert(sessions.slice(1).every((s) => s === "sess-42"));
  } finally {
    await server.shutdown();
  }
});

Deno.test("streamable-http: SSE response bodies are parsed to the matching id", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json() as RpcRequest;
    if (body.id === undefined) {
      return new Response(null, { status: 202 });
    }
    // A notification precedes the actual response on the same POST stream.
    const frames = [
      `event: message\ndata: ${
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })
      }\n\n`,
      `event: message\ndata: ${
        JSON.stringify(rpcResult(body.id, body.method))
      }\n\n`,
    ];
    return new Response(frames.join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

  try {
    const client = new MCPClient(
      clientConfig(url, { transport: "streamable-http" }),
    );
    const tools = await client.sync();
    assertEquals(tools.map((t) => t.name), ["echo"]);
    assertEquals(await client.callTool("echo", {}), "echoed!");
  } finally {
    await server.shutdown();
  }
});

/** Legacy 2024-11-05 server: GET opens the channel, POST goes to /messages. */
function legacyServer(options: { answer: boolean } = { answer: true }) {
  let channel: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const emit = (event: string, data: string) => {
    channel?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
  };
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          channel = controller;
          emit("endpoint", "/messages");
        },
        cancel() {
          channel = undefined;
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const body = await req.json() as RpcRequest;
      if (body.id !== undefined && options.answer) {
        emit("message", JSON.stringify(rpcResult(body.id, body.method)));
      }
      return new Response(null, { status: 202 });
    }
    // Streamable POST probe at the root: reject so "auto" falls back.
    if (req.method === "POST") {
      await req.body?.cancel();
      return new Response("method not allowed", { status: 405 });
    }
    return new Response("unexpected", { status: 500 });
  });
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { url, shutdown: () => server.shutdown() };
}

Deno.test("auto transport falls back to legacy http-sse on 405", async () => {
  const legacy = legacyServer();
  const client = new MCPClient(clientConfig(legacy.url, {
    transport: "auto",
  }));
  try {
    const tools = await client.sync();
    assertEquals(tools.map((t) => t.name), ["echo"]);
    assertEquals(client.resolvedTransport, "http-sse");
    assertEquals(await client.callTool("echo", { y: 2 }), "echoed!");
  } finally {
    await client.dispose();
    await legacy.shutdown();
  }
});

Deno.test("explicit http-sse transport skips the streamable probe", async () => {
  const legacy = legacyServer();
  const client = new MCPClient(
    clientConfig(legacy.url, { transport: "http-sse" }),
  );
  try {
    assertEquals(client.resolvedTransport, "http-sse");
    const tools = await client.sync();
    assertEquals(tools.map((t) => t.name), ["echo"]);
  } finally {
    await client.dispose();
    await legacy.shutdown();
  }
});

Deno.test("legacy transport rejects when the server never answers", async () => {
  const legacy = legacyServer({ answer: false });
  const client = new MCPClient(
    clientConfig(legacy.url, {
      transport: "http-sse",
      requestTimeoutMs: 200,
    }),
  );
  try {
    await assertRejects(
      () => client.sync(),
      MCPError,
      "did not answer",
    );
  } finally {
    await client.dispose();
    await legacy.shutdown();
  }
});
