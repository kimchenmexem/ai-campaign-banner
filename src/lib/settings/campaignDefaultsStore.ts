import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CampaignDefaultsSchema,
  DEFAULT_CAMPAIGN_DEFAULTS,
  type CampaignDefaults,
} from "@/lib/settings/campaignDefaults.schema";

export const CAMPAIGN_DEFAULTS_FILE = path.join(
  process.cwd(),
  "data",
  "campaign-defaults.generated.json",
);

export async function loadCampaignDefaults(): Promise<CampaignDefaults> {
  try {
    const raw = await fs.readFile(CAMPAIGN_DEFAULTS_FILE, "utf8");
    return CampaignDefaultsSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CAMPAIGN_DEFAULTS;
    }
    throw err;
  }
}

export async function saveCampaignDefaults(
  settings: CampaignDefaults,
): Promise<CampaignDefaults> {
  const parsed = CampaignDefaultsSchema.parse(settings);
  const tmp = `${CAMPAIGN_DEFAULTS_FILE}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  await fs.rename(tmp, CAMPAIGN_DEFAULTS_FILE);
  return parsed;
}
