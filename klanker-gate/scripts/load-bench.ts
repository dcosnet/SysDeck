// Tier 1 load test: drives the real gateway over real HTTP against an
// in-process mock provider, then reports throughput and latency percentiles.
//
//   deno task test:load            (defaults: 500 requests, 50 concurrent)
//   deno run --allow-net --allow-env scripts/load-bench.ts 2000 100
//
// In-process mode (the default) measures gateway overhead with the client, the
// gateway, and the mock upstream on one event loop. That is the right shape for
// comparing code changes, and the wrong shape for comparing process counts:
// a multi-process gateway cannot be hosted inside the client's event loop. The
// env knobs below drive an ALREADY-RUNNING gateway instead, which is how the
// process-count rows of docs/benchmark-report.md are produced.
//
//   FROSTY_BENCH_TARGET         base URL of an external gateway. Set = external
//                               mode: no in-process gateway is started.
//   FROSTY_BENCH_UPSTREAM_PORT  pin the mock upstream to a known port, so the
//                               external gateway can be pointed at it before
//                               this script starts. 0/unset = ephemeral.
//   FROSTY_BENCH_STREAM_EVERY   every Nth request uses SSE. 0 = never stream,
//                               1 = always. Default 5.
//   FROSTY_BENCH_MODEL          model to request. Default "m1".
//   FROSTY_BENCH_KEY            Authorization bearer token, for a governed
//                               target that requires a virtual key.
//
// The mock upstream is served in BOTH modes: an external gateway configured to
// reach it only dials per request, so there is no start-order dependency.

import { createHandler } from "../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../apps/gateway/context.ts";
import { ProviderManager } from "../packages/providers/src/mod.ts";
import { Metrics } from "../packages/telemetry/src/metrics.ts";
import { LogBus } from "../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../packages/mcp/src/registry.ts";
import { PluginManager } from "../packages/plugins/src/lifecycle.ts";

const TOTAL = Number(Deno.args[0]) || 500;
const CONCURRENCY = Number(Deno.args[1]) || 50;

/** every Nth request exercises the SSE path; 0 disables streaming entirely */
const STREAM_EVERY = numberEnv("FROSTY_BENCH_STREAM_EVERY", 5);
const UPSTREAM_PORT = numberEnv("FROSTY_BENCH_UPSTREAM_PORT", 0);
const TARGET = Deno.env.get("FROSTY_BENCH_TARGET")?.replace(/\/$/, "");
const MODEL = Deno.env.get("FROSTY_BENCH_MODEL") || "m1";
const KEY = Deno.env.get("FROSTY_BENCH_KEY");

/** Bounded parse: a non-integer or negative value falls back to the default. */
function numberEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const mockBody = JSON.stringify({
  id: "chatcmpl-load",
  object: "chat.completion",
  created: 1700000000,
  model: "m1",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "load test response" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
});

const streamBody = [
  `data: {"id":"chatcmpl-load","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"content":"load"},"finish_reason":null}]}\n\n`,
  `data: {"id":"chatcmpl-load","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  "data: [DONE]\n\n",
].join("");

const upstream = Deno.serve({
  port: UPSTREAM_PORT,
  onListen: () => {},
}, async (req) => {
  const body = await req.json().catch(() => ({}));
  if (body.stream) {
    return new Response(streamBody, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return new Response(mockBody, {
    headers: { "Content-Type": "application/json" },
  });
});
const upstreamUrl = `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`;

const ctx: AppContext = {
  providers: new ProviderManager([{
    id: "openai",
    type: "openai",
    apiKey: "k",
    baseUrl: upstreamUrl,
    enabled: true,
    models: ["m1"],
    priority: 0,
    retry: { maxRetries: 0 },
  }], "openai"),
  metrics: new Metrics(),
  logBus: new LogBus(),
  virtualKeys: new VirtualKeyManager(),
  mcp: new MCPRegistry(),
  plugins: new PluginManager(),
  toolExecutor: new NullToolExecutor(),
  version: VERSION,
};

// Silence per-request logging during the run.
const originalLog = console.log;
console.log = () => {};

// External mode leaves `gateway` undefined: the target is already serving, and
// starting a second one here would measure the wrong process.
const gateway = TARGET
  ? undefined
  : Deno.serve({ port: 0, onListen: () => {} }, createHandler(ctx));
const base = TARGET ??
  `http://127.0.0.1:${(gateway!.addr as Deno.NetAddr).port}`;

const latencies: number[] = [];
let failures = 0;

async function one(index: number): Promise<void> {
  const stream = STREAM_EVERY > 0 && index % STREAM_EVERY === 0;
  const start = performance.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `load ${index}` }],
        stream,
      }),
    });
    if (res.status !== 200) {
      failures++;
      await res.body?.cancel();
    } else {
      await res.text(); // drain fully, including SSE bodies
    }
  } catch {
    failures++;
  }
  latencies.push(performance.now() - start);
}

const startedAt = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < TOTAL) {
      const index = next++;
      await one(index);
    }
  }),
);
const elapsedMs = performance.now() - startedAt;

console.log = originalLog;

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies[
    Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)
  ];

const report = {
  mode: TARGET ? `external (${TARGET})` : "in-process",
  requests: TOTAL,
  concurrency: CONCURRENCY,
  streamShare: STREAM_EVERY === 0 ? "none" : `1/${STREAM_EVERY}`,
  elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
  requestsPerSecond: Number((TOTAL / (elapsedMs / 1000)).toFixed(1)),
  failures,
  latencyMs: {
    p50: Number(pct(50).toFixed(2)),
    p95: Number(pct(95).toFixed(2)),
    p99: Number(pct(99).toFixed(2)),
    max: Number(latencies.at(-1)!.toFixed(2)),
  },
};

console.log(JSON.stringify(report, null, 2));

await gateway?.shutdown();
await upstream.shutdown();

if (failures > 0) {
  console.error(`LOAD TEST FAILED: ${failures} failed requests`);
  Deno.exit(1);
}
