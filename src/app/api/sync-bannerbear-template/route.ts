import { NextResponse } from "next/server";
import { z } from "zod";

// POST /api/sync-bannerbear-template
// Pulls a fresh BannerbearTemplateSnapshot for one template UID and persists
// it. Used by the Settings page when a template is added or its layers change.
// Real work happens in lib/bannerbear/syncTemplate.ts (placeholder for now).

const SyncRequestSchema = z.object({
  templateUid: z.string().min(1),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = SyncRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { ok: false, error: "not_implemented" },
    { status: 501 },
  );
}
