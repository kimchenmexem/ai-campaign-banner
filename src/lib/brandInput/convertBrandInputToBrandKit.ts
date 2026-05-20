import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrandKitLiteSchema,
  type BrandKitLite,
  type LogoVariant,
  type ProvenanceEntry,
} from "@/lib/schemas/brandKit.schema";
import type { BrandInputSpec } from "@/lib/schemas/brandInput.schema";
import {
  itemsByAssetType,
  type BrandInputInventory,
  type BrandInputInventoryItem,
} from "@/lib/brandInput/loadBrandInput";
import type { BannerbearTemplateMap } from "@/lib/bannerbear/templateMapping";

// ─────────────────────────────────────────────────────────────────────────────
// BrandInputSpec + BrandInputInventory  →  BrandKitLite (validated).
//
// Reads:
//   - brand-input/brand-spec/brand-spec.json (the spec)
//   - brand-input/{MEXEM logo,IBKR logo,...}/* (the inventory)
// Produces a fully-validated BrandKitLite ready to be written to
//   data/brand-kit-lite.generated.json
//
// Rules driving the conversion (from the brand owner's spec table):
//   - MEXEM logo folder    → primary brand logos
//   - IBKR logo folder     → "Powered by IB" / IBKR assets
//   - background folder    → approved or candidate background assets
//   - Platform screenshot  → product/platform screenshots
//   - mockup devices       → product/device mockups
//   - Elements             → decorative / supporting visuals
//   - brand-spec/brand-spec.json → source brand rules
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionOptions {
  // When true, log file:// URLs for local logo assets so the generated kit
  // is self-describing without an upload step. Default: true.
  useLocalFileUrls?: boolean;
  // Optional Bannerbear template map (parsed). Used to populate
  // `layout.allowed_templates` when env vars aren't set.
  templateMap?: BannerbearTemplateMap | null;
  // Process env vars. Defaults to process.env. Pass an explicit object to
  // make the conversion deterministic in tests.
  env?: Record<string, string | undefined>;
}

export interface ConversionResult {
  kit: BrandKitLite;
  provenance: ProvenanceEntry[];
  ibkr_ai_policy: {
    blocked: boolean;
    source: "explicit" | "inherited" | "default_false";
  };
  design_defaults_source: "brand_spec" | "mvp_default" | "partial";
}

const TEMPLATE_PLACEHOLDER_PREFIX = "REPLACE_WITH";

// MEXEM banner specification — per-format element measurements sourced from
// the brand owner's spec document. The renderer's computeLayout reads these
// via the per-format brand-kit fields:
//   logo.size_per_format[F]                       width / height
//   layout.element_sizes_per_format[F].text       text column box
//   layout.element_sizes_per_format[F].cta        CTA box / layout zone
//   layout.element_sizes_per_format[F].risk_message  risk-band box
//   layout.element_sizes_per_format[F].product_visual product/visual box
//   layout.section_gaps_per_format[F]             logo→text, text→cta gaps
//   layout.logo_position_per_format[F]            top-left / top-center
//   layout.visual_anchor_per_format[F]            right / bottom-band
//   layout.outer_margins[F].top                   per-spec top inset
//   layout.composition_variants_per_format[F][V]  data-only alt variants
// Formats outside this table fall through to the converter's frame-based
// inset and the historic literal gaps in computeLayout.
//
// Note on 1200x1200 CTA box 717×437 — per the spec this is the LAYOUT ZONE
// available for the CTA, not the visible button height. The renderer's CTA
// keeps the brand-kit min_height; the width caps at this zone's width.
//
// Note on 1200x1200 Variant B — captured here as data-only (under
// composition_variants_per_format). The renderer does NOT pick it today;
// the active 1200x1200 layout is Variant A. A future variant-selector PR
// will wire B at render time.
type MexemFormatSpec = {
  // Boxes that may be absent for a given format when the spec doesn't label
  // them (e.g., 320x100 risk strip is visible but unlabelled; 728x90 has no
  // visual element; 320x50 CTA is visible but unlabelled). Omitted fields
  // fall through to the renderer's defaults rather than fabricating values.
  logo?: { width: number; height: number };
  text?: { width: number; height: number };
  cta?: { width: number; height: number };
  risk_message?: { width: number; height: number };
  product_visual?: { width: number; height: number };
  top_margin?: number;
  section_gaps?: { logo_to_text?: number; text_to_cta?: number };
  logo_position?: "top-left" | "top-center" | "top-right";
  visual_anchor?: "right" | "bottom-band";
};

