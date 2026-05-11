import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BrandKitLiteSchema,
  type BrandKitLite,
} from "@/lib/schemas/brandKit.schema";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import {
  MockupCompositeMapSchema,
  type MockupCompositeMap,
} from "@/lib/preview/composeMockupPreview";
import {
  loadScreenshotTagSidecar,
  type ScreenshotContext,
} from "@/lib/preview/inferScreenshotContext";
import type { MidjourneyContext } from "@/lib/schemas/midjourney.schema";
import {
  buildCloudinaryDelivery,
  loadCloudinaryAssetMap,
  loadCloudinaryCompositeMap,
  pickAssets,
  pickVisualForSpec,
  buildAdSpec,
  type CompositionKind,
  type DemoAdSpec,
  type DesignMotif,
  type PatternStyle,
  type TemplateKind,
} from "@/lib/preview/createDemoCampaign";
import {
  loadMidjourneyUploads,
  filterApproved,
} from "@/lib/midjourney/loadUploads";
import { loadMidjourneyAssignments } from "@/lib/midjourney/loadAssignments";
import type { DeviceType } from "@/lib/preview/mockupManifest";
import type {
  AICampaignPlanRaw,
  CampaignAdSpec,
  CampaignConcept,
  CampaignFormat,
  VisualSelectionMetadata,
} from "@/lib/schemas/aiCampaignPlan.schema";
import type { CampaignBrief } from "@/lib/schemas/campaignBrief.schema";
import type { VisualLayoutSpec } from "@/lib/schemas/visualLayoutSpec.schema";
import {
  resolveConceptLevelPicks,
  resolveFormatLevelPicks,
  deriveRendererHintsForFormat,
  type VisualPicksFallback,
} from "@/lib/ai/mapVisualSpecToInternals";
import {
  loadGeneratedAssetResolver,
  type GeneratedAssetResolver,
} from "@/lib/generators/generatedAssetResolver";
import {
  loadCompositionRules,
  findRule as findCompositionRule,
  findFormat as findCompositionFormat,
  applyCompositionRules,
  clampToSafeZones,
} from "@/lib/ai/applyCompositionRules";

// ─────────────────────────────────────────────────────────────────────────────
// Build CampaignAdSpecs from AI concept stubs.
//
// The AI decides strategy + copy + visual context per concept. This module
// constructs the actual Element Manifests — reusing the same proven layout +
// composite + Midjourney resolution machinery the demo already uses. The AI
// never picks x/y or invents fonts.
//
// Context (one per planner run):
//   brandKit, assets, compositeMap, midjourneyById, activeAssignments,
//   selection, cloudinaryDelivery — exactly what createDemoCampaign loads.
//
// Per concept × per format:
//   1. Pick a device + context for this format from the AI's
//      desired_visual_context.
//   2. Run the demo's pickVisualForSpec → resolves the mockup composite (or
//      Midjourney hero fallback).
//   3. Run the demo's buildAdSpec → emits the full Element Manifest with
//      brand-kit-driven copy, real text/CTA/disclaimer layers, Cloudinary
//      delivery, and Midjourney provenance where applicable.
//   4. Re-shape the demo's DemoAdSpec into a CampaignAdSpec (the planner's
//      output type, which carries concept_id + format + visual selection
//      metadata). The Element Manifest itself is unchanged — the manifest
//      is the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

// Per-format defaults. Picks the device family the renderer should bias
// toward (drives mockup picking) and the channel string saved on each ad
// spec. When adding a new CampaignFormat, also append entries here AND
// to brand-kit-lite.generated.json (sizes_per_format / outer_margins /
// safe_areas) — otherwise the planner will throw on the missing keys.
const FORMAT_TO_DEVICE: Record<CampaignFormat, DeviceType> = {
  "1200x628": "laptop",
  "1080x1080": "tablet",
  "1080x1920": "phone",
  "1080x1350": "tablet",
  "1200x675": "laptop",
  "1200x1200": "tablet",
  "1500x500": "laptop",
  "1920x1080": "laptop",
};

const FORMAT_TO_CHANNEL: Record<CampaignFormat, string> = {
  "1200x628": "leaderboard",
  "1080x1080": "instagram-feed",
  "1080x1920": "instagram-story",
  "1080x1350": "instagram-portrait",
  "1200x675": "x-feed",
  "1200x1200": "linkedin-square",
  "1500x500": "social-cover",
  "1920x1080": "landscape-hd",
};

const FORMAT_TO_SIZE: Record<
  CampaignFormat,
  { width: number; height: number }
> = {
  "1200x628": { width: 1200, height: 628 },
  "1080x1080": { width: 1080, height: 1080 },
  "1080x1920": { width: 1080, height: 1920 },
  "1080x1350": { width: 1080, height: 1350 },
  "1200x675": { width: 1200, height: 675 },
  "1200x1200": { width: 1200, height: 1200 },
  "1500x500": { width: 1500, height: 500 },
  "1920x1080": { width: 1920, height: 1080 },
};

// Fallback chain keyed by the AI's 6-value desired_visual_context. The
// values themselves are 5-value ScreenshotContexts (the screenshot-tag
// vocabulary) since `pickVisualForSpec` operates on screenshot tags.
//
// premium_fintech (no screenshots will ever be tagged this way) maps to
// general_platform for screenshot picking, with no further fallback needed.
const CONTEXT_FALLBACK_CHAIN: Record<MidjourneyContext, ScreenshotContext[]> = {
  stocks: ["charts", "general_platform"],
  etfs: ["charts", "general_platform"],
  charts: ["green_data", "general_platform"],
  green_data: ["charts", "general_platform"],
  general_platform: [],
  premium_fintech: ["general_platform"],
};

// Map the AI's 6-value desired_visual_context onto the 5-value screenshot
// context expected by pickVisualForSpec. premium_fintech has no concrete
// screenshot bucket, so we fall through to general_platform.
function toScreenshotContext(c: MidjourneyContext): ScreenshotContext {
  return c === "premium_fintech" ? "general_platform" : c;
}

