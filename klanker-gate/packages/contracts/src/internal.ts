import { z } from "zod";

export const BifrostRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()).optional(),
});
export type BifrostRequest = z.infer<typeof BifrostRequestSchema>;

export const BifrostResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()).optional(),
});
export type BifrostResponse = z.infer<typeof BifrostResponseSchema>;

export const BifrostErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
  }),
});
export type BifrostError = z.infer<typeof BifrostErrorSchema>;

export const FallbackSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
});
export type Fallback = z.infer<typeof FallbackSchema>;

export const BifrostConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  fallbacks: z.array(FallbackSchema).optional(),
});
export type BifrostConfig = z.infer<typeof BifrostConfigSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string(),
});
export type Account = z.infer<typeof AccountSchema>;
