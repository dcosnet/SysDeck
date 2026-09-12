// Wave-2 streaming surfaces: /v1/messages and /v1/responses stream
// translation, translated /v1/completions streaming, and the binding rule
// that plugins observe the CANONICAL stream (tap before translation).

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
import {
  MockProvider,
  openAIStreamFrames,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

function makeContext(
  providers: ProviderManager,
  plugins = new PluginManager(),
): AppContext {
  return {
    providers,
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins,
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

function openAIProvider(mockUrl: string): ProviderManager {
  return new ProviderManager([{
    id: "openai",
    type: "openai",
    apiKey: "sk-test",
    baseUrl: mockUrl,
    enabled: true,
    models: ["mock-model"],
    priority: 0,
    retry: { maxRetries: 0 },
  }], "openai");
}

interface NamedEvent {
  event?: string;
  data: Record<string, unknown> | "[DONE]";
}

/** readSSE variant that keeps `event:` names alongside the data payloads. */
async function readNamedSSE(response: Response): Promise<NamedEvent[]> {
  const text = await response.text();
  const events: NamedEvent[] = [];
  let event: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      events.push({
        event,
        data: data === "[DONE]"
          ? "[DONE]"
          : JSON.parse(data) as Record<string, unknown>,
      });
      event = undefined;
    }
  }
  return events;
}

Deno.test("/v1/messages stream translates to Anthropic events", async () => {
  const mock = new MockProvider(() =>
    sseResponse(openAIStreamFrames(["Hi", " there"]))
  );
  try {
    const handler = createHandler(makeContext(openAIProvider(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
    );

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    // The upstream request must have been a streaming chat completion.
    assertEquals(mock.calls[0].path, "/chat/completions");
    assertEquals((mock.calls[0].body as { stream: boolean }).stream, true);

    const events = await readNamedSSE(res);
    assertEquals(
      events.map((e) => e.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) =>
        ((e.data as Record<string, unknown>).delta as { text: string }).text
      )
      .join("");
    assertEquals(text, "Hi there");
    const stop = events[5].data as {
      delta: { stop_reason: string };
    };
    assertEquals(stop.delta.stop_reason, "end_turn");
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/responses stream emits the Responses envelope", async () => {
  const mock = new MockProvider(() =>
    sseResponse(openAIStreamFrames(["stream", "ing"]))
  );
  try {
    const handler = createHandler(makeContext(openAIProvider(mock.url)));
    const res = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "hello",
          stream: true,
        }),
      }),
    );

    assertEquals(res.status, 200);
    const events = await readNamedSSE(res);
    assertEquals(events[0].event, "response.created");
    assertEquals(events.at(-1)!.event, "response.completed");

    const sequence = events.map((e) =>
      (e.data as Record<string, unknown>).sequence_number as number
    );
    assertEquals(sequence, events.map((_, i) => i));

    const deltas = events
      .filter((e) => e.event === "response.output_text.delta")
      .map((e) => (e.data as { delta: string }).delta);
    assertEquals(deltas.join(""), "streaming");

    const completed = events.at(-1)!.data as {
      response: { status: string; output_text: string };
    };
    assertEquals(completed.response.status, "completed");
    assertEquals(completed.response.output_text, "streaming");
  } finally {
    await mock.close();
  }
});

Deno.test("/v1/completions streams via chat translation for chat-only providers", async () => {
  const mock = new MockProvider(() =>
    sseResponse(openAIStreamFrames(["a", "b"]))
  );
  try {
    // The gemini adapter has no native completions surface.
    const providers = new ProviderManager([{
      id: "gemini",
      type: "gemini",
      apiKey: "g-key",
      baseUrl: mock.url,
      enabled: true,
      models: ["flash"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "gemini");
    const handler = createHandler(makeContext(providers));
    const res = await handler(
      new Request("http://gateway.test/v1/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini/flash",
          prompt: "count",
          stream: true,
        }),
      }),
    );

    assertEquals(res.status, 200);
    const events = await readNamedSSE(res);
    assertEquals(events.at(-1)!.data, "[DONE]");
    const chunks = events.slice(0, -1).map((e) =>
      e.data as {
        object: string;
        choices: Array<{ text: string; finish_reason: string | null }>;
      }
    );
    assert(chunks.every((c) => c.object === "text_completion"));
    assertEquals(
      chunks.map((c) => c.choices[0].text).join(""),
      "ab",
    );
    assertEquals(chunks.at(-1)!.choices[0].finish_reason, "stop");
    // Upstream saw a chat request, not a completions request.
    assertEquals(mock.calls[0].path, "/chat/completions");
  } finally {
    await mock.close();
  }
});

Deno.test("plugins tap the canonical stream on translated surfaces", async () => {
  const mock = new MockProvider(() =>
    sseResponse(openAIStreamFrames(["canon", "ical"]))
  );
  try {
    const seen: string[] = [];
    const plugins = new PluginManager();
    plugins.register({
      name: "tap-recorder",
      onStreamComplete: (text) => {
        seen.push(text);
        return Promise.resolve();
      },
    });
    const handler = createHandler(
      makeContext(openAIProvider(mock.url), plugins),
    );

    const messages = await handler(
      new Request("http://gateway.test/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "x" }],
          stream: true,
        }),
      }),
    );
    await messages.text(); // drain so the tap flushes

    const responses = await handler(
      new Request("http://gateway.test/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/mock-model",
          input: "x",
          stream: true,
        }),
      }),
    );
    await responses.text();

    // Both surfaces delivered the CANONICAL accumulated text to the hook —
    // proof the tap ran before translation (grilling mitigation A3).
    assertEquals(seen, ["canonical", "canonical"]);
  } finally {
    await mock.close();
  }
});
