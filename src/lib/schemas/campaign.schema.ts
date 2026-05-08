import { z } from "zod";

export const CampaignBriefSchema = z.object({
  message: z.string().min(1, "marketing message is required"),
  audience: z.string().optional(),
  goal: z
    .enum(["awareness", "consideration", "conversion", "retention"])
    .default("awareness"),
  channels: z.array(z.string()).default([]),
  callToAction: z.string().optional(),
  brandId: z.string().optional(),
  notes: z.string().optional(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export const CampaignConceptSchema = z.object({
  conceptId: z.string().min(1),
  title: z.string().min(1),
  bigIdea: z.string().min(1),
  rationale: z.string().min(1),
  keyVisualDirection: z.string().min(1),
  copyDirection: z.string().min(1),
  toneTags: z.array(z.string()).default([]),
});
export type CampaignConcept = z.infer<typeof CampaignConceptSchema>;

export const CampaignPlanSchema = z.object({
  brief: CampaignBriefSchema,
  concepts: z.array(CampaignConceptSchema).min(1),
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

export const CampaignStatusSchema = z.enum([
  "draft",
  "planning",
  "rendering",
  "qa",
  "ready",
  "exported",
  "failed",
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignRecordSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().nullable(),
  status: CampaignStatusSchema,
  brief: CampaignBriefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CampaignRecord = z.infer<typeof CampaignRecordSchema>;
