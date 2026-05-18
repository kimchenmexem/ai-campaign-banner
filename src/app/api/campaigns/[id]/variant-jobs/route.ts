import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";
import { enqueueAndMaybeRunInline } from "@/lib/jobs/enqueueWithOptionalInline";
import { CampaignBriefInputSchema } from "@/lib/schemas/campaignBrief.schema";

const BodySchema = z.object({
  brief: CampaignBriefInputSchema,
  count: z.number().int().min(1).max(5).optional(),
  ai_provider: z.enum(["mock", "openai", "anthropic"]).optional(),
  set_first_active: z.boolean().optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

  const { id: campaignId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const job = await enqueueAndMaybeRunInline({
    type: "variants",
    campaign_id: campaignId ?? null,
    created_by: auth.user_id,
    input: {
      brief: parsed.data.brief,
      count: parsed.data.count,
      ai_provider: parsed.data.ai_provider,
      set_first_active: parsed.data.set_first_active,
    },
    idempotency_key: parsed.data.idempotency_key ?? null,
  });
  return NextResponse.json(
    { ok: true, job_id: job.id, job },
    { status: 202, headers: { Location: `/api/jobs/${job.id}` } },
  );
}
