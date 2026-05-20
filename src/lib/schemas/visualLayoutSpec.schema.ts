import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// VisualLayoutSpec — the AI creative director's output, one per concept.
//
// Sits between the AI concept/copy planner (provider.ts) and the deterministic
// element-manifest builder (createDemoCampaign.ts / buildAdSpecsFromPlan.ts).
//
// Pipeline:
//
//   Campaign concept + copy  (AI pass 1 + critique)
//        │
//        ▼
//   Visual AI Planner        (AI pass 3 — this schema is its output)
//        │
//        ▼
//   VisualLayoutSpec  ────►  buildConceptsFromPlan reads it instead of PRNG
//        │
//        ▼
//   Element Manifest  (code-built, brand-locked, format-fitted)
//        │
//        ▼
//   Rendered PNG
//
// Hard rules baked into the schema:
//   - Every field is a closed enum or boolean. The renderer can map every
//     value to a concrete code path; nothing is free-text-as-instruction.
//   - `rationale` is the only free-text field, and it's NEVER consumed by
//     the renderer — it exists for human review and for downstream critique.
//   - `format_adaptation` per-format overrides are optional partial diffs
//     against the top-level fields. When omitted the top-level value applies
//     to that format. This keeps the AI's job small (one global plan + small
//     diffs) while still allowing per-format expression.
//   - PRNG remains the fallback when (a) the AI returns nothing for a field,
//     or (b) the field is `null`. The renderer never errors on a partial
//     spec — partial overrides are valid by design.
//
// The Element Manifest stays the source of truth. This spec is an INPUT to
// the manifest builder, not a parallel artifact. The manifest is what gets
// validated, saved, exported, and rendered.
// ─────────────────────────────────────────────────────────────────────────────

// ── Top-level enums ─────────────────────────────────────────────────────────

// Layout family. The first four match the existing TemplateKind in
// createDemoCampaign.ts so the spec maps directly onto today's renderer.
// `split_panel` and `data_focus` are NEW intents the AI can express; the
// renderer maps them to the closest existing template until they get their
// own builders. Mapping is documented in mapVisualSpecToInternals().
export const LayoutTypeSchema = z
  .enum([
    "mockup_hero",
    "editorial_type",
    "pattern_immersive",
    "photo_immersive",
    "split_panel",
    "data_focus",
  ])
  .describe(
    "Visual family of the ad. mockup_hero = device mockup + text. editorial_type = pure typography (stat or accent). pattern_immersive = brand gradient + geometric SVG. photo_immersive = AI/Midjourney photo background. split_panel = two equal vertical halves (text | visual). data_focus = oversized stat with sparse supporting text.",
  );
export type LayoutType = z.infer<typeof LayoutTypeSchema>;

// Composition extends the existing CompositionKind union. `centered`,
// `top_down`, `bottom_anchor` are new intents the renderer maps onto the
// closest existing composition path.
export const CompositionStrategySchema = z
  .enum([
    "text_leading",
    "visual_leading",
    "hero_overlay",
    "centered",
    "top_down",
    "bottom_anchor",
  ])
  .describe(
    "How the canvas is read. text_leading = text-left, visual-right. visual_leading = mirror. hero_overlay = visual fills, text anchored at bottom. centered = stacked, axis-centered. top_down = headline up top, visual below. bottom_anchor = visual top, CTA + headline anchored bottom.",
  );
export type CompositionStrategy = z.infer<typeof CompositionStrategySchema>;

// ── Hierarchy ───────────────────────────────────────────────────────────────

const FocusTargetSchema = z.enum([
  "headline",
  "subheadline",
  "mockup",
  "stat",
  "cta",
  "visual",
]);
export type FocusTarget = z.infer<typeof FocusTargetSchema>;

export const HierarchySchema = z
  .object({
    primary_focus: FocusTargetSchema.describe(
      "What the eye should land on first. The renderer scales / positions this element to dominate the visual hierarchy.",
    ),
    secondary_focus: FocusTargetSchema.describe(
      "Second hop. Should be different from primary_focus.",
    ),
    emphasis_level: z
      .enum(["quiet", "balanced", "bold"])
      .describe(
        "How loud the design is overall. quiet = restrained typography, lots of negative space. balanced = standard editorial weights. bold = oversized headline, saturated accents, tight type stacks.",
      ),
  })
  .describe(
    "Visual hierarchy. The renderer uses this to decide which element gets headline weight, which gets supporting weight, and overall design loudness.",
  );
