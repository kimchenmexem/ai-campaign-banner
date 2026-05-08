import "server-only";
import type { CampaignRecord } from "@/lib/schemas/campaign.schema";
import type { Asset } from "@/lib/schemas/asset.schema";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import type { QaReport } from "@/lib/schemas/qaReport.schema";

export async function listCampaigns(): Promise<CampaignRecord[]> {
  return [];
}

export async function getCampaign(_id: string): Promise<CampaignRecord | null> {
  return null;
}

export async function insertCampaign(_record: CampaignRecord): Promise<void> {
  throw new Error("insertCampaign: not implemented");
}

export async function listAssetsByCampaign(_campaignId: string): Promise<Asset[]> {
  return [];
}

export async function insertAsset(_asset: Asset): Promise<void> {
  throw new Error("insertAsset: not implemented");
}

export async function insertElementManifest(_m: ElementManifest): Promise<void> {
  throw new Error("insertElementManifest: not implemented");
}

export async function insertQaReport(_r: QaReport): Promise<void> {
  throw new Error("insertQaReport: not implemented");
}
