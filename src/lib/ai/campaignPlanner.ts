import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getAIProvider,
  readProviderName,
  type AIProviderName,
} from "@/lib/ai/provider";
import {
  AICampaignPlanRawSchema,
  CampaignPlanSchema,
  CampaignIndexFileSchema,
  ActiveCampaignFileSchema,
  type AIConceptStub,
  type CampaignPlan,
  type CampaignIndexEntry,
  type CampaignIndexFile,
} from "@/lib/schemas/aiCampaignPlan.schema";
import type { VisualLayoutSpec } from "@/lib/schemas/visualLayoutSpec.schema";
import {
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import type { BrandKitLite } from "@/lib/schemas/brandKit.schema";
import {
  loadAdBuildContext,
  buildConceptsFromPlan,
} from "@/lib/ai/buildAdSpecsFromPlan";
import {
  generateImageOpenAI,
  type ImageProviderName,
} from "@/lib/ai/imageProvider";
import {
  loadMidjourneyUploads,
  writeMidjourneyUploads,
} from "@/lib/midjourney/loadUploads";
import { fetchCampaignCopyBatch } from "@/lib/marketing-translator/client";
import type { LocalizedCopyBatchConcept } from "@/lib/marketing-translator/schema";
import {
  runDeterministicQa,
  hasBlockingViolations,
  type DeterministicCampaignReport,
} from "@/lib/qa/deterministicQa";

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Planner — the orchestrator.
//
// Flow:
//   1. Validate the brief.
//   2. Load the brand kit + asset preview + composites + Cloudinary maps +
//      Midjourney uploads + assignments via loadAdBuildContext.
//   3. Call the AI provider to get an AICampaignPlanRaw (concept stubs).
//   4. Validate the raw plan; reject if it fails schema.
//   5. Run buildConceptsFromPlan to construct ad_specs deterministically
//      (the AI never invents layouts).
//   6. Validate the final CampaignPlan against schema.
//   7. Save to disk, update the index, optionally set as active.
//
// Element Manifest stays the source of truth at every step. AI hallucination
// can only ever break copy / strategy — not layouts.
// ─────────────────────────────────────────────────────────────────────────────

export const CAMPAIGNS_DIR = path.join(process.cwd(), "data", "campaigns");
export const CAMPAIGNS_INDEX_PATH = path.join(
  CAMPAIGNS_DIR,
  "index.generated.json",
);
export const ACTIVE_CAMPAIGN_PATH = path.join(
  process.cwd(),
  "data",
  "active-campaign.generated.json",
);

// Progress events surfaced to the route's streaming layer so the
// /campaign-planner form can show live status while a generation runs.
// Each `stage` is a stable string the UI maps to a human-readable label;
// `detail` is optional free text (e.g. "concept 2 of 3").
export type PlanProgressStage =
  | "ai_concepts"
  | "refining"
  | "translating"
  | "images"
  | "visual_planning"
  | "building"
  | "qa"
  | "saving";

export interface PlanProgressEvent {
  stage: PlanProgressStage;
  detail?: string;
}

export interface PlanCampaignOptions {
  brief: CampaignBrief;
  // Override the env var when calling programmatically (tests, scripts).
  providerName?: AIProviderName;
  // When true, mark the new campaign as active after saving. Default: false.
  setAsActive?: boolean;
  // When set to "openai", auto-generate one background image per concept via
  // the OpenAI Images API and append it as an approved upload. This is not
  // used by the campaign creation UI/API because production backgrounds are
  // locked to brand-input/background assets. When "none" or omitted (default),
  // no images are generated.
  imageProvider?: ImageProviderName;
  cwd?: string;
  // Optional progress callback. Invoked on each major phase boundary
  // (AI plan → refine → translate → optional images → visual plan → build → QA →
  // save). The streaming route translates each call into an NDJSON event
  // the planner form renders as a stage indicator. Synchronous so the
  // planner doesn't await arbitrary handler work — keep the handler cheap.
  onProgress?: (event: PlanProgressEvent) => void;
}

export interface ImageGenerationSummary {
  provider: ImageProviderName;
  generated: number;
  failed: number;
  estimated_usd: number;
  uploads: Array<{ upload_id: string; concept_id: string; context: string; bytes: number | undefined }>;
  errors: string[];
}

export interface PlanCampaignResult {
  plan: CampaignPlan;
  saved_path: string;
  index_path: string;
  active: boolean;
  images?: ImageGenerationSummary;
}

export async function planCampaign(
  opts: PlanCampaignOptions,
): Promise<PlanCampaignResult> {
  const cwd = opts.cwd ?? process.cwd();
  const brief = CampaignBriefSchema.parse(opts.brief);
  const providerName = opts.providerName ?? readProviderName();

  // Phase 3 — surface generated-asset ids from the brief (and from
  // `use_generated_asset:<id>` tokens in `notes`) into the build context. The
  // resolver loaded inside loadAdBuildContext warns + skips on missing ids
  // rather than throwing.
  const ctxLoadWarnings: string[] = [];
  const ctx = await loadAdBuildContext({
    cwd,
    generatedAssetIds: brief.generated_asset_ids,
    notes: brief.notes,
    warnings: ctxLoadWarnings,
  });

  // Creative-mode hatch from the brief. "exploratory" bumps temperatures
  // across the AI passes AND skips the critique-and-refine pass — the
  // critique kills consultant-ese verbs and locks copy to terse-finance
  // tone, which is great for safe campaigns but throttles creativity. The
  // renderer's safety clamps still apply (no overlapping text, brand-locked
  // colors, disclaimer band) regardless of mode. Default "standard"
  // preserves the pre-Step-12 behavior for every existing campaign.
  const creativeMode = brief.creative_mode;
  const callOpts = { creativeMode };

  // 1. Ask the AI for the raw plan.
  const provider = getAIProvider(providerName);
  opts.onProgress?.({ stage: "ai_concepts" });
  let raw;
  try {
    raw = await provider.generateStructuredCampaignPlan(
      { brief, brandKit: ctx.brandKit },
      callOpts,
    );
  } catch (err) {
    throw new Error(`AI provider failed: ${(err as Error).message}`);
  }
  // 2. Defensive re-validate (provider already validates, belt + braces).
  const parsedRaw = AICampaignPlanRawSchema.safeParse(raw);
  if (!parsedRaw.success) {
    throw new Error(
      `AI campaign plan failed schema validation: ${formatIssues(parsedRaw.error.issues)}`,
    );
  }

  // 2b. Refinement pass.
  //
  //   standard mode    — critique-and-refine (kills consultant-ese, demands
  //                      concrete finance, polishes copy)
  //   exploratory mode — creative-stretch (pushes for divergence, demands
  //                      braver framing, replaces stock-finance metaphors)
  //
  // Both pass through the same provider.refineCampaignPlan method; the
  // provider selects the right system prompt + temperature based on
  // callOpts.creativeMode. If the refinement fails OR returns invalid JSON
  // we keep the original.
  let refined = parsedRaw.data;
  if (provider.refineCampaignPlan) {
    opts.onProgress?.({ stage: "refining" });
    try {
      const r = await provider.refineCampaignPlan(
        { brief, brandKit: ctx.brandKit },
        parsedRaw.data,
        callOpts,
      );
      const reparsed = AICampaignPlanRawSchema.safeParse(r);
      if (reparsed.success) {
        refined = reparsed.data;
      }
    } catch {
      // Refinement is best-effort. Carry on with the initial plan.
    }
  }

  // 2c. Replace every concept's copy_package with marketing-translator
  // output. ai-campaign-banner is the visual / layout / rendering layer
  // only — the source of headline / subheadline / cta / disclaimer is the
  // marketing-translator service. The LLM's strategic_idea / visual
  // direction / midjourney prompts are kept; only the copy fields are
  // overwritten before manifest construction.
  const targetLocale = mapLanguageToLocale(brief.language);
  const timeoutMs = readTranslatorTimeoutMs();
  const translatorDisclaimer =
    ctx.brandKit.legal.disclaimers_by_language?.[brief.language] ??
    ctx.brandKit.legal.default_disclaimer;
  const approvedCtaTexts = ctx.brandKit.cta.allowed_texts.join(", ");
  const translatorComplianceGuidance = [
    translatorDisclaimer
      ? `Use this disclaimer verbatim whenever a risk warning is required: "${translatorDisclaimer}"`
      : "",
    approvedCtaTexts
      ? `Preferred CTA label set from Settings: ${approvedCtaTexts}. Translate or adapt only when the output language requires it, and keep the CTA short.`
      : "",
    "Keep copy calm, concrete and platform-led. Avoid hype, urgency, performance promises, and vague finance slogans.",
  ]
    .filter(Boolean)
    .join(" ");
  const copyByConceptId = new Map<string, LocalizedCopyBatchConcept>();
  const translatorWarnings: string[] = [];
  const totalConcepts = refined.concepts.length;
  opts.onProgress?.({
    stage: "translating",
    detail: `${totalConcepts} concepts`,
  });
  if (targetLocale) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const batch = await fetchCampaignCopyBatch(
        {
          brief: {
            marketingMessage: brief.marketing_message,
            campaignGoal: brief.campaign_goal,
            targetAudience: brief.target_audience,
            notes: brief.notes,
          },
          targetLocale,
          tone: brief.tone,
          complianceNotes: translatorComplianceGuidance,
          riskWarningRequired: brief.risk_warning_required,
          concepts: refined.concepts.map((concept) => ({
            conceptId: concept.concept_id,
            name: concept.name,
            strategicIdea: concept.strategic_idea,
            targetEmotion: concept.target_emotion,
            tone: concept.tone,
            composition: concept.desired_visual_context,
            moodKeywords: [
              concept.target_emotion,
              concept.tone,
              concept.desired_visual_context,
            ],
          })),
        },
        { signal: controller.signal },
      );
      for (const copy of batch.concepts) {
        copyByConceptId.set(copy.conceptId, copy);
      }
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : redactSecret((err as Error).message);
      translatorWarnings.push(
        `marketing-translator: ${reason} — using AI copy fallback for ${brief.language}.`,
      );
    } finally {
      clearTimeout(timer);
    }
  } else {
    translatorWarnings.push(
      `marketing-translator: language "${brief.language}" is not supported by the external service — using AI copy fallback.`,
    );
  }
  for (const concept of refined.concepts) {
    if (copyByConceptId.has(concept.concept_id)) continue;
    copyByConceptId.set(
      concept.concept_id,
      fallbackCopyFromConcept({
        concept,
        brief,
        disclaimer: translatorDisclaimer,
      }),
    );
  }
  // Topic-aware disclaimer appendix. The brand-kit topic_disclaimers entries
  // are English source strings, so only append them to English campaigns.
  // Non-English campaigns already use the matching disclaimers_by_language
  // entry verbatim; appending English here is what made Italian banners show
  // mixed-language legal copy.
  const { appendTopicDisclaimers } = await import("@/lib/ai/disclaimerTopics");
  const topicTexts =
    brief.language === "en" ? ctx.brandKit.legal.topic_disclaimers : undefined;
  refined = {
    ...refined,
    concepts: refined.concepts.map((c) => {
      const localized = copyByConceptId.get(c.concept_id);
      if (!localized) return c;
      const displayCopy = normalizeCopyForBrand({
        copy: localized,
        concept: c,
        brandKit: ctx.brandKit,
        brief,
      });
      // Build the corpus we run keyword detection against. Per-concept so
      // each concept in a multi-concept campaign can get a different
      // appendix when their strategic angles emphasise different topics.
      const corpus = [
        brief.marketing_message,
        brief.notes ?? "",
        c.strategic_idea,
        c.name,
        displayCopy.headline,
        displayCopy.subheadline,
        displayCopy.body ?? c.copy_package.body,
      ]
        .filter(Boolean)
        .join(" ");
      const disclaimerWithTopics = appendTopicDisclaimers(
        displayCopy.disclaimer,
        corpus,
        topicTexts,
      );
      const headline = displayCopy.headline.toUpperCase();
      const cta = displayCopy.cta.toUpperCase();
      return {
        ...c,
        design_elements: normalizeDesignElementsForBrand({
          concept: c,
          brandKit: ctx.brandKit,
          brief,
        }),
        copy_package: {
          ...c.copy_package,
          headline,
          subheadline: displayCopy.subheadline,
          body: displayCopy.body ?? c.copy_package.body,
          cta,
          disclaimer: disclaimerWithTopics,
          // Recreate the reference-style headline split from the final,
          // translator-owned headline. The LLM's original prefix no longer
          // matches after translation, but the renderer needs a real prefix
          // to paint the first claim in the brand accent.
          headline_emphasis: inferHeadlineEmphasis(headline),
          alternative_headlines: [],
          alternative_ctas: [],
          platform_copy_variations: [],
        },
      };
    }),
  };
  if (!usesMexemCopyGuard(ctx.brandKit)) {
    for (const [conceptId, copy] of copyByConceptId) {
      for (const note of copy.complianceNotes) {
        translatorWarnings.push(`marketing-translator [${conceptId}]: ${note}`);
      }
    }
  }

  // 3. Optional image generation. Disabled by default and not used by the
  // campaign creation UI/API: production backgrounds are always brand-input
  // assets. This remains only for explicit internal experiments that pass
  // imageProvider: "openai".
  const imageProviderName = opts.imageProvider ?? "none";
  let images: ImageGenerationSummary | undefined;
  let buildContext = ctx;
  if (imageProviderName === "openai") {
    opts.onProgress?.({ stage: "images" });
    images = await generateImagesForConcepts(refined, cwd);
    if (images.generated > 0) {
      buildContext = await loadAdBuildContext({
        cwd,
        generatedAssetIds: brief.generated_asset_ids,
        notes: brief.notes,
        warnings: ctxLoadWarnings,
      });
    }
  }

  // 3b. Visual planner pass. Asks the AI to produce one VisualLayoutSpec per
  // concept; the spec drives layout / composition / visual / brand / CTA /
  // spacing decisions. Best-effort: a failure here means the renderer falls
  // back to the seeded PRNG (today's behavior). The spec is persisted on
  // each concept for reproducibility and human review.
  let visualSpecsByConceptId: Map<string, VisualLayoutSpec> | undefined;
  const visualPlannerWarnings: string[] = [];
  if (provider.planVisualLayoutsForCampaign) {
    opts.onProgress?.({ stage: "visual_planning" });
    try {
      const batch = await provider.planVisualLayoutsForCampaign(
        { brief, brandKit: ctx.brandKit },
        refined,
        callOpts,
      );
      visualSpecsByConceptId = new Map(
        batch.specs.map((s) => [s.concept_id, s.spec]),
      );
      // Surface a warning for any concept that didn't receive a spec — the
      // renderer will fall through to PRNG for those, which is fine but
      // worth flagging so the operator knows why the design might look
      // off-brand for that concept.
      for (const c of refined.concepts) {
        if (!visualSpecsByConceptId.has(c.concept_id)) {
          visualPlannerWarnings.push(
            `visual_planner: no spec returned for concept ${c.concept_id}; falling back to PRNG.`,
          );
        }
      }
    } catch (err) {
      visualPlannerWarnings.push(
        `visual_planner: ${redactSecret((err as Error).message)} — falling back to PRNG.`,
      );
    }
  }

  // 4. Build ad_specs deterministically.
  opts.onProgress?.({ stage: "building" });
  const campaign_id = `cam_${shortId(`${brief.brief_id}-${new Date().toISOString()}`)}`;
  const { concepts, warnings, qaWarnings } = buildConceptsFromPlan({
    context: buildContext,
    brief,
    campaign_id,
    raw: refined,
    visualSpecsByConceptId,
  });
  for (const w of visualPlannerWarnings) warnings.push(w);
  for (const w of translatorWarnings) warnings.push(w);
  // Phase 4 — drop the cosmetic "Using Midjourney upload as background" line
  // when a generated background actually drove the bg branch in
  // buildElements. The MJ pick happens in `pickAssets` BEFORE the resolver
  // runs (the resolver overrides selection.background_fill later), so the
  // warning is technically true at the time it's emitted but misleading by
  // the time the manifest lands. Keep the warning for campaigns without a
  // generated bg adoption.
  const adoptedBg = buildContext.generatedAssetResolver?.getBackground() ?? null;
  for (const w of ctxLoadWarnings) {
    if (
      adoptedBg &&
      w.startsWith("Using Midjourney upload as background")
    ) {
      continue;
    }
    warnings.push(w);
  }
  // The pickAssets call inside buildAdSpecsForConcept also emits that
  // string into `warnings` — strip from there too.
  if (adoptedBg) {
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (warnings[i].startsWith("Using Midjourney upload as background")) {
        warnings.splice(i, 1);
      }
    }
  }
  if (images && images.errors.length > 0) {
    for (const e of images.errors) warnings.push(`image: ${e}`);
  }

  // Phase 4 — collect every generated-asset id that actually landed on at
  // least one element, in stable order. The resolver's picksByType is a
  // good ground truth for "what could land"; we then verify each really
  // appeared by walking concepts/ads/elements (skipped svg-mode CTAs etc.).
  const generated_assets_used: string[] = [];
  const seenAssetIds = new Set<string>();
  for (const c of concepts) {
    for (const ad of c.ad_specs) {
      for (const el of ad.manifest.elements) {
        const id = el.generated_asset?.id;
        if (id && !seenAssetIds.has(id)) {
          seenAssetIds.add(id);
          generated_assets_used.push(id);
        }
      }
    }
  }
  // Surface "this id was passed but never adopted" as a QA warning.
  if (buildContext.generatedAssetResolver) {
    for (const a of buildContext.generatedAssetResolver.picked) {
      if (!seenAssetIds.has(a.id)) {
        qaWarnings.push(
          `generated_asset_id "${a.id}" (type=${a.type}) was supplied but didn't land on any element. (Possible reasons: type already taken by an earlier id, svg-mode CTA, or no compatible role in the chosen layout.)`,
        );
      }
    }
    for (const id of buildContext.generatedAssetResolver.missingIds) {
      qaWarnings.push(`generated_asset_id "${id}" not found in index.`);
    }
  }

  // Dedupe warnings before persisting. A campaign with 3 concepts × 3
  // formats triggers per-concept asset selection 9 times, so an identical
  // warning ("downgrade: cta.weight=loud → standard") can repeat 9× even
  // though the underlying decision is the same. We keep the FIRST occurrence
  // (preserves order) and drop later duplicates.
  const dedupedWarnings = dedupePreserveOrder(warnings);
  const dedupedQaWarnings = dedupePreserveOrder(qaWarnings);

  // 5. Final validation.
  const planCandidate = CampaignPlanSchema.parse({
    campaign_id,
    brand_id: brief.brand_id,
    source_brief: brief,
    campaign_name: refined.campaign_name,
    campaign_summary: refined.campaign_summary,
    ai_provider: providerName,
    concepts,
    warnings: dedupedWarnings,
    generated_assets_used,
    generated_assets_warnings: dedupedQaWarnings,
    created_at: new Date().toISOString(),
  });

  opts.onProgress?.({ stage: "qa" });
  // 5b. Deterministic position QA — last gate before the campaign hits disk.
  // Catches off-canvas elements, zero-area text, missing required roles, and
  // disclaimer↔CTA / disclaimer↔headline overlaps that the layout clamps in
  // buildElements failed to resolve. If anything is `block`-severity, we
  // refuse the save and surface a readable error to the route. Operators can
  // retry — the next run gets fresh AI temperatures and usually lands clean.
  const qaReport = runDeterministicQa(planCandidate);
  if (hasBlockingViolations(qaReport)) {
    throw new Error(
      `Position QA blocked save: ${formatQaBlocks(qaReport)}`,
    );
  }

  // 6. Save.
  opts.onProgress?.({ stage: "saving" });
  const saved_path = await saveCampaignPlan(cwd, planCandidate);
  const index_path = await upsertCampaignIndex(cwd, planCandidate);
  let active = false;
  if (opts.setAsActive) {
    await setActiveCampaign(cwd, planCandidate.campaign_id, saved_path);
    active = true;
  }

  return { plan: planCandidate, saved_path, index_path, active, images };
}

