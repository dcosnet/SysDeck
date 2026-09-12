import { sseEncode } from "./sse.ts";
import {
  type ChatCompletionChunk,
  type ReconstructedMessage,
  StreamAccumulator,
} from "./accumulate.ts";

/**
 * Buffers incoming text and emits complete lines. SSE events can be split
 * across network chunks, so provider transformers must never see partial
 * lines — this stage guarantees that.
 */
export class LineSplitterStream extends TransformStream<string, string> {
  constructor() {
    let buffer = "";
    super({
      transform(chunk, controller) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          controller.enqueue(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          controller.enqueue(buffer);
        }
      },
    });
  }
}

/** A provider transformer emits canonical chunk objects or the literal "[DONE]". */
export type CanonicalChunk = Record<string, unknown> | "[DONE]";

// Encodes canonical objects back into SSE frames.
export class SSENormalizationStream
  extends TransformStream<CanonicalChunk, string> {
  constructor() {
    super({
      transform(chunk, controller) {
        if (chunk === "[DONE]") {
          controller.enqueue(sseEncode("[DONE]"));
        } else {
          controller.enqueue(sseEncode(chunk));
        }
      },
    });
  }
}

/**
 * Tees the assistant response out of a normalized SSE response and invokes the
 * callback once the stream completes — the plugin stream-completion hook.
 *
 * The tap is passive: every client chunk is enqueued unchanged before it is
 * inspected, so the client-facing stream stays byte-identical. Alongside the
 * historical text concatenation, a {@link StreamAccumulator} reconstructs the
 * FULL assistant message (tool calls, reasoning, refusal, finish_reason,
 * usage). Both are handed to `onComplete`:
 *   - `text` — concatenated assistant text (unchanged, backward-compatible).
 *   - `message` — the reconstructed full message (additive; optional so
 *     existing `(text) => ...` callbacks remain assignable).
 */
export function withStreamCompletion(
  response: Response,
  onComplete: (text: string, message?: ReconstructedMessage) => Promise<void>,
): Response {
  if (!response.body) {
    return response;
  }
  const decoder = new TextDecoder();
  const accumulator = new StreamAccumulator();
  let text = "";
  let buffer = "";

  // Fold one `data:` payload into both the text concat and the accumulator.
  const account = (payload: string): void => {
    try {
      const parsed = JSON.parse(payload) as ChatCompletionChunk;
      accumulator.add(parsed);
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        text += content;
      }
    } catch {
      // [DONE], keep-alives, and partial JSON at cutoff are not accountable.
    }
  };

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      // Scan with a moving offset and slice the buffer once at the end, rather
      // than reallocating the remaining buffer on every consumed line (O(k·n)).
      let scan = 0;
      let newline;
      while ((newline = buffer.indexOf("\n", scan)) >= 0) {
        const line = buffer.slice(scan, newline);
        scan = newline + 1;
        if (line.startsWith("data: ")) {
          account(line.slice(6));
        }
      }
      if (scan > 0) {
        buffer = buffer.slice(scan);
      }
    },
    async flush() {
      // Flush any trailing multi-byte remainder into the accounting buffer,
      // then account a final unterminated data: line before completing.
      buffer += decoder.decode();
      if (buffer.startsWith("data: ")) {
        account(buffer.slice(6));
      }
      try {
        await onComplete(text, accumulator.result());
      } catch (error) {
        // The tap must never error the client-facing stream at its close.
        console.error(
          `stream completion hook failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    },
  });

  return new Response(response.body.pipeThrough(tap), {
    status: response.status,
    headers: response.headers,
  });
}

export class NormalizationPipeline {
  /**
   * upstream bytes -> text -> complete lines -> provider transformer ->
   * canonical chunks -> SSE frames -> bytes
   */
  static create(
    providerTransformer: TransformStream<string, CanonicalChunk>,
    upstreamBody: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    return upstreamBody
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new LineSplitterStream())
      .pipeThrough(providerTransformer)
      .pipeThrough(new SSENormalizationStream())
      .pipeThrough(new TextEncoderStream());
  }
}
