#!/usr/bin/env tsx
/**
 * MEXEM Showcase v1 — plan one campaign that mixes pack assets across roles.
 *
 * Reads:
 *   data/mexem-pack-v1.generated.json  (built by build-mexem-asset-pack.ts)
 *
 * Picks one asset per role (background / CTA / mockup / FX / trading-UI),
 * stuffs the ids into a CampaignBrief.generated_asset_ids, plans the
 * campaign with AI_PROVIDER=mock so it's fully deterministic + offline.
 *
 * Sets it as the active campaign and prints a QA report:
 *   - generated_assets_used   (what landed)
 *   - generated_assets_warnings (refits, AR mismatches)
 *
 * To rasterise the banners (PNGs):
 *   1. npm run dev          # in another terminal
 *   2. npm run render:code-campaign
 *
 * Run with:
 *   npx tsx scripts/build-mexem-showcase-campaign.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CampaignBriefSchema } from "@/lib/schemas/campaignBrief.schema";
import { planCampaign } from "@/lib/ai/campaignPlanner";

interface PackEntry {
  id: string;
  type: "background" | "cta" | "mockup" | "trading_ui" | "fx_overlay";
  variant: string;
  recipe: string;
  recommended_use: string;
  tags: string[];
  approved: boolean;
}

const PACK_PATH = path.join("data", "mexem-pack-v1.generated.json");

async function main() {
  const pack = JSON.parse(await fs.readFile(PACK_PATH, "utf8")) as {
    built: PackEntry[];
  };

  // ── Curated mix ─────────────────────────────────────────────────────────
  // Pick one of each role. The picks below are intentional:
  //   - background → "global investing" mesh (1200×628 → fits leaderboard)
  //   - CTA        → English bottom-band (works with both LTR layouts)
  //   - mockup     → laptop + desktop screenshot (matches 1200×628 best)
  //   - FX         → soft white glow (subtle, doesn't drown text)
  //   - trading UI → bullish candle chart hero
  const pickByRecipe = (r: string) => {
    const hit = pack.built.find((p) => p.recipe === r);
    if (!hit) throw new Error(`Pack missing recipe "${r}". Re-run build-mexem-asset-pack.`);
    return hit;
  };
  const picks = [
    pickByRecipe("global-investing-2-mesh"),
    pickByRecipe("cta-en-long-bottom-band"),
    pickByRecipe("mock-laptop-1-desktop"),
    pickByRecipe("fx-glow-center"),
    pickByRecipe("tui-candle-up"),
  ];
  console.log("Showcase picks:");
  for (const p of picks) {
    console.log(`  · ${p.type.padEnd(10)} ${p.recipe.padEnd(32)} → ${p.id}`);
  }

  // ── Brief ───────────────────────────────────────────────────────────────
  // target_audience intentionally omitted — schema is now optional and the
  // form no longer collects it.
  const brief = CampaignBriefSchema.parse({
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    brand_id: "brand_001",
    marketing_message: "Trade global markets with confidence",
    campaign_goal: "consideration",
    tone: ["confident", "premium", "trustworthy"],
    platforms: ["instagram-feed", "instagram-story", "linkedin"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["stocks", "etfs", "charts"],
    risk_warning_required: true,
    notes: "MEXEM Pack v1 showcase — uses mixed pack picks across roles.",
    language: "en",
    creative_mode: "standard",
    generated_asset_ids: picks.map((p) => p.id),
    created_at: new Date().toISOString(),
  });

  // ── Plan ────────────────────────────────────────────────────────────────
  const result = await planCampaign({
    brief,
    providerName: "mock",
    setAsActive: true,
  });
  const totalAds = result.plan.concepts.reduce(
    (acc, c) => acc + c.ad_specs.length,
    0,
  );

  // ── QA report ───────────────────────────────────────────────────────────
  console.log("\nSummary");
  console.log("─".repeat(72));
  console.log(`  campaign_id:      ${result.plan.campaign_id}`);
  console.log(`  campaign_name:    ${result.plan.campaign_name}`);
  console.log(`  ai_provider:      ${result.plan.ai_provider}`);
  console.log(`  concepts:         ${result.plan.concepts.length}`);
  console.log(`  ads:              ${totalAds}`);
  console.log(`  active:           ${result.active ? "yes" : "no"}`);
  console.log(`  saved_path:       ${path.relative(process.cwd(), result.saved_path)}`);

  console.log("\ngenerated_assets_used (" + result.plan.generated_assets_used.length + "):");
  for (const id of result.plan.generated_assets_used) {
    const meta = picks.find((p) => p.id === id);
    console.log(`  · ${id}   ${meta ? "(" + meta.recipe + ")" : ""}`);
  }
  // Surface assets we asked for that didn't actually land.
  const wanted = new Set(picks.map((p) => p.id));
  const actuallyAdopted = new Set(result.plan.generated_assets_used);
  const skipped = [...wanted].filter((id) => !actuallyAdopted.has(id));
  if (skipped.length > 0) {
    console.log("\nAssets supplied but NOT adopted:");
    for (const id of skipped) console.log(`  · ${id}`);
  }

  console.log("\ngenerated_assets_warnings (" + result.plan.generated_assets_warnings.length + "):");
  for (const w of result.plan.generated_assets_warnings) console.log("  · " + w);

  if (result.plan.warnings.length > 0) {
    console.log("\nGeneral warnings (" + result.plan.warnings.length + "):");
    for (const w of result.plan.warnings) console.log("  · " + w);
  }

  // ── Per-format adoption breakdown ───────────────────────────────────────
  console.log("\nPer-ad adoption:");
  for (const c of result.plan.concepts) {
    for (const ad of c.ad_specs) {
      const adopted = ad.manifest.elements.filter(
        (el) => el.generated_asset !== undefined,
      );
      const labels = adopted.map(
        (el) => `${el.generated_asset!.type}:${el.id.replace(/^el_/, "")}`,
      );
      console.log(`  ${c.concept_id.padEnd(22)} ${ad.format}  →  ${labels.join(", ") || "—"}`);
    }
  }

  console.log("\nNext step (rasterise to PNGs):");
  console.log("  1. npm run dev          # in another terminal");
  console.log("  2. npm run render:code-campaign");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
