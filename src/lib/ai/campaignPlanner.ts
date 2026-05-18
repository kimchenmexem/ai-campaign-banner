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
  type CampaignPlan,
  type CampaignIndexEntry,
  type CampaignIndexFile,
} from "@/lib/schemas/aiCampaignPlan.schema";
import type { VisualLayoutSpec } from "@/lib/schemas/visualLayoutSpec.schema";
import {
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import {
  loadAdBuildContext,
  buildConceptsFromPlan,
} from "@/lib/ai/buildAdSpecsFromPlan";
import {
  generateImageOpenAI,
  readImageProviderName,
  type ImageProviderName,
} from "@/lib/ai/imageProvider";
import {
  loadMidjourneyUploads,
  writeMidjourneyUploads,
} from "@/lib/midjourney/loadUploads";
import { fetchCampaignCopy } from "@/lib/marketing-translator/client";
import type { LocalizedCopyPackage } from "@/lib/marketing-translator/schema";
import {
  DEFAULT_IMAGE_GENERATION_MODE,
  type ImageGenerationMode,
} from "@/lib/ai/imageGenerationMode";
import { getCampaignRepository } from "@/lib/repositories/CampaignRepository";

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

export interface PlanCampaignOptions {
  brief: CampaignBrief;
  // Override the env var when calling programmatically (tests, scripts).
  providerName?: AIProviderName;
  // When true, mark the new campaign as active after saving. Default: false.
  setAsActive?: boolean;
  // When set to "openai", auto-generate one background image per concept via
  // the OpenAI Images API and append it as an approved upload. The downstream
  // applyConceptVisuals will then pick it up by context match. When "none" or
  // omitted (default), no images are generated — manual Midjourney uploads via
  // /midjourney still work.
  imageProvider?: ImageProviderName;
  // Which prompts to send to the image provider when `imageProvider === "openai"`.
  //   "background-only" — one image per concept (the background prompt).
  //                       Default, matches per-route docs and keeps cost
  //                       predictable.
  //   "all-prompts"     — every prompt in midjourney_prompt_pack
  //                       (background + decorative + hero + …), so a 3-concept
  //                       campaign with 3 prompts each generates 9 images.
  imageGenerationMode?: ImageGenerationMode;
  cwd?: string;
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
  const copyByConceptId = new Map<string, LocalizedCopyPackage>();
  for (const concept of refined.concepts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const copy = await fetchCampaignCopy(
        {
          brief: {
            marketingMessage: brief.marketing_message,
            campaignGoal: brief.campaign_goal,
            targetAudience: brief.target_audience,
            notes: brief.notes,
          },
          targetLocale,
          tone: brief.tone,
          riskWarningRequired: brief.risk_warning_required,
          conceptHint: {
            conceptId: concept.concept_id,
            name: concept.name,
            strategicIdea: concept.strategic_idea,
          },
        },
        { signal: controller.signal },
      );
      copyByConceptId.set(concept.concept_id, copy);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `marketing-translator timed out for concept ${concept.concept_id}`,
        );
      }
      throw new Error(
        `marketing-translator failed for concept ${concept.concept_id}: ${redactSecret((err as Error).message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  refined = {
    ...refined,
    concepts: refined.concepts.map((c) => {
      const localized = copyByConceptId.get(c.concept_id);
      if (!localized) return c;
      return {
        ...c,
        copy_package: {
          ...c.copy_package,
          headline: localized.headline,
          subheadline: localized.subheadline,
          body: localized.body ?? c.copy_package.body,
          cta: localized.cta,
          disclaimer: localized.disclaimer,
          // Drop fields that came from the LLM and no longer match the
          // localized headline/cta. headline_emphasis was a verbatim
          // prefix of the LLM headline; alternates / platform variations
          // are out of contract for the translator service.
          headline_emphasis: undefined,
          alternative_headlines: [],
          alternative_ctas: [],
          platform_copy_variations: [],
        },
      };
    }),
  };
  const translatorWarnings: string[] = [];
  for (const [conceptId, copy] of copyByConceptId) {
    for (const note of copy.complianceNotes) {
      translatorWarnings.push(`marketing-translator [${conceptId}]: ${note}`);
    }
  }

  // 3. Optional image generation. When the operator opted in, send each
  // concept's background prompt to OpenAI Images and persist the result as an
  // approved upload. After this runs we reload the build context so the next
  // step can see the newly-generated uploads alongside any manual Midjourney
  // ones. The Element Manifest stays the source of truth — generated images
  // travel through the same upload schema as manual Midjourney outputs.
  const imageProviderName = opts.imageProvider ?? readImageProviderName();
  const imageGenerationMode =
    opts.imageGenerationMode ?? DEFAULT_IMAGE_GENERATION_MODE;
  let images: ImageGenerationSummary | undefined;
  let buildContext = ctx;
  if (imageProviderName === "openai") {
    images = await generateImagesForConcepts(refined, cwd, imageGenerationMode);
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

  // 6. Save. In production this hits the Supabase-backed repository;
  // locally it falls through to the JSON files. The legacy file paths are
  // also kept up-to-date in local dev so scripts that read them directly
  // (e.g. render-code-campaign.ts) keep working.
  const repo = getCampaignRepository();
  await repo.insertCampaign(planCandidate);
  let saved_path = "supabase://campaigns";
  let index_path = "supabase://campaigns";
  if (repo.driver === "local") {
    saved_path = await saveCampaignPlan(cwd, planCandidate);
    index_path = await upsertCampaignIndex(cwd, planCandidate);
  }
  let active = false;
  if (opts.setAsActive) {
    await repo.setActiveCampaign(planCandidate.campaign_id);
    if (repo.driver === "local") {
      await setActiveCampaign(cwd, planCandidate.campaign_id, saved_path);
    }
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
  mode: ImageGenerationMode,
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
    // Default mode generates only the background prompt per concept. The
    // route comment + cost estimate match this number. "all-prompts" runs
    // every prompt (decorative, hero, etc.) and is opt-in.
    const promptsForThisConcept =
      mode === "background-only"
        ? concept.midjourney_prompt_pack
            .filter((p) => p.intended_use === "background")
            .slice(0, 1)
        : concept.midjourney_prompt_pack;
    if (promptsForThisConcept.length === 0) {
      // Concept has no background prompt and the caller asked for
      // background-only. Fall through to the first prompt of any context so
      // each concept still gets one generated image (matches the documented
      // contract: one image per concept).
      if (mode === "background-only" && concept.midjourney_prompt_pack[0]) {
        promptsForThisConcept.push(concept.midjourney_prompt_pack[0]);
      } else {
        continue;
      }
    }
    for (const prompt of promptsForThisConcept) {
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
// marketing-translator's /api/campaign-copy expects. RTL languages (he/ar)
// are first-class — the renderer already has the font stack + RTL handling
// for both, and the translator stub / mock honours them.
export function mapLanguageToLocale(language: string): string {
  const map: Record<string, string> = {
    en: "en-GB",
    fr: "fr-FR",
    it: "it-IT",
    nl: "nl-NL",
    he: "he-IL",
    // ar-AE is the finance-region default for Arabic; override per-brief
    // with `target_locale` once the translator exposes regional variants.
    ar: "ar-AE",
  };
  const locale = map[language];
  if (!locale) {
    throw new Error(
      `marketing-translator does not yet support language "${language}". Supported: ${Object.keys(map).join(", ")}.`,
    );
  }
  return locale;
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
  // Repository wins. In dev with the local driver, it reads the same JSON
  // file the legacy code path used; in production it reads Supabase.
  try {
    return await getCampaignRepository().getCampaign(campaign_id);
  } catch (err) {
    // If the repo factory threw because Supabase isn't configured but we're
    // not in production, fall through to the legacy file path so dev work
    // keeps working.
    if (process.env.NODE_ENV === "production") throw err;
    void cwd;
  }
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