export interface AdBuildContext {
  brandKit: BrandKitLite;
  assets: AssetPreviewMap;
  compositeMap: MockupCompositeMap | null;
  cloudinaryDelivery: ReturnType<typeof buildCloudinaryDelivery>;
  approvedById: Map<string, import("@/lib/schemas/midjourney.schema").MidjourneyUpload>;
  activeAssignments: import("@/lib/schemas/midjourney.schema").MidjourneyAssignment[];
  tagSidecar: Awaited<ReturnType<typeof loadScreenshotTagSidecar>>;
  // Phase 3 — optional. When the brief carries `generated_asset_ids` (or the
  // notes field includes `use_generated_asset:<id>` tokens), the resolver
  // here exposes those assets to the per-spec builder. Null when the brief
  // didn't ask for any — preserving today's behavior end-to-end.
  generatedAssetResolver?: GeneratedAssetResolver | null;
  // Optional composition-rules table. When present and a matching
  // (format, composition) rule exists, applyCompositionRules() re-aligns
  // the text-stack cluster on the manifest. Loaded lazily by loadAdBuildContext.
  compositionRules?: import("@/lib/schemas/compositionRules.schema").CompositionRulesFile | null;
}

export interface LoadAdBuildContextOptions {
  cwd?: string;
  brandKitPath?: string;
  assetMapPath?: string;
  compositeMapPath?: string;
  cloudinaryAssetMapPath?: string;
  cloudinaryCompositeMapPath?: string;
  // Phase 3 — populates AdBuildContext.generatedAssetResolver. Pass the
  // brief's `generated_asset_ids` here, plus the brief's `notes` so the
  // loader can also harvest `use_generated_asset:<id>` tokens.
  generatedAssetIds?: string[];
  notes?: string;
  warnings?: string[];
}

/**
 * Front-half loader: reads every artifact the planner needs to build a
 * single ad. Same files the demo loader reads, kept in sync intentionally.
 */
export async function loadAdBuildContext(
  opts: LoadAdBuildContextOptions = {},
): Promise<AdBuildContext> {
  const cwd = opts.cwd ?? process.cwd();
  const brandKitPath =
    opts.brandKitPath ?? path.join(cwd, "data", "brand-kit-lite.generated.json");
  const assetMapPath =
    opts.assetMapPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const compositeMapPath =
    opts.compositeMapPath ??
    path.join(cwd, "data", "mockup-composite-map.generated.json");
  const cloudinaryAssetMapPath =
    opts.cloudinaryAssetMapPath ??
    path.join(cwd, "data", "cloudinary-asset-map.generated.json");
  const cloudinaryCompositeMapPath =
    opts.cloudinaryCompositeMapPath ??
    path.join(cwd, "data", "cloudinary-composite-map.generated.json");

  const brandKit = BrandKitLiteSchema.parse(
    JSON.parse(await fs.readFile(brandKitPath, "utf8")),
  );
  const assets = AssetPreviewMapSchema.parse(
    JSON.parse(await fs.readFile(assetMapPath, "utf8")),
  );
  const compositeMap = await loadCompositeMapOrNull(compositeMapPath);
  const tagSidecar = await loadScreenshotTagSidecar();
  const cloudinaryAssetMap = await loadCloudinaryAssetMap(cloudinaryAssetMapPath);
  const cloudinaryCompositeMap = await loadCloudinaryCompositeMap(cloudinaryCompositeMapPath);
  const cloudinaryDelivery = buildCloudinaryDelivery(
    cloudinaryAssetMap,
    cloudinaryCompositeMap,
    assets,
  );
  const midjourneyUploads = await loadMidjourneyUploads();
  const approvedUploads = filterApproved(midjourneyUploads.uploads);
  const approvedById = new Map(
    approvedUploads.map((u) => [u.upload_id, u] as const),
  );
  const midjourneyAssignmentsFile = await loadMidjourneyAssignments();
  const activeAssignments = midjourneyAssignmentsFile.assignments.filter(
    (a) => a.active && approvedById.has(a.upload_id),
  );

  // Phase 3 — resolve generated-asset ids if the caller passed any.
  const generatedAssetResolver =
    (opts.generatedAssetIds && opts.generatedAssetIds.length > 0) || opts.notes
      ? await loadGeneratedAssetResolver({
          ids: opts.generatedAssetIds ?? [],
          notes: opts.notes,
          cwd,
          warnings: opts.warnings,
        })
      : null;

  const compositionRules = await loadCompositionRules(cwd);

  return {
    brandKit,
    assets,
    compositeMap,
    cloudinaryDelivery,
    approvedById,
    activeAssignments,
    tagSidecar,
    generatedAssetResolver,
    compositionRules,
  };
}

async function loadCompositeMapOrNull(filePath: string): Promise<MockupCompositeMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return MockupCompositeMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Per-concept × per-format builder ────────────────────────────────────────
export interface BuildAdsFromConceptOptions {
  context: AdBuildContext;
  brief: CampaignBrief;
  campaign_id: string;
  concept: AICampaignPlanRaw["concepts"][number];
  // 0-based position of this concept within the plan. Used to vary per-concept
  // visual choices (gradient angle, etc.) so the 3 concepts look distinct.
  conceptIndexInPlan?: number;
  // PRNG fallbacks. When `visualSpec` is absent these are used directly
  // (today's behavior). When `visualSpec` is present they're used only for
  // fields the spec didn't pin down.
  template?: TemplateKind;
  composition?: CompositionKind;
  patternStyle?: PatternStyle;
  motif?: DesignMotif;
  bgPaletteIndex?: number;
  gradientAngle?: number;
  // AI Visual Planner output for THIS concept. When present, displaces PRNG
  // for layout_type / composition / motif / pattern / gradient angle / palette
  // index — see src/lib/ai/mapVisualSpecToInternals.ts for the full mapping.
  // The spec stays the renderer's input; the Element Manifest stays the
  // source of truth.
  visualSpec?: VisualLayoutSpec;
  warnings: string[];
  // Phase 4 — see buildConceptsFromPlan return shape.
  qaWarnings?: string[];
}

