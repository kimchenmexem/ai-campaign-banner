import { z } from "zod";

export const AdSizeSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AdSize = z.infer<typeof AdSizeSchema>;

export const CopySlotSchema = z.object({
  slotId: z.string().min(1),
  role: z.enum(["headline", "subheadline", "body", "cta", "legal", "other"]),
  text: z.string(),
  maxLength: z.number().int().positive().optional(),
});
export type CopySlot = z.infer<typeof CopySlotSchema>;

export const AdSpecSchema = z.object({
  specId: z.string().min(1),
  conceptId: z.string().min(1),
  channel: z.string().min(1),
  size: AdSizeSchema,
  bannerbearTemplateUid: z.string().min(1),
  copySlots: z.array(CopySlotSchema).default([]),
  notes: z.string().optional(),
});
export type AdSpec = z.infer<typeof AdSpecSchema>;