export type Hierarchy = z.infer<typeof HierarchySchema>;

// ── Text strategy ───────────────────────────────────────────────────────────

export const TextStrategySchema = z
  .object({
    headline_position: z
      .enum(["left", "right", "center", "top", "bottom"])
      .describe(
        "Where the headline sits on the canvas. RTL languages (he/ar) flip left↔right at render time, so the AI can plan in reading order without worrying about script direction.",
      ),
    headline_scale: z
      .enum(["compact", "standard", "large", "hero"])
      .describe(
        "Headline size budget. compact ≈ 0.7× brand kit headline, standard ≈ 1.0×, large ≈ 1.3×, hero ≈ 1.6×. The renderer's fitFontToBox still shrinks-to-fit if the text is too long for the chosen scale.",
      ),
    text_alignment: z
      .enum(["left", "center", "right"])
      .describe(
        "Paragraph alignment of the headline + subheadline block. RTL languages auto-flip at render time.",
      ),
    max_text_density: z
      .enum(["low", "medium", "high"])
      .describe(
        "How much text is allowed on the canvas. low = headline + CTA only (subheadline + eyebrow suppressed). medium = headline + sub + CTA + optional eyebrow. high = all text layers including stat / kicker if present.",
      ),
  })
  .describe(
    "Text placement, scale, and density. Drives where text goes and how loud it is — content of the text is set by the copy_package upstream.",
  );
export type TextStrategy = z.infer<typeof TextStrategySchema>;

// ── Visual strategy ─────────────────────────────────────────────────────────

export const PrimaryVisualSchema = z.enum([
  "mockup",
  "screenshot",
  "motif",
  "pattern",
  "abstract_gradient",
  "none",
]);
export type PrimaryVisual = z.infer<typeof PrimaryVisualSchema>;

// Optional motif type hint. When the AI has a strong opinion (e.g. "this
// concept is about price discovery → use a ticker_strip"), it can name it.
// When omitted the renderer falls back to pickMotifForContext + PRNG.
// `none` here lets the AI explicitly suppress motif rendering even though
// the layout would normally include one.
export const MotifHintSchema = z.enum([
  "chart_silhouette",
  "abstract_bars",
  "axis_grid",
  "wave_curve",
  "gradient_orb",
  "node_network",
  "arc_meter",
  "ticker_strip",
  "none",
]);
export type MotifHint = z.infer<typeof MotifHintSchema>;

export const PatternHintSchema = z.enum([
  "diagonal_lines",
  "diagonal_lines_reverse",
  "vertical_bars",
  "dot_grid",
  "concentric_arcs",
  "none",
]);
export type PatternHint = z.infer<typeof PatternHintSchema>;

export const VisualStrategySchema = z
  .object({
    primary_visual: PrimaryVisualSchema.describe(
      "Which visual element carries the design. mockup = device mockup composite. screenshot = warped platform screenshot without device chrome. motif = generated SVG illustration. pattern = geometric SVG fill. abstract_gradient = brand-locked gradient only, no figurative content. none = pure typography ad.",
    ),
    visual_position: z
      .enum(["left", "right", "center", "background", "foreground"])
      .describe(
        "Where the primary visual lives. background = behind text (full-bleed). foreground = on top of a clean field. left/right/center = beside the text block.",
      ),
    visual_weight: z
      .enum(["subtle", "balanced", "dominant"])
      .describe(
        "How much canvas the primary visual claims. subtle ≈ ≤30%. balanced ≈ 40-50%. dominant ≈ ≥60% (or full-bleed when visual_position = background).",
      ),
    use_mockup: z
      .boolean()
      .describe(
        "Render a device mockup + warped screenshot. Independent of primary_visual: a mockup_hero layout will set both true; a pattern_immersive that wants a small inset can set primary_visual=motif but use_mockup=true.",
      ),
    use_screenshot: z
      .boolean()
      .describe(
        "Use a platform screenshot. When use_mockup=true and use_screenshot=true the screenshot is warped INTO the device. When use_mockup=false and use_screenshot=true the screenshot renders as a flat panel.",
      ),
    use_motif: z
      .boolean()
      .describe(
        "Render the generated SVG motif layer (chart silhouette, ticker strip, etc.). Layer is z-index 8 — above background, below content.",
      ),
    use_pattern: z
      .boolean()
      .describe(
        "Render the geometric SVG pattern fill (diagonal lines, dot grid, etc.). Independent of layout type so an editorial_type ad can opt-in for texture.",
      ),
    motif_hint: MotifHintSchema.optional().describe(
      "Optional explicit motif type. When set, overrides the context-driven motif pool. When absent the renderer picks from the desired_visual_context pool (PRNG fallback).",
    ),
    pattern_hint: PatternHintSchema.optional().describe(
      "Optional explicit pattern style. When set, overrides PRNG pattern selection.",
    ),
  })
  .describe(
    "What's on the canvas besides text, where it sits, and how loud it is.",
  );
