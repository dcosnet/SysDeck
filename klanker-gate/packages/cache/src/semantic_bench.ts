import { SemanticCache } from "./semantic.ts";

/**
 * Cache-key projection microbenchmarks.
 *
 * `SemanticCache.keyFor` runs on every cacheable request (lookup and store),
 * and `promptText` runs again on the semantic path before the embedder is
 * called. Both are pure and both scale with conversation size, which is what
 * these fixtures vary.
 */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current conditions for a city.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name." },
          units: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_docs",
      description: "Full text search over the operator handbook.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
        required: ["query"],
      },
    },
  },
];

/** Turn one from a chat UI: system prompt plus a single user message. */
const smallRequest: Record<string, unknown> = {
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a concise engineering assistant." },
    {
      role: "user",
      content:
        "Summarize the CAP theorem and say which two properties a gateway cache trades away.",
    },
  ],
  temperature: 0.2,
  top_p: 1,
  max_tokens: 512,
};

/** Twenty-turn agent thread with tool schemas attached. */
function threadRequest(): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "You are a concise engineering assistant." },
  ];
  for (let turn = 0; turn < 10; turn++) {
    messages.push({
      role: "user",
      content:
        `Turn ${turn}: walk through the failure mode we saw in the ${turn}th deploy, ` +
        "including the retry budget, the fallback chain, and what the p99 did afterwards.",
    });
    messages.push({
      role: "assistant",
      content:
        `On turn ${turn} the router rerouted on 429 only, the fallback chain held, ` +
        "and p99 moved inside noise. Nothing in the governance path changed.",
    });
  }
  return {
    model: "gpt-4o-mini",
    messages,
    temperature: 0.2,
    top_p: 1,
    max_tokens: 1024,
    tools: TOOLS,
    seed: 7,
    stop: ["\n\n"],
  };
}

const largeRequest = threadRequest();

Deno.bench({
  name: "keyFor, 2-message request",
  group: "cache-key",
  baseline: true,
}, () => {
  SemanticCache.keyFor(smallRequest);
});

Deno.bench({
  name: "keyFor, 21-message thread with 2 tool schemas",
  group: "cache-key",
}, () => {
  SemanticCache.keyFor(largeRequest);
});

Deno.bench({
  name: "keyFor, 21-message thread, excludeSystemPrompt",
  group: "cache-key",
}, () => {
  SemanticCache.keyFor(largeRequest, { excludeSystemPrompt: true });
});

Deno.bench({
  name: "promptText, 21-message thread (embedding input)",
  group: "cache-key",
}, () => {
  SemanticCache.promptText(largeRequest);
});
