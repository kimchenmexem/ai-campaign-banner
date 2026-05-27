import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { renderCampaign } from "@/lib/render/renderCampaign";

// POST /api/render-campaign
// Body: { campaign_id: string, base_url?: string, run_vision_qa?: boolean }
//
// Renders all (concept × format) ad PNGs for the given campaign via headless
// Chromium. Synchronous — typically takes 20-40 seconds. The response carries
// the render map so the client can render thumbnails immediately.
//
// Vision QA is intentionally opt-in here. The campaign page has a separate
// "Run Vision QA" action; doing QA inside render makes the planner look stuck
// on "Rendering" after PNGs already finished.

const RequestSchema = z.object({
  campaign_id: z.string().min(1),
  // Optional override; defaults to NEXT_PUBLIC_APP_URL or localhost.
  base_url: z.string().url().optional(),
  run_vision_qa: z.boolean().optional(),
});

// Render is long-running — give it room. Next 16 caps at the platform's
// max-duration; on Vercel this needs an explicit hint.
export const maxDuration = 120;

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
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

  // Resolve the base URL. Render hits this same Next server for
  // /render/ad/[adId], so the URL must point back at us. Priority:
  //   1. explicit override in the body
  //   2. the request's own origin (always correct in dev)
  //   3. NEXT_PUBLIC_APP_URL (may be production URL)
  //   4. localhost:3000 default
  // Putting requestOrigin BEFORE the env var keeps dev working when
  // NEXT_PUBLIC_APP_URL points at production or a different port.
  const requestOrigin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      return null;
    }
  })();
  const baseUrl =
    parsed.data.base_url ??
    requestOrigin ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";

  try {
    const result = await renderCampaign(plan, baseUrl, {
      runVisionQa: parsed.data.run_vision_qa === true,
    });
    return NextResponse.json({
      ok: true,
      campaign_id: parsed.data.campaign_id,
      total: result.map.total,
      completed: result.map.completed,
      failed: result.map.failed,
      base_url: baseUrl,
      items: result.map.items,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "render_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