export type VisualStrategy = z.infer<typeof VisualStrategySchema>;

// ── Brand strategy ──────────────────────────────────────────────────────────

export const BrandStrategySchema = z
  .object({
    background_style: z
      .enum(["solid", "gradient", "deep_gradient", "split_color"])
      .describe(
        "Background treatment. solid = single brand background hex. gradient = standard 2-stop brand gradient. deep_gradient = multi-stop deep navy gradient (premium / luxury feel). split_color = canvas split into two brand-color blocks (editorial).",
      ),
    palette_intensity: z
      .enum(["calm", "standard", "high_contrast"])
      .describe(
        "How saturated the picked palette stops are. calm = adjacent indices in colors.background[]. standard = default 2-step jump. high_contrast = darkest + lightest brand backgrounds.",
      ),
    accent_usage: z
      .enum(["none", "subtle", "cta_only", "strong"])
      .describe(
        "How the brand accent color (#D81222 in MEXEM) is used. none = pure primary/background. subtle = small decorative tint. cta_only = accent reserved for CTA underline / chip. strong = headline highlight or large accent block.",
      ),
    logo_prominence: z
      .enum(["small", "standard", "prominent"])
      .describe(
        "Logo size relative to canvas. small = bare-minimum brand presence. standard = default formula. prominent = oversized for brand-led concepts.",
      ),
    gradient_angle_hint: z
      .number()
      .min(0)
      .max(359)
      .optional()
      .describe(
        "Optional explicit gradient angle in degrees. When set, overrides PRNG. When absent the renderer picks from GRADIENT_ANGLE_POOL.",
      ),
    background_palette_index_hint: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Optional explicit starting index into brandKit.colors.background[]. Wraps modulo palette length. When absent the renderer picks via PRNG.",
      ),
  })
  .describe(
    "Brand-level visual strategy. The brand kit (colors, logo variants, gradients) is still the source of truth — these flags choose AMONG brand-approved options.",
  );
export type BrandStrategy = z.infer<typeof BrandStrategySchema>;

// ── CTA strategy (added — your goal mentions CTA emphasis explicitly) ───────

export const CtaStrategySchema = z
  .object({
    placement: z
      .enum([
        "below_headline",
        "below_subheadline",
        "bottom_left",
        "bottom_center",
        "bottom_right",
        "top_right",
        "inline_with_headline",
        "bottom_band",
      ])
      .describe(
        "Where the CTA button anchors on the canvas. The renderer maps each value to concrete x/y under the format's safe area. `bottom_band` matches the MEXEM reference leaderboard rule: full canvas width, sharp corners, anchored to the bottom edge, dark text on the brand-accent yellow fill.",
      ),
    weight: z
      .enum(["ghost", "standard", "loud"])
      .describe(
        "CTA visual weight. ghost = outline only, brand text color. standard = filled with kit.cta.button_background_color. loud = filled with brand accent color (overrides kit's CTA bg, used sparingly).",
      ),
    width: z
      .enum(["fit_text", "fixed", "full_text_block"])
      .describe(
        "CTA box width. fit_text = char-budget + padding (current default). fixed = brand-kit minimum. full_text_block = match the text block's width (used in centered / bottom_anchor compositions).",
      ),
  })
  .describe(
    "CTA placement and visual treatment. Separate from text_strategy because CTA presence is mandatory and its emphasis often differs from the headline's.",
  );
