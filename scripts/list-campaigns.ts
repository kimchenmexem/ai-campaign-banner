#!/usr/bin/env tsx
/**
 * Print the local campaign index.
 * Run with: `npm run campaign:list`
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadCampaignIndex,
  loadActiveCampaignPointer,
} from "@/lib/ai/campaignPlanner";

async function main() {
  const file = await loadCampaignIndex();
  const active = await loadActiveCampaignPointer();
  console.log("Campaigns");
  console.log("─".repeat(72));
  if (file.campaigns.length === 0) {
    console.log("  (none)");
    console.log("");
    console.log("Tip: `npm run campaign:generate-mock` to generate a sample.");
    return;
  }
  for (const c of file.campaigns) {
    const tag = c.active ? "★" : " ";
    const renderTag = (await isRendered(c.campaign_id)) ? "✓ rendered" : "·";
    console.log(
      `${tag} ${c.campaign_id}  ${c.ai_provider.padEnd(9)}  ${c.concept_count}c × ${c.ad_count}a  ${renderTag}  ${c.campaign_name}`,
    );
  }
  console.log("");
  console.log(`active: ${active ?? "(none)"}`);
}

async function isRendered(campaign_id: string): Promise<boolean> {
  try {
    await fs.access(
      path.join(
        process.cwd(),
        "data",
        "campaigns",
        campaign_id,
        "code-render-map.generated.json",
      ),
    );
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("campaign:list failed:", (err as Error).message);
  process.exit(1);
});
