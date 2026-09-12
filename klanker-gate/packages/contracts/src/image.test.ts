import { assert, assertEquals } from "@std/assert";
import {
  ImageGenerationRequestSchema,
  type ImageGenerationResponse,
  ImageGenerationResponseSchema,
} from "./image.ts";
import { MAX_IMAGE_N } from "./limits.ts";

// D1-T28, schema half. The envelope half (400 naming the field) is asserted
// against the real route in tests/contract/advanced_apis_test.ts, and the
// reservation clause is deferred to the work package that builds the
// reservation function.

Deno.test("D1-T28: n and sampleCount are bounded by MAX_IMAGE_N", () => {
  for (const field of ["n", "sampleCount"] as const) {
    const over = ImageGenerationRequestSchema.safeParse({
      prompt: "a frosty fjord",
      [field]: 50,
    });
    assert(!over.success, `${field}: 50 must be rejected`);
    // The issue has to name the field, because validationErrorResponse turns
    // the first issue path into the envelope's `param`.
    assertEquals(over.error.issues[0].path, [field]);
    assertEquals(over.error.issues[0].code, "too_big");

    const at = ImageGenerationRequestSchema.safeParse({
      prompt: "a frosty fjord",
      [field]: MAX_IMAGE_N,
    });
    assert(at.success, `${field}: ${MAX_IMAGE_N} must be admitted`);
    assertEquals(at.data[field], MAX_IMAGE_N);
  }
});

Deno.test("D1-T28: zero, negative and fractional counts are rejected", () => {
  for (const field of ["n", "sampleCount"] as const) {
    for (const value of [0, -1, 2.5]) {
      const result = ImageGenerationRequestSchema.safeParse({
        prompt: "a frosty fjord",
        [field]: value,
      });
      assert(!result.success, `${field}: ${value} must be rejected`);
      assertEquals(result.error.issues[0].path, [field]);
    }
    // Absence stays legal: the default is one image, expressed by omission.
    const absent = ImageGenerationRequestSchema.safeParse({
      prompt: "a frosty fjord",
    });
    assert(absent.success);
    assertEquals(absent.data[field], undefined);
  }
});

Deno.test("D1-T28: the bound is exactly MAX_IMAGE_N, not a literal", () => {
  // A hand-written ceiling drifts from the constant the per-response byte cap
  // is derived from, and then the cap stops being out of caller reach.
  assert(
    ImageGenerationRequestSchema.safeParse({ prompt: "p", n: MAX_IMAGE_N })
      .success,
  );
  assert(
    !ImageGenerationRequestSchema.safeParse({ prompt: "p", n: MAX_IMAGE_N + 1 })
      .success,
  );
});

Deno.test("image request is passthrough: vendor fields survive to egress", () => {
  // quality/style/background/output_format/moderation are real gpt-image-1
  // fields the gateway does not model. A bare z.object() strips them, so they
  // never reach the provider.
  const result = ImageGenerationRequestSchema.safeParse({
    prompt: "a frosty fjord",
    quality: "high",
    style: "vivid",
    background: "transparent",
    output_format: "webp",
    moderation: "low",
  });
  assert(result.success);
  const data = result.data as Record<string, unknown>;
  assertEquals(data.quality, "high");
  assertEquals(data.style, "vivid");
  assertEquals(data.background, "transparent");
  assertEquals(data.output_format, "webp");
  assertEquals(data.moderation, "low");
});

Deno.test("image response type carries optional token usage", () => {
  // Type-only: this schema is .parse()d nowhere. The field exists so a media
  // route can carry an image response's own token usage, which a gpt-image-1
  // response reports alongside the images.
  const withUsage: ImageGenerationResponse = {
    created: 1,
    data: [{ b64_json: "AAAA" }],
    usage: { input_tokens: 1500, output_tokens: 4200, total_tokens: 5700 },
  };
  assertEquals(withUsage.usage?.input_tokens, 1500);
  assertEquals(withUsage.usage?.output_tokens, 4200);

  // And a response without it is still the same type, so no adapter breaks.
  const withoutUsage: ImageGenerationResponse = {
    created: 1,
    data: [{ url: "https://img.example/1.png" }],
  };
  assertEquals(withoutUsage.usage, undefined);

  // Deliberately NOT passthrough (an index signature on the inferred type buys
  // nothing when nothing parses it), so an unmodelled key is stripped.
  const parsed = ImageGenerationResponseSchema.safeParse({
    created: 1,
    data: [],
    unmodelled: true,
  });
  assert(parsed.success);
  assertEquals("unmodelled" in parsed.data, false);
});
