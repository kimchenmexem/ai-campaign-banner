import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getCampaignRepository } from "@/lib/repositories/CampaignRepository";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import type { CampaignRecord } from "@/lib/schemas/campaign.schema";
import type { Asset } from "@/lib/schemas/asset.schema";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import type { QaReport } from "@/lib/schemas/qaReport.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Thin Supabase wrappers. Most modern callers should use the repository
// abstraction in `@/lib/repositories/CampaignRepository` directly — these
// helpers exist for legacy code that imports `listCampaigns` / `getCampaign`
// and for the sibling asset / manifest / qa tables that the planner writes.
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function client() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

// Records returned by `listCampaigns` historically conform to CampaignRecord
// (uuid id, status, brief). Modern code prefers CampaignIndexEntry. Both
// shapes are now derived from the underlying campaign plan.
function planToRecord(plan: CampaignPlan, updatedAt?: string): CampaignRecord {
  return {
    id: plan.campaign_id,
    brandId: plan.brand_id ?? null,
    status: "ready",
    brief: {
      message: plan.source_brief?.marketing_message ?? plan.campaign_summary,
      audience: plan.source_brief?.target_audience,
      goal: "awareness",
      channels: [],
      callToAction: undefined,
      brandId: plan.brand_id ?? undefined,
      notes: plan.source_brief?.notes,
    },
    createdAt: plan.created_at,
    updatedAt: updatedAt ?? plan.created_at,
  };
}

export async function listCampaigns(): Promise<CampaignRecord[]> {
  const repo = getCampaignRepository();
  const entries = await repo.listCampaigns();
  const records: CampaignRecord[] = [];
  for (const entry of entries) {
    const plan = await repo.getCampaign(entry.campaign_id);
    if (plan) records.push(planToRecord(plan, entry.updated_at));
  }
  return records;
}

export async function getCampaign(id: string): Promise<CampaignRecord | null> {
  const repo = getCampaignRepository();
  const plan = await repo.getCampaign(id);
  if (!plan) return null;
  return planToRecord(plan);
}

export async function insertCampaign(_record: CampaignRecord): Promise<void> {
  // Campaign insertion goes through `planCampaign` (which writes via the
  // repository); the audit-shaped CampaignRecord here is missing the rich
  // plan fields we need (concepts, ad_specs, source_brief). Surface a clear
  // error rather than synthesising an empty plan.
  void _record;
  throw new Error(
    "insertCampaign(CampaignRecord): not supported. Use planCampaign() or CampaignRepository.insertCampaign(CampaignPlan).",
  );
}

export async function listAssetsByCampaign(
  campaignId: string,
): Promise<Asset[]> {
  const { data, error } = await client()
    .from("campaign_assets")
    .select("asset")
    .eq("campaign_id", campaignId);
  if (error) throw new Error(`listAssetsByCampaign: ${error.message}`);
  return ((data ?? []) as Array<{ asset: Asset }>).map((r) => r.asset);
}

export async function insertAsset(asset: Asset): Promise<void> {
  const { error } = await client()
    .from("campaign_assets")
    .insert({ asset_id: asset.id, campaign_id: asset.campaignId, asset } as never);
  if (error) throw new Error(`insertAsset: ${error.message}`);
}

export async function insertElementManifest(m: ElementManifest): Promise<void> {
  const { error } = await client()
    .from("element_manifests")
    .insert({ manifest_id: m.manifestId, asset_id: m.specId, manifest: m } as never);
  if (error) throw new Error(`insertElementManifest: ${error.message}`);
}

export async function insertQaReport(r: QaReport): Promise<void> {
  const { error } = await client()
    .from("qa_reports")
    .insert({ report_id: r.reportId, asset_id: r.manifestId ?? r.specId ?? r.campaignId, report: r } as never);
  if (error) throw new Error(`insertQaReport: ${error.message}`);
}