const MEXEM_FORMAT_SPECS: Partial<Record<string, MexemFormatSpec>> = {
  "300x250": {
    logo: { width: 153, height: 29 },
    text: { width: 184, height: 100 },
    cta: { width: 125, height: 26 },
    risk_message: { width: 300, height: 25 },
    product_visual: { width: 104, height: 171 },
    top_margin: 34,
    section_gaps: { logo_to_text: 77, text_to_cta: 19 },
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "336x280": {
    logo: { width: 153, height: 30 },
    text: { width: 185, height: 101 },
    cta: { width: 125, height: 26 },
    risk_message: { width: 336, height: 28 },
    product_visual: { width: 136, height: 234 },
    top_margin: 33,
    // section_gaps not given by spec — renderer falls back to literal gaps.
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "1080x1080": {
    logo: { width: 457, height: 100 },
    text: { width: 642, height: 502 },
    cta: { width: 642, height: 85 },
    risk_message: { width: 1080, height: 112 },
    product_visual: { width: 373, height: 811 },
    top_margin: 70,
    section_gaps: { logo_to_text: 70, text_to_cta: 39 },
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "1080x1920": {
    logo: { width: 787.21, height: 171 },
    text: { width: 938, height: 534 },
    cta: { width: 938, height: 87 },
    risk_message: { width: 938, height: 83 },
    product_visual: { width: 1080, height: 568 },
    top_margin: 182,
    section_gaps: { logo_to_text: 107, text_to_cta: 62 },
    logo_position: "top-center",
    visual_anchor: "bottom-band",
  },
  "1200x628": {
    logo: { width: 456, height: 90 },
    text: { width: 711, height: 161 },
    cta: { width: 711, height: 85 },
    risk_message: { width: 1200, height: 66 },
    product_visual: { width: 426, height: 498 },
    top_margin: 54,
    // section_gaps not directly given — spec lists "694 upper-layout
    // spacing" which is the horizontal layout zone, not a vertical gap.
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "1200x1200": {
    logo: { width: 710, height: 142 },
    text: { width: 717, height: 437 },
    cta: { width: 717, height: 437 },
    risk_message: { width: 1200, height: 109 },
    product_visual: { width: 412, height: 931 },
    top_margin: 160,
    section_gaps: { logo_to_text: 88, text_to_cta: 88 },
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "960x1200": {
    logo: { width: 523, height: 98 },
    text: { width: 746, height: 297 },
    cta: { width: 359, height: 86 },
    risk_message: { width: 960, height: 66 },
    product_visual: { width: 960, height: 371 },
    top_margin: 89,
    section_gaps: { logo_to_text: 63, text_to_cta: 63 },
    logo_position: "top-center",
    visual_anchor: "bottom-band",
  },

  // MEXEM Set 2 — IAB / display standard formats. Measurements sourced
  // from MEXEM_Banner_Specifications_Set_2 PDF. Some fields are
  // intentionally omitted where the source either does not label that
  // element or labels it ambiguously; in those cases the renderer falls
  // back to its computed default.
  "320x100": {
    // Wide micro banner. Source labels CTA at 320x12 (the visible bottom
    // strip); the visible START INVESTING button has no separate
    // dimension labelled. Risk strip is visually present but unlabelled
    // → risk_message omitted to avoid duplicate-with-CTA confusion.
    logo: { width: 61, height: 44 },
    text: { width: 151, height: 58 },
    cta: { width: 320, height: 12 },
    product_visual: { width: 67, height: 88 },
    top_margin: 8,
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "320x50": {
    // Ultra-wide micro banner. CTA is visible but not labelled — omitted.
    // No separate visual element labelled — product_visual omitted.
    logo: { width: 65, height: 13 },
    text: { width: 173, height: 26 },
    risk_message: { width: 320, height: 9 },
    top_margin: 15,
    logo_position: "top-left",
  },
  "300x1050": {
    logo: { width: 235, height: 167 },
    text: { width: 277, height: 207 },
    cta: { width: 277, height: 34 },
    risk_message: { width: 300, height: 42 },
    product_visual: { width: 300, height: 433 },
    top_margin: 48,
    section_gaps: { logo_to_text: 44, text_to_cta: 44 },
    logo_position: "top-center",
    visual_anchor: "bottom-band",
  },
  "300x600": {
    logo: { width: 105, height: 106 },
    text: { width: 277, height: 106 },
    cta: { width: 277, height: 26 },
    risk_message: { width: 300, height: 39 },
    product_visual: { width: 277, height: 216 },
    top_margin: 22,
    section_gaps: { logo_to_text: 39, text_to_cta: 22 },
    logo_position: "top-center",
    visual_anchor: "bottom-band",
  },
  "160x600": {
    logo: { width: 101, height: 73 },
    text: { width: 145, height: 90 },
    cta: { width: 145, height: 26 },
    risk_message: { width: 160, height: 34 },
    product_visual: { width: 160, height: 248 },
    top_margin: 34,
    section_gaps: { logo_to_text: 31, text_to_cta: 31 },
    logo_position: "top-center",
    visual_anchor: "bottom-band",
  },
  "970x250": {
    // Large horizontal. CTA visible but not labelled — omitted. Source
    // right-side label says "TEXT used space" but the visual role is the
    // element/phone block (per PDF Section 4 Note 4) — assigned to
    // product_visual rather than text.
    logo: { width: 217, height: 158 },
    text: { width: 425, height: 128 },
    risk_message: { width: 970, height: 26 },
    product_visual: { width: 425, height: 128 },
    top_margin: 33,
    section_gaps: { text_to_cta: 22 },
    logo_position: "top-left",
    visual_anchor: "right",
  },
  "728x90": {
    // Standard leaderboard. Source labels the text block as "LOGO used
    // space"; PDF Section 4 Note 5 corrects to text role. No separate
    // visual element labelled — product_visual omitted.
    logo: { width: 200, height: 38 },
    text: { width: 344, height: 49 },
    cta: { width: 124, height: 26 },
    risk_message: { width: 728, height: 13 },
    top_margin: 17,
    section_gaps: { text_to_cta: 11 },
    logo_position: "top-left",
  },
  "250x250": {
    // Square compact. Source labels element as 149x29 — same shape as the
    // logo box; transcribed verbatim per PDF Section 4 Note 8. No top
    // callout in the spec — top_margin omitted; renderer defaults apply.
    logo: { width: 149, height: 29 },
    text: { width: 153, height: 90 },
    cta: { width: 124, height: 26 },
    risk_message: { width: 250, height: 21 },
    product_visual: { width: 149, height: 29 },
    section_gaps: { logo_to_text: 20, text_to_cta: 22 },
    logo_position: "top-left",
    visual_anchor: "right",
  },
};

// 1200x1200 Variant B — captured as data-only for the variant-selector PR.
const MEXEM_1200X1200_VARIANT_B = {
  logo_position: "top-center" as const,
  logo: { width: 688.37, height: 140.57 },
  text: { width: 850, height: 275 },
  cta: { width: 358, height: 85 },
  risk_message: { width: 1200, height: 102 },
  product_visual: { width: 1200, height: 348 },
  section_gaps: { logo_to_text: 64, text_to_cta: 53 },
};

// Apply MEXEM spec top insets to the per-format outer_margins. Right /
// bottom / left keep the converter's default frame inset where the spec
// doesn't dictate a per-element value. Formats whose spec omits
// top_margin (e.g., 250x250) keep the default top inset.
function applyMexemTopMargins(
  margins: Record<string, { top: number; right: number; bottom: number; left: number }>,
): Record<string, { top: number; right: number; bottom: number; left: number }> {
  const out = { ...margins };
  for (const [fmt, spec] of Object.entries(MEXEM_FORMAT_SPECS)) {
    if (spec === undefined) continue;
    if (spec.top_margin === undefined) continue;
    const prior = out[fmt];
    if (prior === undefined) continue;
    out[fmt] = { ...prior, top: spec.top_margin };
  }
  return out;
}

/**
 * Convert raw brand input into a validated BrandKitLite plus provenance.
 * Throws ZodError if the resulting kit fails the BrandKitLiteSchema.
 *
 * Use `convertBrandInputToBrandKit(...)` for a kit-only return; use
 * `convertBrandInputToBrandKitWithProvenance(...)` when you need the
 * IBKR/policy/defaults metadata for a summary or audit log.
 */
export function convertBrandInputToBrandKit(
  spec: BrandInputSpec,
  inventory: BrandInputInventory,
  opts: ConversionOptions = {},
): BrandKitLite {
  return convertBrandInputToBrandKitWithProvenance(spec, inventory, opts).kit;
}

export function convertBrandInputToBrandKitWithProvenance(
  spec: BrandInputSpec,
  inventory: BrandInputInventory,
  opts: ConversionOptions = {},
): ConversionResult {
  const useLocalFileUrls = opts.useLocalFileUrls ?? true;
  const env = opts.env ?? process.env;
  const templateMap = opts.templateMap ?? null;

  // Provenance accumulator. Every defaulted-or-sourced field gets one entry.
  const provenance: ProvenanceEntry[] = [];
  const recordSpec = (path: string) =>
    provenance.push({ path, source: "brand_spec", needs_review: false });
  const recordDefault = (path: string, reason?: string) =>
    provenance.push({
      path,
      source: "mvp_default",
      needs_review: true,
      ...(reason ? { fallback_reason: reason } : {}),
    });

  /**
   * Pick a value: prefer the brand-spec value when defined, otherwise fall
   * back to the MVP default and mark it as needing review.
   */
  function pick<T>(specValue: T | undefined, mvpDefault: T, path: string): T {
    if (specValue !== undefined && specValue !== null) {
      recordSpec(path);
      return specValue;
    }
    recordDefault(path, "Not set in brand-spec.json design_defaults");
    return mvpDefault;
  }

  // Brand-owner-authored design defaults (optional). Anything declared here
  // overrides the converter's generic fallbacks.
  const dd = spec.design_defaults ?? {};
  const ddCta = dd.cta ?? {};
  const ddTypo = dd.typography ?? {};
  const ddLayout = dd.layout ?? {};

  const logoVariants = buildLogoVariants(inventory, useLocalFileUrls);
  const faviconVariant = pickFavicon(inventory, useLocalFileUrls);

  const gradientPalette = spec.materials.background_gradient.palette;
  const gradientStops = gradientPalette.map((swatch, i) => ({
    color: swatch.hex,
    position: gradientPalette.length === 1 ? 0 : i / (gradientPalette.length - 1),
  }));
  const gradientColors = gradientPalette.map((s) => s.hex);

  const brandColors = spec.materials.brand_colours.colors;
  const ctaBgColors = spec.materials.cta_buttons.background_colors;
  const ctaBackground = ctaBgColors[0]!;
  const ctaTextColor = ctaBgColors.find((c) => c.toLowerCase() === "#ffffff") ?? "#FFFFFF";

  const headlinePx = spec.materials.font_sizes.headline_px;
  const ctaPx = spec.materials.font_sizes.cta_px;
  const bodyPx = spec.materials.font_sizes.running_text_px;
  const disclaimerPx = spec.materials.font_sizes.risk_warning_text_px;

  const fontFamily = spec.materials.fonts.font_family;
  const families = {
    headline: fontFamily,
    body: fontFamily,
    cta: fontFamily,
    disclaimer: fontFamily,
  };

  const sizesPerRole = {
    headline: headlinePx,
    subheadline: Math.round(headlinePx * 0.55),
    body: bodyPx,
    cta: ctaPx,
    disclaimer: disclaimerPx,
  };
  // Same role sizes for every format. The renderer's fitFontToBox shrinks
  // headlines / sub / disclaimer to fit each canvas at render time, so a
  // single seed table is fine; per-format overrides can be hand-tuned in
  // brand-kit-lite.generated.json when we want a tighter fit.
  const sizes_per_format = {
    "1200x628": sizesPerRole,
    "1080x1080": sizesPerRole,
    "1080x1920": sizesPerRole,
    "1080x1350": sizesPerRole,
    "1200x675": sizesPerRole,
    "1200x1200": sizesPerRole,
    "1500x500": sizesPerRole,
    "1920x1080": sizesPerRole,
    "300x250": sizesPerRole,
    "336x280": sizesPerRole,
    "960x1200": sizesPerRole,
    "320x100": sizesPerRole,
    "320x50": sizesPerRole,
    "300x1050": sizesPerRole,
    "300x600": sizesPerRole,
    "160x600": sizesPerRole,
    "970x250": sizesPerRole,
    "728x90": sizesPerRole,
    "250x250": sizesPerRole,
  };

  const frame = spec.materials.spacing.frame;
  const inset = {
    top: frame.top_px,
    right: frame.right_px ?? frame.left_px,
    bottom: frame.bottom_px,
    left: frame.left_px,
  };
  const outer_margins = {
    "1200x628": inset,
    "1080x1080": inset,
    "1080x1920": inset,
    "1080x1350": inset,
    "1200x675": inset,
    "1200x1200": inset,
    "1500x500": inset,
    "1920x1080": inset,
    "300x250": inset,
    "336x280": inset,
    "960x1200": inset,
    "320x100": inset,
    "320x50": inset,
    "300x1050": inset,
    "300x600": inset,
    "160x600": inset,
    "970x250": inset,
    "728x90": inset,
    "250x250": inset,
  };

  const disclaimerText = spec.materials.disclaimer_or_risk_warnings.required_texts.join(
    " ",
  );
  // Topic-specific disclaimer appendices. Optional on the source spec —
  // when absent the brand kit's `topic_disclaimers` field stays undefined
  // and the planner falls back to the general disclaimer only.
  const topicDisclaimers =
    spec.materials.disclaimer_or_risk_warnings.topic_disclaimers;

  // System policies — pulled from spec.rules. Keep human-readable so QA and
  // the AI planner can surface them verbatim.
  const policies = derivePolicies(spec);

  // Asset-type rules. Driven by the spec's `rules` flags plus the brand's
  // taxonomy in materials.
  const approved_asset_types: BrandKitLite["approved_asset_types"] = {
    logo: {
      allowed: true,
      requires_legal_review: false,
      forbidden:
        spec.rules.do_not_generate_logo_with_ai === true
          ? ["AI-generated logos", "modified logo proportions"]
          : [],
      notes: "Brand logo (MEXEM). Use only files from brand-input/MEXEM logo/.",
    },
    favicon: {
      allowed: true,
      requires_legal_review: false,
      forbidden: [],
    },
    screenshot: {
      allowed: true,
      requires_legal_review: true,
      notes: `Required topics: ${spec.materials.app_and_platform_screenshots.required_topics.join(
        ", ",
      )}.`,
      forbidden: ["personally identifiable information", "staging data"],
    },
    mockup: {
      allowed: true,
      requires_legal_review: false,
      notes: `Required device types: ${spec.materials.mockups.required_types.join(", ")}.`,
      forbidden: ["competitor devices"],
    },
    background: {
      allowed: true,
      requires_legal_review: false,
      notes: "Use approved gradient palette. Avoid AI-generated text or logos.",
      forbidden: ["text in image", "logos in image"],
    },
    midjourney_background: {
      allowed: true,
      requires_legal_review: true,
      notes:
        "Manual workflow. Output must contain no text and no logos. Human reviews every output before upload.",
      forbidden:
        spec.rules.do_not_put_required_text_inside_generated_images === true
          ? ["any text overlay", "any logo", "realistic faces of named people"]
          : [],
    },
    decorative: {
      allowed: true,
      requires_legal_review: false,
      forbidden: [],
    },
    generated_visual: {
      allowed: true,
      requires_legal_review: true,
      notes:
        "AI-generated visuals are allowed only as decorative backgrounds. Required text and logos must remain real layers.",
      forbidden:
        spec.rules.do_not_generate_logo_with_ai === true
          ? ["replacing logo with generated art", "embedding required text in image"]
          : [],
    },
  };

  const draft: BrandKitLite = {
    brand_id: spec.brand_id,
    brand_name: spec.brand_name,
    brand_description: `Brand kit generated from ${spec.source}. Source of truth: brand-input/brand-spec/brand-spec.json.`,
    schema_version: "1.0.0",

    logo: {
      variants: logoVariants,
      favicon: faviconVariant,
      allowed_positions: ["top-left", "top-right", "bottom-left", "bottom-right"],
      minimum_size: { width_px: 96, percent_of_canvas_width: 0.08 },
      safe_area: { padding_px: 24, padding_percent_of_logo_height: 0.5 },
      // Per-format logo box dimensions sourced from the MEXEM spec.
      // Cast: schema field is z.record(FormatKey, X.optional()).optional()
      // which Zod infers as a strict Record requiring every format key. The
      // runtime accepts partial records — this PR populates only the formats
      // the spec covers, filtered by per-field presence.
      size_per_format: Object.fromEntries(
        Object.entries(MEXEM_FORMAT_SPECS)
          .filter(([, s]) => s?.logo !== undefined)
          .map(([fmt, s]) => [fmt, s!.logo!]),
      ) as NonNullable<BrandKitLite["logo"]["size_per_format"]>,
    },

    colors: {
      primary: brandColors,
      secondary: spec.materials.logo.colors.filter((c) => !brandColors.includes(c)),
      accent: spec.materials.powered_by_ib.colors,
      background: gradientColors,
      text: brandColors,
      disclaimer: ["#FFFFFF"],
      allowed_gradients: [
        {
          name: "brand-gradient",
          angle_deg: 135,
          stops: gradientStops,
        },
      ],
      forbidden: [],
    },

    typography: {
      families,
      weights: [400, 500, 600, 700],
      sizes_per_format,
      line_heights: {
        headline: pick(ddTypo.headline_line_height_ratio, 1.1, "typography.line_heights.headline"),
        body: pick(ddTypo.running_text_line_height_ratio, 1.4, "typography.line_heights.body"),
        cta: pick(ddTypo.cta_line_height_ratio, 1.0, "typography.line_heights.cta"),
        disclaimer: pick(
          ddTypo.risk_warning_line_height_ratio,
          1.3,
          "typography.line_heights.disclaimer",
        ),
      },
      letter_spacing: { headline: -0.5, body: 0, cta: 0, disclaimer: 0 },
      headline_rules: { max_chars: 80, max_lines: 2, allow_uppercase: true, allow_emoji: false },
      body_rules: { max_chars: 200, max_lines: 4, allow_emoji: false },
      cta_text_rules: { max_chars: 24, max_lines: 1 },
      disclaimer_text_rules: { max_chars: 240, max_lines: 4, allow_emoji: false },
    },

    cta: {
      allowed_texts: spec.materials.cta_buttons.allowed_texts ?? [],
      button_background_color: ctaBackground,
      button_text_color: ctaTextColor,
      border_radius: pick(ddCta.border_radius_px, 12, "cta.border_radius"),
      padding: {
        top: pick(ddCta.padding_y_px, 16, "cta.padding.top"),
        right: pick(ddCta.padding_x_px, 24, "cta.padding.right"),
        bottom: pick(ddCta.padding_y_px, 16, "cta.padding.bottom"),
        left: pick(ddCta.padding_x_px, 24, "cta.padding.left"),
      },
      minimum_size: {
        width: pick(ddCta.min_width_px, 240, "cta.minimum_size.width"),
        height: pick(ddCta.min_height_px, 64, "cta.minimum_size.height"),
      },
      // CTA variant pool — empty by default. Operators may add approved
      // looks here (e.g. white_pill, ghost, yellow_block) and the renderer
      // will pick from them per-concept. Empty list preserves today's
      // single-look behaviour using the button_* fields above.
      variants: [],
    },

    layout: {
      spacing: { unit_px: 4, scale: [0, 4, 8, 16, 24, 32, 48, 64, 96, 180] },
      // Override top inset per MEXEM spec for the listed formats; right /
      // bottom / left fall back to the global brand-spec frame inset.
      outer_margins: applyMexemTopMargins(outer_margins),
      allowed_templates: resolveAllowedTemplates(env, templateMap, provenance),
      allowed_compositions: pick(
        ddLayout.allowed_compositions,
        [
          "hero_left_mockup_right",
          "headline_top_mockup_bottom",
          "centered_mockup_with_headline",
          "split_text_visual",
        ],
        "layout.allowed_compositions",
      ),
      safe_areas: applyMexemTopMargins(outer_margins),
      // Per-format MEXEM data — see MEXEM_FORMAT_SPECS at top of file.
      // Casts on the partial records use the inferred schema field types;
      // see comment on `size_per_format` above for the why. Each element-
      // size sub-field is wrapped in conditional spread so an undefined
      // value (e.g., 320x100 risk_message, 728x90 product_visual) does
      // not pollute the brand-kit with a `{ risk_message: undefined }`
      // pair — the renderer falls back to its default for missing fields.
      element_sizes_per_format: Object.fromEntries(
        Object.entries(MEXEM_FORMAT_SPECS)
          .filter(([, s]) => s !== undefined)
          .map(([fmt, s]) => [
            fmt,
            {
              ...(s!.text ? { text: s!.text } : {}),
              ...(s!.cta ? { cta: s!.cta } : {}),
              ...(s!.risk_message ? { risk_message: s!.risk_message } : {}),
              ...(s!.product_visual ? { product_visual: s!.product_visual } : {}),
            },
          ]),
      ) as NonNullable<BrandKitLite["layout"]["element_sizes_per_format"]>,
      section_gaps_per_format: Object.fromEntries(
        Object.entries(MEXEM_FORMAT_SPECS)
          .filter(([, s]) => s?.section_gaps !== undefined)
          .map(([fmt, s]) => [fmt, s!.section_gaps!]),
      ) as NonNullable<BrandKitLite["layout"]["section_gaps_per_format"]>,
      logo_position_per_format: Object.fromEntries(
        Object.entries(MEXEM_FORMAT_SPECS)
          .filter(([, s]) => s?.logo_position !== undefined)
          .map(([fmt, s]) => [fmt, s!.logo_position!]),
      ) as NonNullable<BrandKitLite["layout"]["logo_position_per_format"]>,
      visual_anchor_per_format: Object.fromEntries(
        Object.entries(MEXEM_FORMAT_SPECS)
          .filter(([, s]) => s?.visual_anchor !== undefined)
          .map(([fmt, s]) => [fmt, s!.visual_anchor!]),
      ) as NonNullable<BrandKitLite["layout"]["visual_anchor_per_format"]>,
      composition_variants_per_format: {
        "1200x1200": { b: MEXEM_1200X1200_VARIANT_B },
      } as unknown as NonNullable<BrandKitLite["layout"]["composition_variants_per_format"]>,
      disclaimer_placement_rules: {
        allowed_positions: ["bottom-center", "bottom-left"],
        min_distance_from_edge_px: 24,
      },
    },

    visual_language: {
      tone: ["confident", "plainspoken", "trustworthy"],
      allowed_styles: ["photographic", "editorial", "minimalist"],
      forbidden_styles: ["3d-render", "collage"],
      background_rules: {
        allow_solid_color: true,
        allow_gradient: true,
        allow_image: true,
        allow_pattern: false,
        forbidden: ["AI-generated text in image", "AI-generated logos in image"],
      },
      decorative_element_rules: {
        allowed: true,
        notes: "Decorative shapes must not overlap legal copy.",
        forbidden: ["confetti", "sparkles"],
      },
      mockup_rules: {
        allowed: true,
        notes: `Approved device families: ${spec.materials.mockups.required_types.join(", ")}.`,
        forbidden: ["competitor devices"],
      },
      screenshot_rules: {
        allowed: true,
        notes: "Real product UI only. Crop to one feature at a time.",
        forbidden: ["staging data", "personally identifiable information"],
      },
    },

    legal: {
      risk_warning_required: true,
      default_disclaimer: disclaimerText,
      // Pre-translated disclaimer set for the supported markets. These
      // are sensible starting points modeled on the English source; legal
      // teams can edit `data/brand-kit-lite.generated.json` directly and
      // re-run the planner without touching code. Empty entries get the
      // default_disclaimer (English) at planner time.
      disclaimers_by_language: {
        en: disclaimerText,
        fr: "Attention. Investir comporte un risque de perte. Des frais tiers et les Conditions générales s'appliquent.",
        it: "Attenzione. Investire comporta rischio di perdita. Si applicano commissioni di terzi e Termini e condizioni.",
        nl: "Let op. Beleggen brengt risico's met zich mee. Kosten van derden en Algemene voorwaarden zijn van toepassing.",
        ar: "تنبيه: الاستثمار ينطوي على مخاطر الخسارة. تنطبق رسوم الأطراف الثالثة والشروط والأحكام.",
        he: "אזהרה. השקעה כרוכה בסיכון להפסד. עמלות צד שלישי ותנאי שימוש חלים.",
      },
      // Topic-specific appendices appended to the general disclaimer when
      // the campaign copy mentions a matching topic. See
      // `src/lib/ai/disclaimerTopics.ts` for the keyword rules.
      ...(topicDisclaimers ? { topic_disclaimers: topicDisclaimers } : {}),
      min_disclaimer_font_size: disclaimerPx,
      disclaimer_must_appear_in_all_formats: true,
      legal_claim_rules: [
        "Do not state or imply guaranteed returns.",
        "Any performance claim must include the time period it covers.",
        "All required disclaimers must appear as real text layers, never inside images.",
      ],
    },

    approved_asset_types,
    policies,
    provenance,
  };

  // Compute summary metadata (for the orchestrator script's audit log).
  const ibkrAiPolicy = computeIbkrPolicy(spec, provenance);
  const designDefaultsSource = computeDesignDefaultsSource(spec);

  return {
    kit: BrandKitLiteSchema.parse(draft),
    provenance,
    ibkr_ai_policy: ibkrAiPolicy,
    design_defaults_source: designDefaultsSource,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildLogoVariants(
  inventory: BrandInputInventory,
  useLocalFileUrls: boolean,
): LogoVariant[] {
  const logoFiles = itemsByAssetType(inventory, "brand_logo");
  const variants: LogoVariant[] = [];

  for (const item of logoFiles) {
    if (item.filename.toLowerCase().includes("fav")) continue; // handled by favicon
    const isWhite = /white/i.test(item.filename);
    const variant: LogoVariant = {
      name: deriveVariantName(item.filename),
      url: toAssetUrl(item, useLocalFileUrls),
      format: normalizeFormat(item.extension),
      background: isWhite ? "dark" : "light",
    };
    variants.push(variant);
  }

  // Schema requires at least one variant. Synthesize a placeholder if the
  // brand-input/MEXEM logo folder is empty so downstream code can run.
  if (variants.length === 0) {
    variants.push({
      name: "primary-placeholder",
      url: "https://example.com/logo-pending-upload.svg",
      format: "svg",
      background: "any",
    });
  }
  return variants;
}

function pickFavicon(
  inventory: BrandInputInventory,
  useLocalFileUrls: boolean,
): BrandKitLite["logo"]["favicon"] | undefined {
  const candidates = inventory.items.filter(
    (i) =>
      i.inferred_asset_type === "brand_logo" && /fav/i.test(i.filename),
  );
  const pick = candidates.find((c) => /blue|colour|color/i.test(c.filename)) ?? candidates[0];
  if (!pick) return undefined;
  return {
    url: toAssetUrl(pick, useLocalFileUrls),
    sizes: ["32x32", "180x180"],
  };
}

function deriveVariantName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  return stem.replace(/\s+/g, "-").replace(/_+/g, "-");
}

function normalizeFormat(ext: string): LogoVariant["format"] {
  const e = ext.toLowerCase();
  if (e === "svg" || e === "png" || e === "jpg" || e === "webp") return e;
  if (e === "jpeg") return "jpg";
  return "png";
}

function toAssetUrl(item: BrandInputInventoryItem, useLocalFileUrls: boolean): string {
  if (!useLocalFileUrls) {
    return `https://example.com/pending-upload/${encodeURIComponent(item.filename)}`;
  }
  const abs = path.resolve(process.cwd(), item.file_path);
  return pathToFileURL(abs).href;
}

function derivePolicies(spec: BrandInputSpec): string[] {
  const policies: string[] = [];
  if (spec.rules.do_not_generate_logo_with_ai)
    policies.push("Do not generate the brand logo with AI.");
  if (resolveIbkrAiBlocked(spec))
    policies.push("Do not generate the IBKR / Powered by IB logo with AI.");
  if (spec.rules.do_not_put_required_text_inside_generated_images)
    policies.push("Do not embed required text inside AI-generated images.");
  if (spec.rules.risk_warning_must_be_real_text_layer)
    policies.push("The risk warning must be a real text layer in the manifest.");
  if (spec.rules.cta_must_be_real_layer)
    policies.push("The CTA must be a real layer in the manifest.");
  if (spec.rules.element_manifest_is_source_of_truth)
    policies.push("The Element Manifest is the source of truth for every ad.");
  if (spec.rules.bannerbear_is_renderer_only)
    policies.push("Bannerbear is the renderer only — never the source of truth.");
  if (spec.rules.future_figma_import_from_element_manifest)
    policies.push(
      "Future Figma integration will read the Element Manifest, not the rendered PNG.",
    );
  return Array.from(new Set(policies));
}

/**
 * IBKR-AI policy: explicit flag wins; otherwise inherit from the brand-logo
 * flag; otherwise default to false. The two cases that matter for the audit
 * log are "explicit" (brand owner set the flag) vs "inherited" (we copied
 * from `do_not_generate_logo_with_ai`).
 */
function resolveIbkrAiBlocked(spec: BrandInputSpec): boolean {
  const explicit = spec.rules.do_not_generate_ibkr_logo_with_ai;
  if (explicit !== undefined) return explicit;
  return spec.rules.do_not_generate_logo_with_ai ?? false;
}

function computeIbkrPolicy(
  spec: BrandInputSpec,
  provenance: ProvenanceEntry[],
): { blocked: boolean; source: "explicit" | "inherited" | "default_false" } {
  const blocked = resolveIbkrAiBlocked(spec);
  const explicit = spec.rules.do_not_generate_ibkr_logo_with_ai !== undefined;
  let source: "explicit" | "inherited" | "default_false";
  if (explicit) {
    source = "explicit";
    provenance.push({
      path: "policies.ibkr_logo_no_ai",
      source: "brand_spec",
      needs_review: false,
    });
  } else if (spec.rules.do_not_generate_logo_with_ai !== undefined) {
    source = "inherited";
    provenance.push({
      path: "policies.ibkr_logo_no_ai",
      source: "inherited",
      needs_review: false,
      fallback_reason: "Inherited from rules.do_not_generate_logo_with_ai",
    });
  } else {
    source = "default_false";
    provenance.push({
      path: "policies.ibkr_logo_no_ai",
      source: "mvp_default",
      needs_review: true,
      fallback_reason:
        "Neither do_not_generate_ibkr_logo_with_ai nor do_not_generate_logo_with_ai set in brand-spec.json",
    });
  }
  return { blocked, source };
}

/**
 * Did the design_defaults block actually drive the kit?
 *  - "brand_spec":  every cta/typography/layout default came from the spec
 *  - "mvp_default": none did
 *  - "partial":     some did, some didn't
 */
function computeDesignDefaultsSource(
  spec: BrandInputSpec,
): "brand_spec" | "mvp_default" | "partial" {
  const dd = spec.design_defaults;
  if (!dd) return "mvp_default";
  const cta = dd.cta ?? {};
  const typo = dd.typography ?? {};
  const layout = dd.layout ?? {};
  const fields = [
    cta.border_radius_px,
    cta.padding_x_px,
    cta.padding_y_px,
    cta.min_width_px,
    cta.min_height_px,
    typo.headline_line_height_ratio,
    typo.running_text_line_height_ratio,
    typo.cta_line_height_ratio,
    typo.risk_warning_line_height_ratio,
    layout.allowed_compositions,
  ];
  const set = fields.filter((v) => v !== undefined).length;
  if (set === 0) return "mvp_default";
  if (set === fields.length) return "brand_spec";
  return "partial";
}

/**
 * Resolve the list of allowed Bannerbear template UIDs.
 * Priority: env vars (BANNERBEAR_TEMPLATE_<W>x<H>) → template map entries →
 * empty (recorded as mvp_default + needs_review).
 *
 * Placeholder values starting with "REPLACE_WITH" are skipped at every layer
 * so the kit never ships with sentinel strings.
 */
function resolveAllowedTemplates(
  env: Record<string, string | undefined>,
  templateMap: BannerbearTemplateMap | null,
  provenance: ProvenanceEntry[],
): string[] {
  const out: string[] = [];
  const fromEnvKeys = [
    "BANNERBEAR_TEMPLATE_1200x628",
    "BANNERBEAR_TEMPLATE_1080x1080",
    "BANNERBEAR_TEMPLATE_1080x1920",
  ];
  for (const k of fromEnvKeys) {
    const v = env[k];
    if (v && !v.startsWith(TEMPLATE_PLACEHOLDER_PREFIX)) out.push(v);
  }
  if (out.length > 0) {
    provenance.push({
      path: "layout.allowed_templates",
      source: "env",
      needs_review: false,
    });
    return Array.from(new Set(out));
  }

  if (templateMap) {
    for (const entry of templateMap.entries) {
      if (entry.templateUid && !entry.templateUid.startsWith(TEMPLATE_PLACEHOLDER_PREFIX)) {
        out.push(entry.templateUid);
      }
    }
    if (out.length > 0) {
      provenance.push({
        path: "layout.allowed_templates",
        source: "template_map",
        needs_review: false,
      });
      return Array.from(new Set(out));
    }
  }

  provenance.push({
    path: "layout.allowed_templates",
    source: "mvp_default",
    needs_review: true,
    fallback_reason:
      "No BANNERBEAR_TEMPLATE_* env vars set and template map contains only placeholders",
  });
  return [];
}
