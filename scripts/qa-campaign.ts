#!/usr/bin/env tsx
/**
 * Run Gemini Vision QA across every rendered banner of one campaign.
 *
 * Usage:
 *   npm run qa:campaign                          # the active campaign
 *   npm run qa:campaign -- --campaign-id=cam_xx  # an explicit one
 *
 * Output:
 *   data/campaigns/<id>/vision-qa.generated.json
 *
 * Requires:
 *   - GEMINI_API_KEY in .env.local
 *   - Campaign already rendered (npm run render:code-campaign)
 */
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import {
  loadActiveCampaignPointer,
  loadCampaignPlanIfExists,
} from "@/lib/ai/campaignPlanner";
import { runQaForCampaign } from "@/lib/qa/runQaForCampaign";

async function main() {
  await loadEnvLocalIfPresent();
  const cliCampaignId = parseFlag("--campaign-id");
  const campaignId = cliCampaignId ?? (await loadActiveCampaignPointer());
  if (!campaignId) {
    console.error(
      "✗ no campaign — pass --campaign-id=cam_xxx or set an active one.",
    );
    process.exit(2);
  }
  const plan = await loadCampaignPlanIfExists(campaignId);
  if (!plan) {
    console.error(`✗ campaign ${campaignId} not found.`);
    process.exit(2);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("✗ GEMINI_API_KEY missing in .env.local.");
    process.exit(2);
  }

  console.log(`Running Vision QA on ${plan.campaign_id} (${plan.concepts.reduce((s,c) => s + c.ad_specs.length, 0)} ads)…`);
  const t0 = Date.now();
  const result = await runQaForCampaign({ plan });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  total banners QAed:      ${result.map.total}`);
  console.log(`  banners with violations: ${result.map.with_violations}`);
  console.log(`  elapsed:                 ${elapsed}s`);
  if (result.errors.length > 0) {
    console.log(`  errors:                  ${result.errors.length}`);
    for (const e of result.errors) console.log(`    · ${e.ad_id}: ${e.message}`);
  }
  console.log("");

  // Per-concept breakdown.
  console.log("Per concept:");
  for (const c of result.map.concept_summary) {
    const sev = c.severities;
    console.log(
      `  ${c.concept_id}  (${c.banners_with_violations}/${c.total_banners} flagged, ` +
        `${c.violation_count} violations: block=${sev.block} warn=${sev.warn} info=${sev.info})`,
    );
  }

  // Top violating banners.
  const flagged = result.map.banners
    .filter((b) => b.violations.length > 0)
    .sort((a, b) => b.violations.length - a.violations.length);
  if (flagged.length > 0) {
    console.log("");
    console.log("Banners with violations:");
    for (const b of flagged) {
      console.log(`  ${b.ad_id}  (${b.format}) — ${b.violations.length} violation(s):`);
      for (const v of b.violations) {
        console.log(`    [${v.severity}] ${v.rule_id}: ${v.description}`);
      }
    }
  } else {
    console.log("");
    console.log("✓ No violations across the campaign.");
  }

  console.log("");
  console.log(`✓ Saved ${result.saved_path}`);
}

function parseFlag(name: string): string | null {
  const f = process.argv.find((a) => a.startsWith(name + "="));
  return f ? f.slice(name.length + 1) : null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
