import { assert, assertEquals } from "@std/assert";
import type { LogEntry } from "./logbus.ts";
import {
  compactEnrichment,
  type LogEnrichment,
  LogEnrichmentBridge,
} from "./logenrich.ts";

function entry(requestId?: string): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: "info",
    message: "200 POST /v1/chat/completions",
    requestId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    durationMs: 42,
  };
}

const USAGE: LogEnrichment = {
  provider: "openai",
  model: "gpt-4o",
  promptTokens: 1000,
  completionTokens: 500,
  totalTokens: 1500,
  costMicroUsd: 7500,
};

// The non-streaming order: telemetry resolves usage from the JSON body BEFORE
// the outer request logger's next() resolves, so enrichment is already waiting.
Deno.test("bridge: record before attach merges into the emitted entry", () => {
  const bridge = new LogEnrichmentBridge();
  bridge.track("req-1");
  bridge.record("req-1", USAGE);

  const merged = bridge.attach(entry("req-1"));

  assertEquals(merged.provider, "openai");
  assertEquals(merged.model, "gpt-4o");
  assertEquals(merged.totalTokens, 1500);
  assertEquals(merged.costMicroUsd, 7500);
  // Base fields survive untouched.
  assertEquals(merged.status, 200);
  assertEquals(merged.durationMs, 42);
  // Slot released once both sides have been seen.
  assertEquals(bridge.size(), 0);
});

// The streaming order: the logger emits while the SSE body is still unread, so
// usage only exists later and must patch the already-published entry.
Deno.test("bridge: attach before record routes to the late sink", () => {
  const patches: Array<[string, LogEnrichment]> = [];
  const bridge = new LogEnrichmentBridge((id, e) => patches.push([id, e]));
  bridge.track("req-2");

  const emitted = bridge.attach(entry("req-2"));
  assertEquals(emitted.model, undefined, "nothing is known at emit time");
  assertEquals(patches.length, 0);

  bridge.record("req-2", USAGE);

  assertEquals(patches.length, 1);
  assertEquals(patches[0][0], "req-2");
  assertEquals(patches[0][1].model, "gpt-4o");
  assertEquals(bridge.size(), 0);
});

Deno.test("bridge: untracked requests pass through unchanged", () => {
  const bridge = new LogEnrichmentBridge();
  const original = entry("req-3");

  const result = bridge.attach(original);

  assertEquals(result, original, "same object, no copy, no added keys");
  // A record for a request that was never tracked is a no-op, not a throw.
  bridge.record("req-3", USAGE);
  assertEquals(bridge.size(), 0);
});

Deno.test("bridge: an entry with no requestId is never enriched", () => {
  const bridge = new LogEnrichmentBridge();
  bridge.track(undefined);
  bridge.record(undefined, USAGE);
  const result = bridge.attach(entry(undefined));
  assertEquals(result.model, undefined);
  assertEquals(bridge.size(), 0);
});

Deno.test("bridge: a throwing late sink cannot escape into the caller", () => {
  const bridge = new LogEnrichmentBridge(() => {
    throw new Error("store exploded");
  });
  bridge.track("req-4");
  bridge.attach(entry("req-4"));
  bridge.record("req-4", USAGE); // must not throw
  assertEquals(bridge.size(), 0);
});

// Slots are only allocated for inference requests, but a middleware throwing
// between track() and the two callbacks would leak one. Eviction bounds it
// without needing a timer.
Deno.test("bridge: tracked slots are bounded by oldest-out eviction", () => {
  const bridge = new LogEnrichmentBridge(undefined, 4);
  for (let i = 0; i < 20; i++) {
    bridge.track(`req-${i}`);
  }
  assertEquals(bridge.size(), 4);

  // The oldest slots are gone, so their entries pass through unenriched.
  bridge.record("req-0", USAGE);
  assertEquals(bridge.attach(entry("req-0")).model, undefined);

  // The newest slot still works end to end.
  bridge.record("req-19", USAGE);
  assertEquals(bridge.attach(entry("req-19")).model, "gpt-4o");
});

Deno.test("bridge: double-tracking a request id keeps one slot", () => {
  const bridge = new LogEnrichmentBridge();
  bridge.track("req-5");
  bridge.record("req-5", USAGE);
  bridge.track("req-5"); // must not clear the stashed enrichment
  assertEquals(bridge.attach(entry("req-5")).model, "gpt-4o");
});

Deno.test("compactEnrichment: drops absent fields, keeps real zeros", () => {
  assertEquals(compactEnrichment({}), {});
  assertEquals(
    compactEnrichment({ provider: undefined, model: "", costMicroUsd: null }),
    {},
    "empty strings and null cost are omitted, not stored as falsy values",
  );
  // A genuinely free/zero-token request records zeros rather than dropping them.
  const zeroed = compactEnrichment({
    model: "local-model",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
  });
  assertEquals(zeroed.promptTokens, 0);
  assertEquals(zeroed.totalTokens, 0);
  assertEquals(zeroed.costMicroUsd, 0);
  assert(!("provider" in zeroed));
});
