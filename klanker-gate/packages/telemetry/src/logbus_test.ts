import { assert, assertEquals } from "@std/assert";
import {
  captureContent,
  LogBus,
  logContentEnabled,
  type LogEntry,
  makePathExcluder,
  redactContent,
  statusClass,
} from "./logbus.ts";

Deno.test("statusClass maps codes to classes, else unknown", () => {
  assertEquals(statusClass(200), "2xx");
  assertEquals(statusClass(204), "2xx");
  assertEquals(statusClass(301), "3xx");
  assertEquals(statusClass(404), "4xx");
  assertEquals(statusClass(503), "5xx");
  assertEquals(statusClass(100), "1xx");
  assertEquals(statusClass(undefined), "unknown");
  assertEquals(statusClass(0), "unknown");
  assertEquals(statusClass(600), "unknown");
});

Deno.test("logContentEnabled is OFF unless explicitly enabled", () => {
  // Default OFF for privacy.
  assertEquals(logContentEnabled(undefined), false);
  assertEquals(logContentEnabled(""), false);
  assertEquals(logContentEnabled("off"), false);
  assertEquals(logContentEnabled("0"), false);
  assertEquals(logContentEnabled("false"), false);
  // Opt-in variants (case/space-insensitive).
  assertEquals(logContentEnabled("on"), true);
  assertEquals(logContentEnabled(" ON "), true);
  assertEquals(logContentEnabled("1"), true);
  assertEquals(logContentEnabled("true"), true);
  assertEquals(logContentEnabled("yes"), true);
});

Deno.test("redactContent strips secret-looking keys, keeps message bodies", () => {
  const redacted = redactContent({
    authorization: "Bearer sk-secret",
    apiKey: "sk-123",
    "x-api-key": "sk-456",
    headers: { cookie: "s=1", "content-type": "application/json" },
    messages: [{ role: "user", content: "hello world" }],
    model: "gpt-4o",
  }) as Record<string, unknown>;

  // Credentials are gone.
  assertEquals(redacted.authorization, "[redacted]");
  assertEquals(redacted.apiKey, "[redacted]");
  assertEquals(redacted["x-api-key"], "[redacted]");
  assertEquals(
    (redacted.headers as Record<string, unknown>).cookie,
    "[redacted]",
  );
  // Non-secret fields (including the content itself) survive verbatim.
  assertEquals(
    (redacted.headers as Record<string, unknown>)["content-type"],
    "application/json",
  );
  assertEquals(redacted.messages, [{ role: "user", content: "hello world" }]);
  assertEquals(redacted.model, "gpt-4o");
});

Deno.test("redactContent recurses arrays and caps deep/cyclic structures", () => {
  assertEquals(redactContent([{ token: "t" }, { ok: 1 }]), [
    { token: "[redacted]" },
    { ok: 1 },
  ]);

  // A structure deeper than the recursion cap is truncated (never loops).
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 12; i++) {
    deep = { nested: deep };
  }
  const out = JSON.stringify(redactContent(deep));
  assert(out.includes("[truncated]"));

  // A genuine cycle is handled without throwing.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  redactContent(cyclic); // must not throw or hang
});

Deno.test("captureContent returns undefined when disabled, redacts when enabled", () => {
  // Disabled (the default) => no content captured at all.
  assertEquals(
    captureContent("chat", { a: 1 }, { b: 2 }, false),
    undefined,
  );

  // Enabled => per-modality record with both sides redacted.
  const captured = captureContent(
    "chat",
    { authorization: "Bearer x", messages: [{ role: "user", content: "hi" }] },
    { choices: [{ message: { content: "hello" } }], apiKey: "leak" },
    true,
  );
  assertEquals(captured?.modality, "chat");
  assertEquals(
    (captured?.request as Record<string, unknown>).authorization,
    "[redacted]",
  );
  assertEquals(
    (captured?.response as Record<string, unknown>).apiKey,
    "[redacted]",
  );
  // Message content preserved.
  assertEquals(
    ((captured?.response as Record<string, unknown>).choices as unknown[])[0],
    { message: { content: "hello" } },
  );
});

Deno.test("LogBus: base LogEntry is unchanged (byte-identical) when unenriched", () => {
  const bus = new LogBus();
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
  bus.publish(base);
  const [got] = bus.recent();
  // No enrichment keys were injected: the round-trip is byte-identical.
  assertEquals(JSON.stringify(got), JSON.stringify(base));
  assertEquals(Object.keys(got).sort(), [
    "durationMs",
    "level",
    "message",
    "method",
    "path",
    "requestId",
    "status",
    "ts",
  ]);
});

