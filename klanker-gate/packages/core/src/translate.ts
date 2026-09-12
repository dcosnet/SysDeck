/**
 * Edge translators: canonical `chat.completion.chunk` SSE in, one vendor's
 * stream shape out. They run AFTER the plugin stream tap, never before, so
 * hooks always observe the canonical shape - which is what lets every ingress
 * dialect share one execution path.
 */
import { sseEncode } from "./sse.ts";
import { LineSplitterStream } from "./stream.ts";

interface CanonicalToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface CanonicalChatChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: CanonicalToolCallDelta[];
      /** Reasoning fragments (OpenRouter `reasoning`, vendor `reasoning_content`). */
      reasoning?: unknown;
      reasoning_content?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** First reasoning fragment present on a canonical delta, if any. */
function reasoningDelta(
  delta: {
    reasoning?: unknown;
    reasoning_content?: unknown;
  } | undefined,
): string {
  const raw = delta?.reasoning ?? delta?.reasoning_content;
  return typeof raw === "string" ? raw : "";
}

function parseDataLine(line: string): CanonicalChatChunk | "[DONE]" | null {
  if (!line.startsWith("data:")) {
    return null;
  }
  const data = line.slice(5).trim();
  if (data === "[DONE]") {
    return "[DONE]";
  }
  try {
    return JSON.parse(data) as CanonicalChatChunk;
  } catch {
    return null;
  }
}

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/**
 * Canonical chat chunks -> Anthropic Messages stream events
 * (message_start, content_block_start/delta/stop, message_delta,
 * message_stop). Text is block 0; each tool call opens its own tool_use
 * block with input_json_delta fragments.
 */
export class AnthropicStreamTranslator extends TransformStream<string, string> {
  constructor(model: string) {
    let started = false;
    let finalized = false;
    let nextBlockIndex = 0;
    let openBlockIndex: number | null = null;
    let openBlockType: "text" | "tool_use" | "thinking" | null = null;
    const toolBlocks = new Map<number, number>();
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let messageId = "msg_stream";

    const start = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (started) {
        return;
      }
      started = true;
      controller.enqueue(sseEncode({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }, "message_start"));
    };

    const closeOpenBlock = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (openBlockIndex === null) {
        return;
      }
      controller.enqueue(sseEncode({
        type: "content_block_stop",
        index: openBlockIndex,
      }, "content_block_stop"));
      openBlockIndex = null;
      openBlockType = null;
    };

    const finalize = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      start(controller);
      closeOpenBlock(controller);
      // input_tokens rides message_delta because the canonical stream reports
      // usage at the END, after message_start has already been emitted. Zero
      // still means "the provider never told us", never "the value was known
      // and discarded".
      controller.enqueue(sseEncode({
        type: "message_delta",
        delta: {
          stop_reason: stopReason ?? "end_turn",
          stop_sequence: null,
        },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }, "message_delta"));
      controller.enqueue(
        sseEncode({ type: "message_stop" }, "message_stop"),
      );
    };

    super({
      transform(line, controller) {
        const chunk = parseDataLine(line);
        if (chunk === null) {
          return;
        }
        if (chunk === "[DONE]") {
          finalize(controller);
          return;
        }
        if (chunk.id && messageId === "msg_stream") {
          messageId = chunk.id.replace(/^chatcmpl-/, "msg_");
        }
        start(controller);
        if (chunk.usage?.completion_tokens !== undefined) {
          outputTokens = chunk.usage.completion_tokens;
        }
        if (chunk.usage?.prompt_tokens !== undefined) {
          inputTokens = chunk.usage.prompt_tokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          return;
        }
        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }

        // Reasoning fragments open a `thinking` block ahead of the answer,
        // mirroring an extended-thinking response on the real wire.
        const thinking = reasoningDelta(choice.delta);
        if (thinking.length > 0) {
          if (openBlockType !== "thinking") {
            closeOpenBlock(controller);
            openBlockIndex = nextBlockIndex++;
            openBlockType = "thinking";
            controller.enqueue(sseEncode({
              type: "content_block_start",
              index: openBlockIndex,
              content_block: { type: "thinking", thinking: "" },
            }, "content_block_start"));
          }
          controller.enqueue(sseEncode({
            type: "content_block_delta",
            index: openBlockIndex,
            delta: { type: "thinking_delta", thinking },
          }, "content_block_delta"));
        }

        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          if (openBlockType !== "text") {
            closeOpenBlock(controller);
            openBlockIndex = nextBlockIndex++;
            openBlockType = "text";
            controller.enqueue(sseEncode({
              type: "content_block_start",
              index: openBlockIndex,
              content_block: { type: "text", text: "" },
            }, "content_block_start"));
          }
          controller.enqueue(sseEncode({
            type: "content_block_delta",
            index: openBlockIndex,
            delta: { type: "text_delta", text: content },
          }, "content_block_delta"));
        }

        for (const tc of choice.delta?.tool_calls ?? []) {
          const tcIndex = tc.index ?? 0;
          if (!toolBlocks.has(tcIndex)) {
            closeOpenBlock(controller);
            const blockIndex = nextBlockIndex++;
            toolBlocks.set(tcIndex, blockIndex);
            openBlockIndex = blockIndex;
            openBlockType = "tool_use";
            controller.enqueue(sseEncode({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id ?? `toolu_${tcIndex}`,
                name: tc.function?.name ?? "",
                input: {},
              },
            }, "content_block_start"));
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            const blockIndex = toolBlocks.get(tcIndex)!;
            // A late fragment for an already-closed block is dropped:
            // Anthropic's protocol forbids deltas after content_block_stop.
            if (blockIndex === openBlockIndex) {
              controller.enqueue(sseEncode({
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: args },
              }, "content_block_delta"));
            }
          }
        }
      },
      flush(controller) {
        finalize(controller);
      },
    });
  }
}

