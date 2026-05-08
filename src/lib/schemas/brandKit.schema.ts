import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Brand Kit Lite — the brand's source of truth for the MVP.
//
// Replaces Figma styles/variables with a single JSON document that the AI
// planner, the manifest builder, and the QA layer all read from. Field names
// are snake_case so the file ports cleanly to external systems and to a future
// Figma importer (Figma Variables and Figma styles map onto these sections).
// See docs/ARCHITECTURE.md > "Brand Kit Lite" for the why.
// ─────────────────────────────────────────────────────────────────────────────

export const HexColorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}){1,2}$/, "must be a hex color like #112233");

// Mirrors CampaignFormatSchema in campaignBrief.schema. Adding a value here
// is required so brand-kit-lite.generated.json can carry per-format
// typography / outer_margins / safe_areas entries for the new format.
export const FormatKeySchema = z.enum([
  "1200x628",
  "1080x1080",
  "1080x1920",
  "1080x1350",
  "1200x675",
  "1200x1200",
  "1500x500",
  "1920x1080",
]);
export type FormatKey = z.infer<typeof FormatKeySchema>;

// ── Logo ─────────────────────────────────────────────────────────────────────
export const LogoVariantSchema = z.object({
  name: z.string().min(1), // e.g. "primary", "mono-light", "mono-dark", "stacked"
  url: z.string().url(),
  format: z.enum(["svg", "png", "jpg", "webp"]),
  background: z.enum(["light", "dark", "transparent", "any"]).default("any"),
});
export type LogoVariant = z.infer<typeof LogoVariantSchema>;

export const LogoPositionSchema = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
export type LogoPosition = z.infer<typeof LogoPositionSchema>;

