import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { runQaForCampaign } from "@/lib/qa/runQaForCampaign";
import { requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// POST /api/qa-campaign
// Body: { campaign_id: string }
//
// Runs Gemini Vision QA across every rendered banner in the campaign and
// writes the result to data/campaigns/<id>/vision-qa.generated.json.
//
// Requires GEMINI_API_KEY in .env.local. Surfaces partial failures as
// `errors` on the response so the campaign UI can flag which ads QA could
// not score.

export const maxDuration = 300;

const RequestSchema = z.object({ campaign_id: z.string().min(1) });

export async function POST(request: Request) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }
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
      {
        ok: false,
        error: "campaign_not_found",
        campaign_id: parsed.data.campaign_id,
      },
      { status: 404 },
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "gemini_key_missing",
        message: "GEMINI_API_KEY missing from .env.local — add it before running QA.",
      },
      { status: 500 },
    );
  }

  try {
    const result = await runQaForCampaign({ plan });
    return NextResponse.json({
      ok: true,
      campaign_id: plan.campaign_id,
      map: result.map,
      saved_path: result.saved_path,
      errors: result.errors,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "qa_failed",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