/**
 * Canonical chat chunks -> OpenAI Responses API semantic stream events with
 * sequence numbers. Emits the core envelope: created/in_progress,
 * output_item + content_part lifecycle, output_text deltas,
 * function_call_arguments deltas, completed. No [DONE] terminator — the
 * Responses stream ends after response.completed.
 */
export class ResponsesStreamTranslator extends TransformStream<string, string> {
  constructor(model: string) {
    let seq = 0;
    let started = false;
    let finalized = false;
    let responseId = "resp_stream";
    let created = 0;
    let messageItemOpen = false;
    let text = "";
    const messageItemId = `msg_${crypto.randomUUID().slice(0, 8)}`;
    // Keyed by the OpenAI tool_call index from the canonical stream.
    const functionItems = new Map<
      number,
      {
        itemId: string;
        callId: string;
        name: string;
        args: string;
        outputIndex: number;
      }
    >();
    let nextOutputIndex = 0;
    let messageOutputIndex = 0;
    let usage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;

    const emit = (
      controller: TransformStreamDefaultController<string>,
      type: string,
      payload: Record<string, unknown>,
    ): void => {
      controller.enqueue(
        sseEncode({ type, sequence_number: seq++, ...payload }, type),
      );
    };

    const responseSkeleton = (status: string): Record<string, unknown> => ({
      id: responseId,
      object: "response",
      created_at: created,
      status,
      model,
    });

    const start = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (started) {
        return;
      }
      started = true;
      // Same skeleton is emitted for both events; build it once.
      const inProgress = responseSkeleton("in_progress");
      emit(controller, "response.created", { response: inProgress });
      emit(controller, "response.in_progress", { response: inProgress });
    };

    const openMessageItem = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (messageItemOpen) {
        return;
      }
      messageItemOpen = true;
      messageOutputIndex = nextOutputIndex++;
      emit(controller, "response.output_item.added", {
        output_index: messageOutputIndex,
        item: {
          id: messageItemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      emit(controller, "response.content_part.added", {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    };

    const finalize = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      start(controller);
      const output: Array<Record<string, unknown>> = [];
      if (messageItemOpen) {
        emit(controller, "response.output_text.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          text,
        });
        emit(controller, "response.content_part.done", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        });
        const item = {
          id: messageItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        emit(controller, "response.output_item.done", {
          output_index: messageOutputIndex,
          item,
        });
        output.push(item);
      }
      for (const fn of functionItems.values()) {
        emit(controller, "response.function_call_arguments.done", {
          item_id: fn.itemId,
          output_index: fn.outputIndex,
          arguments: fn.args,
        });
        const item = {
          id: fn.itemId,
          type: "function_call",
          status: "completed",
          call_id: fn.callId,
          name: fn.name,
          arguments: fn.args,
        };
        emit(controller, "response.output_item.done", {
          output_index: fn.outputIndex,
          item,
        });
        output.push(item);
      }
      emit(controller, "response.completed", {
        response: {
          ...responseSkeleton("completed"),
          output,
          output_text: text,
          ...(usage
            ? {
              usage: {
                input_tokens: usage.prompt_tokens ?? 0,
                output_tokens: usage.completion_tokens ?? 0,
                total_tokens: (usage.prompt_tokens ?? 0) +
                  (usage.completion_tokens ?? 0),
              },
            }
            : {}),
        },
      });
    };

    super({
      transform(line, controller) {
        const chunk = parseDataLine(line);
        if (chunk === null) {
          return;
        }
        if (chunk === "[DONE]") {
          finalize(controller);
          return;
        }
        if (chunk.id && responseId === "resp_stream") {
          responseId = `resp_${chunk.id.replace(/^chatcmpl-/, "")}`;
          created = chunk.created ?? 0;
        }
        start(controller);
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          return;
        }

        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          openMessageItem(controller);
          text += content;
          emit(controller, "response.output_text.delta", {
            item_id: messageItemId,
            output_index: messageOutputIndex,
            content_index: 0,
            delta: content,
          });
        }

        for (const tc of choice.delta?.tool_calls ?? []) {
          const tcIndex = tc.index ?? 0;
          let fn = functionItems.get(tcIndex);
          if (!fn) {
            fn = {
              itemId: `fc_${tcIndex}`,
              callId: tc.id ?? `call_${tcIndex}`,
              name: tc.function?.name ?? "",
              args: "",
              outputIndex: nextOutputIndex++,
            };
            functionItems.set(tcIndex, fn);
            emit(controller, "response.output_item.added", {
              output_index: fn.outputIndex,
              item: {
                id: fn.itemId,
                type: "function_call",
                status: "in_progress",
                call_id: fn.callId,
                name: fn.name,
                arguments: "",
              },
            });
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            fn.args += args;
            emit(controller, "response.function_call_arguments.delta", {
              item_id: fn.itemId,
              output_index: fn.outputIndex,
              delta: args,
            });
          }
        }
      },
      flush(controller) {
        finalize(controller);
      },
    });
  }
}

