import { assertEquals } from "@std/assert";
import {
  formatTraceparent,
  newSpanId,
  newTraceId,
  normalizeSpanId,
  normalizeTraceId,
  parseTraceparent,
  recordChildSpan,
  sanitizeTracestate,
  takeChildSpans,
} from "./trace.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const PARENT = "b7ad6b7169203331";

Deno.test("parseTraceparent: valid header yields trace + parent ids", () => {
  assertEquals(parseTraceparent(`00-${TRACE}-${PARENT}-01`), {
    traceId: TRACE,
    parentId: PARENT,
  });
});

Deno.test("parseTraceparent: uppercase normalized; absent/blank is null", () => {
  const parsed = parseTraceparent(`00-${TRACE.toUpperCase()}-${PARENT}-01`);
  assertEquals(parsed?.traceId, TRACE);
  assertEquals(parseTraceparent(null), null);
  assertEquals(parseTraceparent(""), null);
  assertEquals(parseTraceparent("   "), null);
});

Deno.test("parseTraceparent: rejects malformed shapes", () => {
  // Wrong field count.
  assertEquals(parseTraceparent(`00-${TRACE}-${PARENT}`), null);
  // Wrong lengths.
  assertEquals(parseTraceparent("00-abc-def-01"), null);
  // Non-hex trace id.
  assertEquals(parseTraceparent(`00-${"z".repeat(32)}-${PARENT}-01`), null);
  // Forbidden ff version.
  assertEquals(parseTraceparent(`ff-${TRACE}-${PARENT}-01`), null);
});

Deno.test("parseTraceparent: rejects all-zero trace or parent ids", () => {
  assertEquals(parseTraceparent(`00-${"0".repeat(32)}-${PARENT}-01`), null);
  assertEquals(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`), null);
});

Deno.test("format + mint roundtrip through parse", () => {
  const traceId = newTraceId();
  const spanId = newSpanId();
  assertEquals(traceId.length, 32);
  assertEquals(spanId.length, 16);

  const header = formatTraceparent(traceId, spanId);
  assertEquals(header, `00-${traceId}-${spanId}-01`);
  assertEquals(parseTraceparent(header), { traceId, parentId: spanId });

  assertEquals(
    formatTraceparent(traceId, spanId, false),
    `00-${traceId}-${spanId}-00`,
  );
});

Deno.test("normalizeTraceId: strips hyphens, lowercases, validates 32 hex", () => {
  assertEquals(normalizeTraceId(TRACE), TRACE);
  // Hyphenated UUID -> 32 hex.
  assertEquals(
    normalizeTraceId("0af76519-16cd-43dd-8448-eb211c80319c"),
    TRACE,
  );
  assertEquals(normalizeTraceId(TRACE.toUpperCase()), TRACE);
  // Invalid: wrong length or non-hex.
  assertEquals(normalizeTraceId("tooshort"), "");
  assertEquals(normalizeTraceId("z".repeat(32)), "");
});

Deno.test("normalizeSpanId: 16 hex, truncates a longer UUID, rejects short", () => {
  assertEquals(normalizeSpanId(PARENT), PARENT);
  // Full UUID -> first 16 hex chars.
  assertEquals(
    normalizeSpanId("b7ad6b71-6920-3331-aaaa-bbbbccccdddd"),
    PARENT,
  );
  assertEquals(normalizeSpanId("short"), "");
});

Deno.test("sanitizeTracestate: trims, bounds length, drops empty/oversized", () => {
  assertEquals(sanitizeTracestate("vendor=1,other=2"), "vendor=1,other=2");
  assertEquals(sanitizeTracestate("  vendor=1  "), "vendor=1");
  assertEquals(sanitizeTracestate(null), "");
  assertEquals(sanitizeTracestate("   "), "");
  // Oversized is dropped whole (never truncated mid-member).
  assertEquals(sanitizeTracestate("x".repeat(513)), "");
});

Deno.test("recordChildSpan/takeChildSpans: buffer per request, drain once", () => {
  const req = new Request("http://x/v1/chat/completions");
  // Empty until something is recorded.
  assertEquals(takeChildSpans(req), []);

  recordChildSpan(req, { name: "chat openai", startMs: 1, endMs: 2 });
  recordChildSpan(req, {
    name: "mcp.tool gh__search",
    startMs: 2,
    endMs: 3,
    error: true,
  });

  const drained = takeChildSpans(req);
  assertEquals(drained.length, 2);
  assertEquals(drained[0].name, "chat openai");
  assertEquals(drained[1].error, true);
  // Drain is one-shot.
  assertEquals(takeChildSpans(req), []);
});

Deno.test("recordChildSpan: isolates requests and bounds the buffer at 64", () => {
  const a = new Request("http://x/a");
  const b = new Request("http://x/b");
  recordChildSpan(a, { name: "a1", startMs: 0, endMs: 1 });
  for (let i = 0; i < 100; i++) {
    recordChildSpan(b, { name: `b${i}`, startMs: 0, endMs: 1 });
  }
  // b's records never leak into a.
  assertEquals(takeChildSpans(a).length, 1);
  // Bounded at MAX_CHILD_SPANS.
  assertEquals(takeChildSpans(b).length, 64);
});
