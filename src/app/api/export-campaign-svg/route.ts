import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { exportCampaignSvg } from "@/lib/export/exportCampaignSvg";
import { evaluateExportGate } from "@/lib/qa/exportGate";
import { renderCampaign } from "@/lib/render/renderCampaign";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";

// GET /api/export-campaign-svg?campaign_id=cam_xxxxxxxx
//   ?embed=0 — keep image refs instead of embedding local assets.
//   ?source=rendered — compact version using rendered PNGs instead of
//                      editable manifest layers.
//   ?override_blocking_qa=1 — export even when block-level QA exists.
//
// Returns one SVG sheet containing every banner in the campaign. By default
// each ad is exported from manifest layers, so text/shapes remain editable in
// Figma. Each ad is placed as its own artboard and grouped by concept.

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
  embed: z.enum(["0", "1"]).optional(),
  source: z.enum(["rendered", "editable"]).optional(),
  override_blocking_qa: z.literal("1").optional(),
});

export const maxDuration = 120;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    campaign_id: url.searchParams.get("campaign_id"),
    embed: url.searchParams.get("embed") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    override_blocking_qa:
      url.searchParams.get("override_blocking_qa") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const plan = await loadCampaignPlanIfExists(parsed.data.campaign_id);
  if (!plan) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
        message: `Campaign ${parsed.data.campaign_id} not found.`,
      },
      { status: 404 },
    );
  }

  const gate = await evaluateExportGate({
    plan,
    override: parsed.data.override_blocking_qa === "1",
  });
  if (gate.blocked) {
    return NextResponse.json(
      {
        ok: false,
        error: "blocked_by_qa",
        message:
          "Export refused: block-level QA violations exist. Resolve them or retry with override_blocking_qa=1.",
        block_count: gate.reasons.length,
        reasons: gate.reasons,
      },
      { status: 409 },
    );
  }

  try {
    const source = parsed.data.source ?? "editable";
    if (source === "rendered") {
      const rendered = await hasCompleteRenderMap(plan);
      if (!rendered) {
        const requestOrigin = (() => {
          try {
            return new URL(request.url).origin;
          } catch {
            return null;
          }
        })();
        const baseUrl =
          requestOrigin ??
          process.env.NEXT_PUBLIC_APP_URL ??
          "http://localhost:3000";
        await renderCampaign(plan, baseUrl, { runVisionQa: false });
      }
    }
    const result = await exportCampaignSvg({
      plan,
      embedLocalImages: parsed.data.embed !== "0",
      source,
    });
    return new Response(result.svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Length": String(result.byteLength),
        "X-Mexem-Export-Source": result.source,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "export_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}

async function hasCompleteRenderMap(plan: CampaignPlan): Promise<boolean> {
  const renderMapPath = path.join(
    process.cwd(),
    "data",
    "campaigns",
    plan.campaign_id,
    "code-render-map.generated.json",
  );
  let renderMap: {
    items?: Array<{
      ad_id?: string;
      output_local_path?: string | null;
      status?: string;
    }>;
  };
  try {
    renderMap = JSON.parse(await fs.readFile(renderMapPath, "utf8")) as typeof renderMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const byAd = new Map((renderMap.items ?? []).map((i) => [i.ad_id, i]));
  for (const concept of plan.concepts) {
    for (const ad of concept.ad_specs) {
      const item = byAd.get(ad.ad_id);
      if (item?.status !== "completed" || !item.output_local_path) return false;
      try {
        await fs.access(path.resolve(process.cwd(), item.output_local_path));
      } catch {
        return false;
      }
    }
  }
  return true;
}