/**
 * Canonical chat chunks -> legacy text_completion chunks for providers with
 * no native completions surface. Preserves `data: [DONE]` termination.
 */
export class CompletionsStreamTranslator
  extends TransformStream<string, string> {
  constructor(model: string) {
    let id = "cmpl-stream";
    let created = 0;
    let doneSent = false;

    super({
      transform(line, controller) {
        const chunk = parseDataLine(line);
        if (chunk === null) {
          return;
        }
        if (chunk === "[DONE]") {
          doneSent = true;
          controller.enqueue(sseEncode("[DONE]"));
          return;
        }
        if (chunk.id && id === "cmpl-stream") {
          id = chunk.id.replace(/^chatcmpl-/, "cmpl-");
          created = chunk.created ?? 0;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          return;
        }
        const content = choice.delta?.content;
        const textDelta = typeof content === "string" ? content : "";
        if (textDelta.length === 0 && !choice.finish_reason) {
          return;
        }
        controller.enqueue(sseEncode({
          id,
          object: "text_completion",
          created,
          model,
          choices: [{
            text: textDelta,
            index: 0,
            logprobs: null,
            finish_reason: choice.finish_reason ?? null,
          }],
        }));
      },
      flush(controller) {
        if (!doneSent) {
          controller.enqueue(sseEncode("[DONE]"));
        }
      },
    });
  }
}

/** Canonical finish_reason -> GenAI finishReason. */
function mapGenAIFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    // "tool_calls" included: GenAI has no such enum member - the functionCall
    // part in the candidate is itself the signal.
    default:
      return "STOP";
  }
}

/**
 * Canonical chat chunks -> Google GenAI `streamGenerateContent` SSE chunks.
 * Each `data:` frame is a GenerateContentResponse fragment: one candidate whose
 * content.parts carry the incremental text, mirroring the non-stream
 * generateContent translation (routes/compat_families.ts). The terminal frame
 * carries finishReason + usageMetadata, plus any functionCall parts. GenAI's
 * SSE has no `[DONE]` sentinel - the stream simply ends after the final
 * candidate.
 */
export class GenAIStreamTranslator extends TransformStream<string, string> {
  constructor(model: string) {
    let finalized = false;
    let finishReason = "STOP";
    let modelVersion = model;
    let usage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    // Canonical tool calls stream as argument FRAGMENTS; GenAI has no partial
    // functionCall frame, so they are buffered per index and emitted whole in
    // the terminal frame.
    const toolCalls = new Map<number, { name: string; args: string }>();

    const finalize = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      const prompt = usage?.prompt_tokens ?? 0;
      const completion = usage?.completion_tokens ?? 0;
      const parts = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => {
          let args: unknown = {};
          try {
            args = JSON.parse(call.args || "{}");
          } catch {
            args = {};
          }
          return { functionCall: { name: call.name, args } };
        });
      controller.enqueue(sseEncode({
        candidates: [{
          content: { role: "model", parts },
          finishReason,
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: prompt,
          candidatesTokenCount: completion,
          totalTokenCount: prompt + completion,
        },
        modelVersion,
      }));
    };

