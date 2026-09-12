/**
 * Gateway admission and buffering bounds that a request schema has to
 * reference. They live in `packages/contracts` because that is the root of the
 * dependency flow (`contracts -> core/providers/governance/cache/mcp/config ->
 * apps/gateway`): a bound used inside a `z.max()` in this package cannot be
 * defined in `apps/gateway`, and splitting one family of related constants
 * across the package boundary would put their invariants out of each other's
 * sight. Route-only bounds with no schema consumer stay next to the route
 * (`MAX_JSON_BODY_BYTES`, `apps/gateway/routes/helpers.ts`).
 *
 * None of these is an env knob. They are structural ceilings, not tuning.
 */

/**
 * Largest `n` / `sampleCount` the gateway will admit on an image request.
 * dall-e-2 documents `n` up to 10 [unverified], so a lower value would refuse a
 * legitimate call. It is also the multiplier that turns a per-image byte figure
 * into the per-response ceiling below, which is what keeps that ceiling out of
 * caller reach.
 */
export const MAX_IMAGE_N = 10;

/**
 * Bytes the gateway will buffer per REQUESTED image. Derived from pixel
 * arithmetic rather than a vendor page: the largest documented gpt-image-1
 * render is 1536x1024 [unverified], at 8 bits/channel RGBA that is 6 291 456 raw
 * pixel bytes, a PNG cannot beat raw on incompressible content, and base64 is
 * exactly 4/3 - so one image's `b64_json` JSON body cannot exceed 8 392 844
 * bytes. Integral, because this value is both a read cap and an addend in a
 * running in-flight counter, where a fractional addend leaves a residue.
 */
export const MEDIA_BYTES_PER_IMAGE = 9 * 1024 * 1024;

/**
 * Hard per-response ceiling on a buffered media body. Derived from the two
 * constants above so that no caller-reachable `n` can cross it. MUST stay
 * <= `MAX_MEDIA_INFLIGHT_BYTES`, or the top admissible `n` is permanently
 * unservable.
 */
export const MAX_MEDIA_JSON_BYTES = MAX_IMAGE_N * MEDIA_BYTES_PER_IMAGE;

/**
 * Hard ceiling on a buffered transcription body. A `verbose_json` transcription
 * with word timings over the longest audio a provider accepts (~25 MB
 * [unverified]) is roughly 15 600 words at ~46 bytes each plus ~1 250 segments
 * at ~350 bytes plus the transcript, i.e. ~1.2 MB. 4 MiB is ~3.3x that.
 */
export const MAX_TRANSCRIPTION_JSON_BYTES = 4 * 1024 * 1024;

/**
 * Bytes reserved across all media body reads in flight in THIS process.
 * Reserved pessimistically at the per-response cap before dispatch, so a
 * mid-read crossing is structurally impossible, and held across the provider's
 * generation latency - which makes it the media path's concurrency bound as
 * well as its memory bound. Sized so `MAX_MEDIA_JSON_BYTES` (90 MiB) fits
 * inside it: 90 MiB is the floor, 128 MiB is the smallest power of two that
 * also leaves room alongside one top-n request. Peak held memory is ~2.96x
 * reserved bytes, i.e. ~379 MiB per worker at full saturation.
 */
export const MAX_MEDIA_INFLIGHT_BYTES = 128 * 1024 * 1024;

/**
 * Cap on a single text-to-speech `input`. Not a vendor limit - no vendor page
 * was fetched. It is a GATEWAY bound chosen so one POST cannot buy an unbounded
 * bill: 100k characters at the tts-1 rate is $1.50, against ~$393 for the
 * 26.2M characters `MAX_JSON_BODY_BYTES` admits today. Deliberately far above
 * any plausible single call, so the provider's own 400 stays the authority on
 * what it will accept.
 */
export const MAX_TTS_INPUT_CHARS = 100_000;
