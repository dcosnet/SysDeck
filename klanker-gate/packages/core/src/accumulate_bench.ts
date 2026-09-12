import { type ChatCompletionChunk, StreamAccumulator } from "./accumulate.ts";

/**
 * Stream accumulator microbenchmark.
 *
 * The accumulator is the work half of the passive tee (`withStreamCompletion`)
 * and folds every SSE chunk of every streamed response, so its cost multiplies
 * by chunk count. One iteration accumulates a whole response, not one chunk.
 */

const WORDS =
  "the quick brown fox jumps over the lazy dog while the gateway streams tokens unchanged"
    .split(" ");

/** 64 text deltas plus a terminal usage chunk: a short assistant reply. */
function textChunks(): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [{
    id: "chatcmpl-bench",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
  }];
  for (let i = 0; i < 64; i++) {
    chunks.push({
      id: "chatcmpl-bench",
      object: "chat.completion.chunk",
      created: 1_750_000_000,
      model: "gpt-4o-mini",
      choices: [{
        index: 0,
        delta: { content: ` ${WORDS[i % WORDS.length]}` },
      }],
    });
  }
  chunks.push({
    id: "chatcmpl-bench",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  chunks.push({
    id: "chatcmpl-bench",
    choices: [],
    usage: { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 },
  });
  return chunks;
}

/** Two tool calls streamed as argument fragments: the merge-by-index path. */
function toolCallChunks(): ChatCompletionChunk[] {
  const args = [
    '{"loc',
    'ation":"',
    'Oslo","un',
    'its":"cel',
    'sius"}',
  ];
  const chunks: ChatCompletionChunk[] = [{
    id: "chatcmpl-bench",
    created: 1_750_000_000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
  }];
  for (const index of [0, 1]) {
    chunks.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: `call_bench_${index}`,
            type: "function",
            function: { name: "get_weather", arguments: "" },
          }],
        },
      }],
    });
    for (const fragment of args) {
      chunks.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index, function: { arguments: fragment } }],
          },
        }],
      });
    }
  }
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  chunks.push({
    choices: [],
    usage: { prompt_tokens: 512, completion_tokens: 48, total_tokens: 560 },
  });
  return chunks;
}

const TEXT_CHUNKS = textChunks();
const TOOL_CHUNKS = toolCallChunks();

Deno.bench({
  name: `accumulate ${TEXT_CHUNKS.length} text chunks`,
  group: "stream-accumulate",
  baseline: true,
}, () => {
  const accumulator = new StreamAccumulator();
  for (const chunk of TEXT_CHUNKS) {
    accumulator.add(chunk);
  }
  accumulator.result();
});

Deno.bench({
  name: `accumulate ${TOOL_CHUNKS.length} tool-call chunks`,
  group: "stream-accumulate",
}, () => {
  const accumulator = new StreamAccumulator();
  for (const chunk of TOOL_CHUNKS) {
    accumulator.add(chunk);
  }
  accumulator.result();
});
