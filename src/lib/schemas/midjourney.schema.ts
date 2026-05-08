import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Midjourney — schemas for the manual human-in-the-loop workflow.
//
// The system never calls Midjourney. It generates prompt text, the human runs
// it in Midjourney, then uploads the selected outputs back through the app.
// These schemas describe:
//   - the prompts we emit (MidjourneyPrompt + MidjourneyPromptPack)
//   - the uploaded outputs (MidjourneyUpload, with provenance back to the
//     prompt that produced it)
//
// Element Manifest is still the source of truth. Approved Midjourney uploads
// become regular image elements with `source: "midjourney_manual_upload"`
// and a `midjourney` provenance block; nothing here decides design.
// ─────────────────────────────────────────────────────────────────────────────

export const MidjourneyIntendedUseSchema = z.enum([
  "background",
  "hero_visual",
  "decorative",
  "moodboard",
  "texture",
]);
export type MidjourneyIntendedUse = z.infer<typeof MidjourneyIntendedUseSchema>;

export const MidjourneyContextSchema = z.enum([
  "stocks",
  "etfs",
  "charts",
  "green_data",
  "general_platform",
  "premium_fintech",
]);
export type MidjourneyContext = z.infer<typeof MidjourneyContextSchema>;

export const MidjourneyAspectRatioSchema = z.enum(["16:9", "1:1", "9:16", "4:5"]);
export type MidjourneyAspectRatio = z.infer<typeof MidjourneyAspectRatioSchema>;

// ── Per-prompt reference recommendation ─────────────────────────────────────
// Embedded in each MidjourneyPrompt so the user can see at-a-glance which
// existing project assets to drag into Midjourney. The reference pack file
// (data/midjourney-reference-pack.generated.json) carries the full version
// with classifier reasons + the global avoid list.
export const MidjourneyPromptReferenceSchema = z.object({
  local_path: z.string(),
  public_path: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  filename: z.string(),
  asset_type: z.string(),
  midjourney_role: z.enum(["style_reference", "image_prompt_reference"]),
  why_selected: z.string(),
});
export type MidjourneyPromptReference = z.infer<typeof MidjourneyPromptReferenceSchema>;

