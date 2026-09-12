import { assertEquals } from "@std/assert";
import {
  LineSplitterStream,
  SSENormalizationStream,
  withStreamCompletion,
} from "./stream.ts";
import type { ReconstructedMessage } from "./accumulate.ts";

async function pump<I, O>(
  transform: TransformStream<I, O>,
  inputs: I[],
): Promise<O[]> {
  const out: O[] = [];
  const source = new ReadableStream<I>({
    start(controller) {
      for (const input of inputs) {
        controller.enqueue(input);
      }
      controller.close();
    },
  });
  for await (const value of source.pipeThrough(transform)) {
    out.push(value);
  }
  return out;
}

Deno.test("SSENormalizationStream encodes objects and [DONE]", async () => {
  const frames = await pump(new SSENormalizationStream(), [
    { hello: "world" },
    "[DONE]",
  ]);
  assertEquals(frames, [
    'data: {"hello":"world"}\n\n',
    "data: [DONE]\n\n",
  ]);
});

Deno.test("LineSplitterStream buffers lines split across chunks", async () => {
  const lines = await pump(new LineSplitterStream(), [
    "first li",
    "ne\nsecond",
    " line\nthird",
  ]);
  assertEquals(lines, ["first line", "second line", "third"]);
});

Deno.test("LineSplitterStream strips carriage returns", async () => {
  const lines = await pump(new LineSplitterStream(), ["a\r\nb\r\n"]);
  assertEquals(lines, ["a", "b"]);
});

// Builds a Response whose body streams the given SSE text as the supplied
// network chunks (to exercise line-buffering across chunk boundaries).
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(response: Response): Promise<string> {
  return await new Response(response.body).text();
}

Deno.test("withStreamCompletion passes text through byte-identically", async () => {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  // Split the frames into arbitrary network chunks, including a boundary that
  // falls in the middle of a data: line.
  const whole = frames.join("");
  const networkChunks = [
    whole.slice(0, 20),
    whole.slice(20, 75),
    whole.slice(75),
  ];

  const out = await drain(
    withStreamCompletion(sseResponse(networkChunks), () => Promise.resolve()),
  );
  assertEquals(out, whole);
});

Deno.test("withStreamCompletion hands the hook text and the reconstructed message", async () => {
  let seenText: string | undefined;
  let seenMessage: ReconstructedMessage | undefined;

  const frames = [
    'data: {"id":"chatcmpl-1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ping","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
    "data: [DONE]\n\n",
  ];

  await drain(
    withStreamCompletion(sseResponse(frames), (text, message) => {
      seenText = text;
      seenMessage = message;
      return Promise.resolve();
    }),
  );

  // Backward-compatible text field unchanged.
  assertEquals(seenText, "Hi");
  // Additive reconstructed message carries the full picture.
  assertEquals(seenMessage?.content, "Hi");
  assertEquals(seenMessage?.finish_reason, "tool_calls");
  assertEquals(seenMessage?.usage, {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8,
  });
  assertEquals(seenMessage?.tool_calls, [
    {
      index: 0,
      id: "call_a",
      type: "function",
      function: { name: "ping", arguments: "{}" },
    },
  ]);
});
