// Middleware-level tracing tests: the always-on telemetry middleware emits the
// request's top llm.call span, drains any child spans the inference layer
// recorded against the same Request (provider attempts / MCP tools) as nested
// CHILD spans, and stays a no-op for span export when no exporter is attached.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { telemetryMiddleware } from "./telemetry.ts";
import { recordChildSpan } from "../../../packages/telemetry/src/trace.ts";
import { setRequestTenant } from "../../../packages/telemetry/src/usage.ts";
import type {
  OtelExporter,
  OtelSpanInput,
} from "../../../packages/telemetry/src/otel.ts";
import { Metrics } from "../../../packages/telemetry/src/metrics.ts";
import { ProviderManager } from "../../../packages/providers/src/mod.ts";
import type { AppContext } from "../context.ts";

/** An AppContext with just the fields the telemetry middleware touches, plus a
 * capturing exporter that records the raw OtelSpanInput objects for assertion. */
function makeCtx(withExporter = true): {
  ctx: AppContext;
  spans: OtelSpanInput[];
} {
  const spans: OtelSpanInput[] = [];
  const otel = withExporter
    ? ({
      record: (s: OtelSpanInput) => void spans.push(s),
    } as unknown as OtelExporter)
    : undefined;
  const ctx = {
    providers: new ProviderManager(),
    metrics: new Metrics(),
    otel,
  } as unknown as AppContext;
  return { ctx, spans };
}

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const PARENT = "b7ad6b7169203331";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("telemetry: emits top span + nested child provider span", async () => {
  const { ctx, spans } = makeCtx();
  const mw = telemetryMiddleware(ctx);

  const request = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "traceparent": `00-${TRACE}-${PARENT}-01`,
      "tracestate": "vendor=1",
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
  });
  // Governance resolves this upstream; telemetry reads it via getRequestTenant.
  setRequestTenant(request, {
    virtualKeyId: "vk_1",
    virtualKeyName: "prod",
    teamId: "team_1",
    teamName: "Platform",
  });

  const next = (req: Request): Promise<Response> => {
    // Simulate the inference-side follow-up recording a provider attempt span
    // (with request params) against the very Request telemetry will drain.
    recordChildSpan(req, {
      name: "chat openai",
      startMs: 10,
      endMs: 30,
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.temperature": 0.7,
        "gen_ai.request.top_p": 0.9,
        "gen_ai.request.max_tokens": 128,
        "gen_ai.request.tool_count": 2,
        "gen_ai.fallback_index": 0,
      },
    });
    return Promise.resolve(jsonResponse({
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hi" },
      }],
    }));
  };

  const res = await mw(request, next);
  assertEquals(res.status, 200); // response passes through unchanged
  await res.body?.cancel();

  assertEquals(spans.length, 2);
  const top = spans.find((s) => s.name === "llm.call")!;
  const child = spans.find((s) => s.name === "chat openai")!;

  // Top span adopts the inbound trace + parent (existing behavior, unchanged).
  assertEquals(top.traceId, TRACE);
  assertEquals(top.parentSpanId, PARENT);
  assertEquals(top.kind, 3);
  // Richer attrs on the top span: finish_reason + existing gen_ai.* + tenant.
  assertEquals(top.attributes?.["gen_ai.response.finish_reason"], "stop");
  assertEquals(top.attributes?.["gen_ai.usage.prompt_tokens"], 5);
  assertEquals(top.attributes?.["gen_ai.usage.completion_tokens"], 7);
  assertEquals(top.attributes?.["frosty.virtual_key.id"], "vk_1");
  assertEquals(top.attributes?.["frosty.team.name"], "Platform");
  // tracestate passthrough onto the exported span.
  assertEquals(top.traceState, "vendor=1");

  // Child span is parented to the request span, shares its trace + tracestate,
  // gets a fresh span id, and carries the request-param attributes.
  assertEquals(child.parentSpanId, top.spanId);
  assertEquals(child.traceId, TRACE);
  // Fresh 16-hex child span id, distinct from the parent's.
  assert(child.spanId !== undefined && child.spanId.length === 16);
  assert(child.spanId !== top.spanId);
  assertEquals(child.kind, 3);
  assertEquals(child.attributes?.["gen_ai.request.temperature"], 0.7);
  assertEquals(child.attributes?.["gen_ai.request.tool_count"], 2);
  assertEquals(child.attributes?.["gen_ai.fallback_index"], 0);
  assertEquals(child.traceState, "vendor=1");
});

Deno.test("telemetry: no recorded children -> single top span only", async () => {
  const { ctx, spans } = makeCtx();
  const mw = telemetryMiddleware(ctx);
  const request = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  const next = (): Promise<Response> =>
    Promise.resolve(jsonResponse({
      model: "m",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));

  const res = await mw(request, next);
  await res.body?.cancel();

  assertEquals(spans.length, 1);
  assertEquals(spans[0].name, "llm.call");
  // Fresh trace minted (no inbound traceparent), no parent, no tracestate.
  assertEquals(spans[0].traceId?.length, 32);
  assertEquals(spans[0].parentSpanId, undefined);
  assertEquals(spans[0].traceState, "");
});

Deno.test("telemetry: streaming request nests a child + captures finish_reason", async () => {
  const { ctx, spans } = makeCtx();
  const mw = telemetryMiddleware(ctx);
  const request = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [], stream: true }),
  });
  const frames = [
    `data: ${
      JSON.stringify({
        model: "gpt-4o",
        choices: [{ index: 0, delta: { content: "hi" } }],
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      })
    }\n\n`,
    "data: [DONE]\n\n",
  ];

  const next = (req: Request): Promise<Response> => {
    recordChildSpan(req, { name: "chat openai", startMs: 1, endMs: 9 });
    const encoder = new TextEncoder();
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(encoder.encode(frame));
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
  };

  const res = await mw(request, next);
  // Draining the tapped stream fires the flush -> emit at the stream's end.
  await new Response(res.body).text();

  assertEquals(spans.length, 2);
  const top = spans.find((s) => s.name === "llm.call")!;
  const child = spans.find((s) => s.name === "chat openai")!;
  assertEquals(top.attributes?.["gen_ai.stream"], true);
  assertEquals(top.attributes?.["gen_ai.response.finish_reason"], "stop");
  assertEquals(top.attributes?.["gen_ai.usage.prompt_tokens"], 3);
  assertEquals(child.parentSpanId, top.spanId);
  const metrics = ctx.metrics.renderPrometheus();
  assertStringIncludes(metrics, "frosty_stream_first_token_latency_ms_count 1");
  assertStringIncludes(metrics, "frosty_stream_inter_token_latency_ms_count 2");
});

Deno.test("telemetry: exporter off records no spans and passes the response", async () => {
  const { ctx, spans } = makeCtx(false);
  const mw = telemetryMiddleware(ctx);
  const request = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  let recorded = false;
  const next = (req: Request): Promise<Response> => {
    recordChildSpan(req, { name: "chat openai", startMs: 0, endMs: 1 });
    recorded = true;
    return Promise.resolve(jsonResponse({
      model: "m",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ index: 0, finish_reason: "stop" }],
    }));
  };

  const res = await mw(request, next);
  // Response is returned unchanged and nothing throws without an exporter.
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    model: "m",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ index: 0, finish_reason: "stop" }],
  });
  assert(recorded);
  assertEquals(spans.length, 0);
});