// ── Image generation helper ─────────────────────────────────────────────────
// One image per (concept × prompt) — i.e. the entire midjourney_prompt_pack
// of every concept, not just the background. Each prompt's intended_use +
// context is preserved on the upload, so applyConceptVisuals can route it to
// the right slot per concept (background, hero_visual, decorative…).
//
// Persisted to the same uploads file the /midjourney UI manages, so manual
// + auto uploads coexist.
async function generateImagesForConcepts(
  raw: import("@/lib/schemas/aiCampaignPlan.schema").AICampaignPlanRaw,
  cwd: string,
): Promise<ImageGenerationSummary> {
  const summary: ImageGenerationSummary = {
    provider: "openai",
    generated: 0,
    failed: 0,
    estimated_usd: 0,
    uploads: [],
    errors: [],
  };
  const uploadsFile = await loadMidjourneyUploads();
  const next = [...uploadsFile.uploads];
  for (const concept of raw.concepts) {
    if (concept.midjourney_prompt_pack.length === 0) continue;
    for (const prompt of concept.midjourney_prompt_pack) {
      try {
        const result = await generateImageOpenAI(
          {
            prompt_id: prompt.prompt_id,
            prompt_text: prompt.prompt_text,
            context: prompt.context,
            intended_use: prompt.intended_use,
            aspect_ratio: prompt.aspect_ratio,
            concept_id: concept.concept_id,
          },
          { cwd },
        );
        next.push(result.upload);
        summary.generated += 1;
        summary.estimated_usd += result.estimated_usd ?? 0;
        summary.uploads.push({
          upload_id: result.upload.upload_id,
          concept_id: concept.concept_id,
          context: result.upload.context,
          bytes: result.upload.bytes,
        });
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(
          `concept ${concept.concept_id} / ${prompt.prompt_id}: ${redactSecret((err as Error).message)}`,
        );
      }
    }
  }
  if (summary.generated > 0) {
    await writeMidjourneyUploads(next);
  }
  return summary;
}

