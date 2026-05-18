import { NextResponse } from "next/server";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportAdElementsZip } from "@/lib/export/exportAdElements";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-ad-elements?campaign_id=cam_xxxxxxxx&ad_id=ad_concept_…
//
// Bundles every source asset that composed one rendered banner into a ZIP:
//   - the rendered PNG (when present)
//   - the Element Manifest (renderer's source of truth)
//   - one file per visible Element, named with z-index prefix so the folder
//     order matches stacking
//   - a README explaining how to recompose
//
// Returns the zip directly with Content-Disposition: attachment so the
// browser triggers a download.

export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaign_id");
  const adId = url.searchParams.get("ad_id");

  if (!campaignId || !adId) {
    return NextResponse.json(
      { ok: false, error: "missing_params", required: ["campaign_id", "ad_id"] },
      { status: 400 },
    );
  }

  const plan = await loadCampaignPlanIfExists(campaignId);
  if (!plan) {
    return NextResponse.json(
      { ok: false, error: "campaign_not_found", campaign_id: campaignId },
      { status: 404 },
    );
  }

  try {
    const result = await exportAdElementsZip({ plan, adId });
    // Return as a real binary attachment.
    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Length": String(result.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "export_failed",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
