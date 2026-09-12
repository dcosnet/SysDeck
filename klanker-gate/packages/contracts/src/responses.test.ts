import { assert, assertEquals } from "@std/assert";
import {
  ResponsesFunctionToolSchema,
  ResponsesMCPToolSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesToolChoiceSchema,
  ResponsesToolSchema,
} from "./responses.ts";

// --- New typed request shapes parse ---

Deno.test("ResponsesRequestSchema - typed tools + tool_choice + reasoning", () => {
  const result = ResponsesRequestSchema.safeParse({
    model: "gpt-5",
    input: "solve it",
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "look something up",
        parameters: { type: "object" },
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: "lookup" },
    reasoning: { effort: "high", summary: "auto" },
  });
  assert(result.success);
});

Deno.test("ResponsesRequestSchema - typed input parts and continuation extras parse", () => {
  const result = ResponsesRequestSchema.safeParse({
    model: "gpt-5",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "read this" },
        { type: "input_image", image_url: "https://example.test/image.png" },
        { type: "input_file", file_id: "file_1", filename: "notes.txt" },
      ],
    }],
    previous_response_id: "resp_previous",
    store: true,
    include: ["reasoning.encrypted_content"],
    text: { format: { type: "text" } },
    truncation: "auto",
  });
  assert(result.success);
});

Deno.test("ResponsesToolChoiceSchema - keyword forms parse", () => {
  for (const choice of ["auto", "none", "required"]) {
    assert(ResponsesToolChoiceSchema.safeParse(choice).success);
  }
});

Deno.test("ResponsesRequestSchema - common built-in tool taxonomy parses", () => {
  // The common hosted/built-in tool types are now first-class typed members of
  // the union (they used to fall through the unknown branch).
  const result = ResponsesRequestSchema.safeParse({
    model: "gpt-5",
    input: "search",
    tools: [
      { type: "web_search" },
      { type: "web_search_preview" },
      { type: "file_search", vector_store_ids: ["vs_1"] },
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "computer_use_preview", display_width: 1024 },
      { type: "image_generation" },
      { type: "local_shell" },
      { type: "mcp", server_label: "gh", server_url: "https://mcp.example" },
      { type: "custom", name: "my_tool" },
    ],
  });
  assert(result.success);
});

Deno.test("ResponsesToolSchema - exotic unknown tool still parses via fallback", () => {
  // The ~140 exotic variants are NOT hand-typed; they must still parse
  // untouched through the trailing z.unknown() fallback.
  const result = ResponsesToolSchema.safeParse({
    type: "some_future_hosted_tool_2099",
    weird_field: { nested: true },
  });
  assert(result.success);
});

Deno.test("ResponsesToolSchema - function/mcp tools narrow to their typed member", () => {
  const fn = ResponsesToolSchema.safeParse({
    type: "function",
    name: "lookup",
    parameters: { type: "object" },
  });
  assert(fn.success);
  assertEquals((fn.data as { type: string }).type, "function");
  // The typed member is authoritative for the discriminator.
  assert(
    ResponsesFunctionToolSchema.safeParse({ type: "function", name: "x" })
      .success,
  );
  // A web_search tool must NOT be mistaken for a function tool.
  assert(
    !ResponsesFunctionToolSchema.safeParse({ type: "web_search" }).success,
  );

  const mcp = ResponsesToolSchema.safeParse({
    type: "mcp",
    server_label: "gh",
    server_url: "https://mcp.example",
    allowed_tools: ["search"],
  });
  assert(mcp.success);
  assertEquals((mcp.data as { type: string }).type, "mcp");
  assert(
    ResponsesMCPToolSchema.safeParse({ type: "mcp", server_label: "x" })
      .success,
  );
});

// --- New typed response shapes parse ---

Deno.test("ResponsesResponseSchema - output_text + refusal content blocks", () => {
  const result = ResponsesResponseSchema.safeParse({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5",
    output: [{
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "the answer", annotations: [] },
        { type: "refusal", refusal: "I cannot help with that" },
      ],
    }],
    output_text: "the answer",
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
    },
  });
  assert(result.success);
});

Deno.test("ResponsesResponseSchema - function_call output item parses", () => {
  // The agent loop surfaces client-owned tool calls as function_call items
  // alongside the message item; both must parse.
  const result = ResponsesResponseSchema.safeParse({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      },
      {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
    ],
    output_text: "",
  });
  assert(result.success);
});

// --- BACKWARD-COMPAT: historical shapes still parse ---

Deno.test("BACKWARD-COMPAT: minimal request {model,input} parses", () => {
  assert(
    ResponsesRequestSchema.safeParse({ model: "gpt-5", input: "hi" }).success,
  );
});

Deno.test("BACKWARD-COMPAT: request with structured input items parses", () => {
  const result = ResponsesRequestSchema.safeParse({
    model: "gpt-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    instructions: "be brief",
  });
  assert(result.success);
});

Deno.test("BACKWARD-COMPAT: output_text-only response (old shape) parses", () => {
  const result = ResponsesResponseSchema.safeParse({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5",
    output: [{
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    }],
    output_text: "hi",
  });
  assert(result.success);
  if (result.success) {
    assertEquals(result.data.output_text, "hi");
  }
});
