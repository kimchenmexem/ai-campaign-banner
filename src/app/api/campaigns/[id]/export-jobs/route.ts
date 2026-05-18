import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";
import { enqueueAndMaybeRunInline } from "@/lib/jobs/enqueueWithOptionalInline";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";

const BodySchema = z
  .object({
    upload_to_storage: z.boolean().optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .partial();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

  const { id: campaignId } = await ctx.params;
  if (!campaignId) {
    return NextResponse.json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
  }
  const plan = await loadCampaignPlanIfExists(campaignId);
  if (!plan) {
    return NextResponse.json(
      { ok: false, error: "campaign_not_found", campaign_id: campaignId },
      { status: 404 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const job = await enqueueAndMaybeRunInline({
    type: "export",
    campaign_id: campaignId,
    created_by: auth.user_id,
    input: {
      campaign_id: campaignId,
      upload_to_storage: parsed.data.upload_to_storage ?? false,
    },
    idempotency_key: parsed.data.idempotency_key ?? null,
  });
  return NextResponse.json(
    { ok: true, job_id: job.id, job },
    { status: 202, headers: { Location: `/api/jobs/${job.id}` } },
  );
}
