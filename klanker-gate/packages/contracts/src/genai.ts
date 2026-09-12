import { z } from "zod";

// Provider-native compatibility surface: the Google GenAI
// (generativelanguage) GenerateContentRequest shape, accepted at
// /genai/v1beta/models/{model}:{generateContent,streamGenerateContent,
// countTokens}. Validation is deliberately lenient - this is ingress from
// real vendor SDKs, so accept-and-carry beats reject.

/**
 * One `contents[].parts[]` entry. Left as a bare passthrough object because a
 * part is a one-of (`text` | `inlineData` | `fileData` | `functionCall` |
 * `functionResponse` | `executableCode` | ...) and new variants ship without
 * notice; the ingress mapping reads the shapes it understands.
 */
export const GenAIPartSchema = z.object({}).passthrough();
export type GenAIPart = z.infer<typeof GenAIPartSchema>;

/** One conversation turn. `role` is a lenient string, not an enum. */
export const GenAIContentSchema = z.object({
  role: z.string().optional(),
  parts: z.array(GenAIPartSchema).optional(),
}).passthrough();
export type GenAIContent = z.infer<typeof GenAIContentSchema>;

/** Sampling / output controls. Unlisted keys survive via passthrough. */
export const GenAIGenerationConfigSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  candidateCount: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  responseMimeType: z.string().optional(),
  responseSchema: z.unknown().optional(),
  thinkingConfig: z.unknown().optional(),
}).passthrough();
export type GenAIGenerationConfig = z.infer<typeof GenAIGenerationConfigSchema>;

export const GenAIGenerateContentRequestSchema = z.object({
  contents: z.array(GenAIContentSchema).optional(),
  /** SDKs send either a Content object or a bare string; both are accepted. */
  systemInstruction: z.union([z.string(), GenAIContentSchema]).optional(),
  generationConfig: GenAIGenerationConfigSchema.optional(),
  /** Each entry is either `{functionDeclarations}` or a built-in server tool. */
  tools: z.array(z.object({}).passthrough()).optional(),
  toolConfig: z.object({}).passthrough().optional(),
  safetySettings: z.array(z.object({}).passthrough()).optional(),
  // Passthrough so GenAI-native fields survive to egress (cachedContent,
  // labels, and any key a newer SDK adds).
}).passthrough();
export type GenAIGenerateContentRequest = z.infer<
  typeof GenAIGenerateContentRequestSchema
>;