function redactSecret(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}

// Per-call timeout for outbound /api/campaign-copy requests. Defaults to
// 15 seconds; override with MARKETING_TRANSLATOR_TIMEOUT_MS. A non-positive
// or non-numeric value falls back to the default rather than disabling.
function readTranslatorTimeoutMs(): number {
  const raw = process.env.MARKETING_TRANSLATOR_TIMEOUT_MS;
  if (!raw) return 15_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

// Map the brief's 2-letter language code to the BCP-47 locale that
// marketing-translator's /api/campaign-copy expects. Some country targets are
// supported by the banner pipeline before the external translator supports
// them; return null there and let the planner use the AI-copy fallback.
function mapLanguageToLocale(language: string): string | null {
  const map: Record<string, string> = {
    en: "en-GB",
    fr: "fr-FR",
    it: "it-IT",
    nl: "nl-NL",
  };
  return map[language] ?? null;
}

function fallbackCopyFromConcept(args: {
  concept: AIConceptStub;
  brief: CampaignBrief;
  disclaimer: string | undefined;
}): LocalizedCopyBatchConcept {
  const copy = args.concept.copy_package;
  const fallbackDisclaimer =
    args.brief.risk_warning_required === false
      ? "Terms apply."
      : args.disclaimer || copy.disclaimer || "Investing involves risk.";
  return {
    conceptId: args.concept.concept_id,
    headline: copy.headline,
    subheadline: copy.subheadline,
    body: copy.body,
    cta: copy.cta,
    disclaimer: fallbackDisclaimer,
    complianceNotes: ["marketing-translator unavailable; used AI copy fallback"],
  };
}

function normalizeCopyForBrand(args: {
  copy: LocalizedCopyBatchConcept;
  concept: AIConceptStub;
  brandKit: BrandKitLite;
  brief: CampaignBrief;
}): LocalizedCopyBatchConcept {
  if (!usesMexemCopyGuard(args.brandKit)) return args.copy;

  const fallback = mexemFallbackCopy(args.concept, args.brief);
  const headline = fallback.headline;
  const cta = fallback.cta;
  const subheadline = fallback.subheadline;
  const body =
    args.copy.body &&
    (needsMexemCopyFallback(args.copy.body, "body") ||
      isEnglishMexemFallbackText(args.copy.body))
      ? fallback.body
      : args.copy.body;
  const disclaimer =
    args.brandKit.legal.disclaimers_by_language?.[args.brief.language] ??
    args.brandKit.legal.default_disclaimer ??
    args.copy.disclaimer;

  return {
    ...args.copy,
    headline,
    subheadline,
    body,
    cta,
    disclaimer,
  };
}

type MexemCopyIntent = "etf" | "markets" | "platform";
type MexemSupportedCopyLanguage = "en" | "fr" | "it" | "nl";

type MexemSafeCopy = Pick<
  LocalizedCopyBatchConcept,
  "headline" | "subheadline" | "body" | "cta"
>;

const MEXEM_SAFE_COPY: Record<
  MexemSupportedCopyLanguage,
  Record<MexemCopyIntent, MexemSafeCopy>
> = {
  en: {
    etf: {
      headline: "Build a broader market view",
      subheadline: "Compare instruments, follow data and act with a clearer picture.",
      body: "Bring stocks, ETFs and market insight into one disciplined workflow.",
      cta: "Compare markets",
    },
    markets: {
      headline: "Move with real-time markets",
      subheadline: "Watch prices, charts and order tools work together in one flow.",
      body: "Designed for self-directed investors who follow the market closely.",
      cta: "View tools",
    },
    platform: {
      headline: "Trade global markets with control",
      subheadline: "Advanced tools, real-time data and market access in one platform.",
      body: "A focused platform experience for investors who want depth without noise.",
      cta: "Explore platform",
    },
  },
  fr: {
    etf: {
      headline: "Construisez une vision de marche plus large",
      subheadline: "Comparez les instruments, suivez les donnees et gardez une vue claire.",
      body: "Rassemblez actions, ETF et donnees de marche dans un parcours discipline.",
      cta: "Comparer les marches",
    },
    markets: {
      headline: "Suivez les marches en temps reel",
      subheadline: "Prix, graphiques et outils d'ordre travaillent ensemble.",
      body: "Concu pour les investisseurs autonomes qui suivent les marches de pres.",
      cta: "Voir les outils",
    },
    platform: {
      headline: "Tradez les marches mondiaux avec controle",
      subheadline: "Outils avances, donnees en temps reel et acces marche en une plateforme.",
      body: "Une experience claire pour les investisseurs qui veulent de la profondeur.",
      cta: "Explorer la plateforme",
    },
  },
  it: {
    etf: {
      headline: "Amplia la tua visione sui mercati",
      subheadline: "Confronta strumenti, dati e mercati con un quadro piu chiaro.",
      body: "Porta azioni, ETF e dati di mercato in un flusso disciplinato.",
      cta: "Confronta i mercati",
    },
    markets: {
      headline: "Segui i mercati in tempo reale",
      subheadline: "Prezzi, grafici e strumenti d'ordine lavorano insieme.",
      body: "Pensato per investitori autonomi che seguono i mercati da vicino.",
      cta: "Vedi gli strumenti",
    },
    platform: {
      headline: "Opera sui mercati globali con controllo",
      subheadline: "Strumenti avanzati, dati live e accesso ai mercati in una piattaforma.",
      body: "Un'esperienza mirata per investitori che cercano profondita senza rumore.",
      cta: "Scopri la piattaforma",
    },
  },
  nl: {
    etf: {
      headline: "Bouw een breder marktbeeld",
      subheadline: "Vergelijk instrumenten, volg data en handel met meer overzicht.",
      body: "Breng aandelen, ETF's en marktdata samen in een duidelijke workflow.",
      cta: "Vergelijk markten",
    },
    markets: {
      headline: "Beweeg mee met realtime markten",
      subheadline: "Prijzen, grafieken en ordertools werken samen in een flow.",
      body: "Gemaakt voor zelfstandige beleggers die de markt nauw volgen.",
      cta: "Bekijk tools",
    },
    platform: {
      headline: "Trade wereldmarkten met controle",
      subheadline: "Geavanceerde tools, realtime data en markttoegang in een platform.",
      body: "Een gerichte platformervaring voor beleggers die diepgang willen.",
      cta: "Verken platform",
    },
  },
};

const MEXEM_SAFE_DESIGN_ELEMENTS: Record<
  MexemSupportedCopyLanguage,
  Record<MexemCopyIntent, NonNullable<AIConceptStub["design_elements"]>>
> = {
  en: {
    etf: { eyebrow: "ETF COSTS" },
    markets: { eyebrow: "GLOBAL ACCESS" },
    platform: { eyebrow: "CLEAR COSTS" },
  },
  fr: {
    etf: { eyebrow: "COUTS ETF" },
    markets: { eyebrow: "ACCES GLOBAL" },
    platform: { eyebrow: "COUTS CLAIRS" },
  },
  it: {
    etf: { eyebrow: "COSTI ETF" },
    markets: { eyebrow: "ACCESSO GLOBALE" },
    platform: { eyebrow: "COSTI CHIARI" },
  },
  nl: {
    etf: { eyebrow: "ETF-KOSTEN" },
    markets: { eyebrow: "WERELDWIJDE TOEGANG" },
    platform: { eyebrow: "DUIDELIJKE KOSTEN" },
  },
};

const ENGLISH_MEXEM_FALLBACK_PHRASES = [
  "build a broader market view",
  "compare instruments",
  "bring stocks",
  "compare markets",
  "move with real-time markets",
  "watch prices",
  "view tools",
  "trade global markets with control",
  "advanced tools",
  "explore platform",
];

function isEnglishMexemFallbackText(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return ENGLISH_MEXEM_FALLBACK_PHRASES.some((phrase) =>
    normalized.includes(phrase),
  );
}

function normalizeDesignElementsForBrand(args: {
  concept: AIConceptStub;
  brandKit: BrandKitLite;
  brief: CampaignBrief;
}): AIConceptStub["design_elements"] {
  if (!usesMexemCopyGuard(args.brandKit)) return args.concept.design_elements;
  const language = mexemSupportedCopyLanguage(args.brief);
  const intent = inferMexemCopyIntent(args.concept, args.brief);
  return MEXEM_SAFE_DESIGN_ELEMENTS[language][intent];
}

function usesMexemCopyGuard(brandKit: BrandKitLite): boolean {
  return (
    brandKit.brand_name.toLowerCase().includes("mexem") ||
    (
      brandKit.colors.background.includes("#00122C") &&
      brandKit.colors.background.includes("#006A97")
    )
  );
}

function needsMexemCopyFallback(
  text: string | undefined,
  field: "headline" | "subheadline" | "body" | "cta",
): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const banned = [
    /\bachiev(e|ing)\b/,
    /\bmaster\b/,
    /\bmastery\b/,
    /\bcommand\b/,
    /\bdominat(e|ion)\b/,
    /\bstay ahead\b/,
    /\bstay aligned\b/,
    /\bmarket dynamics\b/,
    /\bportfolio\b/,
    /\bbeat the market\b/,
    /\bwin\b/,
    /\bunlock\b/,
    /\beffortless\b/,
    /\beasy\b/,
    /\bguarantee/,
    /\bprofit\b/,
    /\b(profitto|profitti|guadagni?|rendimenti?)\b/,
    /\b(profits?|gains?|rendements?|winst|rendement)\b/,
  ];
  if (banned.some((re) => re.test(normalized))) return true;
  if (field === "cta") {
    return /\b(options?|strateg(y|ies)|insights?)\b/.test(normalized);
  }
  return false;
}

