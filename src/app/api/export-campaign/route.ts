import { NextResponse } from "next/server";
import { z } from "zod";

const ExportRequestSchema = z.object({
  campaignId: z.string().min(1),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = ExportRequestSchema.safeParse(json);
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
