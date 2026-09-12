import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Metrics } from "./metrics.ts";

Deno.test("recordLlmUsage emits labelled token/cost/request series", () => {
  const m = new Metrics();
  m.setKnownModels(["gpt-4o"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "gpt-4o",
    statusClass: "2xx",
    promptTokens: 1000,
    completionTokens: 500,
    costMicroUsd: 7500,
  });
  const out = m.renderPrometheus();
  assertStringIncludes(
    out,
    'frosty_input_tokens_total{provider="openai",model="gpt-4o"} 1000',
  );
  assertStringIncludes(
    out,
    'frosty_output_tokens_total{provider="openai",model="gpt-4o"} 500',
  );
  assertStringIncludes(
    out,
    'frosty_llm_cost_usd_total{provider="openai",model="gpt-4o"} 0.007500',
  );
  assertStringIncludes(
    out,
    'frosty_llm_requests_total{provider="openai",model="gpt-4o",status_class="2xx"} 1',
  );
});

Deno.test("recordLlmUsage bounds an unknown model to 'other'", () => {
  const m = new Metrics();
  m.setKnownModels(["gpt-4o"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "arbitrary-attacker-supplied-model",
    statusClass: "2xx",
    promptTokens: 1,
    completionTokens: 1,
    costMicroUsd: null,
  });
  const out = m.renderPrometheus();
  assertStringIncludes(out, 'model="other"');
  assert(!out.includes("arbitrary-attacker-supplied-model"));
});

Deno.test("recordLlmUsage attaches tenant labels for a known virtual key", () => {
  const m = new Metrics();
  m.setKnownModels(["gpt-4o"]);
  m.setKnownVirtualKeys(["vk-1"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "gpt-4o",
    statusClass: "2xx",
    promptTokens: 10,
    completionTokens: 5,
    costMicroUsd: 100,
    virtualKey: "vk-1",
    team: "team-1",
    customer: "cust-1",
  });
  const out = m.renderPrometheus();
  assertStringIncludes(
    out,
    'frosty_input_tokens_total{provider="openai",model="gpt-4o",virtual_key="vk-1",team="team-1",customer="cust-1"} 10',
  );
  assertStringIncludes(
    out,
    'frosty_output_tokens_total{provider="openai",model="gpt-4o",virtual_key="vk-1",team="team-1",customer="cust-1"} 5',
  );
  assertStringIncludes(
    out,
    'frosty_llm_requests_total{provider="openai",model="gpt-4o",status_class="2xx",virtual_key="vk-1",team="team-1",customer="cust-1"} 1',
  );
});

Deno.test("recordLlmUsage omits tenant labels when no virtual key applied", () => {
  const m = new Metrics();
  m.setKnownModels(["gpt-4o"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "gpt-4o",
    statusClass: "2xx",
    promptTokens: 10,
    completionTokens: 5,
    costMicroUsd: 100,
  });
  const out = m.renderPrometheus();
  // Un-tenanted series stays byte-identical to the pre-tenant exposition.
  assertStringIncludes(
    out,
    'frosty_input_tokens_total{provider="openai",model="gpt-4o"} 10',
  );
  assert(!out.includes("virtual_key="));
  assert(!out.includes("team="));
  assert(!out.includes("customer="));
});

Deno.test("recordLlmUsage drops an unknown (spoofed) virtual key id", () => {
  const m = new Metrics();
  m.setKnownModels(["gpt-4o"]);
  m.setKnownVirtualKeys(["vk-real"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "gpt-4o",
    statusClass: "2xx",
    promptTokens: 1,
    completionTokens: 1,
    costMicroUsd: null,
    virtualKey: "vk-spoofed-by-attacker",
    team: "team-1",
    customer: "cust-1",
  });
  const out = m.renderPrometheus();
  // The unknown id never becomes a label value (cardinality guard); it folds to
  // "other" exactly like an unknown model. Bounded team/customer pass through.
  assert(!out.includes("vk-spoofed-by-attacker"));
  assertStringIncludes(out, 'virtual_key="other"');
  assertStringIncludes(out, 'team="team-1"');
  assertStringIncludes(out, 'customer="cust-1"');
});

Deno.test("renderPrometheus escapes hostile label characters", () => {
  const m = new Metrics();
  const model = 'a"b\\c'; // contains a quote and a backslash
  m.setKnownModels([model]);
  m.recordLlmUsage({
    provider: 'p"x',
    model,
    statusClass: "4xx",
    promptTokens: 0,
    completionTokens: 0,
    costMicroUsd: null,
  });
  const out = m.renderPrometheus();
  // JSON.stringify is an exact oracle for Prometheus escaping of " and \.
  assertStringIncludes(out, `provider=${JSON.stringify('p"x')}`);
  assertStringIncludes(out, `model=${JSON.stringify(model)}`);
  // No raw newline injected into the exposition (each series is one line).
  const seriesLines = out.split("\n").filter((l) =>
    l.startsWith("frosty_input_tokens_total{")
  );
  assertEquals(seriesLines.length, 1);
});

Deno.test("recordCacheEvent counts hit/miss and ignores other results", () => {
  const m = new Metrics();
  m.recordCacheEvent("hit");
  m.recordCacheEvent("hit");
  m.recordCacheEvent("miss");
  m.recordCacheEvent("garbage");
  const out = m.renderPrometheus();
  assertStringIncludes(out, 'frosty_cache_events_total{result="hit"} 2');
  assertStringIncludes(out, 'frosty_cache_events_total{result="miss"} 1');
  assert(!out.includes("garbage"));
});

Deno.test("labelled metrics coexist with the existing global series", () => {
  const m = new Metrics();
  m.observe("/v1/chat/completions", 200, 12);
  m.increment("cost.micro_usd", 7500);
  m.setKnownModels(["gpt-4o"]);
  m.recordLlmUsage({
    provider: "openai",
    model: "gpt-4o",
    statusClass: "2xx",
    promptTokens: 5,
    completionTokens: 5,
    costMicroUsd: 25,
  });
  const out = m.renderPrometheus();
  // Pre-existing series unchanged.
  assertStringIncludes(
    out,
    'frosty_requests_total{route="/v1/chat/completions",status="200"} 1',
  );
  assertStringIncludes(out, "frosty_cost_usd_total 0.007500");
  // Plus the new labelled series.
  assertStringIncludes(out, "frosty_llm_cost_usd_total{");
});

Deno.test("stream latency observations render bounded Prometheus histograms", () => {
  const m = new Metrics();
  m.recordStreamFirstTokenLatency(40);
  m.recordStreamFirstTokenLatency(300);
  m.recordStreamInterTokenLatency(12);
  m.recordStreamInterTokenLatency(80);
  m.recordStreamInterTokenLatency(-1); // invalid samples are ignored

  const out = m.renderPrometheus();
  assertStringIncludes(
    out,
    "# TYPE frosty_stream_first_token_latency_ms histogram",
  );
  assertStringIncludes(
    out,
    'frosty_stream_first_token_latency_ms_bucket{le="50"} 1',
  );
  assertStringIncludes(
    out,
    'frosty_stream_first_token_latency_ms_bucket{le="+Inf"} 2',
  );
  assertStringIncludes(out, "frosty_stream_first_token_latency_ms_sum 340.00");
  assertStringIncludes(out, "frosty_stream_inter_token_latency_ms_count 2");
});
