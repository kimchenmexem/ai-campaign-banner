import { NextResponse } from "next/server";
import { z } from "zod";

const QaRequestSchema = z.object({
  campaignId: z.string().min(1),
  specId: z.string().min(1).optional(),
  manifestId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = QaRequestSchema.safeParse(json);
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
