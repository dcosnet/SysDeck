import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  MAX_PER_IMAGE_USD,
  MAX_PER_MCHAR_USD,
  MAX_PER_MTOK_USD,
  MAX_PER_SECOND_USD,
  MAX_PRICING_BODY_BYTES,
  MAX_PRICING_KEY_LENGTH,
  MAX_PRICING_KEYS,
  type ModelPrice,
  ModelPriceSchema,
  PersistedModelPriceSchema,
  PricingCatalogSchema,
} from "./pricing.ts";

/** Every field the schema must carry, at a distinct value so a strip shows. */
const THIRTEEN_FIELDS: ModelPrice = {
  inputPerMTokUsd: 1,
  outputPerMTokUsd: 2,
  cacheReadPerMTokUsd: 3,
  cacheCreationPerMTokUsd: 4,
  inputPerMTokAbove128kUsd: 5,
  outputPerMTokAbove128kUsd: 6,
  inputPerMTokAbove200kUsd: 7,
  outputPerMTokAbove200kUsd: 8,
  batchInputPerMTokUsd: 9,
  batchOutputPerMTokUsd: 10,
  outputPerImageUsd: 11,
  inputPerMCharUsd: 12,
  inputPerAudioSecondUsd: 13,
};

Deno.test("ModelPriceSchema carries all thirteen fields", () => {
  // The live ingress schema is a two-field z.object(), and a bare z.object()
  // STRIPS. So PUT /api/pricing silently discards the other eleven before the
  // catalog is replaced and before the truncated set is persisted. One schema is
  // what stops the four sites drifting to four arities again.
  const parsed = ModelPriceSchema.parse(THIRTEEN_FIELDS);
  assertEquals(parsed, THIRTEEN_FIELDS);
  assertEquals(Object.keys(parsed).length, 13);
});

Deno.test("the live two-field shape is what loses eleven of them", () => {
  // Characterisation of the bug the shared schema exists to close, kept next to
  // the replacement so the reason for .strict() is legible.
  const live = z.object({
    inputPerMTokUsd: z.number().nonnegative(),
    outputPerMTokUsd: z.number().nonnegative(),
  });
  const stripped = live.parse(THIRTEEN_FIELDS);
  assertEquals(Object.keys(stripped).length, 2);
  assertEquals("outputPerImageUsd" in stripped, false);
});

Deno.test("ModelPriceSchema is strict at ingress", () => {
  // Operator intent must be exact: a typo in a rate name is a silent
  // mispricing, not a no-op. Same reasoning as GatewayConfigSchema's .strict().
  const result = ModelPriceSchema.safeParse({
    ...THIRTEEN_FIELDS,
    inputPerMTokUSD: 99,
  });
  assert(!result.success);
  assertEquals(result.error.issues[0].code, "unrecognized_keys");
});

Deno.test("the persisted twin strips instead of rejecting", () => {
  // A rollback has to survive: a rate field a newer gateway added must be
  // DROPPED (a downgrade) rather than fatal at boot.
  const result = PersistedModelPriceSchema.safeParse({
    ...THIRTEEN_FIELDS,
    fromANewerGateway: 42,
  });
  assert(result.success);
  assertEquals("fromANewerGateway" in result.data, false);
  assertEquals(result.data.inputPerMTokUsd, 1);
});

Deno.test("the two schemas cannot drift apart", () => {
  // They are built from one shape object, so this asserts the construction, not
  // a hand-maintained parallel list. If they ever diverge, "the persisted twin
  // of the same field set" has stopped being true.
  const strictKeys = Object.keys(ModelPriceSchema.shape).sort();
  const looseKeys = Object.keys(PersistedModelPriceSchema.shape).sort();
  assertEquals(strictKeys, looseKeys);
  assertEquals(strictKeys.length, 13);
});

Deno.test("the persisted twin keeps every rate ceiling", () => {
  // Tolerant about UNKNOWN keys, not about unrepresentable values: a persisted
  // 1e308 would reach costMicroUsd exactly as an ingress one would.
  for (
    const field of [
      "inputPerMTokUsd",
      "outputPerImageUsd",
      "inputPerMCharUsd",
      "inputPerAudioSecondUsd",
    ]
  ) {
    const result = PersistedModelPriceSchema.safeParse({
      ...THIRTEEN_FIELDS,
      [field]: 1e308,
    });
    assert(!result.success, `${field}: 1e308 must be refused on load too`);
  }
});

Deno.test("zod 4.4.3 pin: nonnegative() accepts 1e308, so .max() is the bound", () => {
  // The whole reason every rate carries a .max(). If a zod bump ever makes
  // nonnegative() reject 1e308 this test fails and the reasoning can be
  // revisited deliberately rather than silently inherited.
  const bare = z.number().nonnegative();
  assert(bare.safeParse(1e308).success, "nonnegative() accepts 1e308");
  assert(!bare.safeParse(Infinity).success, "nonnegative() rejects Infinity");
  assert(!bare.safeParse(-Infinity).success);
  assert(!bare.safeParse(NaN).success, "nonnegative() rejects NaN");
  assert(!bare.safeParse(-1).success);
  assert(bare.safeParse(0).success);
  // So .finite() would be redundant and .max() is load-bearing.
  assert(!bare.max(MAX_PER_MTOK_USD).safeParse(1e308).success);
});

