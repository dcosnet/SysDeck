import { assert, assertEquals } from "@std/assert";
import { IDENT_MAX, makeUniqueNamer } from "./sanitize.ts";

Deno.test("makeUniqueNamer terminates on repeated long collisions", () => {
  // Regression for the main-isolate infinite loop: once a disambiguated
  // candidate reached IDENT_MAX, the old `(candidate + "0").slice(0, IDENT_MAX)`
  // made no progress and spun forever. A >=55-char base + same hashKey drives a
  // 64-char candidate whose exact value recurs on the 3rd call.
  const namer = makeUniqueNamer();
  const raw = "a".repeat(60); // sanitizes to a base longer than IDENT_MAX - suffix
  const ids = [
    namer(raw, "same-key"),
    namer(raw, "same-key"),
    namer(raw, "same-key"),
    namer(raw, "same-key"),
  ];
  // Under the old code the 3rd call hung; here all four return and are unique.
  assertEquals(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert(id.length <= IDENT_MAX, `id "${id}" exceeds IDENT_MAX`);
  }
});

Deno.test("makeUniqueNamer stays unique across many colliding bases", () => {
  const namer = makeUniqueNamer();
  const raw = "b".repeat(58);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = namer(raw, `key-${i}`);
    assert(id.length <= IDENT_MAX);
    assert(!seen.has(id), `duplicate id "${id}" at ${i}`);
    seen.add(id);
  }
});
