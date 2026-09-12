import { assert, assertEquals } from "@std/assert";
import {
  COLLAPSED_LABEL,
  DEFAULT_MODEL_CARDINALITY_CAP,
  SpanModelCardinalityGuard,
} from "./span_cardinality.ts";

Deno.test('admits models up to the cap, then folds the rest to "other"', () => {
  const guard = new SpanModelCardinalityGuard(3);
  assertEquals(guard.label("a"), "a");
  assertEquals(guard.label("b"), "b");
  assertEquals(guard.label("c"), "c");
  assert(!guard.collapsed);

  // Fourth distinct model exceeds the cap.
  assertEquals(guard.label("d"), COLLAPSED_LABEL);
  assertEquals(guard.label("e"), COLLAPSED_LABEL);
  assert(guard.collapsed);
  assertEquals(guard.state(), {
    admitted: 3,
    cap: 3,
    collapsed: true,
    collapsedModels: 2,
  });
});

Deno.test("an admitted model keeps its slot forever (series identity is stable)", () => {
  const guard = new SpanModelCardinalityGuard(2);
  guard.label("a");
  guard.label("b");
  guard.label("overflow");
  // "a" must never start reporting as "other" - a series that changes identity
  // mid-flight breaks rate() over it.
  for (let i = 0; i < 100; i++) {
    assertEquals(guard.label("a"), "a");
    assertEquals(guard.label("b"), "b");
  }
  assertEquals(guard.state().admitted, 2);
});

Deno.test("repeated overflow models are counted once, not per call", () => {
  const guard = new SpanModelCardinalityGuard(1);
  guard.label("kept");
  for (let i = 0; i < 50; i++) {
    assertEquals(guard.label("spam"), COLLAPSED_LABEL);
  }
  assertEquals(guard.state().collapsedModels, 1);
});

Deno.test("overflow tracking is itself bounded (no unbounded growth)", () => {
  const guard = new SpanModelCardinalityGuard(1);
  guard.label("kept");
  // Far more distinct overflow ids than the internal sample cap (64).
  for (let i = 0; i < 5_000; i++) {
    assertEquals(guard.label(`model-${i}`), COLLAPSED_LABEL);
  }
  const state = guard.state();
  // The COUNT stays accurate even though the ids are not all retained.
  assertEquals(state.collapsedModels, 5_000);
  assertEquals(state.admitted, 1);
});

Deno.test("absent or empty models never consume a cap slot", () => {
  const guard = new SpanModelCardinalityGuard(2);
  assertEquals(guard.label(undefined), "unknown");
  assertEquals(guard.label(null), "unknown");
  assertEquals(guard.label(""), "unknown");
  assertEquals(guard.state().admitted, 0);
  assert(!guard.collapsed);
  // The slots are still available for real models.
  assertEquals(guard.label("real"), "real");
  assertEquals(guard.state().admitted, 1);
});

Deno.test("a non-positive or unparseable cap falls back to the default", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(
      new SpanModelCardinalityGuard(bad).cap,
      DEFAULT_MODEL_CARDINALITY_CAP,
    );
  }
});

Deno.test("the default cap is 11 distinct models", () => {
  const guard = new SpanModelCardinalityGuard();
  for (let i = 0; i < DEFAULT_MODEL_CARDINALITY_CAP; i++) {
    assertEquals(guard.label(`m${i}`), `m${i}`);
  }
  assert(!guard.collapsed);
  assertEquals(guard.label("one-too-many"), COLLAPSED_LABEL);
  assert(guard.collapsed);
});
