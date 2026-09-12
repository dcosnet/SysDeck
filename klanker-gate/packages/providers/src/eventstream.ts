/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) lookup table. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 checksum of `bytes` as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export type EventStreamHeaderValue =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array;

export interface DecodedEventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

/** Reads a string-typed header, or undefined when absent / non-string. */
export function headerString(
  message: DecodedEventStreamMessage,
  name: string,
): string | undefined {
  const v = message.headers[name];
  return typeof v === "string" ? v : undefined;
}

const textDecoder = new TextDecoder();

/** Header value type codes per the eventstream spec. */
const enum HeaderType {
  BoolTrue = 0,
  BoolFalse = 1,
  Byte = 2,
  Short = 3,
  Integer = 4,
  Long = 5,
  ByteArray = 6,
  String = 7,
  Timestamp = 8,
  Uuid = 9,
}

function parseHeaders(
  bytes: Uint8Array,
): Record<string, EventStreamHeaderValue> {
  const headers: Record<string, EventStreamHeaderValue> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const nameLen = view.getUint8(offset);
    offset += 1;
    const name = textDecoder.decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const type = view.getUint8(offset) as HeaderType;
    offset += 1;
    switch (type) {
      case HeaderType.BoolTrue:
        headers[name] = true;
        break;
      case HeaderType.BoolFalse:
        headers[name] = false;
        break;
      case HeaderType.Byte:
        headers[name] = view.getInt8(offset);
        offset += 1;
        break;
      case HeaderType.Short:
        headers[name] = view.getInt16(offset);
        offset += 2;
        break;
      case HeaderType.Integer:
        headers[name] = view.getInt32(offset);
        offset += 4;
        break;
      case HeaderType.Long:
        headers[name] = view.getBigInt64(offset);
        offset += 8;
        break;
      case HeaderType.ByteArray: {
        const len = view.getUint16(offset);
        offset += 2;
        headers[name] = bytes.slice(offset, offset + len);
        offset += len;
        break;
      }
      case HeaderType.String: {
        const len = view.getUint16(offset);
        offset += 2;
        headers[name] = textDecoder.decode(
          bytes.subarray(offset, offset + len),
        );
        offset += len;
        break;
      }
      case HeaderType.Timestamp:
        headers[name] = view.getBigInt64(offset);
        offset += 8;
        break;
      case HeaderType.Uuid:
        headers[name] = bytes.slice(offset, offset + 16);
        offset += 16;
        break;
      default:
        throw new EventStreamError(
          `unknown eventstream header value type ${type}`,
        );
    }
  }
  return headers;
}

/** Raised on any framing/CRC violation so callers can fail the stream loudly. */
export class EventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStreamError";
  }
}

/** Smallest possible message: two lengths (8) + prelude CRC (4) + message CRC
 * (4) with empty headers and payload. */
const MIN_MESSAGE_LENGTH = 16;

/**
 * Decodes the first complete message at the front of `buf`. Returns the decoded
 * message plus the number of bytes it consumed, or `null` when `buf` does not
 * yet hold a whole message (the caller should buffer more bytes and retry).
 * Throws {@link EventStreamError} on a prelude/message CRC mismatch.
 */
export function decodeEventStreamMessage(
  buf: Uint8Array,
): { message: DecodedEventStreamMessage; size: number } | null {
  if (buf.length < 4) {
    return null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const totalLength = view.getUint32(0);
  if (totalLength < MIN_MESSAGE_LENGTH) {
    throw new EventStreamError(
      `eventstream frame length ${totalLength} below minimum ${MIN_MESSAGE_LENGTH}`,
    );
  }
  if (buf.length < totalLength) {
    return null; // partial frame; need more bytes
  }
  const headersLength = view.getUint32(4);
  if (headersLength > totalLength - MIN_MESSAGE_LENGTH) {
    throw new EventStreamError(
      `eventstream headers length ${headersLength} exceeds frame`,
    );
  }
  const preludeCrc = view.getUint32(8);
  const computedPrelude = crc32(buf.subarray(0, 8));
  if (preludeCrc !== computedPrelude) {
    throw new EventStreamError(
      `eventstream prelude CRC mismatch: got ${preludeCrc}, computed ${computedPrelude}`,
    );
  }
  const messageCrc = view.getUint32(totalLength - 4);
  const computedMessage = crc32(buf.subarray(0, totalLength - 4));
  if (messageCrc !== computedMessage) {
    throw new EventStreamError(
      `eventstream message CRC mismatch: got ${messageCrc}, computed ${computedMessage}`,
    );
  }
  const headersEnd = 12 + headersLength;
  const headers = parseHeaders(buf.subarray(12, headersEnd));
  const payload = buf.subarray(headersEnd, totalLength - 4);
  return { message: { headers, payload }, size: totalLength };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Streaming adapter over {@link decodeEventStreamMessage}: buffers incoming
 * byte chunks (frames routinely split across network reads) and emits one
 * {@link DecodedEventStreamMessage} per complete frame. A trailing partial
 * frame at end-of-stream, or any CRC violation, errors the stream.
 */
export class EventStreamDecoderStream
  extends TransformStream<Uint8Array, DecodedEventStreamMessage> {
  constructor() {
    let buffer: Uint8Array = new Uint8Array(0);
    super({
      transform(chunk, controller) {
        buffer = concat(buffer, chunk);
        while (true) {
          let decoded;
          try {
            decoded = decodeEventStreamMessage(buffer);
          } catch (err) {
            controller.error(err);
            return;
          }
          if (!decoded) {
            break;
          }
          controller.enqueue(decoded.message);
          buffer = buffer.subarray(decoded.size);
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.error(
            new EventStreamError(
              `eventstream ended mid-frame with ${buffer.length} trailing bytes`,
            ),
          );
        }
      },
    });
  }
}

/**
 * Encodes a message with string-typed headers. Used to build fixtures for the
 * decoder tests (and to document the framing by construction); the gateway only
 * ever decodes AWS frames, never encodes them.
 */
export function encodeEventStreamMessage(
  headers: Record<string, string>,
  payload: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const headerChunks: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    headerChunks.push(nameBytes.length, ...nameBytes);
    headerChunks.push(HeaderType.String);
    const valueBytes = encoder.encode(value);
    headerChunks.push(
      (valueBytes.length >> 8) & 0xFF,
      valueBytes.length & 0xFF,
    );
    headerChunks.push(...valueBytes);
  }
  const headerBytes = new Uint8Array(headerChunks);
  const totalLength = 12 + headerBytes.length + payload.length + 4;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(payload, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(out.subarray(0, totalLength - 4)));
  return out;
}
