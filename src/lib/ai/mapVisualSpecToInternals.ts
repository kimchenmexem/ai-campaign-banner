import type {
  VisualLayoutSpec,
  LayoutType,
  CompositionStrategy,
  FormatOverride,
} from "@/lib/schemas/visualLayoutSpec.schema";
import { FORMAT_KEY_TO_NAME } from "@/lib/schemas/visualLayoutSpec.schema";
import type { CampaignFormat } from "@/lib/schemas/aiCampaignPlan.schema";
// Note: CampaignFormat is also used by deriveRendererHintsForFormat further
// down in this file. Single import here keeps it module-scoped.
import type {
  TemplateKind,
  CompositionKind,
  PatternStyle,
  DesignMotif,
} from "@/lib/preview/createDemoCampaign";

// ─────────────────────────────────────────────────────────────────────────────
// VisualLayoutSpec → existing renderer knobs.
//
// The renderer (createDemoCampaign.ts / buildAdSpecsFromPlan.ts) accepts a
// 6-tuple of design picks per (concept × format) ad:
//
//   { template, composition, patternStyle, motif, bgPaletteIndex, gradientAngle }
//
// Today those values come from a seeded PRNG. After this module ships, they
// come from the AI Visual Planner whenever a VisualLayoutSpec is present;
// the PRNG fallback only kicks in for fields the spec didn't pin down.
//
// Split into two surfaces because two of the picks vary per (concept × format)
// while the rest are concept-level (background fill must stay consistent
// across the 3 formats of one concept):
//
//   resolveConceptLevelPicks  →  template, bgPaletteIndex, gradientAngle
//   resolveFormatLevelPicks   →  composition, patternStyle, motif
//
// Spec values that have no matching builder yet (split_panel, data_focus,
// centered, top_down, bottom_anchor) collapse onto the closest existing
// template/composition. The mapping is documented inline so the deferred
// builder work in Step 6 has an explicit list of "what's currently being
// approximated."
// ─────────────────────────────────────────────────────────────────────────────

export interface ConceptLevelPicks {
  template: TemplateKind;
  bgPaletteIndex: number;
  gradientAngle: number;
  // Step 9 — brand_strategy.background_style. "auto" preserves today's
  // behavior (2-stop gradient using calm-adjacent brand palette indices).
  backgroundStyle: "auto" | "solid" | "gradient" | "deep_gradient" | "split_color";
  // Step 9 — brand_strategy.palette_intensity. "auto" preserves today's
  // adjacent-index pick.
  paletteIntensity: "auto" | "calm" | "standard" | "high_contrast";
}

export interface FormatLevelPicks {
  composition: CompositionKind;
  // undefined = renderer applies its built-in default (currently "diagonal_lines"
  // for pattern_immersive, no pattern for other templates).
  patternStyle: PatternStyle | undefined;
  motif: DesignMotif;
}

// Bundle of PRNG-derived values used as fallback for fields the spec leaves
// unspecified. Today's `buildConceptsFromPlan` already computes this bundle
// per concept; we just thread it through the mapping layer.
export interface VisualPicksFallback {
  template: TemplateKind;
  composition: CompositionKind;
  patternStyle: PatternStyle;
  motif: DesignMotif;
  bgPaletteIndex: number;
  gradientAngle: number;
}

// ── Downgrade observability ─────────────────────────────────────────────────
// When the AI picks a value the renderer can't honor, we silently collapse
// to the closest safe alternative. To make those collapses observable
// (Step 11), every public mapping function accepts an optional `downgrades`
// array and pushes a one-line description of each collapse it performs.
// The campaign planner threads the array up into `plan.warnings[]`.
//
// Format of each downgrade string (intentionally machine-parseable):
//   "<spec.field>=<requested> → <applied> (<reason>)"
// Examples:
//   "layout_type=split_panel → mockup_hero (no builder)"
//   "composition=bottom_anchor → hero_overlay (template=editorial_type)"
//   "visual_position=foreground → auto (readability)"

// ── Concept-level resolution ────────────────────────────────────────────────

