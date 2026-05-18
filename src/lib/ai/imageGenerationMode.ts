import { z } from "zod";

// Whether to generate the entire midjourney_prompt_pack per concept or only
// the (single) background prompt. Default is background-only to match the
// per-route comment ("one background image per concept") and keep API costs
// predictable.
export const ImageGenerationModeSchema = z.enum([
  "background-only",
  "all-prompts",
]);
export type ImageGenerationMode = z.infer<typeof ImageGenerationModeSchema>;

export const DEFAULT_IMAGE_GENERATION_MODE: ImageGenerationMode = "background-only";
