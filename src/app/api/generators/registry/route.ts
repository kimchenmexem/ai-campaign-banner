import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERATOR_REGISTRY } from "@/lib/generators/registry";
import { listAssets } from "@/lib/generators/storage";
import { computeAssetUsage } from "@/lib/generators/usage";
import { GeneratedAssetTypeSchema } from "@/lib/schemas/generatedAsset.schema";
import { requireRole } from "@/lib/auth/guard";

// GET /api/generators/registry
//   ?type=background|cta|mockup|trading_ui|fx_overlay  (optional)
//   ?limit=10                                          (optional)
//   ?usage=1                                           (Phase 4 — adds
//                                                       usage_by_id map)
//
// Returns the static generator registry plus the most recent assets (newest
// first), so the Asset Generator UI can populate its tabs and recent gallery
// in a single request.

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const url = new URL(request.url);
  const TypeParse = GeneratedAssetTypeSchema.safeParse(url.searchParams.get("type"));
  const limitRaw = url.searchParams.get("limit");
  const LimitParse = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .safeParse(limitRaw);
  const wantUsage = url.searchParams.get("usage") === "1";
  const recent = await listAssets({
    type: TypeParse.success ? TypeParse.data : undefined,
    limit: LimitParse.success ? LimitParse.data : 30,
  });

  let usage_by_id: Record<string, string[]> | undefined;
  if (wantUsage) {
    const usage = await computeAssetUsage();
    usage_by_id = {};
    for (const a of recent) {
      const cids = usage.byAssetId.get(a.id);
      if (cids && cids.length > 0) usage_by_id[a.id] = cids;
    }
  }

  return NextResponse.json({
    ok: true,
    generators: GENERATOR_REGISTRY,
    recent_assets: recent,
    ...(usage_by_id ? { usage_by_id } : {}),
  });
}