// ── Prompt ──────────────────────────────────────────────────────────────────
export const MidjourneyPromptSchema = z.object({
  prompt_id: z.string().min(1),
  campaign_id: z.string().optional(),
  ad_id: z.string().optional(),
  title: z.string().min(1),
  intended_use: MidjourneyIntendedUseSchema,
  context: MidjourneyContextSchema,
  aspect_ratio: MidjourneyAspectRatioSchema,
  // The actual text the user pastes into Midjourney. Already includes the
  // aspect-ratio parameter (e.g. `--ar 16:9`).
  prompt_text: z.string().min(1),
  // Bullet points the user can append manually if they want stricter negatives.
  negative_instructions: z.array(z.string()).default([]),
  // Optional: paths to a style reference image. Empty by default (the user
  // can paste a URL into Midjourney themselves).
  style_reference_note: z.string().optional(),
  image_reference_note: z.string().optional(),
  notes: z.string().optional(),
  // Existing brand assets to use as Midjourney inputs. Selected by the
  // reference-pack builder. Empty when the prompt was generated without a
  // reference pass (legacy compat).
  recommended_references: z.array(MidjourneyPromptReferenceSchema).default([]),
  // Per-prompt restated forbidden list. Mirrors the global Midjourney rules
  // but is per-prompt so the UI can warn at the right place.
  forbidden_outputs: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type MidjourneyPrompt = z.infer<typeof MidjourneyPromptSchema>;

// ── Pack ────────────────────────────────────────────────────────────────────
export const MidjourneyPromptPackSchema = z.object({
  pack_id: z.string().min(1),
  campaign_id: z.string().min(1),
  brand_id: z.string().min(1),
  prompts: z.array(MidjourneyPromptSchema).min(1),
  source: z.literal("system_generated").default("system_generated"),
  created_at: z.string(),
});
export type MidjourneyPromptPack = z.infer<typeof MidjourneyPromptPackSchema>;

// ── Upload ──────────────────────────────────────────────────────────────────
// One Midjourney output uploaded by the human. `prompt_id` is required so we
// can trace any rendered ad back to the prompt that produced its visuals.
export const MidjourneyUploadSchema = z.object({
  upload_id: z.string().min(1),
  prompt_id: z.string().min(1),
  campaign_id: z.string().optional(),
  ad_id: z.string().optional(),
  intended_use: MidjourneyIntendedUseSchema,
  context: MidjourneyContextSchema,
  // Local copy under /public/midjourney-uploads/.
  local_path: z.string().min(1), // relative to repo root, e.g. "public/midjourney-uploads/<id>/file.png"
  public_path: z.string().min(1), // e.g. "/midjourney-uploads/<id>/file.png"
  cloudinary_public_id: z.string().nullable().optional(),
  cloudinary_secure_url: z.string().nullable().optional(),
  filename: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative().optional(),
  approved: z.boolean().default(false),
  notes: z.string().optional(),
  source: z
    .enum(["midjourney_manual_upload", "openai_image"])
    .default("midjourney_manual_upload"),
  created_at: z.string(),
});
export type MidjourneyUpload = z.infer<typeof MidjourneyUploadSchema>;

export const MidjourneyUploadFileSchema = z.object({
  generated_at: z.string(),
  uploads: z.array(MidjourneyUploadSchema),
});
export type MidjourneyUploadFile = z.infer<typeof MidjourneyUploadFileSchema>;

// ── Assignments ──────────────────────────────────────────────────────────────
// Explicit per-format / per-element-role binding from a Midjourney upload to
// a slot on the demo manifest. Without an assignment the demo falls back to
// "first approved upload by intended_use" (legacy behavior). With an
// assignment, the explicit binding wins.
//
//   format = "1200x628" | "1080x1080" | "1080x1920" | null (= all formats)
//   target_element_role = "background" | "hero_visual" | "decorative_1" | "decorative_2"
export const MidjourneyAssignmentTargetRoleSchema = z.enum([
  "background",
  "hero_visual",
  "decorative_1",
  "decorative_2",
]);
export type MidjourneyAssignmentTargetRole = z.infer<
  typeof MidjourneyAssignmentTargetRoleSchema
>;

export const MidjourneyAssignmentFormatSchema = z
  .enum(["1200x628", "1080x1080", "1080x1920"])
  .nullable();
export type MidjourneyAssignmentFormat = z.infer<
  typeof MidjourneyAssignmentFormatSchema
>;

export const MidjourneyAssignmentSchema = z.object({
  assignment_id: z.string().min(1),
  upload_id: z.string().min(1),
  campaign_id: z.string().optional(),
  ad_id: z.string().optional(),
  format: MidjourneyAssignmentFormatSchema,
  target_element_role: MidjourneyAssignmentTargetRoleSchema,
  // Higher wins when multiple assignments compete for the same slot. Default 0.
  priority: z.number().int().default(0),
  active: z.boolean().default(true),
  created_at: z.string(),
});
export type MidjourneyAssignment = z.infer<typeof MidjourneyAssignmentSchema>;

export const MidjourneyAssignmentFileSchema = z.object({
  generated_at: z.string(),
  assignments: z.array(MidjourneyAssignmentSchema),
});
export type MidjourneyAssignmentFile = z.infer<
  typeof MidjourneyAssignmentFileSchema
>;

// ── Reference Pack ──────────────────────────────────────────────────────────
// Denormalized per-prompt reference file written by createReferencePack.ts.
// The prompt pack carries inline `recommended_references`; this file adds:
//   - `style_reference_assets` / `avoid_assets` per prompt for full audit
//   - the global classification (every asset's role + reason)
//   - a `local_copy_path` field per reference so the export script can copy
//     the file into public/midjourney-reference-pack/ for easy drag-and-drop.
export const MidjourneyReferenceClassifiedSchema = z.object({
  local_path: z.string(),
  public_path: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  cloudinary_public_id: z.string().nullable(),
  filename: z.string(),
  asset_type: z.string(),
  canonical_folder_type: z.string(),
  midjourney_role: z.enum([
    "style_reference",
    "image_prompt_reference",
    "avoid_for_midjourney",
  ]),
  reason: z.string(),
});
export type MidjourneyReferenceClassified = z.infer<
  typeof MidjourneyReferenceClassifiedSchema
>;

export const MidjourneyReferencePerPromptSchema = z.object({
  prompt_id: z.string(),
  intended_use: MidjourneyIntendedUseSchema,
  context: MidjourneyContextSchema,
  aspect_ratio: MidjourneyAspectRatioSchema,
  selected_reference_assets: z.array(
    MidjourneyReferenceClassifiedSchema.extend({
      // Filled in by the export script when it copies the file into
      // public/midjourney-reference-pack/. Null when not exported.
      local_copy_path: z.string().nullable().optional(),
      public_copy_path: z.string().nullable().optional(),
      why_selected: z.string(),
    }),
  ),
  style_reference_assets: z.array(MidjourneyReferenceClassifiedSchema),
  avoid_assets: z.array(MidjourneyReferenceClassifiedSchema),
  usage_notes: z.string(),
  manual_steps: z.array(z.string()),
});
export type MidjourneyReferencePerPrompt = z.infer<
  typeof MidjourneyReferencePerPromptSchema
>;

export const MidjourneyReferencePackSchema = z.object({
  pack_id: z.string().min(1),
  campaign_id: z.string().min(1),
  brand_id: z.string().min(1),
  generated_at: z.string(),
  prompts: z.array(MidjourneyReferencePerPromptSchema),
  classifications: z.object({
    style_reference: z.array(MidjourneyReferenceClassifiedSchema),
    image_prompt_reference: z.array(MidjourneyReferenceClassifiedSchema),
    avoid_for_midjourney: z.array(MidjourneyReferenceClassifiedSchema),
  }),
  source: z.literal("system_generated").default("system_generated"),
});
export type MidjourneyReferencePack = z.infer<typeof MidjourneyReferencePackSchema>;
