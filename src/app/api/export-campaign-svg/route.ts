import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignCombinedSvg } from "@/lib/export/exportCampaignCombinedSvg";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-campaign-svg?campaign_id=cam_xxxxxxxx
//   ?embed=1  — base64-embed local assets (default OFF — Cloudinary refs stay
//               remote to keep the master file under Vercel's response cap).
//   ?cols=N   — override the 3-column default grid (clamped 1..8).
//
// Returns ONE .svg file that contains every banner of the campaign laid out
// in a grid, each banner nested as its own <svg> with a Figma-friendly
// frame-name. Designed for the "drag one file into Figma → get all banners
// as separate frames" workflow.

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
  embed: z.string().optional(),
  cols: z.string().optional(),
});

export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    campaign_id: url.searchParams.get("campaign_id"),
    embed: url.searchParams.get("embed") ?? undefined,
    cols: url.searchParams.get("cols") ?? undefined,
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
    const cols = parsed.data.cols ? Number.parseInt(parsed.data.cols, 10) : undefined;
    const result = await exportCampaignCombinedSvg({
      plan,
      embedLocalImages: parsed.data.embed === "1",
      cols: Number.isFinite(cols) ? cols : undefined,
    });

    if (result.succeeded.length === 0 && result.failed.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "all_ads_failed",
          failures: result.failed,
        },
        { status: 500 },
      );
    }

    return new Response(result.svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
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