export type CtaStrategy = z.infer<typeof CtaStrategySchema>;

// ── Spacing ─────────────────────────────────────────────────────────────────

export const SpacingStrategySchema = z
  .object({
    density: z
      .enum(["minimal", "balanced", "rich"])
      .describe(
        "Element count budget. minimal = headline + CTA + logo + disclaimer. balanced = adds subheadline + (eyebrow or stat). rich = adds motif + pattern + secondary decorative layer.",
      ),
    padding: z
      .enum(["tight", "standard", "airy"])
      .describe(
        "Inner padding multiplier vs brand kit's outer_margins. tight ≈ 0.75×. standard = brand kit value. airy ≈ 1.4×.",
      ),
    safe_area_priority: z
      .enum(["normal", "high"])
      .describe(
        "When high, the renderer enforces a minimum 24px gap between every text layer and any other element, and shrinks-to-fit instead of overlapping. Used for legal-heavy concepts where readability is non-negotiable.",
      ),
  })
  .describe(
    "Density and breathing room. Independent of brand kit's outer_margins — those remain the safe-area floor; spacing.padding scales the inner gap.",
  );
export type SpacingStrategy = z.infer<typeof SpacingStrategySchema>;

// ── Per-format adaptation ───────────────────────────────────────────────────
// Optional partial overrides. The renderer applies them as a shallow diff
// over the top-level fields when building each (concept × format) ad. This
// keeps the AI's primary job small — one global plan per concept — while
// allowing it to express format-specific calls without re-stating everything.

const FormatOverrideSchema = z
  .object({
    composition: CompositionStrategySchema.optional(),
    primary_visual: PrimaryVisualSchema.optional(),
    visual_position: z
      .enum(["left", "right", "center", "background", "foreground"])
      .optional(),
    visual_weight: z.enum(["subtle", "balanced", "dominant"]).optional(),
    headline_position: z
      .enum(["left", "right", "center", "top", "bottom"])
      .optional(),
    headline_scale: z
      .enum(["compact", "standard", "large", "hero"])
      .optional(),
    text_alignment: z.enum(["left", "center", "right"]).optional(),
    max_text_density: z.enum(["low", "medium", "high"]).optional(),
    cta_placement: CtaStrategySchema.shape.placement.optional(),
    density: z.enum(["minimal", "balanced", "rich"]).optional(),
    notes: z
      .string()
      .max(280)
      .optional()
      .describe(
        "Free-text rationale specific to this format. Not consumed by the renderer; preserved for human review.",
      ),
  })
  .describe(
    "Partial override of the top-level spec for one format. Any field omitted falls through to the top-level value.",
  );
export type FormatOverride = z.infer<typeof FormatOverrideSchema>;

export const FormatAdaptationSchema = z
  .object({
    leaderboard: FormatOverrideSchema.optional(),
    square: FormatOverrideSchema.optional(),
    portrait: FormatOverrideSchema.optional(),
  })
  .describe(
    "Per-format diffs vs the top-level spec. Keys are the canonical format names: leaderboard = 1200x628, square = 1080x1080, portrait = 1080x1920.",
  );
export type FormatAdaptation = z.infer<typeof FormatAdaptationSchema>;

// ── Top-level spec ──────────────────────────────────────────────────────────

export const VISUAL_LAYOUT_SPEC_VERSION = "1.0.0" as const;

