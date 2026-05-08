import { z } from "zod";
import { ScreenshotContextSchema } from "@/lib/schemas/screenshotContext.schema";
import { LanguageSchema } from "@/lib/i18n/language";

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Brief — the human-authored input to the AI Campaign Planner.
//
// Validates input from the /campaign-planner form before we hit the AI. Once
// the planner consumes it, the brief is embedded in the resulting CampaignPlan
// as `source_brief` so a campaign can always be regenerated reproducibly.
// ─────────────────────────────────────────────────────────────────────────────

// Canonical ad-format catalogue. Adding a value here also requires entries
// in src/lib/ai/buildAdSpecsFromPlan.ts (FORMAT_TO_DEVICE / FORMAT_TO_CHANNEL
// / FORMAT_TO_SIZE) and brand-kit-lite.generated.json (typography
// sizes_per_format / outer_margins / safe_areas) — otherwise the planner
// will throw on an unknown format.
export const CampaignFormatSchema = z.enum([
  // Original 3
  "1200x628",   // LinkedIn / Facebook link share, leaderboard
  "1080x1080",  // Instagram feed square
  "1080x1920",  // Instagram / TikTok story
  // Added: more sizes
  "1080x1350",  // Instagram feed portrait (4:5)
  "1200x675",   // X (Twitter) feed (16:9)
  "1200x1200",  // LinkedIn / generic large square
  "1500x500",   // X / LinkedIn cover (3:1)
  "1920x1080",  // YouTube card / landscape HD
]);
export type CampaignFormat = z.infer<typeof CampaignFormatSchema>;

export const CampaignBriefSchema = z.object({
  brief_id: z.string().min(1),
  brand_id: z.string().min(1),
  marketing_message: z.string().min(1),
  // Removed from the planner form. Kept on the schema as optional so existing
  // saved campaigns + scripts that still pass it stay valid.
  target_audience: z.string().min(1).optional(),
  campaign_goal: z.enum([
    "awareness",
    "consideration",
    "conversion",
    "retention",
  ]),
  tone: z.array(z.string().min(1)).min(1),
  // Removed from the planner form. Kept on the schema as optional so
  // existing saved campaigns + scripts that still pass it stay valid; the
  // provider and detail page guard against undefined.
  platforms: z.array(z.string().min(1)).optional(),
  required_formats: z.array(CampaignFormatSchema).min(1),
  preferred_contexts: z.array(ScreenshotContextSchema).min(1),
  risk_warning_required: z.boolean().default(true),
  notes: z.string().optional(),
  // Output language. Drives:
  //   - the AI's copy generation language (every text field)
  //   - text-align (RTL languages flip to right-aligned)
  //   - CTA arrow direction (→ for LTR, ← for RTL)
  //   - font_family stack (Heebo for Hebrew, Cairo for Arabic, etc.)
  //   - per-script charWidthRatio in fitFontToBox
  language: LanguageSchema,
  // Creative-discipline level for the AI.
  //   "standard"    — today's behavior: temperature 0.85 first pass, 0.4
  //                   critique pass that kills consultant-ese, 0.5 visual
  //                   planner with the "at most one strong accent" rule.
  //                   Produces on-brand, polished, slightly conservative
  //                   campaigns.
  //   "exploratory" — bumps first-pass temperature to 1.0, SKIPS the
  //                   critique pass entirely (so creative / poetic copy
  //                   survives), bumps visual-planner temperature to 0.75
  //                   and softens the brand-discipline soft rules in the
  //                   prompt. The renderer's safety clamps (no overlapping
  //                   text, brand-locked colors, disclaimer band) still
  //                   apply — it's the AI that gets more freedom, not the
  //                   pixel layout.
  creative_mode: z
    .enum(["standard", "exploratory"])
    .default("standard"),
  // Phase 3 — generated asset injection. When the operator wants to drop an
  // already-generated asset (CTA, background, mockup, FX overlay, trading UI)
  // into the campaign, they pass its id here. The campaign pipeline resolves
  // each id against `data/generated-assets.generated.json` and uses the asset
  // by role (see src/lib/generators/generatedAssetResolver.ts).
  //
  // Two ways to pass ids:
  //   1. This field (preferred — explicit, validated).
  //   2. The `notes` field, with `use_generated_asset:<id>` lines mixed into
  //      free-form notes. Useful when the operator pastes IDs into a generic
  //      brief description without touching the form's dedicated input.
  generated_asset_ids: z.array(z.string().min(1)).optional(),
  // Diversity controls (added 2026-05). When the operator hits "Generate"
  // with the same brief twice, today's pipeline produces the same visuals
  // because the PRNG is keyed on campaign_id (which depends on brief_id).
  // These two knobs let the operator (or the parallel-runs flow) ask for
  // different visual choices without touching copy.
  //
  //   diversity_seed  Optional integer. When set, the per-campaign visual
  //                   PRNG (template / motif / palette / pattern picks)
  //                   uses `${campaign_id}::${diversity_seed}` instead of
  //                   just `campaign_id`. Same seed = same visuals. New
  //                   seed = new visuals.
  //   max_diversity   When true, the per-concept picks are forced to be
  //                   distinct: 3 different templates, 3 different
  //                   motifs, 3 different background palette starting
  //                   indices. Default behaviour is "preferred but not
  //                   enforced" — a 3-concept campaign can land on the
  //                   same motif twice. With this flag it can't.
  diversity_seed: z.number().int().nonnegative().optional(),
  max_diversity: z.boolean().optional(),
  created_at: z.string(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

// Convenience: the form posts this shape (no brief_id / created_at) and the
// API route fills the rest in.
export const CampaignBriefInputSchema = CampaignBriefSchema.omit({
  brief_id: true,
  created_at: true,
});
export type CampaignBriefInput = z.infer<typeof CampaignBriefInputSchema>;
