import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

const QaRequestSchema = z.object({
  campaignId: z.string().min(1),
  specId: z.string().min(1).optional(),
  manifestId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

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
