import { NextResponse } from "next/server";
import {
  CampaignDefaultsSchema,
  type CampaignDefaults,
} from "@/lib/settings/campaignDefaults.schema";
import {
  loadCampaignDefaults,
  saveCampaignDefaults,
} from "@/lib/settings/campaignDefaultsStore";

function redact(s: string): string {
  return s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

export async function GET() {
  try {
    const settings = await loadCampaignDefaults();
    return NextResponse.json({ ok: true, settings });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "read_failed", message: redact((err as Error).message) },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const parsed = CampaignDefaultsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_campaign_defaults",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const settings: CampaignDefaults = await saveCampaignDefaults(parsed.data);
    return NextResponse.json({ ok: true, settings });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "write_failed", message: redact((err as Error).message) },
      { status: 500 },
    );
  }
}
