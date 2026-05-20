import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignPlanZip } from "@/lib/export/exportCampaignPlan";
import { requireRole } from "@/lib/auth/guard";

// GET /api/export-campaign-zip?campaign_id=cam_xxxxxxxx
//
// DOWNLOAD-ONLY. Streams the existing ZIP back to the browser; never renders,
// never mutates anything. If the campaign has not been rendered + exported,
// returns 409 conflict with a hint to POST /api/campaigns/:id/export-jobs.
//
// (Pre-hardening behavior: a GET on this URL would *auto-render* the
// campaign — kicking off Playwright + Gemini Vision QA — which meant a
// download link could fire a 20-40s background job. That is fixed here.)

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
});

export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    campaign_id: url.searchParams.get("campaign_id"),
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
      { ok: false, error: "not_found", message: `Campaign ${parsed.data.campaign_id} not found.` },
      { status: 404 },
    );
  }

  // Refuse if the render artifacts that the ZIP needs aren't already on disk.
  // The export build path is POST /api/campaigns/[id]/export-jobs.
  const renderMapPath = path.join(
    process.cwd(),
    "data",
    "campaigns",
    plan.campaign_id,
    "code-render-map.generated.json",
  );
  const rendered = await pathExists(renderMapPath);
  if (!rendered) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_ready",
        message:
          "Campaign has no rendered PNGs yet. Enqueue a render job first: POST /api/campaigns/" +
          plan.campaign_id +
          "/render-jobs",
      },
      { status: 409 },
    );
  }

  try {
    const result = await exportCampaignPlanZip({ plan });
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(result.byteLength),
        "Content-Disposition": `attachment; filename="${result.filename}"`,
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
