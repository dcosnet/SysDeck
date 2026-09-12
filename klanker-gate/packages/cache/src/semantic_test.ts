import { assert, assertEquals } from "@std/assert";
import {
  cosineSimilarity,
  type ReconstructedMessage,
  SemanticCache,
} from "./semantic.ts";
import { InMemoryVectorStore } from "./vector.ts";
import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";

function response(text: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-c",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
  };
}

const request = (content: string, temperature = 0) => ({
  model: "m",
  messages: [{ role: "user", content }],
  temperature,
});

Deno.test("promptText distinguishes different multimodal prompts", () => {
  // Regression: non-string content used to collapse to "", so two different
  // image-only prompts embedded identically and one served the other's response.
  const imgA = {
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;a" } }],
    }],
  };
  const imgB = {
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;b" } }],
    }],
  };
  const a = SemanticCache.promptText(imgA);
  const b = SemanticCache.promptText(imgB);
  assert(a.length > 0, "multimodal content must not embed as empty text");
  assert(a !== b, "distinct images must produce distinct embedding text");
});

Deno.test("keyFor separates response_format / seed / stop, else stable", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const prose = SemanticCache.keyFor(base);
  assertEquals(SemanticCache.keyFor(base), prose); // deterministic + unchanged
  assert(
    prose !== SemanticCache.keyFor({
      ...base,
      response_format: { type: "json_object" },
    }),
  );
  assert(prose !== SemanticCache.keyFor({ ...base, seed: 7 }));
  assert(prose !== SemanticCache.keyFor({ ...base, stop: ["\n"] }));
});

Deno.test("exact-match hit and miss", async () => {
  const cache = new SemanticCache();
  await cache.set(request("hello"), response("hi"));

  const hit = await cache.get(request("hello"));
  assertEquals(hit?.choices[0].message.content, "hi");

  assertEquals(await cache.get(request("different")), null);
  // parameter changes invalidate the key
  assertEquals(await cache.get(request("hello", 0.9)), null);
});

Deno.test("request-ID invalidation clears its exact and semantic entries", async () => {
  const cache = new SemanticCache({
    embedder: () => Promise.resolve([1, 0]),
    vectorStore: new InMemoryVectorStore(),
  });
  const owner = "11111111-1111-4111-8111-111111111111";
  const cached = request("weather in Oslo");
  await cache.set(cached, response("sunny"), owner);

  assertEquals(await cache.get(cached), response("sunny"));
  assertEquals(await cache.deleteByRequestId(owner), true);
  assertEquals(await cache.get(cached), null);
  // A non-identical but semantically identical request cannot recover the
  // completion: targeted invalidation removed the vector record too.
  assertEquals(await cache.get(request("weather in Oslo now")), null);
  assertEquals(await cache.deleteByRequestId(owner), false);
});

Deno.test("entries expire after the TTL", async () => {
  const cache = new SemanticCache({ ttlMs: 1 });
  await cache.set(request("hello"), response("hi"));
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(await cache.get(request("hello")), null);
  assertEquals(cache.size(), 0);
});

Deno.test("LRU eviction respects maxEntries", async () => {
  const cache = new SemanticCache({ maxEntries: 2 });
  await cache.set(request("a"), response("1"));
  await cache.set(request("b"), response("2"));
  await cache.set(request("c"), response("3"));
  assertEquals(cache.size(), 2);
  assertEquals(await cache.get(request("a")), null); // oldest evicted
  assert(await cache.get(request("c")));
});

Deno.test("vector similarity matches near-duplicate prompts", async () => {
  // toy embedder: bag-of-characters, deterministic
  const embedder = (text: string) => {
    const vec = new Array(26).fill(0);
    for (const ch of text.toLowerCase()) {
      const idx = ch.charCodeAt(0) - 97;
      if (idx >= 0 && idx < 26) {
        vec[idx]++;
      }
    }
    return Promise.resolve(vec);
  };
  const cache = new SemanticCache({ embedder, similarityThreshold: 0.9 });
  await cache.set(
    request("what is the weather in oslo"),
    response("sunny"),
  );

  // near-duplicate wording -> vector hit despite different exact key
  const hit = await cache.get(request("what is the weather in oslo?"));
  assertEquals(hit?.choices[0].message.content, "sunny");

  // unrelated prompt -> miss
  assertEquals(await cache.get(request("zzzzqqqq jjjj xxxx vvvv")), null);
});

