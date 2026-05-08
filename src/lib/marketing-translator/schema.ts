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

export const CampaignCopyRequestSchema = z.object({
  brief: z.object({
    marketingMessage: z.string().min(1),
    campaignGoal: z.enum(["awareness", "consideration", "conversion", "retention"]),
    targetAudience: z.string().optional(),
    notes: z.string().optional(),
  }),
  targetLocale: z.string().min(2),
  tone: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
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
