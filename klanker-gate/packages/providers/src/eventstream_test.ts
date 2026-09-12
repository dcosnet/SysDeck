import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  crc32,
  decodeEventStreamMessage,
  encodeEventStreamMessage,
  EventStreamDecoderStream,
  EventStreamError,
  headerString,
} from "./eventstream.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function jsonFrame(
  eventType: string,
  payload: unknown,
  messageType = "event",
): Uint8Array {
  return encodeEventStreamMessage(
    {
      ":message-type": messageType,
      ":event-type": eventType,
      ":content-type": "application/json",
    },
    enc.encode(JSON.stringify(payload)),
  );
}

async function collect(
  stream: ReadableStream<unknown>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of stream) {
    out.push(item);
  }
  return out;
}

Deno.test("crc32 matches the canonical check value for '123456789'", () => {
  // The standard CRC-32 (IEEE) check value is 0xCBF43926.
  assertEquals(crc32(enc.encode("123456789")), 0xCBF43926);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("encode -> decode round-trips headers and payload", () => {
  const frame = jsonFrame("contentBlockDelta", { delta: { text: "hi" } });
  const decoded = decodeEventStreamMessage(frame);
  assert(decoded);
  assertEquals(decoded.size, frame.length);
  assertEquals(headerString(decoded.message, ":message-type"), "event");
  assertEquals(
    headerString(decoded.message, ":event-type"),
    "contentBlockDelta",
  );
  assertEquals(
    JSON.parse(dec.decode(decoded.message.payload)),
    { delta: { text: "hi" } },
  );
});

Deno.test("decode returns null for a partial (not-yet-complete) frame", () => {
  const frame = jsonFrame("messageStart", { role: "assistant" });
  // Only the first few bytes have arrived.
  assertEquals(decodeEventStreamMessage(frame.subarray(0, 4)), null);
  assertEquals(
    decodeEventStreamMessage(frame.subarray(0, frame.length - 1)),
    null,
  );
  // The full frame decodes.
  assert(decodeEventStreamMessage(frame));
});

Deno.test("decode throws on a prelude CRC mismatch", () => {
  const frame = jsonFrame("messageStop", { stopReason: "end_turn" });
  frame[8] ^= 0xFF; // corrupt the stored prelude CRC (bytes 8-11)
  let threw = false;
  try {
    decodeEventStreamMessage(frame);
  } catch (err) {
    threw = true;
    assert(err instanceof EventStreamError);
    assert((err as Error).message.includes("prelude CRC"));
  }
  assert(threw, "expected a prelude CRC mismatch to throw");
});

Deno.test("decode throws on a message CRC mismatch (corrupt payload)", () => {
  const frame = jsonFrame("messageStop", { stopReason: "end_turn" });
  frame[frame.length - 6] ^= 0xFF; // corrupt a payload byte, not the CRC itself
  let threw = false;
  try {
    decodeEventStreamMessage(frame);
  } catch (err) {
    threw = true;
    assert(err instanceof EventStreamError);
    assert((err as Error).message.includes("message CRC"));
  }
  assert(threw, "expected a message CRC mismatch to throw");
});

Deno.test("EventStreamDecoderStream reassembles frames split across chunks", async () => {
  const a = jsonFrame("messageStart", { role: "assistant" });
  const b = jsonFrame("contentBlockDelta", { delta: { text: "yo" } });
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);

  // Feed the two frames as three arbitrary byte slices (frame boundaries do
  // not line up with chunk boundaries).
  const cut1 = 3;
  const cut2 = a.length + 5;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(combined.subarray(0, cut1));
      controller.enqueue(combined.subarray(cut1, cut2));
      controller.enqueue(combined.subarray(cut2));
      controller.close();
    },
  });

  const messages = await collect(
    readable.pipeThrough(new EventStreamDecoderStream()),
  ) as Array<{ headers: Record<string, unknown>; payload: Uint8Array }>;
  assertEquals(messages.length, 2);
  assertEquals(messages[0].headers[":event-type"], "messageStart");
  assertEquals(messages[1].headers[":event-type"], "contentBlockDelta");
});

Deno.test("EventStreamDecoderStream errors on a truncated trailing frame", async () => {
  const frame = jsonFrame("messageStop", { stopReason: "end_turn" });
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame.subarray(0, frame.length - 3)); // partial
      controller.close();
    },
  });
  await assertRejects(
    () => collect(readable.pipeThrough(new EventStreamDecoderStream())),
    EventStreamError,
    "trailing bytes",
  );
});
