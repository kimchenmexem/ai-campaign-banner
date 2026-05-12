import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CampaignBriefInputSchema,
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import { planCampaign } from "@/lib/ai/campaignPlanner";
import { readProviderName } from "@/lib/ai/provider";

// POST /api/generate-campaign-variants
//
// Runs `planCampaign` N times against the SAME brief, each with a different
// `diversity_seed`, so the operator can compare 3 variants of the same
// strategy (or skim 9 different concept-flavours when N=3 × 3 concepts).
//
// Body:
//   {
//     brief: CampaignBriefInput,
//     ai_provider?: "mock" | "openai" | "anthropic",
//     count?: number          // default 3, capped at 5 (cost protection)
//     set_first_active?: boolean   // default false
//   }
//
// Response:
//   { ok: true, variants: [{ campaign_id, plan_summary, diversity_seed }, …] }
//
// Cost note: each variant runs the full 3-pass AI pipeline. With openai
// that's ~$0.05 in tokens per variant, so 3 variants ≈ $0.15. The cap of 5
// is intentional to keep accidental clicks from spending dollars.

const RequestSchema = z.object({
  brief: CampaignBriefInputSchema,
  ai_provider: z.enum(["mock", "openai", "anthropic", "gemini"]).optional(),
  count: z.number().int().min(1).max(5).optional(),
  set_first_active: z.boolean().optional(),
});

export const maxDuration = 600;

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const count = parsed.data.count ?? 3;
  const provider = parsed.data.ai_provider ?? readProviderName();
  const setFirstActive = parsed.data.set_first_active ?? false;
  const baseSeed =
    parsed.data.brief.diversity_seed ?? Math.floor(Math.random() * 1_000_000);

  const variants: Array<{
    campaign_id: string;
    campaign_name: string;
    diversity_seed: number;
    saved_path: string;
  }> = [];
  const errors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < count; i++) {
    const seed = (baseSeed + i * 100003) % 2_000_000;
    const brief: CampaignBrief = CampaignBriefSchema.parse({
      ...parsed.data.brief,
      brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
      created_at: new Date().toISOString(),
      diversity_seed: seed,
    });
    try {
      const result = await planCampaign({
        brief,
        providerName: provider,
        setAsActive: setFirstActive && i === 0,
      });
      variants.push({
        campaign_id: result.plan.campaign_id,
        campaign_name: result.plan.campaign_name,
        diversity_seed: seed,
        saved_path: result.saved_path,
      });
    } catch (err) {
      errors.push({ index: i, message: redact((err as Error).message) });
    }
  }

  if (variants.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "all_variants_failed",
        errors,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    base_seed: baseSeed,
    variants,
    errors,
  });
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
