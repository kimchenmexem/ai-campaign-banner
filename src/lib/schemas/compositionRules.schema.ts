import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Composition rules — JSON-driven post-processing of element positions.
//
// The renderer (createDemoCampaign + buildAdSpecsForConcept) produces an
// Element Manifest with x/y/w/h on every element. For (format, composition)
// combinations that have a rule here, applyCompositionRules() runs as a
// post-pass and re-aligns elements according to industry banner-design rules
// (cluster cohesion, Z-pattern anchors, story platform safe zones, etc.).
//
// File shape (schema 1.1):
//   formats[<size>].safe_area_extra      — extra px outside the brand-kit
//                                          safe area (e.g. story platform UI)
//   formats[<size>].compositions[<name>] — per-composition cluster rules
//
// Designed to be incremental: every field is optional. Pairs with no rule
// are a no-op.
// ─────────────────────────────────────────────────────────────────────────────

export const TextStackAlignmentSchema = z.enum([
  // CTA + subheadline + headline all share the headline's x-left edge.
  "left-of-headline",
  // CTA + subheadline horizontally centered on the headline's mid-x.
  "centered-on-headline",
]);
export type TextStackAlignment = z.infer<typeof TextStackAlignmentSchema>;

export const CtaAnchorSchema = z.enum([
  // No anchor override — keep the renderer's y for the CTA.
  "default",
  // Z-pattern endpoint: bottom-left of safe area (left-leading copy).
  "bottom-left",
  // Z-pattern endpoint: bottom-right of safe area (Z-terminal — best for
  // landscape ads optimised for impulse / conversion).
  "bottom-right",
  // Center-right of canvas — used in wide split-horizontal banners.
  "right-center",
]);
export type CtaAnchor = z.infer<typeof CtaAnchorSchema>;

export const TextStackRuleSchema = z.object({
  alignment: TextStackAlignmentSchema.optional(),
  // Gap between headline bottom and subheadline top, in em units of the
  // headline's font_size. Typical: 0.3-0.5 (tight, hierarchy preserved).
  head_subhead_gap_em: z.number().min(0).max(5).optional(),
  // Gap between subheadline bottom and CTA top, in em units of the
  // subheadline's font_size. 0.5-0.8 → tight, "part of message". 1.5+ → "the
  // action, separated". When cta_anchor != "default" this is ignored.
  cta_gap_above_em: z.number().min(0).max(5).optional(),
  // Z-pattern anchor for the CTA. "default" keeps the renderer's vertical
  // position. "bottom-left" / "bottom-right" / "right-center" snap the CTA
  // to the safe-area edges; alignment still controls x for "bottom-left".
  cta_anchor: CtaAnchorSchema.optional(),
});
export type TextStackRule = z.infer<typeof TextStackRuleSchema>;

export const VisualClusterRuleSchema = z.object({
  // Informational — documents the intended visual coverage for the
  // composition. Does not currently mutate element geometry; reserved for
  // future visual-placement enforcement.
  coverage: z.enum(["full", "right-half", "left-half", "centered"]).optional(),
  min_width_pct: z.number().min(0).max(100).optional(),
});
export type VisualClusterRule = z.infer<typeof VisualClusterRuleSchema>;

export const CompositionRuleSchema = z.object({
  text_stack_cluster: TextStackRuleSchema.optional(),
  visual_cluster: VisualClusterRuleSchema.optional(),
  description: z.string().optional(),
});
export type CompositionRule = z.infer<typeof CompositionRuleSchema>;

export const SafeAreaExtraSchema = z.object({
  top: z.number().min(0).max(500).optional(),
  right: z.number().min(0).max(500).optional(),
  bottom: z.number().min(0).max(500).optional(),
  left: z.number().min(0).max(500).optional(),
});
export type SafeAreaExtra = z.infer<typeof SafeAreaExtraSchema>;

export const FormatRulesSchema = z.object({
  safe_area_extra: SafeAreaExtraSchema.optional(),
  // Fallback rule applied for any composition that doesn't have its own
  // entry under `compositions`. Use this to guarantee at least basic
  // cluster cohesion (column-align + sane gaps) for every (format, *) pair.
  default: CompositionRuleSchema.optional(),
  compositions: z.record(z.string(), CompositionRuleSchema),
});
export type FormatRules = z.infer<typeof FormatRulesSchema>;

export const CompositionRulesFileSchema = z.object({
  schema_version: z.string().min(1),
  formats: z.record(z.string(), FormatRulesSchema),
});
export type CompositionRulesFile = z.infer<typeof CompositionRulesFileSchema>;
