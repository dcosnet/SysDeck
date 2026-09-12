import { assert, assertEquals } from "@std/assert";
import {
  AnthropicStreamTranslator,
  CompletionsStreamTranslator,
  ResponsesStreamTranslator,
} from "./translate.ts";

function chunkLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}`;
}

function textChunk(content: string): string {
  return chunkLine({
    id: "chatcmpl-t1",
    created: 1700000001,
    model: "mock-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function finishChunk(
  reason: string,
  usage?: Record<string, number>,
): string {
  return chunkLine({
    id: "chatcmpl-t1",
    created: 1700000001,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage ? { usage } : {}),
  });
}

interface ParsedEvent {
  event?: string;
  data: Record<string, unknown>;
}

async function run(
  translator: TransformStream<string, string>,
  lines: string[],
): Promise<ParsedEvent[]> {
  const source = ReadableStream.from(lines);
  const events: ParsedEvent[] = [];
  for await (const frame of source.pipeThrough(translator)) {
    let event: string | undefined;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }
    if (data === "[DONE]") {
      events.push({ event, data: { done: true } });
    } else if (data.length > 0) {
      events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  return events;
}

Deno.test("anthropic translator: text stream event sequence", async () => {
  const events = await run(new AnthropicStreamTranslator("claude-x"), [
    textChunk("Hel"),
    textChunk("lo"),
    finishChunk("stop", { prompt_tokens: 3, completion_tokens: 7 }),
    "data: [DONE]",
  ]);

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
  const start = events[0].data as {
    message: { id: string; model: string; role: string };
  };
  assertEquals(start.message.model, "claude-x");
  assertEquals(start.message.role, "assistant");
  assertEquals(start.message.id, "msg_t1");

  const deltas = events.filter((e) => e.event === "content_block_delta")
    .map((e) => (e.data.delta as { text: string }).text);
  assertEquals(deltas, ["Hel", "lo"]);

  const messageDelta = events[5].data as {
    delta: { stop_reason: string };
    usage: { output_tokens: number };
  };
  assertEquals(messageDelta.delta.stop_reason, "end_turn");
  assertEquals(messageDelta.usage.output_tokens, 7);
});

Deno.test("anthropic translator: tool_use blocks with input_json_delta", async () => {
  const toolStart = chunkLine({
    id: "chatcmpl-t2",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_w1",
          function: { name: "get_weather", arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  });
  const toolArgs = chunkLine({
    id: "chatcmpl-t2",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"city":"Oslo"}' } }],
      },
      finish_reason: null,
    }],
  });
  const events = await run(new AnthropicStreamTranslator("claude-x"), [
    toolStart,
    toolArgs,
    finishChunk("tool_calls"),
    "data: [DONE]",
  ]);

  assertEquals(
    events.map((e) => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  const blockStart = events[1].data as {
    index: number;
    content_block: { type: string; id: string; name: string };
  };
  assertEquals(blockStart.index, 0);
  assertEquals(blockStart.content_block.type, "tool_use");
  assertEquals(blockStart.content_block.id, "call_w1");
  assertEquals(blockStart.content_block.name, "get_weather");

  const argDelta = events[2].data as {
    delta: { type: string; partial_json: string };
  };
  assertEquals(argDelta.delta.type, "input_json_delta");
  assertEquals(argDelta.delta.partial_json, '{"city":"Oslo"}');

  const messageDelta = events[4].data as { delta: { stop_reason: string } };
  assertEquals(messageDelta.delta.stop_reason, "tool_use");
});

Deno.test("responses translator: text envelope with sequence numbers", async () => {
  const events = await run(new ResponsesStreamTranslator("gpt-mock"), [
    textChunk("Hi"),
    textChunk(" there"),
    finishChunk("stop", {
      prompt_tokens: 2,
      completion_tokens: 4,
    }),
    "data: [DONE]",
  ]);

  assertEquals(
    events.map((e) => e.event),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );

  // sequence_number must be present and strictly increasing from 0.
  const sequence = events.map((e) => e.data.sequence_number as number);
  assertEquals(sequence, events.map((_, i) => i));

  const done = events[6].data as { text: string };
  assertEquals(done.text, "Hi there");

  const completed = events[9].data as {
    response: {
      status: string;
      output_text: string;
      usage: { input_tokens: number; output_tokens: number };
    };
  };
  assertEquals(completed.response.status, "completed");
  assertEquals(completed.response.output_text, "Hi there");
  assertEquals(completed.response.usage.output_tokens, 4);
});

Deno.test("responses translator: function_call arguments deltas", async () => {
  const toolStart = chunkLine({
    id: "chatcmpl-t3",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_f1",
          function: { name: "lookup", arguments: '{"q":' },
        }],
      },
      finish_reason: null,
    }],
  });
  const toolArgs = chunkLine({
    id: "chatcmpl-t3",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '"deno"}' } }],
      },
      finish_reason: null,
    }],
  });
  const events = await run(new ResponsesStreamTranslator("gpt-mock"), [
    toolStart,
    toolArgs,
    finishChunk("tool_calls"),
    "data: [DONE]",
  ]);

  assertEquals(
    events.map((e) => e.event),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  const argsDone = events[5].data as { arguments: string };
  assertEquals(argsDone.arguments, '{"q":"deno"}');

  const completed = events[7].data as {
    response: { output: Array<{ type: string; name: string }> };
  };
  assertEquals(completed.response.output[0].type, "function_call");
  assertEquals(completed.response.output[0].name, "lookup");
});

Deno.test("completions translator: text_completion chunks and [DONE]", async () => {
  const source = ReadableStream.from([
    textChunk("One"),
    textChunk(" two"),
    finishChunk("stop"),
    "data: [DONE]",
  ]);
  const frames: string[] = [];
  for await (
    const frame of source.pipeThrough(
      new CompletionsStreamTranslator("gpt-mock"),
    )
  ) {
    frames.push(frame);
  }

  const payloads = frames
    .map((f) => f.split("\n").find((l) => l.startsWith("data: "))!.slice(6))
    .filter((d) => d.length > 0);
  assertEquals(payloads.at(-1), "[DONE]");

  const chunks = payloads.slice(0, -1).map((p) =>
    JSON.parse(p) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ text: string; finish_reason: string | null }>;
    }
  );
  assert(chunks.every((c) => c.object === "text_completion"));
  assert(chunks.every((c) => c.id === "cmpl-t1"));
  assertEquals(chunks.map((c) => c.choices[0].text), ["One", " two", ""]);
  assertEquals(chunks.at(-1)!.choices[0].finish_reason, "stop");
});

Deno.test("translators finalize without [DONE] (flush path)", async () => {
  const events = await run(new AnthropicStreamTranslator("claude-x"), [
    textChunk("partial"),
    // upstream died: no finish chunk, no [DONE]
  ]);
  assertEquals(events.at(-1)?.event, "message_stop");
  assertEquals(events.at(-2)?.event, "message_delta");
});
