import { assertEquals } from "@std/assert";
import { OtelExporter } from "./otel.ts";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  kind: number;
  name: string;
}

interface OtlpBatch {
  resourceSpans: Array<{
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
}

async function collectOne(
  record: (otel: OtelExporter) => void,
): Promise<OtlpSpan> {
  const batches: OtlpBatch[] = [];
  const collector = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    batches.push(await req.json() as OtlpBatch);
    return new Response(null, { status: 200 });
  });
  const endpoint = `http://127.0.0.1:${(collector.addr as Deno.NetAddr).port}`;
  try {
    const otel = new OtelExporter(endpoint, "frosty-test");
    record(otel);
    await otel.flush();
    return batches[0].resourceSpans[0].scopeSpans[0].spans[0];
  } finally {
    await collector.shutdown();
  }
}

Deno.test("otel flush honors provided trace/span/parent ids and kind", async () => {
  const span = await collectOne((otel) =>
    otel.record({
      name: "llm.call",
      startMs: 1000,
      endMs: 1100,
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      kind: 3,
      attributes: { "gen_ai.provider.name": "openai" },
    })
  );
  assertEquals(span.traceId, "0af7651916cd43dd8448eb211c80319c");
  assertEquals(span.spanId, "b7ad6b7169203331");
  assertEquals(span.parentSpanId, "00f067aa0ba902b7");
  assertEquals(span.kind, 3);
});

Deno.test("otel flush mints ids when absent and omits parentSpanId", async () => {
  const span = await collectOne((otel) =>
    otel.record({ name: "GET /x", startMs: 0, endMs: 1 })
  );
  assertEquals(span.traceId.length, 32);
  assertEquals(span.spanId.length, 16);
  assertEquals(span.kind, 2); // SERVER default preserved
  assertEquals("parentSpanId" in span, false);
});

Deno.test("otel flush passes tracestate through, omits it when absent", async () => {
  const withState = await collectOne((otel) =>
    otel.record({
      name: "llm.call",
      startMs: 0,
      endMs: 1,
      traceState: "vendor=1,other=2",
    })
  );
  assertEquals(withState.traceState, "vendor=1,other=2");

  const withoutState = await collectOne((otel) =>
    otel.record({ name: "llm.call", startMs: 0, endMs: 1 })
  );
  assertEquals("traceState" in withoutState, false);
});
