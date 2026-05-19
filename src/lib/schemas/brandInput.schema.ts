import { z } from "zod";
import { HexColorSchema } from "@/lib/schemas/brandKit.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Brand Input schema — validates `brand-input/brand-spec/brand-spec.json`.
//
// This is the *raw* brand input shape. It mirrors the table the brand owner
// fills out by hand. The conversion step (lib/brandInput/convertBrandInputTo
// BrandKit.ts) maps it onto the more structured BrandKitLite schema.
// ─────────────────────────────────────────────────────────────────────────────

const NotesField = z.string().optional();
const WhatWeNeed = z.string().optional();

const RgbTupleSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

export const GradientSwatchSchema = z.object({
  name: z.string().min(1),
  hex: HexColorSchema,
  rgb: RgbTupleSchema.optional(),
});
export type GradientSwatch = z.infer<typeof GradientSwatchSchema>;

const LogoMaterialSchema = z.object({
  what_we_need: WhatWeNeed,
  colors: z.array(HexColorSchema).default([]),
  notes: NotesField,
});

const FontsSchema = z.object({
  font_family: z.string().min(1),
  notes: NotesField,
});

const FontSizesSchema = z.object({
  headline_px: z.number().positive(),
  cta_px: z.number().positive(),
  running_text_px: z.number().positive(),
  risk_warning_text_px: z.number().positive(),
});

const CtaButtonsSchema = z.object({
  what_we_need: WhatWeNeed,
  background_colors: z.array(HexColorSchema).min(1),
  text_size_px: z.number().positive().optional(),
  // Approved CTA copy. Surfaces in the generated BrandKitLite as
  // `cta.allowed_texts` and is what the demo + planner use to pick CTA strings.
  allowed_texts: z.array(z.string().min(1)).optional(),
  notes: NotesField,
});

const BackgroundGradientSchema = z.object({
  what_we_need: WhatWeNeed,
  sensitivity: z.string().optional(), // e.g. "sensitive", "must-match"
  palette: z.array(GradientSwatchSchema).min(2),
});

const MockupsRequirementsSchema = z.object({
  required_types: z.array(z.string()).default([]),
  notes: NotesField,
});

const ScreenshotsRequirementsSchema = z.object({
  required_topics: z.array(z.string()).default([]),
  notes: NotesField,
});

const DisclaimerSchema = z.object({
  required_texts: z.array(z.string().min(1)).min(1),
  // Topic-specific appendix disclaimers. Optional. When present, the
  // brand-kit converter copies these onto the generated brand-kit's
  // `legal.topic_disclaimers` field, and the planner appends them to the
  // general disclaimer when the campaign copy matches the topic's
  // keywords (see src/lib/ai/disclaimerTopics.ts).
  topic_disclaimers: z
    .object({
      etf_free: z.string().optional(),
      complex_products: z.string().optional(),
      tax_advice: z.string().optional(),
    })
    .optional(),
  notes: NotesField,
});

const SpacingFrameSchema = z.object({
  top_px: z.number().nonnegative(),
  left_px: z.number().nonnegative(),
  bottom_px: z.number().nonnegative(),
  right_px: z.number().nonnegative().optional(),
});

const SpacingSchema = z.object({
  frame: SpacingFrameSchema,
  notes: NotesField,
});

const BrandColoursSchema = z.object({
  colors: z.array(HexColorSchema).min(1),
  notes: NotesField,
});

export const BrandInputMaterialsSchema = z.object({
  logo: LogoMaterialSchema,
  favicon: LogoMaterialSchema,
  powered_by_ib: LogoMaterialSchema,
  fonts: FontsSchema,
  font_sizes: FontSizesSchema,
  cta_buttons: CtaButtonsSchema,
  background_gradient: BackgroundGradientSchema,
  mockups: MockupsRequirementsSchema,
  app_and_platform_screenshots: ScreenshotsRequirementsSchema,
  disclaimer_or_risk_warnings: DisclaimerSchema,
  spacing: SpacingSchema,
  brand_colours: BrandColoursSchema,
});
export type BrandInputMaterials = z.infer<typeof BrandInputMaterialsSchema>;

// Free-form rules — keep open-ended so the brand owner can add new ones
// without breaking validation. Known boolean rules are typed; everything
// else passes through.
// ── Optional design_defaults block ───────────────────────────────────────────
// Brand owners can express opinionated styling defaults that the converter
// should treat as authoritative (overriding the generic fallbacks the
// converter would otherwise pick). All fields are optional so older spec
// files without this block still validate.
export const BrandInputDesignDefaultsSchema = z.object({
  cta: z
    .object({
      border_radius_px: z.number().nonnegative().optional(),
      padding_x_px: z.number().nonnegative().optional(),
      padding_y_px: z.number().nonnegative().optional(),
      min_width_px: z.number().positive().optional(),
      min_height_px: z.number().positive().optional(),
    })
    .optional(),
  typography: z
    .object({
      headline_line_height_ratio: z.number().positive().optional(),
      running_text_line_height_ratio: z.number().positive().optional(),
      cta_line_height_ratio: z.number().positive().optional(),
      risk_warning_line_height_ratio: z.number().positive().optional(),
    })
    .optional(),
  layout: z
    .object({
      allowed_compositions: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});
export type BrandInputDesignDefaults = z.infer<typeof BrandInputDesignDefaultsSchema>;

export const BrandInputRulesSchema = z
  .object({
    do_not_generate_logo_with_ai: z.boolean().optional(),
    do_not_generate_ibkr_logo_with_ai: z.boolean().optional(),
    do_not_put_required_text_inside_generated_images: z.boolean().optional(),
    risk_warning_must_be_real_text_layer: z.boolean().optional(),
    cta_must_be_real_layer: z.boolean().optional(),
    bannerbear_is_renderer_only: z.boolean().optional(),
    element_manifest_is_source_of_truth: z.boolean().optional(),
    future_figma_import_from_element_manifest: z.boolean().optional(),
  })
  .catchall(z.unknown());
export type BrandInputRules = z.infer<typeof BrandInputRulesSchema>;

export const BrandInputSpecSchema = z.object({
  brand_id: z.string().min(1),
  brand_name: z.string().min(1),
  source: z.string().min(1),
  materials: BrandInputMaterialsSchema,
  design_defaults: BrandInputDesignDefaultsSchema.optional(),
  rules: BrandInputRulesSchema,
});
export type BrandInputSpec = z.infer<typeof BrandInputSpecSchema>;
