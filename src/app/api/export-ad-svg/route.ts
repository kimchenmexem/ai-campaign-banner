import { NextResponse } from "next/server";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportAdSvg } from "@/lib/export/exportAdSvg";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-ad-svg?campaign_id=cam_xxxxxxxx&ad_id=ad_concept_…
//   ?embed=0 — return SVG with raw image refs (Cloudinary/local paths) instead
//              of embedded base64 data URIs. Smaller file but only works inside
//              the dev server's network; default is to embed.
//
// Returns a single SVG of the whole banner — designed for drag-and-drop into
// Figma. Text elements stay editable, image elements ship as data URIs (so
// the file is portable), drop-shadows use SVG <filter feDropShadow>.

export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaign_id");
  const adId = url.searchParams.get("ad_id");
  const embed = url.searchParams.get("embed");

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
    const result = await exportAdSvg({
      plan,
      adId,
      embedLocalImages: embed !== "0",
    });
    return new Response(result.svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Length": String(result.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "export_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