Deno.test("cosineSimilarity basics", () => {
  assertEquals(cosineSimilarity([1, 0], [1, 0]), 1);
  assertEquals(cosineSimilarity([1, 0], [0, 1]), 0);
  assertEquals(cosineSimilarity([], []), 0);
  assertEquals(cosineSimilarity([1], [1, 2]), 0);
});

// --- key-derivation knobs (all opt-in, default-off = unchanged) -------------

Deno.test("default key derivation is byte-identical to the historical shape", () => {
  const req = {
    model: "m",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
  };
  const historical =
    '{"model":"m","messages":[{"role":"user","content":"hello"}],"temperature":0}';
  assertEquals(SemanticCache.keyFor(req), historical);
  // An explicit empty config must not change the key.
  assertEquals(SemanticCache.keyFor(req, {}), historical);
  // All-off knobs (cacheByModel true == default of "model included") likewise.
  assertEquals(
    SemanticCache.keyFor(req, {
      cacheByProvider: false,
      cacheByModel: true,
      excludeSystemPrompt: false,
    }),
    historical,
  );
});

Deno.test("cacheByProvider folds provider into the key only when enabled", () => {
  const openai = { model: "m", messages: [], provider: "openai" };
  const anthropic = { model: "m", messages: [], provider: "anthropic" };
  // Default: provider is ignored -> identical keys despite different providers.
  assertEquals(SemanticCache.keyFor(openai), SemanticCache.keyFor(anthropic));
  // Enabled: provider is part of the key -> distinct keys.
  assert(
    SemanticCache.keyFor(openai, { cacheByProvider: true }) !==
      SemanticCache.keyFor(anthropic, { cacheByProvider: true }),
  );
  assert(
    SemanticCache.keyFor(openai, { cacheByProvider: true }).includes(
      '"provider":"openai"',
    ),
  );
});

Deno.test("excludeSystemPrompt drops system messages from key + prompt text", () => {
  const a = {
    model: "m",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  };
  const b = {
    model: "m",
    messages: [
      { role: "system", content: "be verbose" },
      { role: "user", content: "hi" },
    ],
  };
  // Default: differing system prompts -> different keys.
  assert(SemanticCache.keyFor(a) !== SemanticCache.keyFor(b));
  // Excluded: system dropped -> keys collapse and embedding text omits it.
  assertEquals(
    SemanticCache.keyFor(a, { excludeSystemPrompt: true }),
    SemanticCache.keyFor(b, { excludeSystemPrompt: true }),
  );
  assertEquals(
    SemanticCache.promptText(a, { excludeSystemPrompt: true }),
    "hi",
  );
});

Deno.test("excludeSystemPrompt: differing system prompts share a cache entry", async () => {
  const cache = new SemanticCache({ excludeSystemPrompt: true });
  await cache.set(
    {
      model: "m",
      messages: [
        { role: "system", content: "A" },
        { role: "user", content: "q" },
      ],
    },
    response("answer"),
  );
  const hit = await cache.get({
    model: "m",
    messages: [
      { role: "system", content: "B" },
      { role: "user", content: "q" },
    ],
  });
  assertEquals(hit?.choices[0].message.content, "answer");
});

Deno.test("cacheByModel false drops the model from the key", () => {
  const gpt = { model: "gpt", messages: [{ role: "user", content: "q" }] };
  const claude = {
    model: "claude",
    messages: [{ role: "user", content: "q" }],
  };
  // Default keeps model -> distinct keys per model.
  assert(SemanticCache.keyFor(gpt) !== SemanticCache.keyFor(claude));
  // Explicit false drops model -> keys collapse across models.
  assertEquals(
    SemanticCache.keyFor(gpt, { cacheByModel: false }),
    SemanticCache.keyFor(claude, { cacheByModel: false }),
  );
  assert(
    !SemanticCache.keyFor(gpt, { cacheByModel: false }).includes('"model"'),
  );
});