/**
 * For one concept, produce one ad spec per required format. Manifest copy
 * is the AI's `copy_package`; visual context is `desired_visual_context`;
 * device is derived from the format.
 *
 * When a VisualLayoutSpec is provided via `visualSpec`, the mapping layer
 * (resolveConceptLevelPicks / resolveFormatLevelPicks) overrides the PRNG
 * fallbacks for any field the spec pins down. PRNG values are still used
 * for fields the AI left unspecified.
 */
export function buildAdSpecsForConcept(
  args: BuildAdsFromConceptOptions,
): CampaignAdSpec[] {
  const { context, brief, campaign_id, concept, warnings } = args;
  // POC: post-pass that re-aligns the text-stack cluster according to
  // data/composition-rules.generated.json. Currently rules exist only for
  // (1200x628, hero_overlay); other (format, composition) pairs are no-ops.
  // Loaded lazily on first call; the file is small and cached after first read.
  const compositionRules = context.compositionRules ?? null;
  const visualComposition = args.visualSpec?.composition;
  const conceptIdx = args.conceptIndexInPlan ?? 0;
  const ctaText = concept.copy_package.cta;
  const disclaimerText = concept.copy_package.disclaimer;

  // Use the demo's pickAssets to pick the campaign-wide brand_logo / IBKR /
  // background / mockup defaults. Cheap to recompute per call but stable.
  const baseSelection = pickAssets(
    context.assets,
    context.brandKit,
    warnings,
    Array.from(context.approvedById.values()),
  );

  // Build the PRNG fallback bundle: today's seeded values, used wherever
  // the spec leaves a field unspecified (or when there's no spec at all).
  const fallback: VisualPicksFallback = {
    template:
      args.template ?? PER_CONCEPT_TEMPLATES[conceptIdx % PER_CONCEPT_TEMPLATES.length],
    composition:
      args.composition ??
      COMPOSITIONS_BY_TEMPLATE[
        args.template ?? PER_CONCEPT_TEMPLATES[conceptIdx % PER_CONCEPT_TEMPLATES.length]
      ]?.[0] ??
      "text_leading",
    patternStyle: args.patternStyle ?? "diagonal_lines",
    motif: args.motif ?? "none",
    bgPaletteIndex: args.bgPaletteIndex ?? conceptIdx,
    gradientAngle: args.gradientAngle ?? 135,
  };

  // Resolve the concept-level picks (template, bg palette index, gradient angle).
  // These don't vary per format because the background fill must stay
  // consistent across the 3 formats of one concept. The downgrades array
  // captures any spec collapse the mapping layer performs (Step 11
  // observability) and is folded into warnings just below.
  const conceptDowngrades: string[] = [];
  const conceptPicks = resolveConceptLevelPicks({
    spec: args.visualSpec,
    fallback,
    downgrades: conceptDowngrades,
  });
  for (const d of conceptDowngrades) {
    warnings.push(`downgrade: ${concept.concept_id}: ${d}`);
  }
  const initialTemplate = conceptPicks.template;

  const selection = applyConceptVisuals({
    base: baseSelection,
    concept,
    conceptIndexInPlan: conceptIdx,
    template: initialTemplate,
    approvedUploads: Array.from(context.approvedById.values()),
    brandKit: context.brandKit,
    warnings,
    bgPaletteIndex: conceptPicks.bgPaletteIndex,
    gradientAngle: conceptPicks.gradientAngle,
    backgroundStyle: conceptPicks.backgroundStyle,
    paletteIntensity: conceptPicks.paletteIntensity,
  });

  const specs: CampaignAdSpec[] = [];
  for (const format of brief.required_formats) {
    const size = FORMAT_TO_SIZE[format];
    const channel = FORMAT_TO_CHANNEL[format];
    const device = FORMAT_TO_DEVICE[format];
    const desired = concept.desired_visual_context;
    const fallback_contexts = CONTEXT_FALLBACK_CHAIN[desired] ?? [];
    const screenshotCtx = toScreenshotContext(desired);

    const visual = pickVisualForSpec({
      plan: {
        device_type: device,
        context: screenshotCtx,
        fallback_contexts,
      },
      selection,
      assets: context.assets,
      compositeMap: context.compositeMap,
      tagSidecar: context.tagSidecar,
      warnings,
    });

    // pattern_immersive doesn't need an image bg — it renders a clean
    // brand-gradient with a geometric SVG pattern overlay. The legacy
    // photo_immersive path still falls back to mockup_hero when no image
    // is wired, in case a future operator override re-enables it.
    let template = initialTemplate;
    if (template === "photo_immersive" && selection.background_fill.kind !== "image") {
      template = "mockup_hero";
    }

    // Resolve the format-level picks (composition, pattern style, motif).
    // The mapping layer reads spec.format_adaptation[format] so per-format
    // overrides flow into the renderer here.
    const formatDowngrades: string[] = [];
    const formatPicks = resolveFormatLevelPicks({
      spec: args.visualSpec,
      format,
      conceptTemplate: template,
      fallback,
      downgrades: formatDowngrades,
    });

    // Step 6+8 — scalar adjustments derived from the spec, with per-format
    // overrides (format_adaptation.<format>) applied on top of the base
    // VisualLayoutSpec. The same concept now produces three different
    // hints — one per format — so a portrait crop can ask for a tighter
    // headline scale / suppressed subheadline / different CTA placement
    // than its leaderboard sibling. When `args.visualSpec` is undefined
    // this returns DEFAULT_RENDERER_HINTS (today's exact behavior).
    // Downgrades from headline_position/visual_position/cta.weight/
    // primary_visual collapses are pushed into formatDowngrades.
    const rendererHints = deriveRendererHintsForFormat(
      args.visualSpec,
      format,
      formatDowngrades,
    );
    // Dedupe: per-format downgrade strings already include format context
    // when they were generated inside resolveFormatLevelPicks; the
    // deriveRendererHints downgrades (headline_position etc.) are
    // identical across formats for the same spec, so we tag them with
    // format here to keep the analyzer accurate.
    for (const d of formatDowngrades) {
      warnings.push(`downgrade: ${concept.concept_id}/${format}: ${d}`);
    }

    const demoAdSpec: DemoAdSpec = buildAdSpec({
      campaignId: campaign_id,
      conceptId: concept.concept_id,
      brandKit: context.brandKit,
      selection,
      visual,
      cloudinaryDelivery: context.cloudinaryDelivery,
      midjourneyById: context.approvedById,
      midjourneyAssignments: context.activeAssignments,
      copy: {
        headline: concept.copy_package.headline,
        headline_emphasis: concept.copy_package.headline_emphasis,
        subheadline: concept.copy_package.subheadline,
        cta: ctaText,
        disclaimer: disclaimerText,
      },
      size: { name: format, width: size.width, height: size.height },
      channel,
      composition: formatPicks.composition,
      template,
      patternStyle: formatPicks.patternStyle,
      motif: formatPicks.motif,
      designElements: concept.design_elements,
      language: brief.language,
      rendererHints,
      generatedAssetResolver: context.generatedAssetResolver ?? null,
      qaWarnings: args.qaWarnings,
    });

    const visual_selection_metadata: VisualSelectionMetadata = {
      desired_context: demoAdSpec.composite_metadata.desired_context,
      selected_context: demoAdSpec.composite_metadata.selected_context,
      intended_device_type: demoAdSpec.composite_metadata.intended_device_type,
      fallback_used: demoAdSpec.composite_metadata.fallback_used,
      fallback_kind: demoAdSpec.composite_metadata.fallback_kind,
      composite_id: demoAdSpec.composite_metadata.composite_id,
      composite_public_path: demoAdSpec.composite_metadata.composite_public_path,
      mockup_filename: demoAdSpec.composite_metadata.mockup_filename,
      screenshot_filename: demoAdSpec.composite_metadata.screenshot_filename,
      screenshot_context_confidence:
        demoAdSpec.composite_metadata.screenshot_context_confidence,
      mockup_slot_source: demoAdSpec.composite_metadata.mockup_slot_source,
    };

    // Composition-rules post-pass. Two passes:
    //   1. Format-level safe-zone clamp — ALWAYS runs when the format
    //      declares safe_area_extra (e.g. story 220px platform UI bands).
    //      This is a safety requirement: the text-stack must stay inside
    //      the safe area regardless of which composition the AI picked.
    //   2. Composition-specific cluster rule — runs only when a rule
    //      exists for the (format, composition) pair.
    const formatRules = findCompositionFormat(compositionRules, format);
    if (formatRules?.safe_area_extra) {
      const clampNotes = clampToSafeZones(
        demoAdSpec.manifest,
        { width: size.width, height: size.height },
        formatRules.safe_area_extra,
      );
      for (const n of clampNotes) {
        warnings.push(`composition_rules ${format}: ${n}`);
      }
    }
    const rule = findCompositionRule(compositionRules, format, visualComposition);
    if (rule) {
      const result = applyCompositionRules(
        demoAdSpec.manifest,
        rule,
        { width: size.width, height: size.height },
        formatRules?.safe_area_extra,
      );
      if (result.applied) {
        for (const n of result.notes) {
          warnings.push(`composition_rules ${format}/${visualComposition}: ${n}`);
        }
      }
    }

    specs.push({
      ad_id: `ad_${concept.concept_id}_${format}`,
      campaign_id,
      concept_id: concept.concept_id,
      format,
      canvas_width: size.width,
      canvas_height: size.height,
      channel,
      internal_template_id: demoAdSpec.bannerbearTemplateUid,
      manifest: demoAdSpec.manifest,
      visual_selection_metadata,
      status: "draft",
    });
  }
  return specs;
}

