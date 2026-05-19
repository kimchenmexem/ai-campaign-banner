import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignPdf } from "@/lib/export/exportCampaignPdf";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-campaign-pdf?campaign_id=cam_xxxxxxxx
//   ?embed=1 — base64-embed local image assets into each banner before
//              the Chromium render pass. Default OFF; Chromium fetches
//              Cloudinary URLs directly while rendering, so the resulting
//              PDF contains real image data either way.
//
// Returns one PDF that contains every banner in the campaign, each as a
// separate page sized to its native pixel dimensions. Designed for the
// "drag one file into Figma → get one native frame per banner with real
// editable text + shapes" workflow.

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
  embed: z.string().optional(),
});

// Per-banner PDF render takes ~0.6-1.0s in Chromium. A 9-banner campaign
// fits comfortably; 90s leaves headroom for cold starts on Vercel.
export const maxDuration = 90;

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    campaign_id: url.searchParams.get("campaign_id"),
    embed: url.searchParams.get("embed") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const plan = await loadCampaignPlanIfExists(parsed.data.campaign_id);
  if (!plan) {
    return NextResponse.json(
      { ok: false, error: "campaign_not_found", campaign_id: parsed.data.campaign_id },
      { status: 404 },
    );
  }

  try {
    const result = await exportCampaignPdf({
      plan,
      embedLocalImages: parsed.data.embed === "1",
    });

    if (result.succeeded.length === 0 && result.failed.length > 0) {
      return NextResponse.json(
        { ok: false, error: "all_ads_failed", failures: result.failed },
        { status: 500 },
      );
    }

    return new Response(new Uint8Array(result.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.byteLength),
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Succeeded": String(result.succeeded.length),
        "X-Export-Failed": String(result.failed.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "export_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