Deno.test("conversationHistoryThreshold skips caching long conversations", async () => {
  const cache = new SemanticCache({ conversationHistoryThreshold: 2 });
  const long = {
    model: "m",
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
  };
  await cache.set(long, response("x"));
  assertEquals(cache.size(), 0); // over threshold -> not stored
  assertEquals(await cache.get(long), null); // over threshold -> bypassed

  const short = { model: "m", messages: [{ role: "user", content: "a" }] };
  await cache.set(short, response("y"));
  assertEquals(cache.size(), 1);
  assertEquals((await cache.get(short))?.choices[0].message.content, "y");
});

// --- tenant scope namespace (opt-in, absent = unchanged) --------------------

Deno.test("scopeKey absent reproduces the historical key exactly", () => {
  const req = {
    model: "m",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
  };
  const historical =
    '{"model":"m","messages":[{"role":"user","content":"hello"}],"temperature":0}';
  // Unscoped traffic (undefined) and keyless traffic (the 2-arg call the rest
  // of the codebase used before scoping existed) must both hash as before.
  assertEquals(SemanticCache.keyFor(req), historical);
  assertEquals(SemanticCache.keyFor(req, {}), historical);
  assertEquals(SemanticCache.keyFor(req, {}, undefined), historical);
  // An empty-string scope is not "unscoped" - it is still a namespace, and
  // must not silently collapse into the shared one.
  assert(SemanticCache.keyFor(req, {}, "") !== historical);
});

Deno.test("two different scoped keys do not share a cache entry", async () => {
  const cache = new SemanticCache();
  const req = request("what is the capital of norway?");
  await cache.set(req, response("oslo"), undefined, "vk-a");

  // Same request, different tenant scope -> miss, so the out-of-scope
  // completion stored by vk-a can never be served to vk-b.
  assertEquals(await cache.get(req, "vk-b"), null);
  assertEquals(
    (await cache.get(req, "vk-a"))?.choices[0].message.content,
    "oslo",
  );
});

Deno.test("a scoped key and an unscoped key do not collide", async () => {
  const cache = new SemanticCache();
  const req = request("shared prompt");
  await cache.set(req, response("scoped answer"), undefined, "vk-a");

  // Unscoped / keyless traffic must not read the scoped namespace...
  assertEquals(await cache.get(req), null);
  await cache.set(req, response("shared answer"));
  // ...and storing there must not overwrite or leak into the scoped entry.
  assertEquals(
    (await cache.get(req, "vk-a"))?.choices[0].message.content,
    "scoped answer",
  );
  assertEquals(
    (await cache.get(req))?.choices[0].message.content,
    "shared answer",
  );
  assertEquals(cache.size(), 2);
});

Deno.test("semantic (vector) hits stay inside their scope", async () => {
  // The vector store is searched by embedding alone, so the exact-key
  // namespace alone would not stop a near-duplicate prompt crossing scopes.
  const cache = new SemanticCache({
    embedder: () => Promise.resolve([1, 0]),
    vectorStore: new InMemoryVectorStore(),
    similarityThreshold: 0.9,
  });
  await cache.set(request("who won?"), response("team a"), "r1", "vk-a");

  // Identical embedding, different prompt text -> exact key misses, vector
  // matches at cosine 1.0, and only the matching scope may be served.
  assertEquals(await cache.get(request("who was the winner?"), "vk-b"), null);
  assertEquals(await cache.get(request("who was the winner?")), null);
  assertEquals(
    (await cache.get(request("who was the winner?"), "vk-a"))?.choices[0]
      .message.content,
    "team a",
  );
});

Deno.test("setStreamed stores under the same scope the read uses", async () => {
  const cache = new SemanticCache();
  const req = request("stream me");
  const reconstructed: ReconstructedMessage = {
    role: "assistant",
    content: "streamed answer",
    finish_reason: "stop",
  };
  await cache.setStreamed(req, reconstructed, "r1", "vk-a");
  assertEquals(await cache.get(req, "vk-b"), null);
  assertEquals(await cache.get(req), null);
  assertEquals(
    (await cache.get(req, "vk-a"))?.choices[0].message.content,
    "streamed answer",
  );
});

