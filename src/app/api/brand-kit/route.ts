import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { BrandKitLiteSchema, type BrandKitLite } from "@/lib/schemas/brandKit.schema";

// Lightweight read + write API for data/brand-kit-lite.generated.json.
//
// The /settings page uses this to surface the current brand kit and to
// persist edits. The full kit is validated on every PATCH so the file on
// disk never holds a shape that would crash the planner / renderer.
//
// File write is atomic: write-to-temp + rename. The dev server reads the
// kit fresh on every render, so edits take effect on the next request
// without a restart.

const KIT_FILE = path.join(process.cwd(), "data", "brand-kit-lite.generated.json");

function redact(s: string): string {
  return s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

async function readKitFromDisk(): Promise<BrandKitLite> {
  const raw = await fs.readFile(KIT_FILE, "utf8");
  return BrandKitLiteSchema.parse(JSON.parse(raw));
}

export async function GET() {
  try {
    const kit = await readKitFromDisk();
    return NextResponse.json({ ok: true, kit });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "read_failed", message: redact((err as Error).message) },
      { status: 500 },
    );
  }
}

// Accepts the FULL brand kit (post-edit). We don't deep-merge on the
// server — the client sends the canonical shape it wants persisted.
// That keeps the contract simple and validation strict.
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

  const parsed = BrandKitLiteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_brand_kit",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const tmp = `${KIT_FILE}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
    await fs.rename(tmp, KIT_FILE);
    return NextResponse.json({ ok: true, kit: parsed.data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "write_failed", message: redact((err as Error).message) },
      { status: 500 },
    );
  }
}
