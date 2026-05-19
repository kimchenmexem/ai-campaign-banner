import { z } from "zod";
import { MidjourneyContextSchema } from "@/lib/schemas/midjourney.schema";
import { ElementManifestSchema } from "@/lib/schemas/elementManifest.schema";
import {
  CampaignBriefSchema,
  CampaignFormatSchema,
} from "@/lib/schemas/campaignBrief.schema";
import { VisualLayoutSpecSchema } from "@/lib/schemas/visualLayoutSpec.schema";

// Re-export for convenience: the campaign format enum is the same one the
// brief schema defines.
export { CampaignFormatSchema, type CampaignFormat } from "@/lib/schemas/campaignBrief.schema";

// ─────────────────────────────────────────────────────────────────────────────
// AI Campaign Plan schemas.
//
// Two layers:
//   1. AI raw output — what the LLM returns (concept stubs, no manifests).
//      Validated immediately after the model call to catch hallucination /
//      drift before anything is saved.
//   2. CampaignPlan — the final saved artifact, with ad_specs whose manifests
//      were *built by code* (not by the AI). This separation keeps Element
//      Manifest validation tight and prevents the AI from inventing broken
//      layouts.
//
// The Element Manifest stays the source of truth. The AI decides strategy
// and copy; the system constructs the layout.
// ─────────────────────────────────────────────────────────────────────────────

export const PlatformCopyVariationSchema = z.object({
  platform: z.string().min(1), // e.g. "instagram-feed", "linkedin"
  headline: z.string().optional(),
  subheadline: z.string().optional(),
  cta: z.string().optional(),
});
export type PlatformCopyVariation = z.infer<typeof PlatformCopyVariationSchema>;

export const CopyPackageSchema = z.object({
  headline: z.string().min(1),
  // Optional yellow-emphasis prefix that opens the headline. Matches the
  // MEXEM reference style where the first clause of the headline (e.g.
  // "ONE INVESTING ACCOUNT.") is rendered in brand-accent yellow and the
  // rest ("ACCESS ACROSS EVERY DEVICE.") in white. Must be a verbatim
  // prefix of `headline`. When omitted or null the headline renders
  // single-color.
  //
  // Accepts `null` because some AI providers (notably GPT-4o in JSON-mode)
  // emit `"headline_emphasis": null` rather than omitting the key when no
  // emphasis fits, even though the prompt asks for the latter. Treating
  // null the same as undefined keeps the planner from rejecting otherwise
  // valid plans.
  headline_emphasis: z.string().nullable().optional(),
  subheadline: z.string().min(1),
  body: z.string().optional(),
  cta: z.string().min(1),
  disclaimer: z.string().min(1),
  alternative_headlines: z.array(z.string().min(1)).default([]),
  alternative_ctas: z.array(z.string().min(1)).default([]),
  platform_copy_variations: z.array(PlatformCopyVariationSchema).default([]),
});
export type CopyPackage = z.infer<typeof CopyPackageSchema>;

export const VisualDirectionSchema = z.object({
  // Free-form description of the desired visual feeling.
  description: z.string().min(1),
  // Brand-color hex codes the AI deemed primary for this concept.
  primary_palette: z.array(z.string()).default([]),
  // Composition language: "hero_left_mockup_right", etc.
  composition: z.string().optional(),
  // Mood adjectives.
  mood_keywords: z.array(z.string()).default([]),
});
export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

// Concept-attached Midjourney prompt. The full pack lives in
// data/midjourney-prompt-pack.generated.json; this is what the AI emits per
// concept so a manual operator can also run them. Uses the 6-value Midjourney
// context enum (which adds `premium_fintech` to the 5 screenshot-tag contexts).
// Optional typographic accents the AI may request per concept. Each is
// rendered as a real manifest element when present; absent fields are simply
// omitted (no placeholder text, no empty layers). Strict length limits keep
// the design discipline ("clean line") even when the AI is feeling creative.
//   eyebrow — small ALL-CAPS line above the headline. Use for category /
//             section labels: "ETF TRADING", "0% COMMISSIONS".
//   stat    — a single big-number + label combo for editorial_type ads.
//             Replaces the geometric accent when present.
//   kicker  — a short pull-quote-style line below the subheadline.
export const ConceptDesignElementsSchema = z.object({
  eyebrow: z.string().min(1).max(40).optional(),
  stat: z.object({
    number: z.string().min(1).max(12),
    label: z.string().min(1).max(40),
  }).optional(),
  kicker: z.string().min(1).max(120).optional(),
});
export type ConceptDesignElements = z.infer<typeof ConceptDesignElementsSchema>;

export const ConceptMidjourneyPromptSchema = z.object({
  prompt_id: z.string().min(1),
  intended_use: z.enum([
    "background",
    "hero_visual",
    "decorative",
    "moodboard",
    "texture",
  ]),
  context: MidjourneyContextSchema,
  aspect_ratio: z.enum(["16:9", "1:1", "9:16", "4:5"]),
  prompt_text: z.string().min(1),
  notes: z.string().optional(),
});
export type ConceptMidjourneyPrompt = z.infer<typeof ConceptMidjourneyPromptSchema>;