Deno.test("differing request params produce distinct keys (params_hash)", () => {
  const base = { model: "m", messages: [{ role: "user", content: "q" }] };
  const key = SemanticCache.keyFor(base);
  assert(SemanticCache.keyFor({ ...base, temperature: 0.7 }) !== key);
  assert(SemanticCache.keyFor({ ...base, top_p: 0.5 }) !== key);
  assert(SemanticCache.keyFor({ ...base, max_tokens: 100 }) !== key);
  assert(
    SemanticCache.keyFor({
      ...base,
      tools: [{ type: "function", function: { name: "f" } }],
    }) !== key,
  );
});

// --- structured cache-debug --------------------------------------------------

Deno.test("getWithDebug reports direct, semantic, and miss cache types", async () => {
  const embedder = (text: string) => {
    const vec = new Array(26).fill(0);
    for (const ch of text.toLowerCase()) {
      const idx = ch.charCodeAt(0) - 97;
      if (idx >= 0 && idx < 26) {
        vec[idx]++;
      }
    }
    return Promise.resolve(vec);
  };
  const cache = new SemanticCache({ embedder, similarityThreshold: 0.9 });

  // miss
  const miss = await cache.getWithDebug(request("weather in oslo"));
  assertEquals(miss.response, null);
  assertEquals(miss.debug.cache_type, "miss");
  assertEquals(miss.debug.threshold, 0.9);

  const resp = response("sunny");
  resp.usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  await cache.set(request("weather in oslo"), resp);

  // direct (exact) hit -> tokens from usage, no similarity
  const direct = await cache.getWithDebug(request("weather in oslo"));
  assertEquals(direct.debug.cache_type, "direct");
  assertEquals(direct.debug.tokens, 4);
  assertEquals(direct.debug.similarity, undefined);

  // semantic hit -> similarity present and at/above threshold
  const semantic = await cache.getWithDebug(request("weather in oslo?"));
  assertEquals(semantic.response?.choices[0].message.content, "sunny");
  assertEquals(semantic.debug.cache_type, "semantic");
  assert((semantic.debug.similarity ?? 0) >= 0.9);
  assertEquals(semantic.debug.tokens, 4);
});

// --- streaming-response caching ---------------------------------------------

Deno.test("streaming: setStreamed stores a reconstructed message for retrieval", async () => {
  const cache = new SemanticCache();
  const req = {
    model: "m",
    messages: [{ role: "user", content: "stream me" }],
  };
  const reconstructed: ReconstructedMessage = {
    role: "assistant",
    content: "streamed answer",
    finish_reason: "stop",
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    id: "chatcmpl-stream-1",
    model: "m",
    created: 123,
  };
  const built = await cache.setStreamed(req, reconstructed);
  assertEquals(built.object, "chat.completion");
  assertEquals(built.id, "chatcmpl-stream-1");
  assertEquals(built.choices[0].message.content, "streamed answer");
  assertEquals(built.choices[0].finish_reason, "stop");
  assertEquals(built.usage?.total_tokens, 4);

  // A subsequent identical request is served from cache.
  const hit = await cache.getWithDebug(req);
  assertEquals(hit.debug.cache_type, "direct");
  assertEquals(hit.response?.choices[0].message.content, "streamed answer");
  assertEquals(hit.debug.tokens, 4);
});

Deno.test("responseFromReconstructed maps tool calls and defaults the envelope", () => {
  const resp = SemanticCache.responseFromReconstructed(
    { model: "m", messages: [] },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: "{}" },
      }],
    },
  );
  assertEquals(resp.model, "m"); // falls back to request.model
  assertEquals(resp.object, "chat.completion");
  assert(resp.id.startsWith("chatcmpl-")); // generated envelope id
  const toolCalls = resp.choices[0].message.tool_calls as Array<
    Record<string, unknown>
  >;
  assertEquals(toolCalls[0].id, "call_1");
  assertEquals(toolCalls[0].function, { name: "search", arguments: "{}" });
  assertEquals("index" in toolCalls[0], false); // streaming index dropped
});