export function resolveConceptLevelPicks(args: {
  spec: VisualLayoutSpec | undefined;
  fallback: VisualPicksFallback;
  downgrades?: string[];
}): ConceptLevelPicks {
  const { spec, fallback, downgrades } = args;
  if (!spec) {
    return {
      template: fallback.template,
      bgPaletteIndex: fallback.bgPaletteIndex,
      gradientAngle: fallback.gradientAngle,
      backgroundStyle: "auto",
      paletteIntensity: "auto",
    };
  }
  // Detect layout_type collapses BEFORE mapping so we can record them.
  if (
    downgrades &&
    (spec.layout_type === "split_panel" || spec.layout_type === "data_focus")
  ) {
    const mapped = mapLayoutType(spec.layout_type);
    downgrades.push(`layout_type=${spec.layout_type} → ${mapped} (no builder)`);
  }
  return {
    template: mapLayoutType(spec.layout_type),
    bgPaletteIndex:
      spec.brand_strategy.background_palette_index_hint ?? fallback.bgPaletteIndex,
    gradientAngle:
      spec.brand_strategy.gradient_angle_hint ?? fallback.gradientAngle,
    backgroundStyle: spec.brand_strategy.background_style,
    paletteIntensity: spec.brand_strategy.palette_intensity,
  };
}

// ── Format-level resolution ─────────────────────────────────────────────────

