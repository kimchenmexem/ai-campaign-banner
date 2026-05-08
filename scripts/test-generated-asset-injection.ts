#!/usr/bin/env tsx
/**
 * Phase 3 verification — wire generated assets into a mock campaign.
 *
 * What it does:
 *   1. Generates one of each asset type via the Asset Generator lib (in-process,
 *      no HTTP). Persists to data/generated-assets.generated.json + writes the
 *      bytes under public/generated-assets/.
 *   2. Runs the campaign planner with AI_PROVIDER=mock and the freshly-minted
 *      ids in `generated_asset_ids`.
 *   3. Walks the resulting manifests and prints which elements adopted a
 *      generated asset (source === "generated_asset" / generated_asset block).
 *
 * Run with:
 *   npx tsx scripts/test-generated-asset-injection.ts
 */
import crypto from "node:crypto";
import {
  loadBrandKit,
  generateBackground,
  generateCta,
  generateFxOverlay,
  generateTradingUi,
  persistAsset,
} from "@/lib/generators";
import { CampaignBriefSchema } from "@/lib/schemas/campaignBrief.schema";
import { planCampaign } from "@/lib/ai/campaignPlanner";

async function main() {
  const brandKit = await loadBrandKit();
  const ctx = { cwd: process.cwd(), brandKit };

  // 1. Generate one of each asset type. We persist them so the resolver can
  //    look them up by id later.
  const bgRes = await generateBackground(
    {
      variant: "linear_gradient",
      size: { width: 1080, height: 1080 },
      source_mode: "generated_only",
      angle_deg: 135,
      seed: 42,
    },
    ctx,
  );
  const ctaRes = await generateCta(
    {
      variant: "accent_block",
      text: "Start trading",
      size: { width: 480, height: 96 },
      output_mode: "element",
      arrow: "ltr",
    },
    ctx,
  );
  const fxRes = await generateFxOverlay(
    {
      variant: "vignette",
      size: { width: 1080, height: 1080 },
      intensity: 0.4,
      source_mode: "generated_only",
      brand_input_element_paths: [],
      seed: 7,
    },
    ctx,
  );
  const tuiRes = await generateTradingUi(
    { variant: "candle_chart", size: { width: 720, height: 480 }, ticker: "AAPL", seed: 99 },
    ctx,
  );

  const bg = await persistAsset({ result: bgRes });
  const cta = await persistAsset({ result: ctaRes });
  const fx = await persistAsset({ result: fxRes });
  const tui = await persistAsset({ result: tuiRes });

  // (Mockup omitted — needs a calibrated mockup + screenshot pair on disk.
  // Add manually via curl POST /api/generators/mockup if you want to exercise
  // that path too; the resolver will pick it up from the index file.)

  console.log("Generated:");
  console.log("  bg :", bg.id);
  console.log("  cta:", cta.id);
  console.log("  fx :", fx.id);
  console.log("  tui:", tui.id);

  // 2. Plan a mock campaign that injects all four ids.
  const brief = CampaignBriefSchema.parse({
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    brand_id: brandKit.brand_id,
    marketing_message: "Trade global markets with confidence",
    target_audience: "self-directed retail investors comfortable with charts",
    campaign_goal: "consideration",
    tone: ["confident", "trustworthy"],
    platforms: ["instagram-feed", "instagram-story", "linkedin"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["stocks", "etfs", "charts"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Phase 3 verification — generated-asset injection.",
    generated_asset_ids: [bg.id, cta.id, fx.id, tui.id],
    created_at: new Date().toISOString(),
  });

  const result = await planCampaign({
    brief,
    providerName: "mock",
    setAsActive: true,
  });

  // 3. Walk the manifests and surface every element that adopted a
  //    generated asset.
  console.log("");
  console.log("Manifest audit:");
  for (const concept of result.plan.concepts) {
    for (const ad of concept.ad_specs) {
      const adopted = ad.manifest.elements.filter(
        (el) => el.source === "generated_asset" || el.generated_asset !== undefined,
      );
      if (adopted.length === 0) continue;
      console.log(`  ${concept.concept_id}/${ad.format}:`);
      for (const el of adopted) {
        const ga = el.generated_asset;
        const tag = ga ? `${ga.type}:${ga.id}` : "(no provenance)";
        console.log(`    ${el.id.padEnd(28)} role=${el.role.padEnd(18)} → ${tag}`);
      }
    }
  }

  console.log("");
  console.log("Warnings:");
  for (const w of result.plan.warnings) console.log("  ·", w);
  if (result.plan.warnings.length === 0) console.log("  (none)");
  console.log("");
  console.log("✓ campaign_id:", result.plan.campaign_id);
  console.log("  Inspect: data/campaigns/" + result.plan.campaign_id + "/plan.generated.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
