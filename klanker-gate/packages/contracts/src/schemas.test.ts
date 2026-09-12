import { assert, assertEquals } from "@std/assert";
import {
  parseChatCompletionRequest,
  ProviderRegistry,
} from "./provider-registry.ts";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ChatToolChoiceSchema,
  MessageSchema,
} from "./schemas.ts";

Deno.test("ChatCompletionRequestSchema - Valid Payload", () => {
  const payload = {
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ],
    temperature: 0.7,
  };

  const result = ChatCompletionRequestSchema.safeParse(payload);
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.model, "gpt-4");
    assertEquals(result.data.messages.length, 2);
  }
});

Deno.test("ChatCompletionRequestSchema - Missing Model", () => {
  const payload = {
    messages: [
      { role: "user", content: "Hello!" },
    ],
  };

  const result = ChatCompletionRequestSchema.safeParse(payload);
  assert(!result.success);
});

Deno.test("ChatCompletionRequestSchema - passes modern vendor fields through", () => {
  // These were silently stripped before .passthrough(): reasoning-model token
  // caps and the streaming-usage opt-in (whose loss zeroed usage accounting).
  const payload = {
    model: "gpt-5",
    messages: [{ role: "user", content: "Hi" }],
    max_completion_tokens: 256,
    stream_options: { include_usage: true },
    reasoning_effort: "high",
  };
  const result = ChatCompletionRequestSchema.safeParse(payload);
  assert(result.success);
  if (result.success) {
    const data = result.data as Record<string, unknown>;
    assertEquals(data.max_completion_tokens, 256);
    assertEquals(data.stream_options, { include_usage: true });
    assertEquals(data.reasoning_effort, "high");
  }
});

Deno.test("ProviderRegistry - OpenAI Capabilities", () => {
  const capabilities = ProviderRegistry["openai"];
  assert(capabilities.supportsStreaming);
  assert(capabilities.supportsTools);
  assertEquals(capabilities.authRequirements[0], "OPENAI_API_KEY");
});

Deno.test("parseChatCompletionRequest Helper", () => {
  const payload = {
    model: "claude-3-opus",
    messages: [{ role: "user", content: "Hello" }],
  };
  const result = parseChatCompletionRequest(payload);
  assert(result.success);
});

// --- Task 1: typed multimodal content + typed tools ---

Deno.test("MessageSchema - typed multimodal content blocks parse", () => {
  const result = MessageSchema.safeParse({
    role: "user",
    content: [
      { type: "text", text: "describe these" },
      {
        type: "image_url",
        image_url: { url: "https://x/a.png", detail: "high" },
      },
      { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
      { type: "file", file: { file_id: "file-1" } },
    ],
  });
  assert(result.success);
  if (result.success) {
    assert(Array.isArray(result.data.content));
    assertEquals((result.data.content as unknown[]).length, 4);
  }
});

Deno.test("MessageSchema - cache_control passthrough on a content block", () => {
  const result = MessageSchema.safeParse({
    role: "user",
    content: [
      { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
    ],
  });
  assert(result.success);
  if (result.success) {
    const block = (result.data.content as Array<Record<string, unknown>>)[0];
    assertEquals(
      (block.cache_control as Record<string, unknown>).type,
      "ephemeral",
    );
  }
});

Deno.test("MessageSchema - vendor field on an image block survives", () => {
  const result = MessageSchema.safeParse({
    role: "user",
    content: [
      { type: "image_url", image_url: { url: "u" }, vendor_flag: true },
    ],
  });
  assert(result.success);
  if (result.success) {
    const block = (result.data.content as Array<Record<string, unknown>>)[0];
    assertEquals(block.vendor_flag, true);
  }
});

Deno.test("BACKWARD-COMPAT: string content still parses", () => {
  const result = MessageSchema.safeParse({ role: "user", content: "plain" });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: array of arbitrary/unknown content still parses", () => {
  // The historical shape was z.array(z.unknown()); these do not match any
  // typed block yet must still be accepted via the union's unknown fallback.
  const result = MessageSchema.safeParse({
    role: "user",
    content: [
      { type: "text", text: 123 }, // wrong inner type -> unknown fallback
      { some: "vendor-only-block" }, // no discriminator -> unknown fallback
      "loose-string-part",
    ],
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: null and omitted content still parse", () => {
  assert(MessageSchema.safeParse({ role: "assistant", content: null }).success);
  assert(MessageSchema.safeParse({ role: "assistant" }).success);
});

Deno.test("ChatCompletionRequestSchema - typed tools + typed tool_choice", () => {
  const result = ChatCompletionRequestSchema.safeParse({
    model: "gpt-4",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "look up weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  });
  assert(result.success);
});

Deno.test("ChatToolChoiceSchema - string keyword forms parse", () => {
  for (const choice of ["auto", "none", "required"]) {
    assert(ChatToolChoiceSchema.safeParse(choice).success);
  }
});

Deno.test("Chat contracts type JSON-schema output and reasoning/audio response fields", () => {
  const request = ChatCompletionRequestSchema.safeParse({
    model: "gpt-5",
    messages: [{ role: "user", content: "respond as JSON" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    },
  });
  assert(request.success);

  const response = ChatCompletionResponseSchema.safeParse({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "{}",
        reasoning_content: "derived answer",
        audio: { id: "audio_1" },
      },
      logprobs: { content: [{ token: "{" }] },
      finish_reason: "stop",
    }],
  });
  assert(response.success);
});

Deno.test("BACKWARD-COMPAT: loose tools/tool_choice still parse", () => {
  // Historical: tools = array of unknown, tool_choice = unknown.
  const result = ChatCompletionRequestSchema.safeParse({
    model: "gpt-4",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ anything: "goes", type: "retrieval" }],
    tool_choice: { weird: "legacy-object" },
  });
  assert(result.success);
});