Deno.test("zod 4.4.3 pin: .strict() accepts a missing optional", () => {
  // The honesty caveat on .strict(): it rejects an unknown key but it does NOT
  // stop a two-field client from wiping the other eleven, because absence is
  // legal. That gap is closed by a per-model PATCH, not by the schema.
  const twoFieldsOnly = ModelPriceSchema.safeParse({
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 2,
  });
  assert(twoFieldsOnly.success);
  assertEquals(twoFieldsOnly.data.outputPerImageUsd, undefined);
});

Deno.test("every rate is bounded at its own ceiling", () => {
  const ceilings: Array<[keyof ModelPrice, number]> = [
    ["inputPerMTokUsd", MAX_PER_MTOK_USD],
    ["outputPerMTokUsd", MAX_PER_MTOK_USD],
    ["cacheReadPerMTokUsd", MAX_PER_MTOK_USD],
    ["cacheCreationPerMTokUsd", MAX_PER_MTOK_USD],
    ["inputPerMTokAbove128kUsd", MAX_PER_MTOK_USD],
    ["outputPerMTokAbove128kUsd", MAX_PER_MTOK_USD],
    ["inputPerMTokAbove200kUsd", MAX_PER_MTOK_USD],
    ["outputPerMTokAbove200kUsd", MAX_PER_MTOK_USD],
    ["batchInputPerMTokUsd", MAX_PER_MTOK_USD],
    ["batchOutputPerMTokUsd", MAX_PER_MTOK_USD],
    ["outputPerImageUsd", MAX_PER_IMAGE_USD],
    ["inputPerMCharUsd", MAX_PER_MCHAR_USD],
    ["inputPerAudioSecondUsd", MAX_PER_SECOND_USD],
  ];
  assertEquals(ceilings.length, 13, "every field needs a ceiling");

  for (const [field, ceiling] of ceilings) {
    const at = ModelPriceSchema.safeParse({
      ...THIRTEEN_FIELDS,
      [field]: ceiling,
    });
    assert(at.success, `${field}: the ceiling itself is admissible`);

    for (const value of [ceiling + 1, 1e308]) {
      const over = ModelPriceSchema.safeParse({
        ...THIRTEEN_FIELDS,
        [field]: value,
      });
      assert(!over.success, `${field}: ${value} must be refused`);
      assertEquals(over.error.issues[0].path, [field]);
      assertEquals(over.error.issues[0].code, "too_big");
    }

    const negative = ModelPriceSchema.safeParse({
      ...THIRTEEN_FIELDS,
      [field]: -1,
    });
    assert(!negative.success, `${field}: a negative rate must be refused`);
  }
});

Deno.test("MAX_PER_MCHAR_USD exists and bounds the per-character rate", () => {
  // The one ceiling of the four that a prior revision omitted while claiming the
  // chain was closed end to end. A per-character rate times a large input is
  // exactly the magnitude the chain is supposed to bound.
  assertEquals(MAX_PER_MCHAR_USD, 1_000_000);
  assert(
    !ModelPriceSchema.safeParse({
      ...THIRTEEN_FIELDS,
      inputPerMCharUsd: MAX_PER_MCHAR_USD + 1,
    }).success,
  );
});

Deno.test("PricingCatalogSchema bounds key length", () => {
  const ok = PricingCatalogSchema.safeParse({
    ["m".repeat(MAX_PRICING_KEY_LENGTH)]: THIRTEEN_FIELDS,
  });
  assert(ok.success, "a key at the limit is admitted");

  const over = PricingCatalogSchema.safeParse({
    ["m".repeat(MAX_PRICING_KEY_LENGTH + 1)]: THIRTEEN_FIELDS,
  });
  assert(!over.success, "an over-long key is refused");

  const empty = PricingCatalogSchema.safeParse({ "": THIRTEEN_FIELDS });
  assert(!empty.success, "an empty model name is refused");
});

Deno.test("PricingCatalogSchema bounds key count", () => {
  // Unbounded key count is an unbounded persisted blob reloaded at every boot,
  // and it raises the metrics label ceiling seeded from the same body.
  const entries: Record<string, ModelPrice> = {};
  for (let i = 0; i < MAX_PRICING_KEYS; i++) entries[`m${i}`] = THIRTEEN_FIELDS;
  assert(PricingCatalogSchema.safeParse(entries).success, "the limit is legal");

  entries[`m${MAX_PRICING_KEYS}`] = THIRTEEN_FIELDS;
  assert(!PricingCatalogSchema.safeParse(entries).success, "one over is not");
});

Deno.test("PricingCatalogSchema is strict per entry", () => {
  const result = PricingCatalogSchema.safeParse({
    "gpt-4o": { ...THIRTEEN_FIELDS, typo: 1 },
  });
  assert(!result.success);
  // The issue path names the model, which is what the canonical envelope needs
  // in order to tell an operator which row was refused.
  assertEquals(result.error.issues[0].path, ["gpt-4o"]);
});

Deno.test("the pricing bounds carry their stated values and no env knob", async () => {
  assertEquals(MAX_PRICING_KEY_LENGTH, 256);
  assertEquals(MAX_PRICING_KEYS, 20_000);
  assertEquals(MAX_PRICING_BODY_BYTES, 4 * 1024 * 1024);
  assertEquals(MAX_PER_MTOK_USD, 1_000_000);
  assertEquals(MAX_PER_IMAGE_USD, 1_000);
  assertEquals(MAX_PER_SECOND_USD, 1_000);
  const source = await Deno.readTextFile(
    new URL("./pricing.ts", import.meta.url),
  );
  assert(!source.includes("Deno.env"), "pricing.ts must not read the env");
});