/**
 * For an entire AI plan, build ad_specs for every concept × format pair and
 * return enriched concepts ready to embed in CampaignPlan.
 *
 * Per-campaign design randomization is applied here, deterministically
 * seeded by `campaign_id` so:
 *   - the same campaign URL always renders identically (reproducibility)
 *   - every NEW campaign produces a fresh design language (variety)
 *
 * What's randomized per campaign:
 *   - Which template each concept gets (one of 6 permutations)
 *   - Composition for mockup_hero (text-left vs visual-left)
 *   - Pattern style for pattern_immersive (5 variants)
 *   - Gradient angle (1 of 8) and brand color pair (any 2 of 8 background hexes)
 */
export function buildConceptsFromPlan(args: {
  context: AdBuildContext;
  brief: CampaignBrief;
  campaign_id: string;
  raw: AICampaignPlanRaw;
  // Optional. When provided, the AI Visual Planner's output for each concept
  // overrides the seeded-PRNG picks below for the fields it pins down. PRNG
  // values are still computed because they remain the fallback for fields
  // the spec didn't address. See src/lib/ai/mapVisualSpecToInternals.ts.
  visualSpecsByConceptId?: Map<string, VisualLayoutSpec>;
}): {
  concepts: CampaignConcept[];
  warnings: string[];
  qaWarnings: string[];
} {
  const warnings: string[] = [];
  // Phase 4 — separate sink so the planner can surface QA-only warnings
  // (CTA refits, aspect-ratio mismatches, unapproved-asset adoptions) on
  // CampaignPlan.generated_assets_warnings without forcing reviewers to
  // grep through the larger general warnings list.
  const qaWarnings: string[] = [];
  // Diversity controls (Phase 5):
  //   1. `diversity_seed`  — when set, baked into the PRNG seed so the same
  //                          brief can produce different visuals across
  //                          runs. When omitted we keep the historic
  //                          campaign_id-only behaviour.
  //   2. `max_diversity`   — forces the 3 concepts to receive DISTINCT
  //                          templates, motifs and background-palette
  //                          starting indices. Default mode picks
  //                          independently per concept and a 3-concept
  //                          campaign can land on the same motif twice
  //                          (especially within the same context).
  const seedKey =
    args.brief.diversity_seed !== undefined
      ? `${args.campaign_id}::${args.brief.diversity_seed}`
      : args.campaign_id;
  const rng = makeSeededPRNG(seedKey);
  const enforceDiversity = args.brief.max_diversity === true;

  // Pick one of 6 template permutations for this campaign. Used as the
  // PRNG fallback when the spec doesn't pin down layout_type.
  const templates =
    TEMPLATE_PERMUTATIONS[Math.floor(rng() * TEMPLATE_PERMUTATIONS.length)];

  // For max_diversity mode we pre-allocate the per-concept slot decisions
  // (template / motif / palette index) so we can de-dupe across the 3 concepts
  // BEFORE the .map runs. Inside the .map we just consume the prepared
  // values. The pattern + gradient angle still vary per concept via the
  // shared PRNG.
  const conceptCount = args.raw.concepts.length;
  const presetTemplates: TemplateKind[] = enforceDiversity
    ? distinctTemplatesFromPermutation(templates, conceptCount)
    : args.raw.concepts.map((_, idx) => templates[idx % templates.length]);
  const presetMotifs: DesignMotif[] = enforceDiversity
    ? distinctMotifsAcrossConcepts(args.raw.concepts.map((c) => c.desired_visual_context), rng)
    : args.raw.concepts.map((c) => pickMotifForContext(c.desired_visual_context, rng));
  const paletteShift = enforceDiversity ? 3 : 2;

  const concepts: CampaignConcept[] = args.raw.concepts.map((c, idx) => {
    const template = presetTemplates[idx];
    const compositionPool = COMPOSITIONS_BY_TEMPLATE[template];
    const composition =
      compositionPool[Math.floor(rng() * compositionPool.length)];
    const patternStyle = pickPatternStyle(rng);
    const bgPaletteIndex = pickBgPaletteIndex(
      args.context.brandKit,
      rng,
      idx,
      paletteShift,
    );
    const gradientAngle = pickGradientAngle(rng);
    const motif = presetMotifs[idx];

    const visualSpec = args.visualSpecsByConceptId?.get(c.concept_id);

    return {
      ...c,
      campaign_id: args.campaign_id,
      visual_layout_spec: visualSpec,
      ad_specs: buildAdSpecsForConcept({
        context: args.context,
        brief: args.brief,
        campaign_id: args.campaign_id,
        concept: c,
        conceptIndexInPlan: idx,
        template,
        composition,
        patternStyle,
        motif,
        bgPaletteIndex,
        gradientAngle,
        visualSpec,
        warnings,
        qaWarnings,
      }),
    };
  });
  return { concepts, warnings, qaWarnings };
}

