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

// POST /api/generate-campaign
// Body: { brief: CampaignBriefInput, ai_provider?: "mock" | "openai" | "anthropic", set_as_active?: boolean }
//
// Validates the brief, calls the planner (which validates AI output and builds
// ad_specs deterministically), saves to data/campaigns/{id}/, returns the plan.
//
// Element Manifest is the source of truth at every step. AI output that fails
// schema validation is rejected with a clear error and not saved.

const RequestSchema = z.object({
  brief: CampaignBriefInputSchema,
  ai_provider: z.enum(["mock", "openai", "anthropic", "gemini"]).optional(),
  set_as_active: z.boolean().optional(),
  // Auto-generate one background image per concept via OpenAI Images.
  // Costs roughly $0.04-0.06 per image (3-9 cents per campaign at 3 concepts).
  auto_generate_images: z.boolean().optional(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Stamp a brief_id + created_at, then re-validate as a full CampaignBrief.
  const brief: CampaignBrief = CampaignBriefSchema.parse({
    ...parsed.data.brief,
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    created_at: new Date().toISOString(),
  });

  try {
    const result = await planCampaign({
      brief,
      providerName: parsed.data.ai_provider ?? readProviderName(),
      setAsActive: parsed.data.set_as_active ?? false,
      imageProvider: parsed.data.auto_generate_images ? "openai" : "none",
    });
    return NextResponse.json({
      ok: true,
      campaign_id: result.plan.campaign_id,
      plan: result.plan,
      saved_path: result.saved_path,
      active: result.active,
      images: result.images,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "planner_failed",
        message: redact((err as Error).message),
      },
      { status: 500 },
    );
  }
}

// Strip `Bearer ...` / `api_key=...` / `sk-...` from any error surface before
// it gets returned to the client.
function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