Deno.test("LogBus: ring eviction counts as dropped", () => {
  const bus = new LogBus(3);
  for (let i = 0; i < 5; i++) {
    bus.publish({ ts: "t", level: "info", message: String(i) });
  }
  assertEquals(bus.recent().length, 3);
  assertEquals(bus.dropped(), 2);
  // Newest three retained.
  assertEquals(bus.recent().map((e) => e.message), ["2", "3", "4"]);
});

/* ------------------------- in-place enrichment patch --------------------- */

Deno.test("LogBus.update: patches in place and republishes to subscribers", () => {
  const bus = new LogBus(10);
  const seen: LogEntry[] = [];
  bus.subscribe((entry) => seen.push(entry));

  bus.publish({ ts: "t1", level: "info", message: "a", requestId: "r1" });
  bus.publish({ ts: "t2", level: "info", message: "b", requestId: "r2" });

  const merged = bus.update("r1", { model: "gpt-4o", totalTokens: 1500 });

  assertEquals(merged?.model, "gpt-4o");
  assertEquals(merged?.message, "a", "base fields survive the patch");
  // The ring holds two entries, not three: this is a rewrite, not an append.
  assertEquals(bus.recent().length, 2);
  assertEquals(bus.recent()[0].model, "gpt-4o");
  assertEquals(bus.dropped(), 0, "a patch never evicts a neighbour");
  // Subscribers see the patched entry so an open SSE view can refresh the row.
  assertEquals(seen.length, 3);
  assertEquals(seen[2].requestId, "r1");
  assertEquals(seen[2].totalTokens, 1500);
});

Deno.test("LogBus.update: unknown or aged-out request id is a no-op", () => {
  const bus = new LogBus(2);
  bus.publish({ ts: "t1", level: "info", message: "a", requestId: "r1" });
  bus.publish({ ts: "t2", level: "info", message: "b", requestId: "r2" });
  bus.publish({ ts: "t3", level: "info", message: "c", requestId: "r3" });

  assertEquals(bus.update("r1", { model: "gpt-4o" }), undefined);
  assertEquals(bus.update("nope", { model: "gpt-4o" }), undefined);
  assertEquals(bus.recent().length, 2);
});

Deno.test("LogBus.update: patches the newest entry sharing a request id", () => {
  const bus = new LogBus(10);
  bus.publish({ ts: "t1", level: "info", message: "first", requestId: "r1" });
  bus.publish({ ts: "t2", level: "info", message: "second", requestId: "r1" });

  bus.update("r1", { model: "gpt-4o" });

  assertEquals(bus.recent()[0].model, undefined);
  assertEquals(bus.recent()[1].model, "gpt-4o");
});

/* --------------------------- path exclusion ------------------------------ */

Deno.test("makePathExcluder: default keeps machine probes out of the trail", () => {
  const excluded = makePathExcluder();
  // The three probes that measured 99.6% of a real deployment's stored trail.
  assert(excluded("/healthz"));
  assert(excluded("/metrics"));
  assert(excluded("/favicon.ico"));
  // Real traffic and admin calls are untouched.
  assert(!excluded("/v1/chat/completions"));
  assert(!excluded("/api/logs/stored"));
  assert(!excluded("/"));
  assert(!excluded(undefined));
  // Exact match only: a prefix collision must not swallow a real path.
  assert(!excluded("/healthz/deep"));
  assert(!excluded("/metrics-export"));
});

Deno.test("makePathExcluder: blank uses the default, off disables entirely", () => {
  // Compose passes `${VAR:-}` through as an empty string, so blank must not
  // silently mean "log everything".
  assert(makePathExcluder("")("/healthz"));
  assert(makePathExcluder("   ")("/healthz"));
  for (const off of ["off", "none", "0", "false", "disabled", "OFF"]) {
    assert(!makePathExcluder(off)("/healthz"), `${off} must disable exclusion`);
  }
});

Deno.test("makePathExcluder: explicit list replaces the default", () => {
  const excluded = makePathExcluder("/ping, /api/internal");
  assert(excluded("/ping"));
  assert(excluded("/api/internal"), "surrounding whitespace is trimmed");
  assert(!excluded("/healthz"), "the default is replaced, not extended");
});

Deno.test("makePathExcluder: trailing /* matches a subtree", () => {
  const excluded = makePathExcluder("/assets/*,/healthz");
  assert(excluded("/assets/index-abc.js"));
  assert(excluded("/assets/nested/deep.css"));
  assert(excluded("/healthz"));
  assert(!excluded("/assets"), "the bare parent is not the subtree");
  assert(!excluded("/v1/chat/completions"));
});

Deno.test("makePathExcluder: pattern list is bounded", () => {
  const many = Array.from({ length: 500 }, (_, i) => `/p${i}`).join(",");
  const excluded = makePathExcluder(many);
  assert(excluded("/p0"));
  assert(!excluded("/p499"), "patterns beyond the cap are ignored");
});
