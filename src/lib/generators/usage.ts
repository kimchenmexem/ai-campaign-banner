import { promises as fs } from "node:fs";
import path from "node:path";
import { CampaignPlanSchema } from "@/lib/schemas/aiCampaignPlan.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — compute "is this generated asset used in any campaign?" by
// scanning data/campaigns/<campaign_id>/campaign-plan.json files. The result
// drives:
//   - the "Show used only" gallery filter
//   - the DELETE refusal when an asset is referenced
//
// Why scan files instead of an index: there's no central usage table, and
// keeping one in sync with deletions/regenerations is fragile. A few-dozen
// JSON parses on demand is fine for the volumes we expect (low hundreds).
// ─────────────────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR = path.posix.join("data", "campaigns");
const PLAN_FILENAME = "campaign-plan.json";

export interface AssetUsage {
  // Asset id → list of campaign ids that reference it on at least one
  // element. Empty list means the asset is unused.
  byAssetId: Map<string, string[]>;
}

export async function computeAssetUsage(
  cwd: string = process.cwd(),
): Promise<AssetUsage> {
  const dir = path.join(cwd, CAMPAIGNS_DIR);
  const byAssetId = new Map<string, string[]>();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { byAssetId };
    }
    throw err;
  }

  for (const name of entries) {
    if (!name.startsWith("cam_")) continue;
    const planPath = path.join(dir, name, PLAN_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(planPath, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = CampaignPlanSchema.safeParse(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!parsed.success) continue;

    const seenInCampaign = new Set<string>();
    for (const concept of parsed.data.concepts) {
      for (const ad of concept.ad_specs) {
        for (const el of ad.manifest.elements) {
          const ga = el.generated_asset;
          if (ga?.id) seenInCampaign.add(ga.id);
        }
      }
    }
    for (const id of seenInCampaign) {
      const list = byAssetId.get(id) ?? [];
      list.push(parsed.data.campaign_id);
      byAssetId.set(id, list);
    }
  }
  return { byAssetId };
}

export async function isAssetUsed(
  id: string,
  cwd: string = process.cwd(),
): Promise<{ used: boolean; campaign_ids: string[] }> {
  const usage = await computeAssetUsage(cwd);
  const campaign_ids = usage.byAssetId.get(id) ?? [];
  return { used: campaign_ids.length > 0, campaign_ids };
}