function _mirrorsConceptName(headline: string, conceptName: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const h = normalize(headline);
  const c = normalize(conceptName);
  return h === c || h.includes(c) || c.includes(h);
}

function mexemFallbackCopy(
  concept: AIConceptStub,
  brief: CampaignBrief,
): Pick<LocalizedCopyBatchConcept, "headline" | "subheadline" | "body" | "cta"> {
  const language = mexemSupportedCopyLanguage(brief);
  const intent = inferMexemCopyIntent(concept, brief);
  return MEXEM_SAFE_COPY[language][intent];
}

function mexemSupportedCopyLanguage(
  brief: CampaignBrief,
): MexemSupportedCopyLanguage {
  return brief.language === "fr" ||
    brief.language === "it" ||
    brief.language === "nl"
    ? brief.language
    : "en";
}

function inferMexemCopyIntent(
  concept: AIConceptStub,
  brief: CampaignBrief,
): MexemCopyIntent {
  const conceptText = [
    concept.name,
    concept.strategic_idea,
    concept.target_emotion,
    concept.desired_visual_context,
  ]
    .join(" ")
    .toLowerCase();
  const fullText = [
    conceptText,
    brief.marketing_message,
  ]
    .join(" ")
    .toLowerCase();
  if (/\b(etf|diversif|discipline|balanced)\b/.test(conceptText)) return "etf";
  if (/\betfs?\b/.test(fullText)) return "etf";
  if (
    /\b(stock|equities|move|alert|real-time|instant|access)\b/.test(
      conceptText,
    ) ||
    /\b(mercati|mondo|istantaneo|accesso|globali?|mondiaux|wereld|markten|toegang)\b/.test(
      conceptText,
    )
  ) {
    return "markets";
  }
  return "platform";
}

