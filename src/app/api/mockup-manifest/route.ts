import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadMockupManifestArray,
  writeMockupManifest,
  MockupManifestFileSchema,
} from "@/lib/preview/mockupManifest";

// /api/mockup-manifest
//   GET  → returns the current mockup-manifest.json contents (or [])
//   POST → writes the body { entries: [...] } to the sidecar file

const PostBodySchema = z.object({
  entries: MockupManifestFileSchema,
});

export async function GET() {
  const entries = await loadMockupManifestArray();
  return NextResponse.json({ ok: true, entries });
}

export async function POST(request: Request) {
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
