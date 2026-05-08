import { z } from "zod";

export const AssetKindSchema = z.enum([
  "midjourney-output",
  "logo",
  "product-photo",
  "background",
  "icon",
  "rendered-final",
  "other",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetSchema = z.object({
  id: z.string().uuid(),
  campaignId: z.string().min(1),
  kind: AssetKindSchema,
  cloudinaryPublicId: z.string().min(1),
  secureUrl: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative().optional(),
  format: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof AssetSchema>;
