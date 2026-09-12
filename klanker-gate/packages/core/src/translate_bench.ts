import {
  AnthropicStreamTranslator,
  CohereStreamTranslator,
  CompletionsStreamTranslator,
  GenAIStreamTranslator,
  ResponsesStreamTranslator,
} from "./translate.ts";

/**
 * Edge stream-translation microbenchmarks.
 *
 * Every non-OpenAI streaming surface is produced by piping the canonical SSE
 * stream through one of these translators, so their per-chunk cost is paid on
 * every streamed request to that surface. One iteration translates a whole
 * response. The group baseline is an identity TransformStream over the same
 * line sequence, so the Web Streams plumbing every translator pays for is
 * measured rather than attributed to the translators.
 */

const WORDS =
  "the quick brown fox jumps over the lazy dog while the gateway streams tokens unchanged"
    .split(" ");

/** Canonical `data:` lines as LineSplitterStream would hand them over. */
function canonicalLines(): string[] {
  const lines: string[] = [];
  const push = (chunk: unknown) => lines.push(`data: ${JSON.stringify(chunk)}`);
  const envelope = {
    id: "chatcmpl-bench",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model: "gpt-4o-mini",
  };
  push({
    ...envelope,
    choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
  });
  for (let i = 0; i < 64; i++) {
    push({
      ...envelope,
      choices: [{
        index: 0,
        delta: { content: ` ${WORDS[i % WORDS.length]}` },
      }],
    });
  }
  push({
    ...envelope,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_bench",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        }],
      },
    }],
  });
  for (
    const fragment of ['{"loc', 'ation":"', 'Oslo","un', 'its":"cel', 'sius"}']
  ) {
    push({
      ...envelope,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: fragment } }],
        },
      }],
    });
  }
  push({
    ...envelope,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  push({
    ...envelope,
    choices: [],
    usage: { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 },
  });
  lines.push("data: [DONE]");
  return lines;
}

/**
 * A reasoning-carrying variant. The base fixture has no `reasoning` deltas, so
 * without this the thinking-block path would ship unmeasured (decision-log 78).
 */
function reasoningLines(): string[] {
  const lines: string[] = [];
  const envelope = {
    id: "chatcmpl-bench",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model: "gpt-4o-mini",
  };
  for (let i = 0; i < 32; i++) {
    lines.push(`data: ${
      JSON.stringify({
        ...envelope,
        choices: [{
          index: 0,
          delta: { reasoning: ` ${WORDS[i % WORDS.length]}` },
        }],
      })
    }`);
  }
  return [...lines, ...canonicalLines()];
}

const LINES = canonicalLines();
const REASONING_LINES = reasoningLines();
const MODEL = "gpt-4o-mini";

/** Drives one canonical response through a translator and drains the output. */
async function translate(
  translator: TransformStream<string, string>,
  lines: string[] = LINES,
): Promise<void> {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(line);
      }
      controller.close();
    },
  });
  for await (const _event of source.pipeThrough(translator)) {
    // Drained, not inspected: the translator's own work is what is measured.
  }
}

Deno.bench({
  name: `identity passthrough, ${LINES.length} chunks (Web Streams floor)`,
  group: "sse-translate",
  baseline: true,
}, async () => {
  await translate(new TransformStream<string, string>());
});

Deno.bench({
  name: `Anthropic Messages, ${LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new AnthropicStreamTranslator(MODEL));
});

Deno.bench({
  name:
    `Anthropic Messages + thinking blocks, ${REASONING_LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new AnthropicStreamTranslator(MODEL), REASONING_LINES);
});

Deno.bench({
  name: `OpenAI Responses, ${LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new ResponsesStreamTranslator(MODEL));
});

Deno.bench({
  name: `Google GenAI, ${LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new GenAIStreamTranslator(MODEL));
});

Deno.bench({
  name: `Cohere v2, ${LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new CohereStreamTranslator(MODEL));
});

Deno.bench({
  name: `legacy completions, ${LINES.length} canonical chunks`,
  group: "sse-translate",
}, async () => {
  await translate(new CompletionsStreamTranslator(MODEL));
});
