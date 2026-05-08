import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Bannerbear schemas — Bannerbear is the renderer only.
//
// These shapes describe what we *store* about Bannerbear, not the source of
// truth. The Element Manifest is the source of truth; everything here is for
// tracking, debugging, and template introspection.
//
// Template snapshots come from GET /v2/templates/:uid (cached locally).
// Render records wrap POST /v2/images responses for one ad render.
// ─────────────────────────────────────────────────────────────────────────────

// A single available modification slot exposed by a Bannerbear template.
// Mirrors the shape Bannerbear returns under `available_modifications`.
export const BannerbearAvailableModificationSchema = z.object({
  name: z.string().min(1),
  // Bannerbear surfaces a layer's modifiable fields here. Keep loose so we
  // don't fight upstream changes — validate only when we read specific keys.
  text: z.string().optional(),
  color: z.string().optional(),
  image_url: z.string().optional(),
  // Catch-all for fields we don't model yet (e.g. `disabled`, `font_family`).
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type BannerbearAvailableModification = z.infer<
  typeof BannerbearAvailableModificationSchema
>;

// Snapshot of a Bannerbear template fetched via the sync route.
// We persist this so the manifest builder knows which layers exist without
// hitting Bannerbear on every request.
export const BannerbearTemplateSnapshotSchema = z.object({
  template_uid: z.string().min(1),
  template_name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  available_modifications: z.array(BannerbearAvailableModificationSchema),
  // Defaults Bannerbear ships with the template (background, fonts, etc.)
  // plus any extension fields we discover. Kept open-ended on purpose.
  extended_defaults: z.record(z.string(), z.unknown()).optional(),
  fetched_at: z.string(), // ISO timestamp of the sync.
});
export type BannerbearTemplateSnapshot = z.infer<
  typeof BannerbearTemplateSnapshotSchema
>;

// One modification we send to Bannerbear when rendering. Built from an
// Element in the manifest — never authored by hand.
export const BannerbearModificationSchema = z.object({
  name: z.string().min(1),
  text: z.string().optional(),
  image_url: z.string().url().optional(),
  color: z.string().optional(),
  background_color: z.string().optional(),
});
export type BannerbearModification = z.infer<typeof BannerbearModificationSchema>;

export const BannerbearRenderStatusSchema = z.enum([
  "pending",
  "rendering",
  "completed",
  "failed",
]);
export type BannerbearRenderStatus = z.infer<typeof BannerbearRenderStatusSchema>;

// Record of one Bannerbear render call. Stored for tracking/debugging only.
// `image_url` is the rendered output we attach to the ad — not editable state.
export const BannerbearRenderRecordSchema = z.object({
  render_id: z.string().min(1),
  ad_id: z.string().min(1),
  template_uid: z.string().min(1),
  // Exact payload we sent to Bannerbear. Kept verbatim so we can replay or
  // diff against the manifest when something looks wrong on the rendered PNG.
  modifications_sent: z.array(BannerbearModificationSchema),
  // Raw response from Bannerbear, opaque on purpose.
  render_response: z.record(z.string(), z.unknown()).optional(),
  image_url: z.string().url().nullable(),
  status: BannerbearRenderStatusSchema,
  created_at: z.string(),
});
export type BannerbearRenderRecord = z.infer<typeof BannerbearRenderRecordSchema>;
