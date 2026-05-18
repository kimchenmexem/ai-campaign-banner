import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { loadBrandKit } from "@/lib/generators/brandKit";
import { persistAsset } from "@/lib/generators/storage";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// Shared runner for the five generator POST routes. Each route just supplies
// a `generate(params, ctx)` and the rest of the lifecycle (parse JSON →
// validate → run → persist → respond) is identical.

export type GenerateFn = (
  params: unknown,
  ctx: GenerateContext,
) => Promise<GenerateResult>;

export async function runGenerator(
  request: Request,
  generate: GenerateFn,
): Promise<Response> {
  // All generator routes are AI-backed and write to data/generated-assets.
  // They share the same protection: dev-only writes, editor role, expensive
  // rate limit.
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  let brandKit;
  try {
    brandKit = await loadBrandKit();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "brand_kit_unavailable",
        message: (err as Error).message,
        hint: "Run `npm run brand:intake` to materialise data/brand-kit-lite.generated.json.",
      },
      { status: 500 },
    );
  }

  const ctx: GenerateContext = { cwd: process.cwd(), brandKit };

  let result: GenerateResult;
  try {
    result = await generate(json, ctx);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { ok: false, error: "invalid_params", issues: err.issues },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "generate_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  const asset = await persistAsset({ result });
  return NextResponse.json({ ok: true, asset });
}