export function resolveFormatLevelPicks(args: {
  spec: VisualLayoutSpec | undefined;
  format: CampaignFormat;
  // Concept-level template (post-mapping) — used to pick a sensible composition
  // when the spec's composition value has no direct equivalent.
  conceptTemplate: TemplateKind;
  fallback: VisualPicksFallback;
  downgrades?: string[];
}): FormatLevelPicks {
  const { spec, format, conceptTemplate, fallback, downgrades } = args;
  if (!spec) {
    return {
      composition: fallback.composition,
      patternStyle: fallback.patternStyle,
      motif: fallback.motif,
    };
  }

  const formatName = FORMAT_KEY_TO_NAME[format];
  const override: FormatOverride | undefined = spec.format_adaptation?.[formatName];

  // Composition: per-format override > top-level > fallback.
  const specComposition = override?.composition ?? spec.composition;
  // Detect composition collapses (centered / top_down / bottom_anchor have
  // no dedicated builder yet — they map onto the closest existing one).
  const composition = mapCompositionStrategy(specComposition, conceptTemplate);
  if (downgrades) {
    if (
      specComposition === "centered" ||
      specComposition === "top_down" ||
      specComposition === "bottom_anchor"
    ) {
      // New-vocabulary collapse (Step 7).
      downgrades.push(
        `composition=${specComposition} → ${composition} (template=${conceptTemplate}, format=${format})`,
      );
    } else if (composition !== specComposition) {
      // Template-compatibility collapse (Step 11 follow-up). Most common:
      // mockup_hero + hero_overlay → text_leading.
      downgrades.push(
        `composition=${specComposition} → ${composition} (template=${conceptTemplate} doesn't support it, format=${format})`,
      );
    }
  }

  // Step 10 — primary_visual is the lead. It overrides conflicting use_*
  // booleans so the spec is internally coherent even when the AI is.
  const primaryVisual = spec.visual_strategy.primary_visual;

  // Motif: precedence order
  //   1. primary_visual="none" / "abstract_gradient" / "mockup" / "screenshot" / "pattern"
  //      → motif suppressed (these leads don't include motif as the lead;
  //      the editorial decorative still rolls in via fallback when AI
  //      explicitly enables use_motif=true)
  //   2. primary_visual="motif" → motif forced ON (override "none" hint)
  //   3. use_motif=false → suppressed
  //   4. motif_hint set → use it
  //   5. fallback (PRNG context-pool pick)
  const FORCED_MOTIF: DesignMotif = "axis_grid";
  let motif: DesignMotif;
  if (
    primaryVisual === "motif"
  ) {
    // Force a motif even when the AI's motif_hint is "none" or unset —
    // this is the lead, it has to render.
    if (spec.visual_strategy.motif_hint && spec.visual_strategy.motif_hint !== "none") {
      motif = spec.visual_strategy.motif_hint;
    } else if (fallback.motif !== "none") {
      motif = fallback.motif;
    } else {
      motif = FORCED_MOTIF;
    }
  } else if (
    primaryVisual === "none" ||
    primaryVisual === "abstract_gradient" ||
    spec.visual_strategy.use_motif === false
  ) {
    motif = "none";
  } else if (spec.visual_strategy.motif_hint) {
    motif = spec.visual_strategy.motif_hint;
  } else {
    motif = fallback.motif;
  }

  // Pattern: precedence order
  //   1. primary_visual="pattern" → pattern forced ON (override missing
  //      pattern_hint with a safe default)
  //   2. primary_visual="none" / "abstract_gradient" / "motif" / "mockup" /
  //      "screenshot" → pattern suppressed (other leads don't pair with
  //      pattern unless AI explicitly enabled use_pattern=true)
  //   3. use_pattern=false → undefined
  //   4. pattern_hint set → use it
  //   5. fallback
  // Pattern element only actually renders on pattern_immersive template
  // (see createDemoCampaign.ts gating) — for other templates this hint
  // is informational. That's a documented Step 5 constraint.
  let patternStyle: PatternStyle | undefined;
  if (primaryVisual === "pattern") {
    if (
      spec.visual_strategy.pattern_hint &&
      spec.visual_strategy.pattern_hint !== "none"
    ) {
      patternStyle = spec.visual_strategy.pattern_hint;
    } else {
      patternStyle = fallback.patternStyle ?? "diagonal_lines";
    }
  } else if (
    primaryVisual === "none" ||
    primaryVisual === "abstract_gradient" ||
    spec.visual_strategy.use_pattern === false
  ) {
    patternStyle = undefined;
  } else if (
    spec.visual_strategy.pattern_hint &&
    spec.visual_strategy.pattern_hint !== "none"
  ) {
    patternStyle = spec.visual_strategy.pattern_hint;
  } else {
    patternStyle = fallback.patternStyle;
  }

  return { composition, patternStyle, motif };
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

// Spec layout_type → renderer TemplateKind.
//   split_panel  → mockup_hero  (closest existing: text-side + visual-side)
//   data_focus   → editorial_type  (closest existing: stat-anchored typography)
// Step 6 will add dedicated builders for these two and remove the collapse.
export function mapLayoutType(t: LayoutType): TemplateKind {
  switch (t) {
    case "mockup_hero":
      return "mockup_hero";
    case "editorial_type":
      return "editorial_type";
    case "pattern_immersive":
      return "pattern_immersive";
    case "photo_immersive":
      return "photo_immersive";
    case "split_panel":
      return "mockup_hero";
    case "data_focus":
      return "editorial_type";
  }
}

// Spec composition → renderer CompositionKind.
//   centered, top_down, bottom_anchor have no dedicated builder yet. They
//   collapse onto the most natural existing composition for the template:
//     centered      → text_leading (mockup_hero) | hero_overlay (others)
//     top_down      → text_leading (mockup_hero) | hero_overlay (others)
//     bottom_anchor → hero_overlay (every template — it's already a bottom-anchored layout)
//
// Then template-compatibility is enforced. The renderer's COMPOSITIONS_BY_TEMPLATE
// rule (in buildAdSpecsFromPlan.ts) says mockup_hero supports only
// text_leading / visual_leading; pattern_immersive / editorial_type /
// photo_immersive support only hero_overlay. When the AI picks an
// incompatible combination (most common: mockup_hero + hero_overlay,
// which would put a busy mockup composite full-canvas with text floating
// on top — visually unreadable) we collapse onto the template's default
// composition. The downgrade is reported via the resolveFormatLevelPicks
// downgrades array.
export function mapCompositionStrategy(
  c: CompositionStrategy,
  template: TemplateKind,
): CompositionKind {
  // 1. Spec value → renderer CompositionKind (with the new-composition collapses).
  let mapped: CompositionKind;
  switch (c) {
    case "text_leading":
      mapped = "text_leading";
      break;
    case "visual_leading":
      mapped = "visual_leading";
      break;
    case "hero_overlay":
      mapped = "hero_overlay";
      break;
    case "centered":
      mapped = template === "mockup_hero" ? "text_leading" : "hero_overlay";
      break;
    case "top_down":
      mapped = template === "mockup_hero" ? "text_leading" : "hero_overlay";
      break;
    case "bottom_anchor":
      mapped = "hero_overlay";
      break;
  }
  // 2. Enforce template compatibility.
  if (template === "mockup_hero" && mapped === "hero_overlay") {
    // mockup_hero + hero_overlay → mockup composite covers the canvas with
    // text on top of the chart screenshot. Unreadable. Fall back to
    // text_leading (text-on-left, mockup-on-right).
    return "text_leading";
  }
  if (
    (template === "pattern_immersive" ||
      template === "editorial_type" ||
      template === "photo_immersive") &&
    mapped !== "hero_overlay"
  ) {
    // These templates have NO side-panel layout — the visual fills the
    // canvas by definition. text_leading / visual_leading on these would
    // produce a layout where layout.visual = full canvas but the layout
    // math thinks it's a side panel. Fall back to hero_overlay.
    return "hero_overlay";
  }
  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: scalar renderer hints derived from the spec.
//
// The mapping above feeds the *enum-shaped* renderer knobs (template,
// composition, motif, pattern). RendererHints feeds the *numeric* knobs
// inside computeLayout / pickLogoHeight / buildElements: headline size,
// outer margins, inter-block gaps, logo size, decorative opacity, CTA
// style, eyebrow color/visibility.
//
// Designed so that DEFAULT_RENDERER_HINTS produces today's exact behavior —
// every multiplier is 1.0, every boolean is false, and ctaStyle="standard"
// matches the existing "kit.cta.button_background_color" path. That keeps
// the rendering pipeline backwards-compatible: when no spec is present
// (e.g., campaigns saved before the visual planner shipped, or partial
// specs), the renderer behaves exactly as it did before.
// ─────────────────────────────────────────────────────────────────────────────

export interface RendererHints {
  // Multiplier applied to the format-capped base headline size before
  // shrink-to-fit. Combined product of headline_scale × emphasis_level
  // contributions. Clamped to a safe range — the floor keeps text readable;
  // the ceiling lets fitFontToBox handle further shrink at render time.
  headlineSizeMultiplier: number;
  // Multiplier applied to outer margins (kit.layout.outer_margins). Clamped
  // so disclaimer-floor and edge-clearance commitments remain intact.
  marginMultiplier: number;
  // Multiplier applied to vertical gaps between text blocks. Applied as a
  // pure post-pass over computeLayout so per-format math stays untouched.
  innerGapMultiplier: number;
  // Multiplier applied to the per-format logo height. Floor protects
  // brand-mark visibility; ceiling avoids logo overpowering the headline.
  logoSizeMultiplier: number;
  // density="minimal" suppresses the eyebrow even when the AI emitted one.
  // Matches the spec's "element count budget" intent.
  suppressEyebrow: boolean;
  // Opacity multiplier on motif + pattern + brand-tint layers. emphasis=quiet
  // dims them; emphasis=bold pushes them louder. Clamped to [0.3, 1.0]
  // because >1.0 has no effect (CSS clamps to 1) and <0.3 makes them invisible.
  decorativeOpacityMultiplier: number;
  // CTA visual treatment.
  //   standard → today's behavior: filled with kit.cta.button_background_color
  //   ghost    → outline only: transparent fill, brand-text-color border + text
  //   accent   → filled with brand accent (e.g. #D81222) — only chosen when
  //              accent_usage permits it (cta_only / strong); otherwise the
  //              hint maps to "standard" so the brand discipline rule
  //              ("at most ONE concept may use accent_usage=strong") flows
  //              through to the CTA color choice.
  ctaStyle: "standard" | "ghost" | "accent";
  // accent_usage="strong" recolors the eyebrow with the brand accent so the
  // accent shows up somewhere even when the CTA stays standard.
  eyebrowUsesAccent: boolean;
  // Step 8 — text_strategy.max_text_density. When "low", the renderer
  // skips the subheadline element entirely and pulls the CTA up to close
  // the gap (eyebrow is already covered by suppressEyebrow). "medium" is
  // today's behavior (subheadline always rendered). "high" doesn't add
  // new layers today (kicker / body aren't rendered yet) but reserves
  // future expansion.
  suppressSubheadline: boolean;

  // ── Step 7 — composition control ─────────────────────────────────────────
  // Each field below is read from the spec verbatim. "auto" means "use the
  // composition's existing default" — preserves today's behavior so any
  // pre-Step-7 campaign (or partial spec) stays pixel-identical.
  //
  // The renderer collapses values it can't safely express on existing
  // builders (e.g. headline_position=top, visual_position=center) onto
  // "auto" — see applyCompositionFromSpec in createDemoCampaign.ts for the
  // collapse table. Those collapses are documented in the Step 7 deliverable.

  // text_strategy.headline_position. Horizontal anchor of the headline +
  // subheadline block on the canvas. "auto" preserves today's per-format
  // x. "top" / "bottom" collapse to "auto" for now (composition already
  // controls vertical orientation).
  headlinePosition: "auto" | "left" | "right" | "center";
  // text_strategy.text_alignment. Paragraph-level alignment of headline +
  // subheadline. RTL languages auto-flip — when the AI says "left" in
  // Hebrew, the renderer outputs "right" so reading order stays coherent.
  textAlignment: "auto" | "left" | "center" | "right";
  // visual_strategy.visual_position. left/right swap the existing visual
  // region with the text block. Step 10: "background" is honored for
  // layouts where it's natural (pattern_immersive / editorial_type already
  // render their lead visual full-canvas) and downgraded to "auto" for
  // mockup_hero (no full-canvas-mockup builder). "center" / "foreground"
  // still collapse to "auto" — visual overlapping text is a readability
  // risk we don't accept automatically.
  visualPosition: "auto" | "left" | "right" | "background";
  // Step 10 — visual_strategy.primary_visual. Drives which layer "leads"
  // the ad. Resolves enum-by-enum to overrides on the use_* booleans:
  //   mockup            → mockup is the lead; motif/pattern can decorate
  //   screenshot        → collapses to mockup (no chrome-free screenshot
  //                       builder yet)
  //   motif             → motif element forced to render (overrides
  //                       "none" motif_hint with a safe default)
  //   pattern           → pattern element forced to render (overrides
  //                       missing pattern_hint with "diagonal_lines")
  //   abstract_gradient → motif + pattern suppressed; pure brand bg
  //   none              → motif + pattern + mockup all suppressed
  //   auto              → no override; today's behavior
  primaryVisual:
    | "auto"
    | "mockup"
    | "screenshot"
    | "motif"
    | "pattern"
    | "abstract_gradient"
    | "none";
  // Step 10 — text_strategy.max_text_density="high" enables kicker
  // rendering when the AI emitted design_elements.kicker AND there's
  // vertical room between subheadline and CTA. buildElements does the
  // final fit check before pushing the element.
  allowKicker: boolean;
  // visual_strategy.visual_weight. Scales the visual region's width as a
  // percentage of the inner content area. "auto" keeps today's ~50% split.
  visualWeight: "auto" | "subtle" | "balanced" | "dominant";
  // cta_strategy.placement. Each non-auto value resolves to a concrete
  // (x, y) anchor inside the safe area. Unsafe placements (e.g. top_right
  // when the IBKR badge already lives there) fall back to the closest safe
  // alternative.
  ctaPlacement:
    | "auto"
    | "below_headline"
    | "below_subheadline"
    | "bottom_left"
    | "bottom_center"
    | "bottom_right"
    | "top_right"
    | "inline_with_headline"
    | "bottom_band";
  // cta_strategy.width. Sets a minimum width on the CTA box.
  // fit_text             = today's behavior (charBudget + 96 px breathing room)
  // fixed                = brand kit minimum (180 px floor) — fit_text still
  //                        wins when the localized text is longer
  // full_text_block      = match the headline's width (used in centered /
  //                        bottom_center compositions for visual symmetry)
  ctaWidth: "auto" | "fit_text" | "fixed" | "full_text_block";
  // spacing.safe_area_priority. When "high", a final clamp pass enforces
  // ≥24 px gaps between every (logo, eyebrow, headline, subheadline, cta,
  // disclaimer) pair. Pushes elements down (clamped against the disclaimer
  // band) rather than letting them collide.
  safeAreaPriority: "normal" | "high";
}

export const DEFAULT_RENDERER_HINTS: RendererHints = {
  headlineSizeMultiplier: 1,
  marginMultiplier: 1,
  innerGapMultiplier: 1,
  logoSizeMultiplier: 1,
  suppressEyebrow: false,
  decorativeOpacityMultiplier: 1,
  ctaStyle: "standard",
  eyebrowUsesAccent: false,
  suppressSubheadline: false,
  headlinePosition: "auto",
  textAlignment: "auto",
  visualPosition: "auto",
  visualWeight: "auto",
  ctaPlacement: "auto",
  ctaWidth: "auto",
  safeAreaPriority: "normal",
  primaryVisual: "auto",
  allowKicker: false,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function deriveRendererHints(
  spec: VisualLayoutSpec | undefined,
  downgrades?: string[],
): RendererHints {
  if (!spec) return DEFAULT_RENDERER_HINTS;

  // headline_scale × emphasis_level. The AI picks scale; emphasis nudges it.
  const SCALE_MAP = { compact: 0.78, standard: 1, large: 1.22, hero: 1.45 };
  const EMPHASIS_HEADLINE_MAP = { quiet: 0.95, balanced: 1, bold: 1.08 };
  const headlineSizeMultiplier = clamp(
    (SCALE_MAP[spec.text_strategy.headline_scale] ?? 1) *
      (EMPHASIS_HEADLINE_MAP[spec.hierarchy.emphasis_level] ?? 1),
    0.6, // floor — fitFontToBox already shrinks long text further
    1.55, // ceiling — anything bigger overflows without helping
  );

  // padding → outer margin multiplier.
  const PADDING_MAP = { tight: 0.8, standard: 1, airy: 1.22 };
  const marginMultiplier = clamp(
    PADDING_MAP[spec.spacing.padding] ?? 1,
    0.7, // floor — protects safe-area / disclaimer clearance
    1.35, // ceiling — beyond this content gets squeezed
  );

  // density → inter-block gap multiplier.
  const DENSITY_GAP_MAP = { minimal: 0.85, balanced: 1, rich: 1.18 };
  const innerGapMultiplier = clamp(
    DENSITY_GAP_MAP[spec.spacing.density] ?? 1,
    0.7,
    1.3,
  );

  // density="minimal" → eyebrow suppressed (matches the "element count
  // budget: headline + CTA + logo + disclaimer" intent in the schema).
  // Step 8 — max_text_density="low" also suppresses eyebrow because that
  // mode reduces the canvas to "headline + CTA only" per the schema doc.
  const suppressEyebrow =
    spec.spacing.density === "minimal" ||
    spec.text_strategy.max_text_density === "low";

  // Step 8 — max_text_density="low" suppresses subheadline. "medium" is
  // today's default (renders). "high" doesn't add anything new yet — the
  // kicker / body fields exist on the schema but aren't yet rendered.
  const suppressSubheadline = spec.text_strategy.max_text_density === "low";

  // logo_prominence multiplier.
  const LOGO_MAP = { small: 0.78, standard: 1, prominent: 1.22 };
  let logoSizeMultiplier = LOGO_MAP[spec.brand_strategy.logo_prominence] ?? 1;
  // Step 10 — logo_prominence × background_style interaction.
  // Solid backgrounds have empty negative space the logo can grow into;
  // deep_gradient and split_color are visually busy and a too-prominent
  // logo competes with the gradient itself. Only adjusts the "prominent"
  // case — small/standard already read at any background.
  if (spec.brand_strategy.logo_prominence === "prominent") {
    if (spec.brand_strategy.background_style === "solid") {
      logoSizeMultiplier *= 1.07; // 1.22 → ~1.30 — fills the empty canvas
    } else if (spec.brand_strategy.background_style === "deep_gradient") {
      logoSizeMultiplier *= 0.9; // 1.22 → ~1.10 — gradient is loud already
    } else if (spec.brand_strategy.background_style === "split_color") {
      logoSizeMultiplier *= 0.94; // 1.22 → ~1.15 — split is a strong element
    }
  }
  logoSizeMultiplier = clamp(
    logoSizeMultiplier,
    0.65, // floor — must stay legible for brand recognition
    1.4, // ceiling raised vs Step 6 to admit solid+prominent
  );

  // emphasis_level × density → decorative opacity. quiet/minimal dims; bold
  // pushes louder. Stays in [0.3, 1.0] so motifs are always visible enough
  // to read and never above the renderer's CSS-clamped ceiling.
  const EMPHASIS_OPACITY_MAP = { quiet: 0.6, balanced: 1, bold: 1.15 };
  const DENSITY_OPACITY_MAP = { minimal: 0.85, balanced: 1, rich: 1 };
  const decorativeOpacityMultiplier = clamp(
    (EMPHASIS_OPACITY_MAP[spec.hierarchy.emphasis_level] ?? 1) *
      (DENSITY_OPACITY_MAP[spec.spacing.density] ?? 1),
    0.3,
    1,
  );

  // CTA style. Brand discipline: "loud" only becomes "accent" when the
  // accent_usage flag explicitly permits it. Otherwise loud falls back to
  // standard — the AI doesn't get to bypass the "at most one strong
  // accent per campaign" rule via cta.weight alone.
  let ctaStyle: RendererHints["ctaStyle"];
  if (spec.cta_strategy.weight === "ghost") {
    ctaStyle = "ghost";
  } else if (
    spec.cta_strategy.weight === "loud" &&
    (spec.brand_strategy.accent_usage === "cta_only" ||
      spec.brand_strategy.accent_usage === "strong")
  ) {
    ctaStyle = "accent";
  } else {
    if (spec.cta_strategy.weight === "loud") {
      downgrades?.push(
        `cta.weight=loud → standard (accent_usage=${spec.brand_strategy.accent_usage} doesn't permit accent fill)`,
      );
    }
    ctaStyle = "standard";
  }

  // accent_usage="strong" → eyebrow recolored to brand accent so the
  // accent appears somewhere when the CTA stays standard. accent_usage=
  // "cta_only" deliberately keeps the eyebrow on the regular text color.
  const eyebrowUsesAccent = spec.brand_strategy.accent_usage === "strong";

  // ── Step 7 — composition fields ──────────────────────────────────────────
  // Spec values that have no safe builder yet collapse onto "auto" so the
  // renderer falls back to the composition's existing default placement.

  // headline_position: only horizontal anchors currently honored. The
  // composition enum already encodes vertical intent (top_down /
  // bottom_anchor / hero_overlay), so "top" and "bottom" collapse here.
  let headlinePosition: RendererHints["headlinePosition"];
  switch (spec.text_strategy.headline_position) {
    case "left":
    case "right":
    case "center":
      headlinePosition = spec.text_strategy.headline_position;
      break;
    case "top":
    case "bottom":
      downgrades?.push(
        `headline_position=${spec.text_strategy.headline_position} → auto (vertical anchor handled by composition)`,
      );
      headlinePosition = "auto";
      break;
    default:
      headlinePosition = "auto";
  }

  const textAlignment: RendererHints["textAlignment"] =
    spec.text_strategy.text_alignment;

  // visual_position: left/right swap for side-panel layouts. Step 10:
  // "background" passes through — applyCompositionFromSpec honors it on
  // pattern_immersive / editorial_type (already full-canvas) and
  // downgrades on mockup_hero (no full-canvas-mockup builder yet).
  // "center" / "foreground" still collapse to "auto" — visuals overlapping
  // text is a readability risk we don't take automatically.
  let visualPosition: RendererHints["visualPosition"];
  switch (spec.visual_strategy.visual_position) {
    case "left":
    case "right":
    case "background":
      visualPosition = spec.visual_strategy.visual_position;
      break;
    case "center":
    case "foreground":
      downgrades?.push(
        `visual_position=${spec.visual_strategy.visual_position} → auto (no safe builder)`,
      );
      visualPosition = "auto";
      break;
    default:
      visualPosition = "auto";
  }

  const visualWeight: RendererHints["visualWeight"] =
    spec.visual_strategy.visual_weight;

  const ctaPlacement: RendererHints["ctaPlacement"] = spec.cta_strategy.placement;
  const ctaWidth: RendererHints["ctaWidth"] = spec.cta_strategy.width;
  const safeAreaPriority: RendererHints["safeAreaPriority"] =
    spec.spacing.safe_area_priority;

  // Step 10 — primary_visual passes through to the renderer-mapping
  // layer (resolveFormatLevelPicks reads it to force / suppress motif
  // and pattern). Defaults to "auto" — no override on today's enum-
  // driven layer choice. "screenshot" is recorded as a soft collapse
  // because the renderer treats it identically to "mockup" (no chrome-
  // free screenshot builder yet).
  if (spec.visual_strategy.primary_visual === "screenshot") {
    downgrades?.push(
      `primary_visual=screenshot → mockup behavior (no chrome-free screenshot builder)`,
    );
  }
  const primaryVisual: RendererHints["primaryVisual"] =
    spec.visual_strategy.primary_visual;

  // Step 10 — kicker rendering is gated by max_text_density="high".
  // The element only actually appears when the AI also emitted
  // design_elements.kicker AND the renderer's fit-check finds vertical
  // room between subheadline and CTA — see buildElements.
  const allowKicker = spec.text_strategy.max_text_density === "high";

  return {
    headlineSizeMultiplier,
    marginMultiplier,
    innerGapMultiplier,
    logoSizeMultiplier,
    suppressEyebrow,
    decorativeOpacityMultiplier,
    ctaStyle,
    eyebrowUsesAccent,
    suppressSubheadline,
    headlinePosition,
    textAlignment,
    visualPosition,
    visualWeight,
    ctaPlacement,
    ctaWidth,
    safeAreaPriority,
    primaryVisual,
    allowKicker,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 8 — per-format hint derivation.
//
// VisualLayoutSpec.format_adaptation.<format> can override a subset of the
// top-level fields per (concept × format). The override wins; absent fields
// fall through to the base spec; an absent format key collapses to base
// hints (today's behavior).
//
// Implemented as a "patched spec → deriveRendererHints" pipeline so the
// existing clamps + collapses + brand-discipline rules apply uniformly to
// the merged value. This means an unsafe per-format override (e.g.,
// visual_position="center") still falls through the same documented
// collapse table as a top-level value would.
// ─────────────────────────────────────────────────────────────────────────────

export function deriveRendererHintsForFormat(
  spec: VisualLayoutSpec | undefined,
  format: CampaignFormat,
  downgrades?: string[],
): RendererHints {
  if (!spec) return DEFAULT_RENDERER_HINTS;
  const formatName = FORMAT_KEY_TO_NAME[format];
  const override = spec.format_adaptation?.[formatName];
  if (!override) return deriveRendererHints(spec, downgrades);

  // Clone-and-patch — never mutate the saved spec. Each override field
  // replaces the corresponding nested top-level field; everything else
  // stays. Fields the schema doesn't permit per-format (layout_type,
  // hierarchy.emphasis_level, brand_strategy.*, cta_strategy.weight /
  // width, spacing.padding / safe_area_priority) inherit unchanged.
  const patched: VisualLayoutSpec = {
    ...spec,
    text_strategy: {
      ...spec.text_strategy,
      ...(override.headline_position
        ? { headline_position: override.headline_position }
        : {}),
      ...(override.headline_scale
        ? { headline_scale: override.headline_scale }
        : {}),
      ...(override.text_alignment
        ? { text_alignment: override.text_alignment }
        : {}),
      ...(override.max_text_density
        ? { max_text_density: override.max_text_density }
        : {}),
    },
    visual_strategy: {
      ...spec.visual_strategy,
      ...(override.primary_visual
        ? { primary_visual: override.primary_visual }
        : {}),
      ...(override.visual_position
        ? { visual_position: override.visual_position }
        : {}),
      ...(override.visual_weight
        ? { visual_weight: override.visual_weight }
        : {}),
    },
    cta_strategy: {
      ...spec.cta_strategy,
      ...(override.cta_placement
        ? { placement: override.cta_placement }
        : {}),
    },
    spacing: {
      ...spec.spacing,
      ...(override.density ? { density: override.density } : {}),
    },
  };

  return deriveRendererHints(patched, downgrades);
}