// Each context has a curated pool of motifs that read as natural for the
// subject. "charts" → chart_silhouette, wave_curve, axis_grid; "etfs" →
// abstract_bars, node_network, gradient_orb; etc. Within a pool, the
// per-campaign PRNG picks one. "none" is in every pool with a small
// weight — sometimes the cleanest design IS no motif.
function pickMotifForContext(
  context: import("@/lib/schemas/midjourney.schema").MidjourneyContext,
  rng: () => number,
): DesignMotif {
  const pools: Record<string, DesignMotif[]> = {
    charts: ["chart_silhouette", "wave_curve", "axis_grid", "ticker_strip", "none"],
    stocks: ["chart_silhouette", "abstract_bars", "ticker_strip", "arc_meter", "none"],
    etfs: ["abstract_bars", "node_network", "gradient_orb", "axis_grid", "none"],
    green_data: ["wave_curve", "node_network", "gradient_orb", "none"],
    general_platform: ["gradient_orb", "axis_grid", "wave_curve", "node_network", "none"],
    premium_fintech: ["gradient_orb", "wave_curve", "arc_meter", "none"],
  };
  const pool = pools[context] ?? pools.general_platform;
  return pool[Math.floor(rng() * pool.length)];
}

// Tiny seeded xorshift PRNG. Keys off campaign_id (which already includes
// a brief hash + timestamp), so different generations produce different
// designs but viewing the same campaign URL always renders identically.
function makeSeededPRNG(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h = h >>> 0;
    return h / 0xffffffff;
  };
}

function pickPatternStyle(rng: () => number): import("@/lib/preview/createDemoCampaign").PatternStyle {
  const pool: Array<import("@/lib/preview/createDemoCampaign").PatternStyle> = [
    "diagonal_lines",
    "diagonal_lines_reverse",
    "vertical_bars",
    "dot_grid",
    "concentric_arcs",
  ];
  return pool[Math.floor(rng() * pool.length)];
}

const GRADIENT_ANGLE_POOL = [135, 45, 200, 90, 110, 160, 25, 305];
function pickGradientAngle(rng: () => number): number {
  return GRADIENT_ANGLE_POOL[Math.floor(rng() * GRADIENT_ANGLE_POOL.length)];
}

// Pick a starting index into brandKit.colors.background for this concept,
// avoiding repeats across the 3 concepts. The shift multiplier widens the
// gap between concepts when max_diversity is on (3) vs default (2).
function pickBgPaletteIndex(
  brandKit: BrandKitLite,
  rng: () => number,
  conceptIdx: number,
  shift = 2,
): number {
  const n = brandKit.colors.background.length;
  if (n === 0) return 0;
  const base = Math.floor(rng() * n);
  return (base + conceptIdx * shift) % n;
}

