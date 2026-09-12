import { assertEquals } from "@std/assert";
import { type ChatCompletionChunk, StreamAccumulator } from "./accumulate.ts";

function accumulate(chunks: ChatCompletionChunk[]): StreamAccumulator {
  const acc = new StreamAccumulator();
  for (const chunk of chunks) {
    acc.add(chunk);
  }
  return acc;
}

Deno.test("reconstructs content, tool calls, reasoning, finish_reason, usage", () => {
  // Synthetic OpenAI chat.completion.chunk stream: role + content deltas, two
  // tool calls streamed by index with arguments split across chunks, reasoning
  // deltas, a finish_reason chunk, then a terminal usage-only chunk.
  const acc = accumulate([
    {
      id: "chatcmpl-abc",
      model: "gpt-4o",
      created: 1234,
      choices: [{ index: 0, delta: { role: "assistant", content: "The " } }],
    },
    { choices: [{ index: 0, delta: { reasoning: "Let me " } }] },
    { choices: [{ index: 0, delta: { content: "weather" } }] },
    { choices: [{ index: 0, delta: { reasoning: "check tools." } }] },
    { choices: [{ index: 0, delta: { content: " is:" } }] },
    // Tool call 0 opens with id + name, empty args.
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_weather",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          }],
        },
      }],
    },
    // Tool call 0 arguments split across two chunks.
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
        },
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }],
        },
      }],
    },
    // Tool call 1 opens by index with its own id + name.
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 1,
            id: "call_time",
            type: "function",
            function: { name: "get_time", arguments: "" },
          }],
        },
      }],
    },
    // Tool call 1 arguments split across two chunks.
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 1, function: { arguments: '{"tz":"' } }],
        },
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 1, function: { arguments: 'PST"}' } }] },
      }],
    },
    // finish_reason chunk (empty delta).
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    // Terminal usage-only chunk (choices empty, as OpenAI emits it).
    {
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    },
  ]);

  const message = acc.result();

  assertEquals(message.role, "assistant");
  assertEquals(message.content, "The weather is:");
  assertEquals(message.reasoning, "Let me check tools.");
  assertEquals(message.finish_reason, "tool_calls");
  assertEquals(message.usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
  });
  // Envelope metadata captured for downstream cache reconstruction.
  assertEquals(message.id, "chatcmpl-abc");
  assertEquals(message.model, "gpt-4o");
  assertEquals(message.created, 1234);

  // Both tool calls, merged by index, with ids/names set once and arguments
  // concatenated in arrival order.
  assertEquals(message.tool_calls, [
    {
      index: 0,
      id: "call_weather",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SF"}' },
    },
    {
      index: 1,
      id: "call_time",
      type: "function",
      function: { name: "get_time", arguments: '{"tz":"PST"}' },
    },
  ]);
});

Deno.test("text-only stream reconstructs cleanly with no tool calls", () => {
  const acc = accumulate([
    {
      id: "chatcmpl-text",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
    },
    { choices: [{ index: 0, delta: { content: ", world" } }] },
    { choices: [{ index: 0, delta: { content: "!" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);

  const message = acc.result();

  assertEquals(message.content, "Hello, world!");
  assertEquals(message.finish_reason, "stop");
  // No tool calls, reasoning, refusal, or usage were streamed -> absent.
  assertEquals(message.tool_calls, undefined);
  assertEquals(message.reasoning, undefined);
  assertEquals(message.reasoning_details, undefined);
  assertEquals(message.refusal, undefined);
  assertEquals(message.usage, undefined);
});

Deno.test("pure tool-call turn yields empty content", () => {
  const acc = accumulate([
    {
      choices: [{
        index: 0,
        delta: {
          // OpenAI sends content: null on tool-call turns.
          content: null,
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "do_thing", arguments: "{}" },
          }],
        },
      }],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);

  const message = acc.result();
  assertEquals(message.content, "");
  assertEquals(message.tool_calls?.length, 1);
  assertEquals(message.tool_calls?.[0].function.name, "do_thing");
});

Deno.test("refusal deltas concatenate", () => {
  const acc = accumulate([
    { choices: [{ index: 0, delta: { refusal: "I cannot " } }] },
    { choices: [{ index: 0, delta: { refusal: "help with that." } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  assertEquals(acc.result().refusal, "I cannot help with that.");
});

Deno.test("reasoning_details merge by index: text concatenates, signature overwrites", () => {
  const acc = accumulate([
    {
      choices: [{
        index: 0,
        delta: {
          reasoning_details: [
            { index: 0, type: "reasoning.text", text: "Step 1. " },
            { index: 1, type: "reasoning.text", text: "Aside. " },
          ],
        },
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          reasoning_details: [
            { index: 0, text: "Step 2.", signature: "sig-early" },
          ],
        },
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          reasoning_details: [{ index: 0, signature: "sig-final" }],
        },
      }],
    },
  ]);

  assertEquals(acc.result().reasoning_details, [
    {
      index: 0,
      type: "reasoning.text",
      text: "Step 1. Step 2.",
      signature: "sig-final",
    },
    { index: 1, type: "reasoning.text", text: "Aside. " },
  ]);
});

Deno.test("usage total is derived when the upstream omits total_tokens", () => {
  const acc = accumulate([
    { choices: [{ index: 0, delta: { content: "hi" } }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } },
  ]);
  assertEquals(acc.result().usage, {
    prompt_tokens: 4,
    completion_tokens: 6,
    total_tokens: 10,
  });
});

Deno.test("result() is idempotent and returns independent copies", () => {
  const acc = accumulate([
    {
      choices: [{
        index: 0,
        delta: {
          content: "x",
          tool_calls: [{
            index: 0,
            id: "c1",
            function: { name: "f", arguments: "{}" },
          }],
        },
      }],
    },
  ]);

  const first = acc.result();
  const second = acc.result();
  assertEquals(first, second);
  // Mutating one projection must not leak into the accumulator or the next.
  first.content = "mutated";
  first.tool_calls![0].function.arguments = "tampered";
  const third = acc.result();
  assertEquals(third.content, "x");
  assertEquals(third.tool_calls![0].function.arguments, "{}");
});

Deno.test("continues past malformed and empty chunks without throwing", () => {
  const acc = new StreamAccumulator();
  // Deliberately hostile inputs: null, missing choices, null delta, junk.
  acc.add(null as unknown as ChatCompletionChunk);
  acc.add({} as ChatCompletionChunk);
  acc.add({ choices: [] });
  acc.add({ choices: [null as unknown as never] });
  acc.add({ choices: [{ index: 0, delta: null as unknown as never }] });
  acc.add({ choices: [{ index: 0, delta: { content: "ok" } }] });
  acc.add({
    choices: [{
      index: 0,
      // Tool-call delta with no index defaults to index 0.
      delta: { tool_calls: [{ function: { arguments: "!" } }] },
    }],
  });

  const message = acc.result();
  assertEquals(message.content, "ok");
  assertEquals(message.tool_calls, [
    { index: 0, type: "function", function: { name: "", arguments: "!" } },
  ]);
});