// ── File IO ─────────────────────────────────────────────────────────────────
export async function saveCampaignPlan(
  cwd: string,
  plan: CampaignPlan,
): Promise<string> {
  const dir = path.join(cwd, "data", "campaigns", plan.campaign_id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "campaign-plan.json");
  await fs.writeFile(filePath, JSON.stringify(plan, null, 2) + "\n", "utf8");
  return filePath;
}

export async function loadCampaignPlanIfExists(
  campaign_id: string,
  cwd: string = process.cwd(),
): Promise<CampaignPlan | null> {
  const filePath = path.join(
    cwd,
    "data",
    "campaigns",
    campaign_id,
    "campaign-plan.json",
  );
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return CampaignPlanSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadCampaignIndex(
  cwd: string = process.cwd(),
): Promise<CampaignIndexFile> {
  const filePath = path.join(cwd, "data", "campaigns", "index.generated.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return CampaignIndexFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generated_at: new Date().toISOString(),
        active_campaign_id: null,
        campaigns: [],
      };
    }
    throw err;
  }
}

async function upsertCampaignIndex(
  cwd: string,
  plan: CampaignPlan,
): Promise<string> {
  const file = await loadCampaignIndex(cwd);
  const ad_count = plan.concepts.reduce((acc, c) => acc + c.ad_specs.length, 0);
  const entry: CampaignIndexEntry = {
    campaign_id: plan.campaign_id,
    brand_id: plan.brand_id,
    campaign_name: plan.campaign_name,
    ai_provider: plan.ai_provider,
    concept_count: plan.concepts.length,
    ad_count,
    created_at: plan.created_at,
    active: file.active_campaign_id === plan.campaign_id,
    rendered: false,
  };
  const next: CampaignIndexFile = {
    generated_at: new Date().toISOString(),
    active_campaign_id: file.active_campaign_id,
    campaigns: [
      entry,
      ...file.campaigns.filter((c) => c.campaign_id !== plan.campaign_id),
    ],
  };
  const dir = path.join(cwd, "data", "campaigns");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "index.generated.json");
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return filePath;
}

