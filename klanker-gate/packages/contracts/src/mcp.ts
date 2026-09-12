import { z } from "zod";

export const BifrostMCPRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional(),
});
export type BifrostMCPRequest = z.infer<typeof BifrostMCPRequestSchema>;

export const BifrostMCPResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
}).refine((v) => (v.result === undefined) !== (v.error === undefined), {
  message: "Response must include exactly one of result or error",
});
export type BifrostMCPResponse = z.infer<typeof BifrostMCPResponseSchema>;
