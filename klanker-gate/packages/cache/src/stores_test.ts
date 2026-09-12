// Hermetic unit layer for the pgvector store, driven through an injected query
// executor. Live end-to-end evidence against a real dockerized PostgreSQL lives
// in tests/live/vector_stores_live_test.ts.
//
// The RediSearch adapter that used to sit beside this one was removed with the
// rest of Redis (decision-log 60): it was provisioned by Compose and never
// selected by any configuration, and pgvector now serves the same role in the
// single PostgreSQL that also holds state and cache.

import { assert, assertEquals } from "@std/assert";
import { PgVectorStore } from "./pgvector.ts";

Deno.test("pgvector: schema bootstrap, parameterized upsert, scored search", async () => {
  const queries: Array<{ query: string; params?: unknown[] }> = [];
  const store = new PgVectorStore({
    executor: {
      unsafe(query, params) {
        queries.push({ query, params });
        if (query.startsWith("SELECT")) {
          return Promise.resolve([
            { id: "u1", payload: { note: "hei" }, score: "0.97" },
          ]);
        }
        return Promise.resolve([]);
      },
    },
    table: "test_vectors",
  });

  await store.upsert("11111111-1111-4111-8111-111111111111", [1, 0, 0], {
    note: "hei",
  });
  assert(queries[0].query.includes("CREATE EXTENSION IF NOT EXISTS vector"));
  assert(queries[1].query.includes("vector(3)"));
  const upsert = queries[2];
  assert(upsert.query.includes("ON CONFLICT (id) DO UPDATE"));
  assertEquals(upsert.params![1], "[1,0,0]");

  const matches = await store.search([1, 0, 0], { threshold: 0.9, limit: 2 });
  const search = queries[3];
  assert(search.query.includes("embedding <=> $1::vector"));
  assertEquals(search.params, ["[1,0,0]", 0.9, 2]);
  assertEquals(matches, [{ id: "u1", score: 0.97, payload: { note: "hei" } }]);

  assertEquals(
    await store.delete("11111111-1111-4111-8111-111111111111"),
    true,
  );
  assert(queries[4].query.includes("DELETE FROM test_vectors WHERE id = $1"));
});