    super({
      transform(line, controller) {
        const chunk = parseDataLine(line);
        if (chunk === null) {
          return;
        }
        if (chunk === "[DONE]") {
          finalize(controller);
          return;
        }
        if (chunk.model) {
          modelVersion = chunk.model;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          return;
        }
        if (choice.finish_reason) {
          finishReason = mapGenAIFinish(choice.finish_reason);
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const index = tc.index ?? 0;
          let call = toolCalls.get(index);
          if (!call) {
            call = { name: "", args: "" };
            toolCalls.set(index, call);
          }
          if (tc.function?.name) {
            call.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === "string") {
            call.args += tc.function.arguments;
          }
        }
        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          controller.enqueue(sseEncode({
            candidates: [{
              content: { role: "model", parts: [{ text: content }] },
              index: 0,
            }],
            modelVersion,
          }));
        }
      },
      flush(controller) {
        finalize(controller);
      },
    });
  }
}

/** Canonical finish_reason -> Cohere v2 finish_reason. */
function mapCohereFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "MAX_TOKENS";
    case "tool_calls":
      return "TOOL_CALL";
    default:
      return "COMPLETE";
  }
}

/**
 * Canonical chat chunks -> Cohere v2 chat stream events (message-start,
 * content-start/delta/end, tool-call-start/delta/end, message-end). Text
 * streams through a single content block (index 0); each tool call opens its
 * own tool-call block keyed by the canonical tool_call index. The terminal
 * message-end carries finish_reason + billed_units usage. Cohere's SSE has no
 * `[DONE]` sentinel. Round-trips with CohereStreamTransformer
 * (packages/providers/src/cohere.ts), which parses these same events back into
 * canonical chunks.
 */
export class CohereStreamTranslator extends TransformStream<string, string> {
  constructor(model: string) {
    let started = false;
    let finalized = false;
    let messageId = "";
    let textOpen = false;
    const toolIndices = new Set<number>();
    let finishReason = "COMPLETE";
    let usage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;

    const start = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (started) {
        return;
      }
      started = true;
      // The model rides message-start so cost accounting, which meters the
      // TRANSLATED bytes, can price a streamed Cohere response. Without it the
      // usage block is recovered but prices to null, and the surface enforces
      // no cost budget at all.
      controller.enqueue(sseEncode({
        type: "message-start",
        id: messageId || undefined,
        model,
        delta: { message: { role: "assistant" } },
      }));
    };

    const closeText = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (!textOpen) {
        return;
      }
      textOpen = false;
      controller.enqueue(sseEncode({ type: "content-end", index: 0 }));
    };

    const finalize = (
      controller: TransformStreamDefaultController<string>,
    ): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      start(controller);
      closeText(controller);
      for (const index of toolIndices) {
        controller.enqueue(sseEncode({ type: "tool-call-end", index }));
      }
      controller.enqueue(sseEncode({
        type: "message-end",
        delta: {
          finish_reason: finishReason,
          usage: {
            billed_units: {
              input_tokens: usage?.prompt_tokens ?? 0,
              output_tokens: usage?.completion_tokens ?? 0,
            },
          },
        },
      }));
    };

    super({
      transform(line, controller) {
        const chunk = parseDataLine(line);
        if (chunk === null) {
          return;
        }
        if (chunk === "[DONE]") {
          finalize(controller);
          return;
        }
        if (chunk.id && !messageId) {
          messageId = chunk.id.replace(/^chatcmpl-/, "");
        }
        start(controller);
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          return;
        }
        if (choice.finish_reason) {
          finishReason = mapCohereFinish(choice.finish_reason);
        }

        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          if (!textOpen) {
            textOpen = true;
            controller.enqueue(sseEncode({
              type: "content-start",
              index: 0,
              delta: { message: { content: { type: "text", text: "" } } },
            }));
          }
          controller.enqueue(sseEncode({
            type: "content-delta",
            index: 0,
            delta: { message: { content: { text: content } } },
          }));
        }

        for (const tc of choice.delta?.tool_calls ?? []) {
          const tcIndex = tc.index ?? 0;
          if (!toolIndices.has(tcIndex)) {
            // Cohere closes the text block before emitting tool calls.
            closeText(controller);
            toolIndices.add(tcIndex);
            controller.enqueue(sseEncode({
              type: "tool-call-start",
              index: tcIndex,
              delta: {
                message: {
                  tool_calls: {
                    id: tc.id ?? `tool_${tcIndex}`,
                    type: "function",
                    function: { name: tc.function?.name ?? "", arguments: "" },
                  },
                },
              },
            }));
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            controller.enqueue(sseEncode({
              type: "tool-call-delta",
              index: tcIndex,
              delta: {
                message: { tool_calls: { function: { arguments: args } } },
              },
            }));
          }
        }
      },
      flush(controller) {
        finalize(controller);
      },
    });
  }
}

/** Pipes a canonical SSE byte stream through a line-based translator. */
export function translateSSEBody(
  body: ReadableStream<Uint8Array>,
  translator: TransformStream<string, string>,
): ReadableStream<Uint8Array> {
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new LineSplitterStream())
    .pipeThrough(translator)
    .pipeThrough(new TextEncoderStream());
}
