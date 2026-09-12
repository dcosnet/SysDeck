import { assert, assertEquals } from "@std/assert";
import {
  InMemoryVectorStore,
  type VectorMatch,
  type VectorStore,
} from "./vector.ts";
import { SemanticCache } from "./semantic.ts";
import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";

const response: ChatCompletionResponse = {
  id: "chatcmpl-v1",
  object: "chat.completion",
  created: 1700000000,
  model: "mock-model",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "cached" },
    finish_reason: "stop",
  }],
};

Deno.test("InMemoryVectorStore: search honors threshold and ranking", async () => {
  const store = new InMemoryVectorStore();
  await store.upsert("a", [1, 0], { name: "east" });
  await store.upsert("b", [0, 1], { name: "north" });

  const matches = await store.search([0.9, 0.1], { threshold: 0.9 });
  assertEquals(matches.length, 1);
  assertEquals(matches[0].id, "a");
  assert(matches[0].score > 0.9);

  const none = await store.search([0.7, 0.7], { threshold: 0.999 });
  assertEquals(none.length, 0);
});

Deno.test("InMemoryVectorStore: LRU bound", async () => {
  const store = new InMemoryVectorStore(2);
  await store.upsert("a", [1, 0], null);
  await store.upsert("b", [0, 1], null);
  await store.upsert("c", [1, 1], null);
  assertEquals(store.size(), 2);
  // "a" was evicted as the oldest entry.
  const matches = await store.search([1, 0], { threshold: 0.99 });
  assertEquals(matches.length, 0);
});

/**
 * Programmable external VectorStore double. Records what the cache upserts and
 * replays a canned search result, which is all the cache contract needs - the
 * real adapter (pgvector) is covered against its own wire format in
 * stores_test.ts and end to end in tests/live/vector_stores_live_test.ts.
 */
function fakeStore() {
  const state = {
    upserts: [] as Array<{ id: string; vector: number[]; payload: unknown }>,
    deletes: [] as string[],
    searchResult: [] as VectorMatch[],
  };
  const store: VectorStore = {
    upsert(id, vector, payload) {
      state.upserts.push({ id, vector, payload });
      return Promise.resolve();
    },
    search(_vector, opts) {
      return Promise.resolve(
        state.searchResult.filter((m) => m.score >= opts.threshold),
      );
    },
    delete(id) {
      state.deletes.push(id);
      return Promise.resolve(true);
    },
  };
  return { state, store };
}

Deno.test("SemanticCache: similarity lookups go through the external store", async () => {
  const { state, store } = fakeStore();
  const embedder = (text: string) =>
    Promise.resolve(text.includes("weather") ? [1, 0, 0] : [0, 1, 0]);
  const cache = new SemanticCache({ embedder, vectorStore: store });

  const request = {
    model: "m",
    messages: [{ role: "user", content: "weather in Oslo" }],
  };
  await cache.set(request, response);
  // The stored payload carries the full response, so a later hit can serve it.
  assertEquals(state.upserts.length, 1);
  assertEquals(state.upserts[0].vector, [1, 0, 0]);
  assertEquals(
    (state.upserts[0].payload as { response: ChatCompletionResponse }).response
      .id,
    "chatcmpl-v1",
  );

  // A semantically-close but non-identical request: exact match misses,
  // the external store answers.
  state.searchResult = [{
    id: "22222222-2222-4222-8222-222222222222",
    score: 0.98,
    payload: { response, storedAt: Date.now() },
  }];
  const hit = await cache.get({
    model: "m",
    messages: [{ role: "user", content: "weather in Oslo right now" }],
  });
  assertEquals(hit?.id, "chatcmpl-v1");

  // Expired vector payloads are not served.
  state.searchResult = [{
    id: "22222222-2222-4222-8222-222222222222",
    score: 0.98,
    payload: { response, storedAt: Date.now() - 10 * 60_000 },
  }];
  const stale = await cache.get({
    model: "m",
    messages: [{ role: "user", content: "weather in Oslo tomorrow" }],
  });
  assertEquals(stale, null);
});

Deno.test("SemanticCache: custom VectorStore is honored (seam contract)", async () => {
  const calls: string[] = [];
  const fake: VectorStore = {
    upsert(_id, _vector, _payload) {
      calls.push("upsert");
      return Promise.resolve();
    },
    search(_vector, _opts) {
      calls.push("search");
      return Promise.resolve([]);
    },
    delete(_id) {
      calls.push("delete");
      return Promise.resolve(true);
    },
  };
  const cache = new SemanticCache({
    embedder: () => Promise.resolve([1]),
    vectorStore: fake,
  });
  await cache.set({ model: "m", messages: [] }, response);
  await cache.get({ model: "m", messages: [{ role: "user", content: "x" }] });
  assertEquals(calls, ["upsert", "search"]);
});