export const LogoSchema = z.object({
  variants: z.array(LogoVariantSchema).min(1),
  favicon: z
    .object({
      url: z.string().url(),
      sizes: z.array(z.string()).optional(), // e.g. ["32x32", "180x180"]
    })
    .optional(),
  allowed_positions: z.array(LogoPositionSchema).default([
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]),
  // Smallest allowed render size (whichever is more restrictive applies).
  minimum_size: z
    .object({
      width_px: z.number().positive().optional(),
      percent_of_canvas_width: z.number().min(0).max(1).optional(),
    })
    .optional(),
  // Clearance the logo must keep from canvas edges and other elements.
  safe_area: z
    .object({
      padding_px: z.number().nonnegative().optional(),
      padding_percent_of_logo_height: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type Logo = z.infer<typeof LogoSchema>;

// ── Colors ───────────────────────────────────────────────────────────────────
export const GradientStopSchema = z.object({
  color: HexColorSchema,
  position: z.number().min(0).max(1), // 0 to 1
});

export const AllowedGradientSchema = z.object({
  name: z.string().min(1),
  angle_deg: z.number().optional(),
  stops: z.array(GradientStopSchema).min(2),
});
export type AllowedGradient = z.infer<typeof AllowedGradientSchema>;

export const ColorsSchema = z.object({
  primary: z.array(HexColorSchema).min(1),
  secondary: z.array(HexColorSchema).default([]),
  accent: z.array(HexColorSchema).default([]),
  background: z.array(HexColorSchema).default([]),
  text: z.array(HexColorSchema).default([]),
  disclaimer: z.array(HexColorSchema).default([]),
  allowed_gradients: z.array(AllowedGradientSchema).default([]),
  forbidden: z.array(HexColorSchema).default([]),
});
export type Colors = z.infer<typeof ColorsSchema>;

// ── Typography ───────────────────────────────────────────────────────────────
export const FontFamiliesSchema = z.object({
  headline: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  disclaimer: z.string().min(1),
});

// font_size per format per role.
//   sizes_per_format["1080x1080"].headline → number (px)
const SizeRoleSchema = z.object({
  headline: z.number().positive().optional(),
  subheadline: z.number().positive().optional(),
  body: z.number().positive().optional(),
  cta: z.number().positive().optional(),
  disclaimer: z.number().positive().optional(),
});

const PerRoleNumberSchema = z.object({
  headline: z.number().optional(),
  body: z.number().optional(),
  cta: z.number().optional(),
  disclaimer: z.number().optional(),
});

export const TextRulesSchema = z.object({
  max_chars: z.number().int().positive().optional(),
  max_lines: z.number().int().positive().optional(),
  allow_uppercase: z.boolean().optional(),
  allow_lowercase: z.boolean().optional(),
  allow_emoji: z.boolean().optional(),
  forbidden_characters: z.array(z.string()).optional(),
  forbidden_phrases: z.array(z.string()).optional(),
});
export type TextRules = z.infer<typeof TextRulesSchema>;

export const TypographySchema = z.object({
  families: FontFamiliesSchema,
  weights: z.array(z.number().int().min(100).max(900)).default([400, 700]),
  sizes_per_format: z.record(FormatKeySchema, SizeRoleSchema).optional(),
  line_heights: PerRoleNumberSchema.optional(),
  letter_spacing: PerRoleNumberSchema.optional(),
  headline_rules: TextRulesSchema.default({}),
  body_rules: TextRulesSchema.default({}),
  cta_text_rules: TextRulesSchema.default({}),
  disclaimer_text_rules: TextRulesSchema.default({}),
});
export type Typography = z.infer<typeof TypographySchema>;

// ── CTA ──────────────────────────────────────────────────────────────────────
// A single approved CTA "look". The brand kit declares one DEFAULT (the
// `button_*` / `border_radius` fields) plus an optional list of additional
// `variants` the renderer may pick from per-concept. All variants are on-
// brand by definition; the planner's diversity controls choose between them
// so a 3-concept campaign can ship 3 distinct CTA treatments without any of
// them being "off brand". When `variants` is empty the renderer falls back
// to the single default look (today's behaviour).
export const CtaVariantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  background_color: z.string(), // accepts "transparent" + #hex
  text_color: HexColorSchema,
  border_radius: z.number().nonnegative().default(0),
  border_width: z.number().nonnegative().optional(),
  border_color: HexColorSchema.optional(),
  min_width: z.number().positive().optional(),
  min_height: z.number().positive().optional(),
});
export type CtaVariant = z.infer<typeof CtaVariantSchema>;

export const CtaSchema = z.object({
  allowed_texts: z.array(z.string().min(1)).default([]),
  button_background_color: HexColorSchema,
  button_text_color: HexColorSchema,
  border_radius: z.number().nonnegative().default(0),
  padding: z.object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
  minimum_size: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  // Optional: extra approved CTA looks. Renderer picks one per concept.
  variants: z.array(CtaVariantSchema).default([]),
});
export type Cta = z.infer<typeof CtaSchema>;

// ── Layout ───────────────────────────────────────────────────────────────────
export const SpacingSchema = z.object({
  unit_px: z.number().positive().default(4),
  scale: z.array(z.number().nonnegative()).default([0, 4, 8, 16, 24, 32, 48, 64]),
});

const Inset = z.object({
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
  left: z.number().nonnegative(),
});

export const DisclaimerPlacementSchema = z.enum([
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "top-left",
  "top-center",
  "top-right",
  "custom",
]);
export type DisclaimerPlacement = z.infer<typeof DisclaimerPlacementSchema>;

export const LayoutSchema = z.object({
  spacing: SpacingSchema.optional(),
  outer_margins: z.record(FormatKeySchema, Inset).optional(),
  allowed_templates: z.array(z.string()).default([]), // Bannerbear template UIDs or names
  // Composition vocabulary is brand-specific — accept any string the brand
  // owner declares (e.g. "hero_left_mockup_right", "risk_warning_bottom_bar").
  // The QA layer cross-references these against the manifest's role layout.
  allowed_compositions: z.array(z.string().min(1)).default([]),
  safe_areas: z.record(FormatKeySchema, Inset).optional(),
  disclaimer_placement_rules: z
    .object({
      allowed_positions: z.array(DisclaimerPlacementSchema).default(["bottom-center"]),
      min_distance_from_edge_px: z.number().nonnegative().optional(),
    })
    .default({ allowed_positions: ["bottom-center"] }),
});
export type Layout = z.infer<typeof LayoutSchema>;

// ── Visual language ──────────────────────────────────────────────────────────
export const VisualStyleSchema = z.enum([
  "photographic",
  "illustrated",
  "3d-render",
  "abstract",
  "geometric",
  "editorial",
  "minimalist",
  "collage",
  "duotone",
  "isometric",
]);
export type VisualStyle = z.infer<typeof VisualStyleSchema>;

const UsageRulesSchema = z.object({
  allowed: z.boolean().default(true),
  notes: z.string().optional(),
  forbidden: z.array(z.string()).default([]),
});

export const VisualLanguageSchema = z.object({
  tone: z.array(z.string()).default([]),
  allowed_styles: z.array(VisualStyleSchema).default([]),
  forbidden_styles: z.array(VisualStyleSchema).default([]),
  background_rules: z
    .object({
      allow_solid_color: z.boolean().default(true),
      allow_gradient: z.boolean().default(true),
      allow_image: z.boolean().default(true),
      allow_pattern: z.boolean().default(false),
      forbidden: z.array(z.string()).default([]),
    })
    .optional(),
  decorative_element_rules: UsageRulesSchema.optional(),
  mockup_rules: UsageRulesSchema.optional(),
  screenshot_rules: UsageRulesSchema.optional(),
});
export type VisualLanguage = z.infer<typeof VisualLanguageSchema>;

// ── Legal ────────────────────────────────────────────────────────────────────
// Per-language disclaimer overrides. Keyed by ISO 639-1 language code (the
// same set as the campaign brief's `language` field). Optional — when the
// brief asks for a language with no override, the planner falls back to
// `default_disclaimer` (English) and lets the AI translate as a last resort.
export const LegalDisclaimersByLanguageSchema = z.object({
  en: z.string().optional(),
  fr: z.string().optional(),
  it: z.string().optional(),
  nl: z.string().optional(),
  ar: z.string().optional(),
  he: z.string().optional(),
});
export type LegalDisclaimersByLanguage = z.infer<typeof LegalDisclaimersByLanguageSchema>;

export const LegalSchema = z.object({
  risk_warning_required: z.boolean().default(false),
  default_disclaimer: z.string().default(""),
  // Optional, regulator-vetted disclaimer per language. When present, the
  // planner uses the matching entry verbatim (regulators care about exact
  // wording — AI translation is risky for compliance).
  disclaimers_by_language: LegalDisclaimersByLanguageSchema.optional(),
  min_disclaimer_font_size: z.number().positive().optional(),
  disclaimer_must_appear_in_all_formats: z.boolean().default(true),
  legal_claim_rules: z.array(z.string()).default([]),
});
export type Legal = z.infer<typeof LegalSchema>;

// ── Approved asset types ─────────────────────────────────────────────────────
// Per asset type: is it allowed, and what extra rules apply?
export const AssetTypeKeySchema = z.enum([
  "logo",
  "favicon",
  "screenshot",
  "mockup",
  "background",
  "midjourney_background",
  "decorative",
  "generated_visual",
]);
export type AssetTypeKey = z.infer<typeof AssetTypeKeySchema>;

export const AssetTypeRuleSchema = z.object({
  allowed: z.boolean().default(true),
  notes: z.string().optional(),
  requires_legal_review: z.boolean().default(false),
  forbidden: z.array(z.string()).default([]),
});
export type AssetTypeRule = z.infer<typeof AssetTypeRuleSchema>;

// ── Provenance ───────────────────────────────────────────────────────────────
// One entry per defaulted-or-sourced field on the kit. `path` uses dotted
// JSON-pointer-ish notation (e.g. "cta.border_radius") so a reviewer can
// jump straight to the value in the generated kit.
export const ProvenanceSourceSchema = z.enum([
  "brand_spec", // Value came from brand-input/brand-spec/brand-spec.json.
  "mvp_default", // Converter picked a generic fallback. needs_review = true.
  "env", // Value came from process.env (e.g. BANNERBEAR_TEMPLATE_*).
  "template_map", // Value came from data/bannerbear-template-map.example.json.
  "inherited", // Value was derived from another spec field (e.g. IBKR-AI inherited from logo-AI).
  "brand_input_inventory", // Value came from a file in brand-input/ folders.
]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const ProvenanceEntrySchema = z.object({
  path: z.string().min(1),
  source: ProvenanceSourceSchema,
  needs_review: z.boolean(),
  fallback_reason: z.string().optional(),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

// ── Brand Kit Lite (root) ────────────────────────────────────────────────────
export const BrandKitLiteSchema = z.object({
  brand_id: z.string().min(1),
  brand_name: z.string().min(1),
  brand_description: z.string().default(""),

  logo: LogoSchema,
  colors: ColorsSchema,
  typography: TypographySchema,
  cta: CtaSchema,
  layout: LayoutSchema,
  visual_language: VisualLanguageSchema,
  legal: LegalSchema,

  approved_asset_types: z
    .record(AssetTypeKeySchema, AssetTypeRuleSchema)
    .optional(),

  // System-level brand policies that don't fit any of the typed sections —
  // e.g. "do not generate logo with AI", "Element Manifest is source of truth".
  // Free-form on purpose: brand owners add lines as policies evolve. QA can
  // surface them in reports without trying to parse them.
  policies: z.array(z.string()).optional(),

  // Where each generated value came from. The intake converter walks the
  // BrandInputSpec, picks values, and records one entry per field that was
  // either drawn from the spec or filled with an MVP default. `needs_review`
  // is true whenever the value did NOT come from the brand owner — those
  // entries are the surface a reviewer must approve before a campaign ships.
  provenance: z.array(ProvenanceEntrySchema).optional(),

  schema_version: z.string().default("1.0.0"),
});
export type BrandKitLite = z.infer<typeof BrandKitLiteSchema>;
