import { z } from "zod";
import { ElementSchema } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// GeneratedAsset — a reusable creative asset produced by the Asset Generator.
//
// These are NOT full banners; they are *building blocks* (a CTA button, a
// background, a device mockup, an FX overlay, a trading-UI widget) that the
// banner pipeline can drop into a campaign later.
//
// Compatibility contract (the reason for the v2 fields):
//   The banner renderer reads ElementManifest elements with absolute geometry,
//   padding, font sizing, text_align, border_radius, etc. For an asset to be
//   "renderer-compatible", it must either:
//     a) carry an `element_manifest_preview` that the campaign builder can
//        adopt verbatim into a manifest (CTA, decorative shape), OR
//     b) carry `placement_rules` describing how an image-based asset should
//        be placed (background, mockup, FX overlay).
//
// On disk:
//   data/generated-assets.generated.json — flat array, append-only-ish index
//   public/generated-assets/<type>/<asset_id>.<ext> — the actual bytes
// ─────────────────────────────────────────────────────────────────────────────

export const GeneratedAssetTypeSchema = z.enum([
  "background",
  "cta",
  "mockup",
  "trading_ui",
  "fx_overlay",
]);
export type GeneratedAssetType = z.infer<typeof GeneratedAssetTypeSchema>;

export const GeneratedAssetFormatSchema = z.enum(["svg", "png"]);
export type GeneratedAssetFormat = z.infer<typeof GeneratedAssetFormatSchema>;

// How the renderer should consume this asset.
//   - element  → adopt `element_manifest_preview` into the manifest verbatim
//                (CTA buttons in primary mode use this).
//   - svg      → standalone SVG download; not designed to be embedded as a
//                renderable Element, but can still ride an Element's file_url.
//   - image    → bytes go on an Element with file_url (background, mockup,
//                hero-image). Use `placement_rules` for sizing/fit.
//   - composite → bytes are a finished composite (mockup + screenshot, etc.).
export const RenderModeSchema = z.enum(["element", "svg", "image", "composite"]);
export type RenderMode = z.infer<typeof RenderModeSchema>;

// What the asset can stand in for, on the manifest.
export const PlacementRoleSchema = z.enum([
  "background",
  "cta",
  "product_visual",
  "decorative",
  "hero-image",
  "supporting-image",
  "logo",
  "headline",
  "subheadline",
  "legal-disclaimer",
]);
export type PlacementRole = z.infer<typeof PlacementRoleSchema>;

export const PlacementRulesSchema = z.object({
  compatible_roles: z.array(PlacementRoleSchema).default([]),
  recommended_z_index: z.number().int().default(0),
  // True when the asset must sit inside the safe area (logo, CTA, disclaimer).
  // False for backgrounds, mockups, FX overlays that bleed.
  safe_area_required: z.boolean().default(true),
  // True when the asset can extend past the canvas safe-area into bleed.
  bleed_allowed: z.boolean().default(false),
  object_fit: z
    .enum(["cover", "contain", "fill", "none", "scale-down"])
    .optional(),
  // Shorthand string ("center", "left top", etc.) — passed straight through.
  object_position: z.string().optional(),
  min_width: z.number().int().nonnegative().optional(),
  min_height: z.number().int().nonnegative().optional(),
  // Max as a fraction of the banner canvas (0-1). 0.5 = "no wider than half
  // the canvas". Helps the planner refuse to stretch a 480×96 CTA across a
  // 1920px banner.
  max_width_ratio: z.number().min(0).max(1).optional(),
  max_height_ratio: z.number().min(0).max(1).optional(),
  // Suggested padding when the asset is placed inside a parent box.
  padding_hint: z
    .object({
      top: z.number().nonnegative().optional(),
      right: z.number().nonnegative().optional(),
      bottom: z.number().nonnegative().optional(),
      left: z.number().nonnegative().optional(),
    })
    .optional(),
  // Hint to the campaign planner — e.g. CTAs prefer text_leading + bottom_band.
  preferred_compositions: z.array(z.string()).optional(),
});
export type PlacementRules = z.infer<typeof PlacementRulesSchema>;

// Where the bytes the asset is composed from came from. Each generated asset
// records every input it touched so a reviewer can audit provenance.
export const SourceAssetRefSchema = z.object({
  source_type: z.enum(["brand_input", "generated_asset", "upload", "computed"]),
  // Stable id (when known): a brand-input AssetPreviewRecord's
  // original_local_path, or a previously-generated asset id.
  id: z.string().optional(),
  // Filesystem path (project-relative).
  path: z.string().optional(),
  // Public URL under /public.
  public_path: z.string().optional(),
  role: z.enum([
    "background",
    "screenshot",
    "mockup_device",
    "decorative",
    "logo",
    "hero",
    "other",
  ]),
  notes: z.string().optional(),
});
export type SourceAssetRef = z.infer<typeof SourceAssetRefSchema>;

