#!/usr/bin/env tsx
/**
 * Generate one campaign from a built-in sample brief using AI_PROVIDER=mock
 * (deterministic, no network, no API key needed). Marks it as active.
 *
 * Run with: `npm run campaign:generate-mock`
 *
 * Useful for:
 *   - Verifying the planner pipeline end-to-end without spending tokens.
 *   - Bootstrapping a fresh checkout into a renderable state.
 */
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { planCampaign } from "@/lib/ai/campaignPlanner";
import {
  CampaignBriefSchema,
  type CampaignFormat,
} from "@/lib/schemas/campaignBrief.schema";

const SUPPORTED_FORMATS: CampaignFormat[] = [
  "1200x628",
  "1080x1080",
  "1080x1920",
  "1200x1200",
  "300x250",
  "336x280",
  "960x1200",
  "320x100",
  "320x50",
  "300x1050",
  "300x600",
  "160x600",
  "970x250",
  "728x90",
  "250x250",
];

async function main() {
  await loadEnvLocalIfPresent();
  console.log("Generating mock campaign — AI_PROVIDER=mock (deterministic).\n");

  const brief = CampaignBriefSchema.parse({
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    brand_id: "brand_001",
    marketing_message: "Trade global markets with confidence",
    target_audience:
      "self-directed retail investors comfortable with charts and order tools",
    campaign_goal: "consideration",
    tone: ["confident", "trustworthy", "premium"],
    platforms: ["instagram-feed", "instagram-story", "linkedin"],
    required_formats: SUPPORTED_FORMATS,
    preferred_contexts: ["stocks", "etfs", "charts"],
    risk_warning_required: true,
    notes: "Sample brief shipped with the repo for end-to-end testing.",
    created_at: new Date().toISOString(),
  });

  const result = await planCampaign({
    brief,
    providerName: "mock",
    setAsActive: true,
  });

  const totalAds = result.plan.concepts.reduce(
    (acc, c) => acc + c.ad_specs.length,
    0,
  );

  console.log("Summary");
  console.log("─".repeat(72));
  console.log(`  campaign_id:      ${result.plan.campaign_id}`);
  console.log(`  campaign_name:    ${result.plan.campaign_name}`);
  console.log(`  ai_provider:      ${result.plan.ai_provider}`);
  console.log(`  concepts:         ${result.plan.concepts.length}`);
  console.log(`  ads:              ${totalAds} (${result.plan.concepts.length} × ${totalAds / result.plan.concepts.length})`);
  console.log(`  active:           ${result.active ? "yes" : "no"}`);
  console.log(`  saved_path:       ${path.relative(process.cwd(), result.saved_path)}`);
  if (result.plan.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    console.log("─".repeat(72));
    for (const w of result.plan.warnings) console.log(`  ! ${w}`);
  }
  console.log("");
  console.log("Concepts");
  console.log("─".repeat(72));
  for (const c of result.plan.concepts) {
    console.log(`  • ${c.name} — ${c.target_emotion} — ${c.desired_visual_context}`);
    console.log(`    headline:    ${c.copy_package.headline}`);
    console.log(`    cta:         ${c.copy_package.cta}`);
    console.log(`    ads:         ${c.ad_specs.map((s) => s.format).join(", ")}`);
  }
  console.log("");
  console.log("Next:");
  console.log("  npm run render:code-campaign      # render the active campaign as PNGs");
  console.log("  npm run campaign:list             # list all campaigns");
  console.log("  open http://localhost:3000/visual-preview");
  console.log("  open http://localhost:3000/campaigns/" + result.plan.campaign_id);
}

main().catch((err) => {
  console.error("campaign:generate-mock failed:", (err as Error).message);
  process.exit(1);
});
