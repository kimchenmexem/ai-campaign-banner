import { NextResponse } from "next/server";
import {
  SaveFigmaAdapterCampaignSchema,
  saveFigmaAdapterCampaign,
} from "@/lib/figmaAdapter/campaign";

export const maxDuration = 60;

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = SaveFigmaAdapterCampaignSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await saveFigmaAdapterCampaign(parsed.data);
    return NextResponse.json({
      ok: true,
      campaign_id: result.campaign.campaign_id,
      campaign_name: result.campaign.campaign_name,
      saved_path: result.savedPath,
      href: `/campaigns/${result.campaign.campaign_id}`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "save_failed",
        message: redact((err as Error).message),
      },
      { status: 500 },
    );
  }
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