// 16 base fields + the v2 compatibility fields (render_mode, placement_rules,
// source_assets, element_manifest_preview).
export const GeneratedAssetSchema = z.object({
  id: z.string().min(1),
  type: GeneratedAssetTypeSchema,
  variant: z.string().min(1),
  format: GeneratedAssetFormatSchema,
  size: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  // Path on disk under public/, e.g. "generated-assets/backgrounds/<id>.svg".
  file_path: z.string().min(1),
  // Public URL the browser can fetch directly, always starts with "/".
  url: z.string().min(1),
  // The validated input params used to create this asset.
  params: z.record(z.string(), z.unknown()),
  brand_token_refs: z.array(z.string()).default([]),
  generator: z.string().min(1),
  seed: z.number().int().nonnegative(),
  created_at: z.string(),
  preview_thumbnail_path: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  license: z.string().default("internal"),
  // Phase 4 — operator approval flag. New assets default to true (created
  // = ready). Set to false via PATCH /api/generators/asset/<id> to flag an
  // asset as draft / on-hold; the resolver still picks it but warns when an
  // unapproved asset is adopted.
  approved: z.boolean().default(true),
  // ── v2 compatibility fields ──────────────────────────────────────────────
  render_mode: RenderModeSchema.default("image"),
  placement_rules: PlacementRulesSchema.default({
    compatible_roles: [],
    recommended_z_index: 0,
    safe_area_required: true,
    bleed_allowed: false,
  }),
  source_assets: z.array(SourceAssetRefSchema).default([]),
  // When `render_mode === "element"`, this is the canonical Element row the
  // banner builder should adopt. Validated against the same ElementSchema as
  // every Element in a real manifest, so an asset cannot save with a malformed
  // preview. Optional because most assets render as images.
  element_manifest_preview: ElementSchema.optional(),
});
export type GeneratedAsset = z.infer<typeof GeneratedAssetSchema>;

export const GeneratedAssetIndexSchema = z.object({
  generated_at: z.string(),
  assets: z.array(GeneratedAssetSchema),
});
export type GeneratedAssetIndex = z.infer<typeof GeneratedAssetIndexSchema>;

// ── Per-generator param schemas ──────────────────────────────────────────────

const SizeSchema = z.object({
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
});

// Source-mode controls how much the generator leans on existing brand assets.
//   - generated_only           → only the algorithm; no brand-input reads
//   - brand_input_only         → use a brand-input asset verbatim
//   - brand_input_plus_generated → composite generated artwork onto a brand-
//                                  input base
export const SourceModeSchema = z.enum([
  "generated_only",
  "brand_input_only",
  "brand_input_plus_generated",
]);
export type SourceMode = z.infer<typeof SourceModeSchema>;

export const BackgroundParamsSchema = z.object({
  variant: z.enum([
    "linear_gradient",
    "radial_gradient",
    "mesh_gradient",
    "vignette",
    "diagonal_split",
  ]),
  size: SizeSchema,
  source_mode: SourceModeSchema.default("generated_only"),
  // Public URL or relative path to a brand-input/background image. Required
  // when source_mode is brand_input_*.
  brand_input_background_path: z.string().optional(),
  // How to combine the generated layer with the brand-input image:
  //   replace → only the brand-input image, generator skipped
  //   scrim   → generated gradient as a semi-opaque overlay
  //   tint    → generator becomes a single-color tint
  overlay_mode: z.enum(["replace", "scrim", "tint"]).default("scrim"),
  overlay_opacity: z.number().min(0).max(1).optional(),
  colors: z.array(z.string()).max(8).optional(),
  angle_deg: z.number().min(0).max(360).optional(),
  seed: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});
export type BackgroundParams = z.infer<typeof BackgroundParamsSchema>;

