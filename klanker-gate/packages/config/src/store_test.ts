import { assertEquals } from "@std/assert";
import { MemoryStateStore } from "./store_memory.ts";

Deno.test("ConfigStore operations", async () => {
  const store = new MemoryStateStore();
  // Use an ephemeral in-memory KV for tests

  await store.set(["provider", "openai"], { apiKey: "sk-test" });

  const val = await store.get<{ apiKey: string }>(["provider", "openai"]);
  assertEquals(val?.apiKey, "sk-test");

  const nonExistent = await store.get(["provider", "unknown"]);
  assertEquals(nonExistent, null);

  await store.close();
});
