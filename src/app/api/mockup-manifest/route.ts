import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadMockupManifestArray,
  writeMockupManifest,
  MockupManifestFileSchema,
} from "@/lib/preview/mockupManifest";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// /api/mockup-manifest
//   GET  → returns the current mockup-manifest.json contents (or []) — viewer
//   POST → writes the body { entries: [...] } — editor, dev-only

const PostBodySchema = z.object({
  entries: MockupManifestFileSchema,
});

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const entries = await loadMockupManifestArray();
  return NextResponse.json({ ok: true, entries });
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
  await writeMockupManifest(parsed.data.entries);
  return NextResponse.json({ ok: true, count: parsed.data.entries.length });
}