export const VisualLayoutSpecSchema = z
  .object({
    spec_version: z
      .literal(VISUAL_LAYOUT_SPEC_VERSION)
      .default(VISUAL_LAYOUT_SPEC_VERSION)
      .describe(
        "Schema version. Bumped on breaking changes so old saved plans can be migrated.",
      ),
    layout_type: LayoutTypeSchema,
    composition: CompositionStrategySchema,
    hierarchy: HierarchySchema,
    text_strategy: TextStrategySchema,
    visual_strategy: VisualStrategySchema,
    brand_strategy: BrandStrategySchema,
    cta_strategy: CtaStrategySchema,
    spacing: SpacingStrategySchema,
    format_adaptation: FormatAdaptationSchema.default({}),
    rationale: z
      .string()
      .min(1)
      .max(600)
      .describe(
        "Why this design fits this concept. 1-3 sentences. NEVER consumed by the renderer — exists for human review and future critique-pass refinement.",
      ),
  })
  .describe(
    "AI creative-director output for one concept. Drives layout / composition / visual / brand / CTA / spacing decisions; the renderer maps each field to a concrete code path.",
  );
export type VisualLayoutSpec = z.infer<typeof VisualLayoutSpecSchema>;

// ── Map to canonical format names ───────────────────────────────────────────
// The brief uses "1200x628" / "1080x1080" / "1080x1920". The spec uses
// human-readable names. This is the single mapping point.
export const FORMAT_NAME_TO_KEY = {
  leaderboard: "1200x628",
  square: "1080x1080",
  portrait: "1080x1920",
} as const;

// Maps every CampaignFormat to one of the three semantic format-names the AI
// Visual Planner uses for `format_adaptation` (leaderboard / square /
// portrait). Each new format is folded into the closest existing bucket by
// aspect ratio so the AI's per-format overrides keep applying:
//   * AR ≥ 1.4   → leaderboard (wide)
//   * 0.95 ≤ AR ≤ 1.05 → square
//   * AR < 0.95  → portrait (tall)
export const FORMAT_KEY_TO_NAME = {
  "1200x628": "leaderboard",
  "1080x1080": "square",
  "1080x1920": "portrait",
  "1080x1350": "portrait",   // 4:5
  "1200x675": "leaderboard", // 16:9
  "1200x1200": "square",     // 1:1
  "1500x500": "leaderboard", // 3:1
  "1920x1080": "leaderboard",// 16:9
  // MEXEM display + portrait. 300x250 & 336x280 are AR ~1.2 — between the
  // square (0.95-1.05) and leaderboard (≥1.4) buckets above; folded into
  // leaderboard because the AI's "leaderboard" persona handles compact
  // horizontal-leaning content better than the square one.
  "300x250": "leaderboard",  // AR 1.20 — compact rectangle
  "336x280": "leaderboard",  // AR 1.20 — compact rectangle
  "960x1200": "portrait",    // AR 0.80 — taller portrait
  // MEXEM Set 2 — IAB / display standard sizes. Bucketed by aspect ratio
  // using the AR cutoffs documented above.
  "320x100": "leaderboard",  // AR 3.20 — wide micro banner
  "320x50": "leaderboard",   // AR 6.40 — ultra-wide micro banner
  "300x1050": "portrait",    // AR 0.286 — portrait skyscraper
  "300x600": "portrait",     // AR 0.50  — half-page vertical
  "160x600": "portrait",     // AR 0.267 — narrow skyscraper
  "970x250": "leaderboard",  // AR 3.88 — IAB billboard
  "728x90":  "leaderboard",  // AR 8.09 — IAB leaderboard
  "250x250": "square",       // AR 1.00 — small square
} as const;

export type FormatName = keyof typeof FORMAT_NAME_TO_KEY;

// ── Provider response envelope ──────────────────────────────────────────────
// What the AI Visual Planner returns: one spec per concept, keyed by the
// concept_id from the upstream AICampaignPlanRaw. The planner validates this
// envelope, then builds a Map<concept_id, VisualLayoutSpec> for the renderer.
//
// Kept here (not in provider.ts) so the schema module is the single source
// of truth for the spec contract. The provider just imports + parses.
export const VisualLayoutBatchSchema = z
  .object({
    specs: z
      .array(
        z.object({
          concept_id: z.string().min(1),
          spec: VisualLayoutSpecSchema,
        }),
      )
      .min(1),
  })
  .describe(
    "AI Visual Planner output. One VisualLayoutSpec per concept_id. Order should match the input concept order.",
  );
export type VisualLayoutBatch = z.infer<typeof VisualLayoutBatchSchema>;