export async function setActiveCampaign(
  cwd: string,
  campaign_id: string,
  pointer_path: string,
): Promise<void> {
  const file = await loadCampaignIndex(cwd);
  const next: CampaignIndexFile = {
    generated_at: new Date().toISOString(),
    active_campaign_id: campaign_id,
    campaigns: file.campaigns.map((c) => ({
      ...c,
      active: c.campaign_id === campaign_id,
    })),
  };
  const indexPath = path.join(cwd, "data", "campaigns", "index.generated.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(next, null, 2) + "\n", "utf8");

  const activeFile = ActiveCampaignFileSchema.parse({
    campaign_id,
    pointer_path: path.relative(cwd, pointer_path),
    set_at: new Date().toISOString(),
  });
  await fs.writeFile(
    path.join(cwd, "data", "active-campaign.generated.json"),
    JSON.stringify(activeFile, null, 2) + "\n",
    "utf8",
  );
}

export async function loadActiveCampaignPointer(
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(cwd, "data", "active-campaign.generated.json"),
      "utf8",
    );
    const parsed = ActiveCampaignFileSchema.parse(JSON.parse(raw));
    return parsed.campaign_id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function shortId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
    .join("; ");
}

function inferHeadlineEmphasis(headline: string): string | undefined {
  const s = headline.trim();
  if (s.length < 8) return undefined;

  for (const match of s.matchAll(/[,.:;!?]/g)) {
    const end = (match.index ?? -1) + 1;
    if (end >= 4 && end < s.length && end <= Math.ceil(s.length * 0.72)) {
      return s.slice(0, end);
    }
  }

  const words = s.split(/\s+/);
  if (words.length < 2) return undefined;
  if (words.length === 2) return words[0];
  const count = Math.min(Math.max(2, Math.ceil(words.length / 2)), words.length - 1);
  return words.slice(0, count).join(" ");
}

// Summarise blocking deterministic-QA violations for the planner error.
// Grouped per banner so the operator can tell which concept/format is broken
// (a single bad concept usually shows up across all formats).
function formatQaBlocks(report: DeterministicCampaignReport): string {
  const lines: string[] = [];
  for (const b of report.banners) {
    const blocks = b.violations.filter((v) => v.severity === "block");
    if (blocks.length === 0) continue;
    const detail = blocks
      .map((v) => `${v.check_id}: ${v.description}`)
      .join(" | ");
    lines.push(`[${b.concept_id} ${b.format}] ${detail}`);
  }
  return lines.join(" — ");
}

// Drop repeated identical warnings while preserving first-seen order.
// Example: a "downgrade: cta.weight=loud → standard" message that fires
// per-format (3 formats × 3 concepts = 9 lines) collapses to a single line.
function dedupePreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of arr) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}