// max_diversity helper — given the seed-shuffled permutation, pick N
// distinct templates. The permutation already contains 3 unique entries by
// construction; we just need to slice and (when fewer than N concepts in a
// permutation) cycle without repeats.
function distinctTemplatesFromPermutation(
  permutation: TemplateKind[],
  count: number,
): TemplateKind[] {
  // The permutation is a 3-tuple of distinct templates. If count > 3 we
  // start cycling, but max_diversity is most useful for the standard
  // 3-concept case which is exactly len(permutation).
  const distinct: TemplateKind[] = [];
  for (let i = 0; i < count; i++) {
    distinct.push(permutation[i % permutation.length]);
  }
  return distinct;
}

// max_diversity helper — pick N motifs such that no two concepts share the
// same motif. Falls back to the per-context pool but reserves picked motifs
// across the loop. When the pools are too small to satisfy distinctness, we
// settle for "as distinct as possible" rather than crash.
function distinctMotifsAcrossConcepts(
  contexts: import("@/lib/schemas/midjourney.schema").MidjourneyContext[],
  rng: () => number,
): DesignMotif[] {
  const used = new Set<DesignMotif>();
  const out: DesignMotif[] = [];
  for (const ctx of contexts) {
    let motif = pickMotifForContext(ctx, rng);
    // Try a couple of times to land on something unused.
    for (let attempt = 0; attempt < 6 && used.has(motif); attempt++) {
      motif = pickMotifForContext(ctx, rng);
    }
    used.add(motif);
    out.push(motif);
  }
  return out;
}


// ── Per-concept visual overrides ────────────────────────────────────────────
// Replaces the campaign-wide background with one that suits the concept.
// Priority:
//   1. Approved Midjourney background whose context matches the concept's
//      desired_visual_context — gives the design real photographic depth.
//   2. CSS gradient built from the concept's visual_direction.primary_palette
//      with a per-concept angle so the 3 concepts feel visually distinct.
//   3. The brand kit's default fill (untouched if neither path applies).
//
// The Element Manifest stays the source of truth — this only chooses what
// the background element points at; positions, sizes, and z-index are
// unchanged.
const HEX = /^#?[0-9a-f]{6}$/i;
const PER_CONCEPT_GRADIENT_ANGLES = [135, 45, 200] as const;

// All 6 permutations of the 3-template set — used so every campaign picks
// a different concept-to-template mapping. With a fixed cycle, every run
// produced visually identical design across campaigns; with shuffling,
// concept 1 might be editorial_type one campaign and mockup_hero the next.
const TEMPLATE_PERMUTATIONS: TemplateKind[][] = [
  ["mockup_hero", "pattern_immersive", "editorial_type"],
  ["mockup_hero", "editorial_type", "pattern_immersive"],
  ["pattern_immersive", "mockup_hero", "editorial_type"],
  ["pattern_immersive", "editorial_type", "mockup_hero"],
  ["editorial_type", "mockup_hero", "pattern_immersive"],
  ["editorial_type", "pattern_immersive", "mockup_hero"],
];

// Composition pairings per template. mockup_hero can be text_leading OR
// visual_leading — both work and read differently. The other two are
// locked to hero_overlay because their visual languages need full-canvas
// presence (pattern fills / stat anchored top).
const COMPOSITIONS_BY_TEMPLATE: Record<TemplateKind, CompositionKind[]> = {
  mockup_hero: ["text_leading", "visual_leading"],
  pattern_immersive: ["hero_overlay"],
  editorial_type: ["hero_overlay"],
  photo_immersive: ["hero_overlay"],
};

// Templates pair with compositions to give each concept a distinct DESIGN
// FAMILY rather than just a position swap:
//   index 0 — mockup_hero       (text + device mockup, brand gradient bg)
//   index 1 — pattern_immersive (brand gradient + clean SVG pattern, no mockup)
//   index 2 — editorial_type    (brand color block, stat or accent, no mockup)
// The matching with compositions is intentional:
//   text_leading    + mockup_hero       → text-left, mockup-right (classic)
//   visual_leading  + pattern_immersive → text-right, pattern fills bg
//   hero_overlay    + editorial_type    → stat-anchored editorial
// All three templates use BRAND-LOCKED COLORS only — auto-generated AI
// photography is no longer routed (text glyphs / off-brand palette were
// the constant offenders).
const PER_CONCEPT_TEMPLATES: TemplateKind[] = [
  "mockup_hero",
  "pattern_immersive",
  "editorial_type",
];

