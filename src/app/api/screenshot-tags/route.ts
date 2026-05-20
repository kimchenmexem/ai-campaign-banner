import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadScreenshotTagFile,
  writeScreenshotTagFile,
  ScreenshotTagFileSchema,
} from "@/lib/preview/inferScreenshotContext";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// /api/screenshot-tags
//   GET  → returns the current screenshot-tags.json contents (or []) — viewer
//   POST → writes the body { tags: [...] } to the sidecar file — editor,
//          dev-only (refused in production)

const PostBodySchema = z.object({
  tags: ScreenshotTagFileSchema,
});

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const tags = await loadScreenshotTagFile();
  return NextResponse.json({ ok: true, tags });
}

export async function POST(request: Request) {
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.write, auth);
  if (limited) return limited;

  const json = await request.json().catch(() => null);
  const parsed = PostBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  await writeScreenshotTagFile(parsed.data.tags);
  return NextResponse.json({ ok: true, count: parsed.data.tags.length });
}
