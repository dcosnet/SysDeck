import { z } from "zod";

// Provider-native compatibility surface: Anthropic Messages API request shape,
// accepted at /v1/messages so Anthropic SDK clients can point at the gateway.
// Non-streaming only in this wave (documented in decision-log.md).

export const AnthropicContentBlockSchema = z.object({
  type: z.string(),
}).passthrough();

export const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
});

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessageSchema),
  system: z.union([z.string(), z.array(AnthropicContentBlockSchema)])
    .optional(),
  max_tokens: z.number(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      input_schema: z.record(z.string(), z.unknown()),
    }),
  ).optional(),
  // Passthrough so Anthropic-native fields survive to egress (thinking, top_k,
  // tool_choice, metadata, service_tier), matching AnthropicContentBlockSchema.
}).passthrough();
export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.record(z.string(), z.unknown())),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});
export type AnthropicMessagesResponse = z.infer<
  typeof AnthropicMessagesResponseSchema
>;
