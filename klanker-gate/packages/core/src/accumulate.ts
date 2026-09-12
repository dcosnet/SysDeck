export interface ChatChunkToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatChunkReasoningDetailDelta {
  index?: number;
  type?: string;
  id?: string;
  text?: string;
  signature?: string;
  summary?: string;
  data?: string;
}

export interface ChatChunkDelta {
  role?: string;
  content?: string | null;
  refusal?: string | null;
  reasoning?: string | null;
  reasoning_details?: ChatChunkReasoningDetailDelta[];
  tool_calls?: ChatChunkToolCallDelta[];
}

export interface ChatChunkChoice {
  index?: number;
  delta?: ChatChunkDelta;
  finish_reason?: string | null;
}

export interface ChatChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatChunkChoice[];
  usage?: ChatChunkUsage | null;
}

export interface ReconstructedToolCall {
  /** OpenAI streaming tool-call index this call was merged under. */
  index: number;
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ReconstructedReasoningDetail {
  index: number;
  type?: string;
  id?: string;
  text?: string;
  signature?: string;
  summary?: string;
  data?: string;
}

export interface ReconstructedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ReconstructedMessage {
  role: "assistant";
  /**
   * Concatenated text content. Empty string when the turn produced no text
   * (e.g. a pure tool-call turn), mirroring the historical text field.
   */
  content: string;
  /** Concatenated refusal text; present only if any refusal delta arrived. */
  refusal?: string;
  /** Concatenated reasoning text; present only if any reasoning delta arrived. */
  reasoning?: string;
  /** Reasoning detail blocks merged by index; present only if any arrived. */
  reasoning_details?: ReconstructedReasoningDetail[];
  /** Tool calls merged by index (ordered); present only if any arrived. */
  tool_calls?: ReconstructedToolCall[];
  /** Last non-empty finish_reason observed on the first choice. */
  finish_reason?: string;
  /** Token usage from the terminal usage chunk, if the upstream emitted one. */
  usage?: ReconstructedUsage;
  /** Response envelope id (first non-empty chunk id), for cache reconstruction. */
  id?: string;
  /** Response model (first non-empty chunk model). */
  model?: string;
  /** Response created timestamp (first chunk that carried one). */
  created?: number;
}

/**
 * Folds OpenAI-wire chat streaming deltas into a full assistant message.
 *
 * Usage:
 * ```ts
 * const acc = new StreamAccumulator();
 * for (const chunk of parsedChunks) acc.add(chunk);
 * const message = acc.result();
 * ```
 */
export class StreamAccumulator {
  #role: "assistant" = "assistant";
  #content = "";
  #refusal: string | undefined = undefined;
  #reasoning: string | undefined = undefined;
  // Keyed by delta index; insertion order tracks arrival, result() sorts by index.
  #reasoningDetails = new Map<number, ReconstructedReasoningDetail>();
  #toolCalls = new Map<number, ReconstructedToolCall>();
  #finishReason: string | undefined = undefined;
  #usage: ReconstructedUsage | undefined = undefined;
  #id: string | undefined = undefined;
  #model: string | undefined = undefined;
  #created: number | undefined = undefined;

  /** Fold one parsed chat.completion.chunk into the reconstruction. Pure per call. */
  add(chunk: ChatCompletionChunk): void {
    if (chunk === null || typeof chunk !== "object") {
      return;
    }

    // Envelope metadata — first non-empty value wins.
    if (
      this.#id === undefined && typeof chunk.id === "string" &&
      chunk.id.length > 0
    ) {
      this.#id = chunk.id;
    }
    if (
      this.#model === undefined && typeof chunk.model === "string" &&
      chunk.model.length > 0
    ) {
      this.#model = chunk.model;
    }
    if (this.#created === undefined && typeof chunk.created === "number") {
      this.#created = chunk.created;
    }

    // Terminal usage — last chunk carrying token counts wins. Captured before
    // the choices guard because the usage chunk often has `choices: []`.
    this.#captureUsage(chunk.usage);

    const choices = chunk.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return;
    }
    const choice = choices[0];
    if (choice === null || typeof choice !== "object") {
      return;
    }

    if (
      typeof choice.finish_reason === "string" &&
      choice.finish_reason.length > 0
    ) {
      this.#finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (delta === null || typeof delta !== "object") {
      return;
    }

