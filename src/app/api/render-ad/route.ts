import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  RenderableAdSpecSchema,
  renderAdWithBannerbear,
} from "@/lib/bannerbear/renderAd";
import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import { requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// POST /api/render-ad
// Body shape (one of):
//   { ad_id: string }                        → looks up the spec in
//                                              data/demo-campaign.preview.json
//   { adSpec: <RenderableAdSpec> }           → renders the spec verbatim
//
// Returns a RenderAdResult: ad_id, format, template_uid, modifications_sent,
// conversion_diagnostics, bannerbear_render_response, final_render_url, status.

const RequestSchema = z.union([
  z.object({ ad_id: z.string().min(1) }),
  z.object({ adSpec: RenderableAdSpecSchema }),
]);

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");

export async function POST(request: Request) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.expensive, auth);
  if (limited) return limited;

  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let adSpec: z.infer<typeof RenderableAdSpecSchema> | null = null;
  if ("adSpec" in parsed.data) {
    adSpec = parsed.data.adSpec;
  } else {
    const adId = parsed.data.ad_id;
    const demo = await loadDemoOrNull();
    if (!demo) {
      return NextResponse.json(
        {
          ok: false,
          error: "no_demo_file",
          hint: "Run `npm run preview:demo` to generate data/demo-campaign.preview.json, then retry.",
        },
        { status: 404 },
      );
    }
    const found = demo.ad_specs.find((s) => s.specId === adId);
    if (!found) {
      return NextResponse.json(
        { ok: false, error: "ad_id_not_found", ad_id: adId },
        { status: 404 },
      );
    }
    adSpec = RenderableAdSpecSchema.parse(found);
  }

  try {
    const result = await renderAdWithBannerbear(adSpec);
    if (result.status === "completed") {
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ ok: false, result }, { status: 502 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "render_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}

async function loadDemoOrNull(): Promise<DemoCampaign | null> {
  try {
    const raw = await fs.readFile(DEMO_PATH, "utf8");
    return DemoCampaignSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
