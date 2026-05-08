import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteAsset, setAssetApproval } from "@/lib/generators/storage";
import { isAssetUsed } from "@/lib/generators/usage";

// /api/generators/asset/:id
//   DELETE — refuses when the asset is referenced from any saved campaign
//            plan (data/campaigns/<id>/campaign-plan.json). Pass `?force=1`
//            to override (still refuses on missing id).
//   PATCH  — toggle the `approved` flag. Body: { approved: boolean }.

const PatchBodySchema = z.object({
  approved: z.boolean(),
});

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "missing_id" },
      { status: 400 },
    );
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (!force) {
    const usage = await isAssetUsed(id);
    if (usage.used) {
      return NextResponse.json(
        {
          ok: false,
          error: "asset_in_use",
          message: `Asset ${id} is referenced by ${usage.campaign_ids.length} campaign(s). Pass ?force=1 to delete anyway.`,
          campaign_ids: usage.campaign_ids,
        },
        { status: 409 },
      );
    }
  }
  const result = await deleteAsset(id);
  if (!result) {
    return NextResponse.json(
      { ok: false, error: "not_found", id },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, deleted: result.deleted });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "missing_id" },
      { status: 400 },
    );
  }
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }
  const parsed = PatchBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const updated = await setAssetApproval(id, parsed.data.approved);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: "not_found", id },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, asset: updated });
}
