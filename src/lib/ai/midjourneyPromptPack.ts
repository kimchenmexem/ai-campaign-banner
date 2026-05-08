import { z } from "zod";
import type { CampaignConcept } from "@/lib/schemas/campaign.schema";
import type { AdSpec } from "@/lib/schemas/adSpec.schema";

export const MidjourneyPromptSchema = z.object({
  promptId: z.string().min(1),
  conceptId: z.string().min(1),
  text: z.string().min(1),
  aspectRatio: z.string().regex(/^\d+:\d+$/),
  styleTags: z.array(z.string()).default([]),
  negativeTerms: z.array(z.string()).default([]),
});
export type MidjourneyPrompt = z.infer<typeof MidjourneyPromptSchema>;

export const MidjourneyPromptPackSchema = z.object({
  packId: z.string().min(1),
  campaignId: z.string().min(1),
  prompts: z.array(MidjourneyPromptSchema).min(1),
});
export type MidjourneyPromptPack = z.infer<typeof MidjourneyPromptPackSchema>;

export interface BuildPromptPackInput {
  campaignId: string;
  concept: CampaignConcept;
  specs: AdSpec[];
}

export async function buildMidjourneyPromptPack(
  _input: BuildPromptPackInput,
): Promise<MidjourneyPromptPack> {
  throw new Error("buildMidjourneyPromptPack: not implemented");
}