// ── AI raw output (concept stubs only — no ad_specs, no element layouts) ────
//
// `desired_visual_context` uses the 6-value MidjourneyContext enum so the AI
// can request `premium_fintech` for purely abstract visuals. The downstream
// builder maps `premium_fintech` → `general_platform` for screenshot picking
// (since screenshot tags only have 5 values).
export const AIConceptStubSchema = z.object({
  concept_id: z.string().min(1),
  name: z.string().min(1),
  strategic_idea: z.string().min(1),
  target_emotion: z.string().min(1),
  tone: z.string().min(1),
  visual_direction: VisualDirectionSchema,
  copy_package: CopyPackageSchema,
  desired_visual_context: MidjourneyContextSchema,
  midjourney_prompt_pack: z.array(ConceptMidjourneyPromptSchema).default([]),
  design_elements: ConceptDesignElementsSchema.optional(),
});
export type AIConceptStub = z.infer<typeof AIConceptStubSchema>;

export const AICampaignPlanRawSchema = z.object({
  campaign_name: z.string().min(1),
  campaign_summary: z.string().min(1),
  concepts: z.array(AIConceptStubSchema).min(1),
});
export type AICampaignPlanRaw = z.infer<typeof AICampaignPlanRawSchema>;

// ── Final saved CampaignPlan (concepts + ad_specs with manifests) ───────────
export const VisualSelectionMetadataSchema = z.object({
  desired_context: z.string(),
  selected_context: z.string(),
  intended_device_type: z.string(),
  fallback_used: z.boolean(),
  fallback_kind: z.enum(["composite", "mockup_only", "screenshot_only", "none"]),
  composite_id: z.string().nullable(),
  composite_public_path: z.string().nullable(),
  mockup_filename: z.string().nullable(),
  screenshot_filename: z.string().nullable(),
  screenshot_context_confidence: z.string().nullable(),
  mockup_slot_source: z.string().nullable(),
});
export type VisualSelectionMetadata = z.infer<typeof VisualSelectionMetadataSchema>;

export const CampaignAdSpecSchema = z.object({
  ad_id: z.string().min(1),
  campaign_id: z.string().min(1),
  concept_id: z.string().min(1),
  format: CampaignFormatSchema,
  canvas_width: z.number().int().positive(),
  canvas_height: z.number().int().positive(),
  channel: z.string(),
  internal_template_id: z.string(),
  manifest: ElementManifestSchema,
  visual_selection_metadata: VisualSelectionMetadataSchema,
  status: z.enum(["draft", "ready", "rendered", "failed"]),
});
export type CampaignAdSpec = z.infer<typeof CampaignAdSpecSchema>;

export const CampaignConceptSchema = AIConceptStubSchema.extend({
  campaign_id: z.string().min(1),
  ad_specs: z.array(CampaignAdSpecSchema).min(1),
  // AI Visual Planner output for this concept. Optional for backwards
  // compatibility with campaigns saved before the visual planner shipped —
  // those concepts simply have no spec and the renderer falls through to
  // PRNG. New campaigns generated through campaignPlanner.ts persist the
  // spec here so the design choice is reproducible and human-reviewable.
  visual_layout_spec: VisualLayoutSpecSchema.optional(),
});
export type CampaignConcept = z.infer<typeof CampaignConceptSchema>;

export const CampaignPlanSchema = z.object({
  campaign_id: z.string().min(1),
  brand_id: z.string().min(1),
  source_brief: CampaignBriefSchema,
  campaign_name: z.string().min(1),
  campaign_summary: z.string().min(1),
  ai_provider: z.enum(["openai", "anthropic", "mock"]),
  concepts: z.array(CampaignConceptSchema).min(1),
  warnings: z.array(z.string()).default([]),
  // Phase 4 — generated-asset QA report. Optional for backward compat with
  // existing saved campaign plans.
  //   generated_assets_used      — every asset id that actually landed on at
  //                                least one element (deduped, stable order).
  //   generated_assets_warnings  — asset-specific warnings (missing ids,
  //                                aspect-ratio mismatches, CTA refits,
  //                                unapproved-asset adoptions). Distinct from
  //                                the general `warnings` array so a reviewer
  //                                can scan QA without grepping.
  generated_assets_used: z.array(z.string()).default([]),
  generated_assets_warnings: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

// ── Index file that lists all generated campaigns ───────────────────────────
export const CampaignIndexEntrySchema = z.object({
  campaign_id: z.string().min(1),
  brand_id: z.string().min(1),
  campaign_name: z.string().min(1),
  ai_provider: z.enum(["openai", "anthropic", "mock"]),
  concept_count: z.number().int().nonnegative(),
  ad_count: z.number().int().nonnegative(),
  created_at: z.string(),
  active: z.boolean().default(false),
  rendered: z.boolean().default(false),
});
export type CampaignIndexEntry = z.infer<typeof CampaignIndexEntrySchema>;

export const CampaignIndexFileSchema = z.object({
  generated_at: z.string(),
  active_campaign_id: z.string().nullable(),
  campaigns: z.array(CampaignIndexEntrySchema),
});
export type CampaignIndexFile = z.infer<typeof CampaignIndexFileSchema>;

export const ActiveCampaignFileSchema = z.object({
  campaign_id: z.string().min(1),
  pointer_path: z.string(),
  set_at: z.string(),
});
export type ActiveCampaignFile = z.infer<typeof ActiveCampaignFileSchema>;
