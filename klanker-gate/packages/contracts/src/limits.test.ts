import { assert, assertEquals } from "@std/assert";
import {
  MAX_IMAGE_N,
  MAX_MEDIA_INFLIGHT_BYTES,
  MAX_MEDIA_JSON_BYTES,
  MAX_TRANSCRIPTION_JSON_BYTES,
  MAX_TTS_INPUT_CHARS,
  MEDIA_BYTES_PER_IMAGE,
} from "./limits.ts";

// D1-T32. These are the relationships between the media bounds, not their
// values for their own sake. Each one is here because breaking it produces a
// specific failure, named per assertion.

Deno.test("D1-T32: MAX_MEDIA_JSON_BYTES is derived, not restated", () => {
  // A hand-written literal drifts from the two constants it is supposed to be
  // the product of, and then the per-response cap stops being out of caller
  // reach - which is the only thing that makes the cap fail-closed.
  assertEquals(MAX_MEDIA_JSON_BYTES, MAX_IMAGE_N * MEDIA_BYTES_PER_IMAGE);
});

Deno.test("D1-T32: the largest admissible reservation fits the budget", () => {
  // A budget below the largest admissible reservation makes the top admissible
  // n permanently unservable: every n=MAX_IMAGE_N request would 429 forever.
  assert(
    MAX_MEDIA_JSON_BYTES <= MAX_MEDIA_INFLIGHT_BYTES,
    `MAX_MEDIA_JSON_BYTES (${MAX_MEDIA_JSON_BYTES}) must fit inside ` +
      `MAX_MEDIA_INFLIGHT_BYTES (${MAX_MEDIA_INFLIGHT_BYTES})`,
  );
  assert(
    MAX_TRANSCRIPTION_JSON_BYTES <= MAX_MEDIA_INFLIGHT_BYTES,
    `MAX_TRANSCRIPTION_JSON_BYTES (${MAX_TRANSCRIPTION_JSON_BYTES}) must fit ` +
      `inside MAX_MEDIA_INFLIGHT_BYTES (${MAX_MEDIA_INFLIGHT_BYTES})`,
  );
});

Deno.test("D1-T32: every byte bound is an integer", () => {
  // A fractional byte constant is both a `bytesRead > cap` comparand and an
  // addend in a reserve/release counter. Under overlapping reservations the
  // counter does not return to zero, so the budget shrinks permanently on every
  // cycle; and `2516582 > 2516582.4` is false, so a fractional cap is not even
  // reachable by an integral byte count.
  for (
    const [name, value] of Object.entries({
      MEDIA_BYTES_PER_IMAGE,
      MAX_IMAGE_N,
      MAX_MEDIA_JSON_BYTES,
      MAX_TRANSCRIPTION_JSON_BYTES,
      MAX_MEDIA_INFLIGHT_BYTES,
    })
  ) {
    assert(Number.isInteger(value), `${name} is not an integer: ${value}`);
  }
});

Deno.test("D1-T32: the counter returns to zero under overlapping holds", () => {
  // The consequence of the assertion above, stated as behavior rather than as a
  // property of the literal. Sequential reserve/release cannot show it
  // (`0 + c - c === 0` exactly, in doubles); overlapping holds can.
  let inflight = 0;
  const held: number[] = [];
  for (let i = 0; i < 14; i++) {
    const size = MEDIA_BYTES_PER_IMAGE * ((i % MAX_IMAGE_N) + 1);
    inflight += size;
    held.push(size);
  }
  for (const size of held) inflight -= size;
  assertEquals(inflight, 0, `residue after 14 overlapping holds: ${inflight}`);
});

Deno.test("D1-T32: per-image bytes cover the worst-case single image", () => {
  // 1536x1024 RGBA at 8 bits/channel is 6 291 456 raw pixel bytes; base64 is
  // exactly 4/3 of that (the raw count is divisible by 3, so no padding); PNG
  // cannot beat raw on incompressible content. 8 392 844 is that body plus its
  // JSON envelope. Below this figure a single legitimate n=1 render is refused
  // 502 AND goes unbilled: an availability break and a billing hole on the same
  // request.
  const rawPixelBytes = 1536 * 1024 * 4;
  assertEquals(rawPixelBytes, 6_291_456);
  assertEquals(rawPixelBytes % 3, 0);
  assertEquals((rawPixelBytes / 3) * 4, 8_388_608);
  assert(
    MEDIA_BYTES_PER_IMAGE >= 8_392_844,
    `MEDIA_BYTES_PER_IMAGE (${MEDIA_BYTES_PER_IMAGE}) is below the measured ` +
      `worst-case single-image body (8392844)`,
  );
});

Deno.test("D1-T32: the bounds carry their stated values", () => {
  assertEquals(MEDIA_BYTES_PER_IMAGE, 9 * 1024 * 1024);
  assertEquals(MAX_IMAGE_N, 10);
  assertEquals(MAX_MEDIA_JSON_BYTES, 90 * 1024 * 1024);
  assertEquals(MAX_TRANSCRIPTION_JSON_BYTES, 4 * 1024 * 1024);
  assertEquals(MAX_MEDIA_INFLIGHT_BYTES, 128 * 1024 * 1024);
  assertEquals(MAX_TTS_INPUT_CHARS, 100_000);
});

Deno.test("D1-T32: no media bound is an env knob", async () => {
  // Every other tunable in this repo is read through Deno.env with a bounded
  // parse and owes a row in docs/reference/environment-variables.md. These are
  // structural ceilings, so the absence of any env read is the contract.
  const source = await Deno.readTextFile(
    new URL("./limits.ts", import.meta.url),
  );
  assert(!source.includes("Deno.env"), "limits.ts must not read the env");
});
