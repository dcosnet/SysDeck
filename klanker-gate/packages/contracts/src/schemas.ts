import { z } from "zod";

// Base schemas
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

// Cache-control marker carried by multimodal blocks (Anthropic-style prompt
// caching). Widened `type` and passthrough so any vendor variant survives.
export const CacheControlSchema = z.object({
  type: z.union([z.literal("ephemeral"), z.string()]),
}).passthrough();
export type CacheControl = z.infer<typeof CacheControlSchema>;

// Typed multimodal content blocks. Each is passthrough so open/vendor fields
// survive verbatim, and every block carries optional `cache_control`.
export const ChatContentTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControlSchema.nullish(),
}).passthrough();
export type ChatContentText = z.infer<typeof ChatContentTextSchema>;

export const ChatContentImageSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.union([z.enum(["auto", "low", "high"]), z.string()]).optional(),
  }).passthrough(),
  cache_control: CacheControlSchema.nullish(),
}).passthrough();
export type ChatContentImage = z.infer<typeof ChatContentImageSchema>;

export const ChatContentAudioSchema = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.union([z.enum(["wav", "mp3"]), z.string()]),
  }).passthrough(),
  cache_control: CacheControlSchema.nullish(),
}).passthrough();
export type ChatContentAudio = z.infer<typeof ChatContentAudioSchema>;

export const ChatContentFileSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  }).passthrough(),
  cache_control: CacheControlSchema.nullish(),
}).passthrough();
export type ChatContentFile = z.infer<typeof ChatContentFileSchema>;

// Union of the typed blocks with an `unknown` fallback: any array element that
// parsed under the historical `z.array(z.unknown())` still parses.
export const ChatContentPartSchema = z.union([
  ChatContentTextSchema,
  ChatContentImageSchema,
  ChatContentAudioSchema,
  ChatContentFileSchema,
  z.unknown(),
]);
export type ChatContentPart = z.infer<typeof ChatContentPartSchema>;

// A string OR an array of typed content parts. Backward-compatible superset of
// the historical `z.union([z.string(), z.array(z.unknown())])`.
export const MessageContentSchema = z.union([
  z.string(),
  z.array(ChatContentPartSchema),
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  content: MessageContentSchema.nullable().optional(),
  name: z.string().optional(),
  // Typed tool calls with an `unknown` fallback (historical: array of unknown).
  tool_calls: z.array(z.union([ToolCallSchema, z.unknown()])).optional(),
  tool_call_id: z.string().optional(),
  function_call: z.unknown().optional(),
  /** Reasoning text emitted by compatible reasoning-model providers. */
  reasoning_content: z.string().nullable().optional(),
  /** Audio response metadata (id/data/expiry/vendor fields pass through). */
  audio: z.unknown().nullable().optional(),
  refusal: z.string().nullable().optional(),
}).passthrough();
export type Message = z.infer<typeof MessageSchema>;

// Typed function tool + tool_choice for Chat Completions. Both keep the
// historical loose forms accepted via a trailing `unknown` union member.
export const ChatToolFunctionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type ChatToolFunction = z.infer<typeof ChatToolFunctionSchema>;

export const ChatToolSchema = z.object({
  type: z.literal("function"),
  function: ChatToolFunctionSchema,
}).passthrough();
export type ChatTool = z.infer<typeof ChatToolSchema>;

export const ChatToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }).passthrough(),
  }).passthrough(),
  z.unknown(),
]);
export type ChatToolChoice = z.infer<typeof ChatToolChoiceSchema>;

export const ChatResponseFormatSchema = z.union([
  z.object({ type: z.enum(["text", "json_object"]) }).passthrough(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().optional(),
    }).passthrough(),
  }).passthrough(),
  z.unknown(),
]);
export type ChatResponseFormat = z.infer<typeof ChatResponseFormatSchema>;

// Chat Completions
export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  // Typed tools/tool_choice; each keeps its historical loose form via the
  // trailing `unknown` union member so today's requests never get rejected.
  tools: z.array(z.union([ChatToolSchema, z.unknown()])).optional(),
  tool_choice: ChatToolChoiceSchema.optional(),
  response_format: ChatResponseFormatSchema.optional(),
  seed: z.number().optional(),
  /** Gateway extension: ordered fallback targets tried on 429/5xx/network failure. Stripped before provider egress. */
  fallbacks: z.array(z.object({
    provider: z.string(),
    model: z.string().optional(),
  })).optional(),
}).passthrough();

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: MessageSchema,
      logprobs: z.object({
        content: z.array(z.unknown()).nullable().optional(),
        refusal: z.array(z.unknown()).nullable().optional(),
      }).passthrough().nullable().optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});

// Text Completions
export const CompletionRequestSchema = z.object({
  model: z.string(),
  prompt: z.union([z.string(), z.array(z.string())]),
  suffix: z.string().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().optional(),
  stream: z.boolean().optional(),
  logprobs: z.number().optional(),
  echo: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  best_of: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  // Passthrough so provider-specific fields survive to egress.
}).passthrough();

export const CompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("text_completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      text: z.string(),
      index: z.number(),
      logprobs: z.unknown().nullable().optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});

// Embeddings
export const EmbeddingRequestSchema = z.object({
  model: z.string(),
  input: z.union([
    z.string(),
    z.array(z.string()),
    z.array(z.number()),
    z.array(z.array(z.number())),
  ]),
  encoding_format: z.string().optional(),
  dimensions: z.number().optional(),
  user: z.string().optional(),
  // Passthrough so vendor-required fields survive to egress (e.g. Cohere v3
  // `input_type`/`truncate`).
}).passthrough();

export const EmbeddingResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      object: z.literal("embedding"),
      index: z.number(),
      embedding: z.array(z.number()),
    }),
  ),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

// Gateway Config & Internal
export const BifrostConfigSchema = z.object({
  log_level: z.string().optional(),
  port: z.number().optional(),
});

export const TelemetrySchema = z.object({
  latency: z.number(),
  provider: z.string(),
  model: z.string(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<
  typeof ChatCompletionResponseSchema
>;
export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;
export type CompletionResponse = z.infer<typeof CompletionResponseSchema>;
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;