function applyConceptVisuals(args: {
  base: import("@/lib/preview/createDemoCampaign").DemoAssetSelection;
  concept: AICampaignPlanRaw["concepts"][number];
  conceptIndexInPlan: number;
  template: TemplateKind;
  approvedUploads: import("@/lib/schemas/midjourney.schema").MidjourneyUpload[];
  brandKit: BrandKitLite;
  warnings: string[];
  // Optional: deterministic-random color/angle from the per-campaign PRNG.
  bgPaletteIndex?: number;
  gradientAngle?: number;
  // Step 9 — brand_strategy.background_style + palette_intensity.
  // Both default to "auto" → today's behavior (2-stop gradient with
  // adjacent-index calm picks). When set, the helpers below build the
  // CSS string and stops list using ONLY brand-palette colors — AI is
  // never allowed to inject arbitrary hexes.
  backgroundStyle?: "auto" | "solid" | "gradient" | "deep_gradient" | "split_color";
  paletteIntensity?: "auto" | "calm" | "standard" | "high_contrast";
}): import("@/lib/preview/createDemoCampaign").DemoAssetSelection {
  const { base, concept, conceptIndexInPlan, template, approvedUploads, warnings } = args;
  const conceptCtx = concept.desired_visual_context;

  // Per-concept routing: an approved upload is "this concept's" if its
  // context matches AND its intended_use slots into background / hero /
  // decorative / texture.
  //
  // Auto-generated `openai_image` backgrounds are NEVER auto-routed — they
  // bled text glyphs ("ETF", "F", etc.) and consistently fought the brand
  // palette. All templates default to brand-locked gradients instead. A
  // manual Midjourney upload (source: "midjourney_manual_upload") IS still
  // routed when present — those are hand-curated and the operator can
  // verify they're text-free before approving.
  const matches = approvedUploads.filter((u) => u.context === conceptCtx);
  const mjBg = template === "editorial_type"
    ? undefined
    : matches.find(
        (u) =>
          u.intended_use === "background" &&
          u.source === "midjourney_manual_upload",
      );
  const mjHero = matches.find((u) => u.intended_use === "hero_visual");
  const mjDecoratives = matches
    .filter((u) => u.intended_use === "decorative" || u.intended_use === "texture")
    .slice(0, 2);

  // Per-concept midjourney slot identifiers, with the global defaults as a
  // fallback so a concept with zero matches still renders cleanly.
  //
  // Decorative routing rules — auto-generated AI decoratives consistently
  // looked amateur as random corner accents, so we drop them entirely.
  //   - If we're using an AI background image: NO decoratives at all (the
  //     background already provides visual richness; corner blobs look like
  //     clutter on top).
  //   - Otherwise: keep ONLY decoratives whose upload source is the manual
  //     Midjourney path. Operators who hand-curate Midjourney accents still
  //     see them; auto-generated ones are filtered out.
  void mjDecoratives;
  const filterManualDecoratives = (ids: string[]): string[] => {
    const byId = new Map(approvedUploads.map((u) => [u.upload_id, u] as const));
    return ids.filter(
      (id) => byId.get(id)?.source === "midjourney_manual_upload",
    );
  };
  const midjourney = {
    background_upload_id: mjBg?.upload_id ?? base.midjourney.background_upload_id,
    hero_upload_id: mjHero?.upload_id ?? base.midjourney.hero_upload_id,
    decorative_upload_ids: mjBg
      ? []
      : filterManualDecoratives(base.midjourney.decorative_upload_ids),
  };

  // 1. Midjourney background match → swap the fill to a real image.
  if (mjBg) {
    return {
      ...base,
      background: mjBg.public_path,
      background_fill: { kind: "image", public_path: mjBg.public_path },
      midjourney,
    };
  }

  // 2. Brand-locked gradient. We always pick stops from brandKit.colors —
  // the AI's primary_palette is a hint for mood only, not the literal fill.
  // This guarantees on-brand backgrounds even when the AI drifts. When
  // a per-campaign seeded PRNG provides bgPaletteIndex / gradientAngle,
  // we use those instead of the deterministic-by-concept-index pair, so
  // each new campaign produces a different brand-color combination.
  //
  // Step 9 — brand_strategy.background_style and palette_intensity now
  // control which kind of gradient is emitted (solid / 2-stop / multi-stop
  // / split) and how far apart the chosen indices are. Both still operate
  // exclusively over brand-palette tokens — there is no path for an AI
  // to introduce off-brand hex codes here.
  const angle =
    args.gradientAngle ??
    PER_CONCEPT_GRADIENT_ANGLES[conceptIndexInPlan % PER_CONCEPT_GRADIENT_ANGLES.length];
  const fill = buildBrandBackgroundFill({
    brandKit: args.brandKit,
    paletteStart: args.bgPaletteIndex ?? conceptIndexInPlan,
    angleDeg: angle,
    style: args.backgroundStyle ?? "auto",
    intensity: args.paletteIntensity ?? "auto",
  });
  const stops = fill.stops;
  const css = fill.css;

  // Log a small warning if the AI's palette didn't match the brand kit, so
  // the operator can see when the lock kicked in. Not a failure — the
  // brand-locked stops are always valid.
  const aiHex = (concept.visual_direction.primary_palette ?? []).filter((c) =>
    HEX.test(c),
  );
  const brandSet = new Set(
    [
      ...args.brandKit.colors.background,
      ...args.brandKit.colors.primary,
      ...args.brandKit.colors.accent,
    ].map((c) => c.toLowerCase()),
  );
  const offBrand = aiHex.filter((c) => !brandSet.has(c.toLowerCase()));
  if (offBrand.length > 0) {
    warnings.push(
      `Concept ${concept.concept_id}: AI palette had off-brand hex(es) ${offBrand.join(", ")}; using brand-kit gradient.`,
    );
  }

  return {
    ...base,
    background_fill: {
      kind: "gradient",
      css,
      stops,
      angle_deg: angle,
    },
    midjourney,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 9 — brand background fill builder.
//
// Builds a (css, stops, angle_deg) triple from brand-kit colors only. The
// AI never injects hex codes; it picks an enum value (background_style ∈
// {auto, solid, gradient, deep_gradient, split_color}) and an intensity
// (∈ {auto, calm, standard, high_contrast}), and this helper translates
// those choices into a brand-locked palette.
//
// Defaults (auto / auto) reproduce the pre-Step-9 output bit-for-bit:
// 2-stop linear gradient, adjacent palette indices, given angle.
//
// All four styles return `kind: "gradient"` because the demo schema only
// admits "image" / "gradient" — solid is encoded as a 2-stop gradient
// with identical colors; split_color uses 4 stops with a sharp 50% step.
// ─────────────────────────────────────────────────────────────────────────────

interface BrandFillResult {
  css: string;
  stops: Array<{ color: string; position: number }>;
  angle_deg: number;
}

function buildBrandBackgroundFill(args: {
  brandKit: BrandKitLite;
  paletteStart: number;
  angleDeg: number;
  style: "auto" | "solid" | "gradient" | "deep_gradient" | "split_color";
  intensity: "auto" | "calm" | "standard" | "high_contrast";
}): BrandFillResult {
  const bg =
    args.brandKit.colors.background.length > 0
      ? args.brandKit.colors.background
      : args.brandKit.colors.primary;

  // Hard fallback: kit has no background OR primary palette. Only triggers
  // on a setup bug — keep the existing safety net intact.
  if (bg.length === 0) {
    const stops = [
      { color: "#0A0F1F", position: 0 },
      { color: "#00122C", position: 1 },
    ];
    return { css: cssLinearGradient(args.angleDeg, stops), stops, angle_deg: args.angleDeg };
  }

  // Resolve "auto": today's behavior is a 2-stop gradient with adjacent
  // palette indices (calm).
  const style = args.style === "auto" ? "gradient" : args.style;
  const intensity = args.intensity === "auto" ? "calm" : args.intensity;

  // Resolve the start / end index pair for 2-stop / split / solid styles.
  // intensity controls how far apart the indices are.
  const { startIdx, endIdx } = resolvePaletteIndices(bg.length, args.paletteStart, intensity);

  if (style === "solid") {
    // Solid color: one brand background hex. We still emit two identical
    // stops because the schema requires a stops array and the renderer's
    // fallback `background_color` reads stops[0].color. Intensity is
    // intentionally ignored for solid — picking "high_contrast" or "calm"
    // for a single color is meaningless; the operator gets bg[paletteStart].
    const c = bg[startIdx];
    const stops = [
      { color: c, position: 0 },
      { color: c, position: 1 },
    ];
    return {
      css: cssLinearGradient(0, stops),
      stops,
      angle_deg: 0,
    };
  }

  if (style === "deep_gradient") {
    // Multi-stop gradient using every brand background color in palette
    // order. Picks up the 8-stop "luxury" feel from the brand kit's
    // allowed_gradients[0] when present (regulator-vetted stop list);
    // otherwise constructs uniform spacing from background[]. Intensity
    // is intentionally ignored — deep_gradient IS the high-contrast play
    // by definition.
    const allowed = args.brandKit.colors.allowed_gradients[0];
    const stops: Array<{ color: string; position: number }> = (() => {
      if (allowed && allowed.stops.length >= 2) {
        return allowed.stops.map((s) => ({ color: s.color, position: s.position }));
      }
      // Synthesize: bg[0] at 0, bg[n-1] at 1, evenly spaced.
      return bg.map((color, i) => ({
        color,
        position: bg.length === 1 ? 0 : i / (bg.length - 1),
      }));
    })();
    return {
      css: cssLinearGradient(args.angleDeg, stops),
      stops,
      angle_deg: args.angleDeg,
    };
  }

  if (style === "split_color") {
    // Two brand colors with a sharp 50% transition. CSS `linear-gradient`
    // with stops at the same position renders as a clean cut, no gradient
    // band. Diagonal angles produce a slanted split that reads like a
    // rendering glitch — only the four orthogonal angles (0 / 90 / 180 /
    // 270) produce a visually clean half/half. Anything else falls back
    // to 90deg (vertical split — left half / right half). The AI can
    // still pick direction explicitly via gradient_angle_hint=0/90/180/270.
    const CLEAN_SPLIT_ANGLES = new Set([0, 90, 180, 270]);
    const splitAngle = CLEAN_SPLIT_ANGLES.has(args.angleDeg) ? args.angleDeg : 90;
    const cA = bg[startIdx];
    const cB = bg[endIdx];
    const stops = [
      { color: cA, position: 0 },
      { color: cA, position: 0.5 },
      { color: cB, position: 0.5 },
      { color: cB, position: 1 },
    ];
    return {
      css: cssLinearGradient(splitAngle, stops),
      stops,
      angle_deg: splitAngle,
    };
  }

  // Default: 2-stop gradient — today's behavior for style="gradient".
  // Single-color palette degrades to bg[0] + a darkened sibling.
  if (bg.length === 1) {
    const stops = [
      { color: bg[0], position: 0 },
      { color: darken(bg[0], 0.5), position: 1 },
    ];
    return {
      css: cssLinearGradient(args.angleDeg, stops),
      stops,
      angle_deg: args.angleDeg,
    };
  }
  const stops = [
    { color: bg[startIdx], position: 0 },
    { color: bg[endIdx], position: 1 },
  ];
  return {
    css: cssLinearGradient(args.angleDeg, stops),
    stops,
    angle_deg: args.angleDeg,
  };
}

// Map (paletteStart, intensity) → (startIdx, endIdx) into the brand
// background palette. intensity controls how far apart the two stops are.
//
//   calm           → adjacent: jump=1   (today's default)
//   standard       → 3-step jump (more visible depth, still on-brand)
//   high_contrast  → first ↔ last (max range across the palette)
//
// startIdx is taken from the (already deterministic) paletteStart value
// so concept-to-concept variation continues to be driven by the seeded
// PRNG / spec hint at Step 5.
function resolvePaletteIndices(
  n: number,
  paletteStart: number,
  intensity: "calm" | "standard" | "high_contrast",
): { startIdx: number; endIdx: number } {
  const startIdx = ((paletteStart % n) + n) % n;
  if (intensity === "high_contrast") {
    // Anchor on the canonical extremes — darkest and brightest brand
    // background. Ignores paletteStart so the high-contrast look is
    // consistent across concepts.
    return { startIdx: 0, endIdx: n - 1 };
  }
  const jump = intensity === "calm" ? 1 : 3;
  const endIdx = (startIdx + jump) % n;
  return { startIdx, endIdx };
}

function cssLinearGradient(
  angleDeg: number,
  stops: Array<{ color: string; position: number }>,
): string {
  return `linear-gradient(${angleDeg}deg, ${stops
    .map((s) => `${s.color} ${Math.round(s.position * 100)}%`)
    .join(", ")})`;
}

// Multiply RGB channels by (1 - amount) to produce a darker variant.
// `amount` is 0..1 — 0.6 means "60% darker".
function darken(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 0xff) * (1 - amount)));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