export const CtaParamsSchema = z.object({
  variant: z.enum([
    "primary_pill",
    "primary_block",
    "outline",
    "accent_pill",
    "accent_block",
    "bottom_band",
  ]),
  text: z.string().min(1).max(48),
  size: SizeSchema,
  // element  → renderer-compatible cta-button Element (default; embed in banner)
  // svg      → standalone SVG file (download-only)
  output_mode: z.enum(["element", "svg"]).default("element"),
  border_radius: z.number().int().min(0).max(200).optional(),
  background_color: z.string().optional(),
  text_color: z.string().optional(),
  border_color: z.string().optional(),
  border_width: z.number().int().min(0).max(12).optional(),
  font_size: z.number().int().min(8).max(160).optional(),
  font_weight: z.number().int().min(100).max(900).optional(),
  font_family: z.string().optional(),
  // RTL languages reverse the arrow direction; "auto" mirrors what the banner
  // renderer does. The renderer's per-language arrow picker still wins at
  // banner build time; this just controls preview text.
  arrow: z.enum(["none", "auto", "ltr", "rtl"]).default("none"),
  notes: z.string().optional(),
});
export type CtaParams = z.infer<typeof CtaParamsSchema>;

export const MockupParamsSchema = z.object({
  device: z.enum(["phone", "tablet", "laptop", "desktop", "smartwatch"]),
  // Path under public/ (or project-root) to the screenshot.
  screenshot_path: z.string().min(1),
  // Optional explicit mockup picker. When omitted, the generator scans
  // brand-input/mockup devices/ and picks a calibrated mockup whose
  // device_type matches `device`. Pass a public URL or a project-relative
  // filesystem path to override.
  mockup_path: z.string().optional(),
  source_mode: SourceModeSchema.default("brand_input_only"),
  notes: z.string().optional(),
});
export type MockupParams = z.infer<typeof MockupParamsSchema>;

export const TradingUiParamsSchema = z.object({
  variant: z.enum([
    "price_card",
    "candle_chart",
    "portfolio_donut",
    "ticker_strip",
  ]),
  size: SizeSchema,
  ticker: z.string().min(1).max(8).optional(),
  seed: z.number().int().nonnegative().optional(),
  trend: z.enum(["up", "down"]).optional(),
  notes: z.string().optional(),
});
export type TradingUiParams = z.infer<typeof TradingUiParamsSchema>;

export const FxOverlayParamsSchema = z.object({
  variant: z.enum([
    "glow",
    "vignette",
    "corner_swoosh",
    "light_ray",
    "noise_grain",
  ]),
  size: SizeSchema,
  intensity: z.number().min(0).max(1).optional(),
  color: z.string().optional(),
  format: z.enum(["svg", "png"]).optional(),
  seed: z.number().int().nonnegative().optional(),
  source_mode: SourceModeSchema.default("generated_only"),
  // When source_mode is brand_input_*, list paths from brand-input/Elements/
  // to use as base layers. PNG output stacks the FX above each one.
  brand_input_element_paths: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type FxOverlayParams = z.infer<typeof FxOverlayParamsSchema>;

// ── Registry response shape ──────────────────────────────────────────────────
export const GeneratorRegistryEntrySchema = z.object({
  id: z.string(),
  type: GeneratedAssetTypeSchema,
  label: z.string(),
  description: z.string(),
  variants: z.array(z.string()),
  default_size: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  output_format: GeneratedAssetFormatSchema,
  api_path: z.string(),
  // v2 — what the UI/picker should know about each generator.
  source_modes: z.array(SourceModeSchema),
  default_source_mode: SourceModeSchema,
  output_modes: z.array(z.string()),
  default_output_mode: z.string(),
  // Which brand-input folders are surfaced in the picker for this generator.
  brand_input_folders: z.array(
    z.enum([
      "backgrounds",
      "elements",
      "mockups",
      "platform_screenshots",
      "brand_logo",
      "powered_by_ib",
    ]),
  ),
  default_placement_rules: PlacementRulesSchema,
});
export type GeneratorRegistryEntry = z.infer<typeof GeneratorRegistryEntrySchema>;

// ── Brand-input picker response (powered by /api/generators/brand-input-assets)
export const BrandInputAssetSchema = z.object({
  // The original_local_path under brand-input/ (stable id).
  id: z.string(),
  filename: z.string(),
  original_filename: z.string(),
  canonical_folder_type: z.enum([
    "backgrounds",
    "elements",
    "mockups",
    "platform_screenshots",
    "brand_logo",
    "powered_by_ib",
  ]),
  public_path: z.string(),
  cloudinary_secure_url: z.string().optional(),
  // For mockups — calibrated device + slot source (when known).
  device_type: z.string().optional(),
  slot_source: z.string().optional(),
  // For screenshots — inferred context.
  screenshot_context: z.string().optional(),
});
export type BrandInputAsset = z.infer<typeof BrandInputAssetSchema>;
