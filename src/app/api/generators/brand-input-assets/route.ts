import { NextResponse } from "next/server";
import { listBrandInputAssets } from "@/lib/generators/brandInput";
import { GeneratedAssetTypeSchema } from "@/lib/schemas/generatedAsset.schema";

// GET /api/generators/brand-input-assets
//   ?for=background|cta|mockup|trading_ui|fx_overlay   (optional)
//
// Returns the brand-input picker payload for one generator. When `for` is
// omitted, returns every brand-input asset. The UI uses this to populate the
// per-tab picker with backgrounds, mockups, screenshots, and elements that
// the generator can pull in as source layers.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const forParam = url.searchParams.get("for");
  const TypeParse = GeneratedAssetTypeSchema.safeParse(forParam);
  const items = await listBrandInputAssets({
    generatorType: TypeParse.success ? TypeParse.data : undefined,
  });
  return NextResponse.json({ ok: true, assets: items });
}
