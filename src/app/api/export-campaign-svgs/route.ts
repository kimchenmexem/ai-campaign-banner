import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignSvgsZip } from "@/lib/export/exportCampaignSvgsZip";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-campaign-svgs?campaign_id=cam_xxxxxxxx
//   ?embed=1 — base64-embed local assets into each SVG (default OFF). The
//              default keeps Cloudinary refs remote, which is what makes this
//              bulk export safe under Vercel's ~4.5MB response cap even for
//              campaigns that include heavy product mockups.
//
// Returns a ZIP with one SVG per banner. Unlike /api/export-campaign-zip
// this has NO render dependency — it works directly from campaign-plan.json
// before "Render Campaign" has been clicked.

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
  embed: z.string().optional(),
});

export const maxDuration = 60;

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
    const result = await exportCampaignSvgsZip({
      plan,
      embedLocalImages: parsed.data.embed === "1",
    });

    // All ads failed — surface as a 500 so the client sees the error
    // instead of an empty/useless ZIP.
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

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(result.byteLength),
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        // Surface partial-failure info to clients that want it without
        // breaking the download itself. The body is still a valid ZIP that
        // contains a FAILED.txt entry for any per-ad errors.
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
