import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadScreenshotTagFile,
  writeScreenshotTagFile,
  ScreenshotTagFileSchema,
} from "@/lib/preview/inferScreenshotContext";

// /api/screenshot-tags
//   GET  → returns the current screenshot-tags.json contents (or [])
//   POST → writes the body { tags: [...] } to the sidecar file
//
// Local development tool only. Writes to brand-input/Platform screenshot/.
// Do not enable in production: there is no auth, by design.

const PostBodySchema = z.object({
  tags: ScreenshotTagFileSchema,
});

export async function GET() {
  const tags = await loadScreenshotTagFile();
  return NextResponse.json({ ok: true, tags });
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
  await writeScreenshotTagFile(parsed.data.tags);
  return NextResponse.json({ ok: true, count: parsed.data.tags.length });
}
