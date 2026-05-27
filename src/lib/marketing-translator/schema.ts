import { z } from "zod";

// Localised ad copy contract returned by marketing-translator's
// POST /api/campaign-copy. ai-campaign-banner consumes this and writes
// it into each concept's copy_package — it never invents copy itself.

export const LocalizedCopyPackageSchema = z.object({
  locale: z.string().min(2),
  direction: z.enum(["ltr", "rtl"]),
  headline: z.string().min(1),
  subheadline: z.string().min(1),
  body: z.string().min(1).optional(),
  cta: z.string().min(1),
  disclaimer: z.string().min(1),
  complianceNotes: z.array(z.string()).default([]),
});
export type LocalizedCopyPackage = z.infer<typeof LocalizedCopyPackageSchema>;

const CampaignCopyBriefSchema = z.object({
  marketingMessage: z.string().min(1),
  campaignGoal: z.enum(["awareness", "consideration", "conversion", "retention"]),
  targetAudience: z.string().optional(),
  notes: z.string().optional(),
});

const ToneSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const CampaignCopyRequestSchema = z.object({
  brief: CampaignCopyBriefSchema,
  targetLocale: z.string().min(2),
  tone: ToneSchema,
  complianceNotes: z.string().optional(),
  riskWarningRequired: z.boolean().optional(),
  conceptHint: z
    .object({
      conceptId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      strategicIdea: z.string().min(1).optional(),
    })
    .optional(),
});
export type CampaignCopyRequest = z.infer<typeof CampaignCopyRequestSchema>;

export const CampaignCopyBatchConceptSchema = z.object({
  conceptId: z.string().min(1),
  name: z.string().min(1).optional(),
  strategicIdea: z.string().min(1).optional(),
  targetEmotion: z.string().min(1).optional(),
  tone: ToneSchema.optional(),
  composition: z.string().min(1).optional(),
  moodKeywords: z.array(z.string().min(1)).optional(),
});

export const CampaignCopyBatchRequestSchema = z.object({
  brief: CampaignCopyBriefSchema,
  targetLocale: z.string().min(2),
  tone: ToneSchema,
  complianceNotes: z.string().optional(),
  riskWarningRequired: z.boolean().optional(),
  concepts: z.array(CampaignCopyBatchConceptSchema).min(1).max(8),
});
export type CampaignCopyBatchRequest = z.infer<typeof CampaignCopyBatchRequestSchema>;

export const LocalizedCopyBatchConceptSchema = z.object({
  conceptId: z.string().min(1),
  headline: z.string().min(1),
  subheadline: z.string().min(1),
  body: z.string().min(1).optional(),
  cta: z.string().min(1),
  disclaimer: z.string().min(1),
  eyebrow: z.string().min(1).optional(),
  kicker: z.string().min(1).optional(),
  complianceNotes: z.array(z.string()).default([]),
});
export type LocalizedCopyBatchConcept = z.infer<typeof LocalizedCopyBatchConceptSchema>;

export const LocalizedCopyBatchResponseSchema = z.object({
  locale: z.string().min(2),
  direction: z.enum(["ltr", "rtl"]),
  concepts: z.array(LocalizedCopyBatchConceptSchema).min(1),
});
export type LocalizedCopyBatchResponse = z.infer<typeof LocalizedCopyBatchResponseSchema>;
