// In-process mock upstream used by contract, integration, and e2e tests.

export interface MockCall {
  path: string;
  body: unknown;
  headers: Headers;
}

export type MockHandler = (
  call: MockCall,
  index: number,
) => Response | Promise<Response>;

export class MockProvider {
  calls: MockCall[] = [];
  url: string;
  private server: Deno.HttpServer;

  constructor(handler: MockHandler) {
    this.server = Deno.serve(
      { port: 0, onListen: () => {} },
      async (req) => {
        const body = req.method === "POST"
          ? await req.json().catch(() => null)
          : null;
        const call: MockCall = {
          path: new URL(req.url).pathname,
          body,
          headers: req.headers,
        };
        const index = this.calls.length;
        this.calls.push(call);
        return await handler(call, index);
      },
    );
    const addr = this.server.addr as Deno.NetAddr;
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    await this.server.shutdown();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

export function openAIChatBody(
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1700000000,
    model: "mock-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ...overrides,
  };
}

export function openAIStreamFrames(texts: string[]): string[] {
  const frames = texts.map((text, i) =>
    `data: ${
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "mock-model",
        choices: [{
          index: 0,
          delta: i === 0
            ? { role: "assistant", content: text }
            : { content: text },
          finish_reason: null,
        }],
      })
    }\n\n`
  );
  frames.push(
    `data: ${
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })
    }\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** Reads an SSE body fully and returns the parsed `data:` payloads. */
export async function readSSE(
  response: Response,
): Promise<Array<Record<string, unknown> | "[DONE]">> {
  const text = await response.text();
  const out: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      out.push("[DONE]");
    } else {
      out.push(JSON.parse(data) as Record<string, unknown>);
    }
  }
  return out;
}
