import { assert, assertEquals } from "@std/assert";
import { MemoryStateStore } from "../../config/src/store_memory.ts";
import type { LogEntry } from "./logbus.ts";
import { LogStore } from "./logstore.ts";

function entry(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: "info",
    message: "ok",
    requestId: crypto.randomUUID(),
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    durationMs: 10,
    ...partial,
  };
}

async function withStore(
  fn: (store: LogStore) => Promise<void>,
  opts?: { maxEntries?: number; pruneEvery?: number },
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const cs = MemoryStateStore.named(`${dir}/logs.kv`);
  try {
    await fn(new LogStore(cs, opts?.maxEntries, opts?.pruneEvery));
  } finally {
    cs.close();
  }
}

Deno.test("stats: totals, status classes, success rate, latency, tokens, cost", async () => {
  await withStore(async (store) => {
    await store.append(entry({
      status: 200,
      durationMs: 10,
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 50,
      costMicroUsd: 500,
    }));
    await store.append(entry({ status: 200, durationMs: 20 }));
    await store.append(entry({ status: 500, durationMs: 30 })); // 5xx response
    await store.append(
      entry({ level: "error", status: undefined, durationMs: 5 }),
    ); // thrown
    await store.append(entry({ status: 404, durationMs: 15 }));

    const stats = await store.stats();
    assertEquals(stats.total, 5);
    assertEquals(stats.byStatusClass, {
      "2xx": 2,
      "5xx": 1,
      "unknown": 1,
      "4xx": 1,
    });
    assertEquals(stats.successCount, 2);
    assertEquals(stats.errorCount, 3);
    assertEquals(stats.successRate, 40); // 2 of 5 completed
    assertEquals(stats.avgLatencyMs, 16); // (10+20+30+5+15)/5
    assertEquals(stats.promptTokens, 100);
    assertEquals(stats.completionTokens, 50);
    assertEquals(stats.totalTokens, 150);
    assertEquals(stats.costMicroUsd, 500);
    assertEquals(stats.costUsd, 0.0005);
  });
});

Deno.test("stats: honestly empty for an empty store", async () => {
  await withStore(async (store) => {
    const stats = await store.stats();
    assertEquals(stats.total, 0);
    assertEquals(stats.byStatusClass, {});
    assertEquals(stats.successRate, 0);
    assertEquals(stats.avgLatencyMs, 0);
    assertEquals(stats.totalTokens, 0);
    assertEquals(stats.costMicroUsd, 0);
    assertEquals(stats.costUsd, 0);
  });
});

Deno.test("stats: honors the q + status filters", async () => {
  await withStore(async (store) => {
    await store.append(entry({ path: "/v1/messages", status: 200 }));
    await store.append(entry({ path: "/v1/chat/completions", status: 200 }));
    await store.append(entry({ path: "/v1/chat/completions", status: 500 }));

    const byStatus = await store.stats({ status: 200 });
    assertEquals(byStatus.total, 2);
    assertEquals(byStatus.successCount, 2);

    const byPath = await store.stats({ q: "messages" });
    assertEquals(byPath.total, 1);
  });
});

Deno.test("filterData: distinct facets, honestly empty where unrecorded", async () => {
  await withStore(async (store) => {
    await store.append(entry({
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      provider: "openai",
      model: "gpt-4o",
    }));
    await store.append(
      entry({ method: "GET", path: "/api/logs", status: 200 }),
    );
    await store.append(
      entry({ method: "POST", path: "/v1/messages", status: 429 }),
    );

    const fd = await store.filterData();
    assertEquals(fd.statuses, [200, 429]);
    assertEquals(fd.statusClasses, ["2xx", "4xx"]);
    assertEquals(fd.methods, ["GET", "POST"]);
    assertEquals(fd.paths, [
      "/api/logs",
      "/v1/chat/completions",
      "/v1/messages",
    ]);
    // Only one entry recorded provider/model; the rest contribute nothing.
    assertEquals(fd.models, ["gpt-4o"]);
    assertEquals(fd.providers, ["openai"]);
  });
});

Deno.test("filterData: models/providers empty when no producer records them", async () => {
  await withStore(async (store) => {
    await store.append(entry());
    await store.append(entry({ status: 500 }));
    const fd = await store.filterData();
    assertEquals(fd.models, []);
    assertEquals(fd.providers, []);
    assert(fd.statuses.length > 0); // dimensions that ARE recorded are present
  });
});

Deno.test("dropped: cap-prune evictions are counted", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.append(entry({ requestId: String(i) }));
    }
    assertEquals(store.dropped(), 3); // cap 2 => 3 evicted
    assertEquals((await store.query({})).total, 2);
  }, { maxEntries: 2, pruneEvery: 1 });
});