    // content: concatenate every string fragment (empty fragments are no-ops).
    if (typeof delta.content === "string") {
      this.#content += delta.content;
    }
    // refusal / reasoning: concatenate only real (non-empty) fragments so a
    // stream that never refuses/reasons leaves these fields absent.
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      this.#refusal = (this.#refusal ?? "") + delta.refusal;
    }
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      this.#reasoning = (this.#reasoning ?? "") + delta.reasoning;
    }
    if (Array.isArray(delta.reasoning_details)) {
      this.#mergeReasoningDetails(delta.reasoning_details);
    }
    if (Array.isArray(delta.tool_calls)) {
      this.#mergeToolCalls(delta.tool_calls);
    }
  }

  /** Project the accumulated state into a fresh reconstructed message. */
  result(): ReconstructedMessage {
    const message: ReconstructedMessage = {
      role: this.#role,
      content: this.#content,
    };
    if (this.#refusal !== undefined) {
      message.refusal = this.#refusal;
    }
    if (this.#reasoning !== undefined) {
      message.reasoning = this.#reasoning;
    }
    if (this.#reasoningDetails.size > 0) {
      message.reasoning_details = [...this.#reasoningDetails.values()]
        .sort((a, b) => a.index - b.index)
        .map((rd) => ({ ...rd }));
    }
    if (this.#toolCalls.size > 0) {
      message.tool_calls = [...this.#toolCalls.values()]
        .sort((a, b) => a.index - b.index)
        .map((tc) => ({
          index: tc.index,
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
    }
    if (this.#finishReason !== undefined) {
      message.finish_reason = this.#finishReason;
    }
    if (this.#usage !== undefined) {
      message.usage = { ...this.#usage };
    }
    if (this.#id !== undefined) {
      message.id = this.#id;
    }
    if (this.#model !== undefined) {
      message.model = this.#model;
    }
    if (this.#created !== undefined) {
      message.created = this.#created;
    }
    return message;
  }

  #captureUsage(usage: ChatChunkUsage | null | undefined): void {
    if (usage === null || typeof usage !== "object") {
      return;
    }
    const hasPrompt = typeof usage.prompt_tokens === "number";
    const hasCompletion = typeof usage.completion_tokens === "number";
    const hasTotal = typeof usage.total_tokens === "number";
    if (!hasPrompt && !hasCompletion && !hasTotal) {
      return;
    }
    const prompt = hasPrompt ? usage.prompt_tokens as number : 0;
    const completion = hasCompletion ? usage.completion_tokens as number : 0;
    this.#usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: hasTotal
        ? usage.total_tokens as number
        : prompt + completion,
    };
  }

  // Merge streamed tool-call deltas by index: id and name are set once (the
  // first non-empty value), arguments are concatenated across chunks.
  #mergeToolCalls(deltas: ChatChunkToolCallDelta[]): void {
    for (const delta of deltas) {
      if (delta === null || typeof delta !== "object") {
        continue;
      }
      const index = typeof delta.index === "number" ? delta.index : 0;
      let call = this.#toolCalls.get(index);
      if (call === undefined) {
        call = {
          index,
          type: "function",
          function: { name: "", arguments: "" },
        };
        this.#toolCalls.set(index, call);
      }
      if (
        call.id === undefined && typeof delta.id === "string" &&
        delta.id.length > 0
      ) {
        call.id = delta.id;
      }
      const fn = delta.function;
      if (fn !== null && typeof fn === "object") {
        if (
          call.function.name.length === 0 && typeof fn.name === "string" &&
          fn.name.length > 0
        ) {
          call.function.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          call.function.arguments += fn.arguments;
        }
      }
    }
  }

  // Merge reasoning-detail deltas by index: text/summary/data concatenate,
  // signature overwrites (sent once at the end), type/id update in place.
  #mergeReasoningDetails(deltas: ChatChunkReasoningDetailDelta[]): void {
    for (const delta of deltas) {
      if (delta === null || typeof delta !== "object") {
        continue;
      }
      const index = typeof delta.index === "number" ? delta.index : 0;
      let detail = this.#reasoningDetails.get(index);
      if (detail === undefined) {
        detail = { index };
        this.#reasoningDetails.set(index, detail);
      }
      if (typeof delta.type === "string" && delta.type.length > 0) {
        detail.type = delta.type;
      }
      if (typeof delta.id === "string" && delta.id.length > 0) {
        detail.id = delta.id;
      }
      if (typeof delta.text === "string" && delta.text.length > 0) {
        detail.text = (detail.text ?? "") + delta.text;
      }
      if (typeof delta.summary === "string" && delta.summary.length > 0) {
        detail.summary = (detail.summary ?? "") + delta.summary;
      }
      if (typeof delta.data === "string" && delta.data.length > 0) {
        detail.data = (detail.data ?? "") + delta.data;
      }
      if (typeof delta.signature === "string") {
        detail.signature = delta.signature;
      }
    }
  }
}
