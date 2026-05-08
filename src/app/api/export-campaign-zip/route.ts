import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignPlanZip } from "@/lib/export/exportCampaignPlan";
import { renderCampaign } from "@/lib/render/renderCampaign";

// GET /api/export-campaign-zip?campaign_id=cam_xxxxxxxx
//
// Streams a self-contained ZIP back to the browser. Includes the validated
// CampaignPlan, all rendered PNGs, per-ad Element Manifests, and Midjourney
// prompt packs.
//
// When the campaign hasn't been rendered yet, this endpoint AUTO-RENDERS
// before zipping — the ZIP must always contain graphics, never just JSON.

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
});

export const maxDuration = 120;

export async function GET(request: Request) {
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
  try {
    // Auto-render if no PNGs exist yet. ZIPs without graphics are useless
    // for handoff — the recipient gets JSON they can't open in Photoshop.
    const renderMapPath = path.join(
      process.cwd(),
      "data",
      "campaigns",
      plan.campaign_id,
      "code-render-map.generated.json",
    );
    const alreadyRendered = await pathExists(renderMapPath);
    if (!alreadyRendered) {
      const requestOrigin = (() => {
        try {
          return new URL(request.url).origin;
        } catch {
          return null;
        }
      })();
      const baseUrl =
        requestOrigin ??
        process.env.NEXT_PUBLIC_APP_URL ??
        "http://localhost:3000";
      await renderCampaign(plan, baseUrl);
    }

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