Deno.test("recalculateCost: re-derives cost for token-bearing entries only", async () => {
  await withStore(async (store) => {
    await store.append(entry({ model: "gpt-4o", promptTokens: 100 })); // -> 200
    await store.append(
      entry({ model: "gpt-4o", promptTokens: 50, costMicroUsd: 100 }), // already 100
    );
    await store.append(entry({ promptTokens: 100 })); // no model -> skip
    await store.append(entry({ model: "gpt-4o", promptTokens: 0 })); // no tokens -> skip

    // Fake coster: 2 micro-USD per prompt token, only when a model is present.
    const result = await store.recalculateCost((e) =>
      e.model && e.promptTokens ? e.promptTokens * 2 : null
    );
    assertEquals(result.scanned, 4);
    assertEquals(result.recalculated, 1); // only the first entry changed
    assertEquals(result.skipped, 3);

    // The newly-costed entry is persisted.
    const priced = (await store.query({ q: "chat" })).entries
      .find((e) => e.promptTokens === 100 && e.model === "gpt-4o");
    assertEquals(priced?.costMicroUsd, 200);
  });
});

Deno.test("backward-compat: base entries persist unchanged; aggregates stay honest", async () => {
  await withStore(async (store) => {
    // A base (RequestLogEntry-shaped) entry with no enrichment fields.
    const base: LogEntry = {
      ts: "2026-07-15T00:00:00.000Z",
      level: "info",
      message: "200 POST /v1/chat/completions",
      requestId: "req-1",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      durationMs: 12.5,
    };
    await store.append(base);

    const { entries, total } = await store.query({});
    assertEquals(total, 1);
    // Round-trips byte-identically (no enrichment keys injected).
    assertEquals(JSON.stringify(entries[0]), JSON.stringify(base));

    // Aggregates over base-only data are honest (no tokens/cost/models).
    const stats = await store.stats();
    assertEquals(stats.total, 1);
    assertEquals(stats.totalTokens, 0);
    assertEquals(stats.costMicroUsd, 0);
    const fd = await store.filterData();
    assertEquals(fd.models, []);
    assertEquals(fd.providers, []);
  });
});

/* --------------------- late enrichment patch (streaming) ----------------- */

Deno.test("update: patches a stored entry by request id", async () => {
  await withStore(async (store) => {
    await store.append(entry({ requestId: "req-a", message: "200 POST /v1" }));
    await store.append(entry({ requestId: "req-b" }));

    const merged = await store.update("req-a", {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costMicroUsd: 900,
    });

    assertEquals(merged?.model, "gpt-4o");
    assertEquals(merged?.message, "200 POST /v1", "base fields survive");

    // One row rewritten in place: the trail did not grow.
    const { entries, total } = await store.query({ limit: 100 });
    assertEquals(total, 2);
    const patched = entries.find((e) => e.requestId === "req-a");
    assertEquals(patched?.totalTokens, 150);
    assertEquals(patched?.costMicroUsd, 900);
    // The untouched neighbour carries no borrowed values.
    const other = entries.find((e) => e.requestId === "req-b");
    assertEquals(other?.model, undefined);
  });
});

Deno.test("update: patched tokens and cost reach the aggregate stats", async () => {
  await withStore(async (store) => {
    await store.append(entry({ requestId: "req-s" }));
    assertEquals((await store.stats()).totalTokens, 0);

    await store.update("req-s", {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costMicroUsd: 250,
    });

    const stats = await store.stats();
    assertEquals(stats.totalTokens, 15);
    assertEquals(stats.promptTokens, 10);
    assertEquals(stats.costMicroUsd, 250);
  });
});

Deno.test("update: patched model and provider reach the filter facets", async () => {
  await withStore(async (store) => {
    await store.append(entry({ requestId: "req-f" }));
    assertEquals((await store.filterData()).models, []);

    await store.update("req-f", { model: "gpt-4o", provider: "openai" });

    const facets = await store.filterData();
    assertEquals(facets.models, ["gpt-4o"]);
    assertEquals(facets.providers, ["openai"]);
  });
});

Deno.test("update: unknown request id resolves to undefined", async () => {
  await withStore(async (store) => {
    await store.append(entry({ requestId: "req-x" }));
    assertEquals(await store.update("nope", { model: "gpt-4o" }), undefined);
  });
});

// The in-memory requestId -> key index is a latency shortcut, not the source of
// truth: a store that never saw the append (fresh process, index empty) must
// still find the row by scanning.
Deno.test("update: falls back to a scan when the key index misses", async () => {
  const dir = await Deno.makeTempDir();
  const cs = MemoryStateStore.named(`${dir}/logs.kv`);
  try {
    const writer = new LogStore(cs);
    await writer.append(entry({ requestId: "req-scan" }));

    const reader = new LogStore(cs); // no index entries at all
    const merged = await reader.update("req-scan", { model: "gpt-4o" });
    assertEquals(merged?.model, "gpt-4o");
  } finally {
    cs.close();
  }
});

Deno.test("update: a pruned entry cannot be resurrected", async () => {
  await withStore(async (store) => {
    await store.append(entry({ requestId: "req-old" }));
    for (let i = 0; i < 5; i++) {
      await store.append(entry({ requestId: `req-${i}` }));
    }
    await store.prune(); // cap is 2, so req-old is gone

    assertEquals(await store.update("req-old", { model: "gpt-4o" }), undefined);
    assertEquals((await store.query({ limit: 100 })).total, 2);
  }, { maxEntries: 2 });
});
