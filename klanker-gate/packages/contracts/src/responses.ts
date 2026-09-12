import { z } from "zod";

// Initial Responses API surface (Tier 2). Non-streaming requests are mapped
// onto the canonical chat pipeline; streaming is a documented gap for this
// wave (see docs/contracts/decision-log.md).

export const ResponsesInputItemSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([
    z.string(),
    z.array(z.union([
      z.object({ type: z.literal("input_text"), text: z.string() })
        .passthrough(),
      z.object({
        type: z.literal("input_image"),
        image_url: z.string().optional(),
        image_file_id: z.string().optional(),
      }).passthrough(),
      z.object({
        type: z.literal("input_file"),
        file_id: z.string().optional(),
        filename: z.string().optional(),
        file_data: z.string().optional(),
      }).passthrough(),
      z.record(z.string(), z.unknown()),
    ])),
  ]),
}).passthrough();
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;

// Typed function tool for the Responses API (flat name/parameters, unlike the
// nested Chat Completions shape).
export const ResponsesFunctionToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();
export type ResponsesFunctionTool = z.infer<typeof ResponsesFunctionToolSchema>;

export const ResponsesWebSearchToolSchema = z.object({
  // Real OpenAI has shipped several dated/preview spellings of web search.
  type: z.enum([
    "web_search",
    "web_search_preview",
    "web_search_preview_2025_03_11",
  ]),
}).passthrough();
export type ResponsesWebSearchTool = z.infer<
  typeof ResponsesWebSearchToolSchema
>;

export const ResponsesFileSearchToolSchema = z.object({
  type: z.literal("file_search"),
  vector_store_ids: z.array(z.string()).optional(),
}).passthrough();
export type ResponsesFileSearchTool = z.infer<
  typeof ResponsesFileSearchToolSchema
>;

export const ResponsesCodeInterpreterToolSchema = z.object({
  type: z.literal("code_interpreter"),
}).passthrough();
export type ResponsesCodeInterpreterTool = z.infer<
  typeof ResponsesCodeInterpreterToolSchema
>;

export const ResponsesComputerUseToolSchema = z.object({
  type: z.enum(["computer_use", "computer_use_preview", "computer-preview"]),
}).passthrough();
export type ResponsesComputerUseTool = z.infer<
  typeof ResponsesComputerUseToolSchema
>;

export const ResponsesImageGenerationToolSchema = z.object({
  type: z.literal("image_generation"),
}).passthrough();
export type ResponsesImageGenerationTool = z.infer<
  typeof ResponsesImageGenerationToolSchema
>;

export const ResponsesLocalShellToolSchema = z.object({
  type: z.literal("local_shell"),
}).passthrough();
export type ResponsesLocalShellTool = z.infer<
  typeof ResponsesLocalShellToolSchema
>;

// Hosted MCP server config. EXECUTED: the gateway advertises its aggregated
// MCP catalog when this tool is present, and the ToolExecutor runs the calls.
export const ResponsesMCPToolSchema = z.object({
  type: z.literal("mcp"),
  server_label: z.string().optional(),
  server_url: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
}).passthrough();
export type ResponsesMCPTool = z.infer<typeof ResponsesMCPToolSchema>;

export const ResponsesCustomToolSchema = z.object({
  type: z.literal("custom"),
  name: z.string().optional(),
}).passthrough();
export type ResponsesCustomTool = z.infer<typeof ResponsesCustomToolSchema>;

// Order matters: the specific typed members are tried first, then the trailing
// `z.unknown()` accepts any exotic variant so no valid request is ever rejected.
export const ResponsesToolSchema = z.union([
  ResponsesFunctionToolSchema,
  ResponsesMCPToolSchema,
  ResponsesWebSearchToolSchema,
  ResponsesFileSearchToolSchema,
  ResponsesCodeInterpreterToolSchema,
  ResponsesComputerUseToolSchema,
  ResponsesImageGenerationToolSchema,
  ResponsesLocalShellToolSchema,
  ResponsesCustomToolSchema,
  z.unknown(),
]);
export type ResponsesTool = z.infer<typeof ResponsesToolSchema>;

export const ResponsesToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    name: z.string(),
  }).passthrough(),
  z.unknown(),
]);
export type ResponsesToolChoice = z.infer<typeof ResponsesToolChoiceSchema>;

export const ResponsesReasoningSchema = z.object({
  effort: z.union([z.enum(["minimal", "low", "medium", "high"]), z.string()])
    .nullable().optional(),
  summary: z.union([z.enum(["auto", "concise", "detailed"]), z.string()])
    .nullable().optional(),
  generate_summary: z.union([
    z.enum(["auto", "concise", "detailed"]),
    z.string(),
  ]).nullable().optional(),
}).passthrough();
export type ResponsesReasoning = z.infer<typeof ResponsesReasoningSchema>;

export const ResponsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
  instructions: z.string().nullable().optional(),
  max_output_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stream: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  // Additive typed request fields (all optional, all backward-compatible).
  tools: z.array(ResponsesToolSchema).optional(),
  tool_choice: ResponsesToolChoiceSchema.optional(),
  reasoning: ResponsesReasoningSchema.optional(),
  previous_response_id: z.string().nullable().optional(),
  store: z.boolean().nullable().optional(),
  include: z.array(z.string()).optional(),
  text: z.record(z.string(), z.unknown()).nullable().optional(),
  truncation: z.union([z.enum(["auto", "disabled"]), z.string()]).nullable()
    .optional(),
}).passthrough();
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export const ResponsesOutputTextSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.unknown()),
}).passthrough();
export type ResponsesOutputText = z.infer<typeof ResponsesOutputTextSchema>;

export const ResponsesOutputRefusalSchema = z.object({
  type: z.literal("refusal"),
  refusal: z.string(),
}).passthrough();
export type ResponsesOutputRefusal = z.infer<
  typeof ResponsesOutputRefusalSchema
>;

// Typed output content blocks with an `unknown` fallback so the historical
// output_text-only shape (and any richer wire block) still parses.
export const ResponsesOutputContentSchema = z.union([
  ResponsesOutputTextSchema,
  ResponsesOutputRefusalSchema,
  z.unknown(),
]);
export type ResponsesOutputContent = z.infer<
  typeof ResponsesOutputContentSchema
>;

export const ResponsesOutputMessageSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  status: z.string(),
  content: z.array(ResponsesOutputContentSchema),
}).passthrough();
export type ResponsesOutputMessage = z.infer<
  typeof ResponsesOutputMessageSchema
>;

// `function_call` output item: the model asked the caller to run a tool the
// gateway does not own. The agent loop surfaces these so the caller can execute
// the tool and continue the conversation.
export const ResponsesFunctionCallOutputSchema = z.object({
  id: z.string(),
  type: z.literal("function_call"),
  status: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
}).passthrough();
export type ResponsesFunctionCallOutput = z.infer<
  typeof ResponsesFunctionCallOutputSchema
>;

// Typed output items with an `unknown` fallback so the historical
// message-only output (and any richer hosted-tool item) still parses.
export const ResponsesOutputItemSchema = z.union([
  ResponsesOutputMessageSchema,
  ResponsesFunctionCallOutputSchema,
  z.unknown(),
]);
export type ResponsesOutputItem = z.infer<typeof ResponsesOutputItemSchema>;

export const ResponsesResponseSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  created_at: z.number(),
  status: z.string(),
  model: z.string(),
  output: z.array(ResponsesOutputItemSchema),
  output_text: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  }).passthrough().optional(),
}).passthrough();
export type ResponsesResponse = z.infer<typeof ResponsesResponseSchema>;
