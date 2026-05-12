import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CampaignBriefInputSchema,
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import {
  planCampaign,
  saveCampaignPlan,
  setActiveCampaign,
} from "@/lib/ai/campaignPlanner";
import { readProviderName } from "@/lib/ai/provider";

// POST /api/generate-campaign-from-svg
//
// Variant of /api/generate-campaign that ALSO accepts a user-supplied SVG.
// The existing AI strategy + translator copy pipeline runs unchanged; after
// the campaign plan is built, the SVG is saved under public/uploads/svg/
// and injected into every ad spec's manifest as a decorative full-bleed
// element (z-index 5 — above the background, below mockup and text). No
// existing element is replaced.
//
// Body shape:
//   {
//     brief: CampaignBriefInput,
//     svg: string,                       // raw <svg>...</svg> XML
//     ai_provider?: "mock"|"openai"|"anthropic"|"gemini",
//     set_as_active?: boolean,
//   }

export const maxDuration = 600;

const RequestSchema = z.object({
  brief: CampaignBriefInputSchema,
  svg: z
    .string()
    .min(20)
    .max(2_500_000) // ~2.5 MB cap
    .refine((s) => s.trim().startsWith("<svg") || s.trim().startsWith("<?xml"), {
      message: "svg must be valid SVG XML starting with <svg or <?xml",
    }),
  ai_provider: z.enum(["mock", "openai", "anthropic", "gemini"]).optional(),
  set_as_active: z.boolean().optional(),
});

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const brief: CampaignBrief = CampaignBriefSchema.parse({
    ...parsed.data.brief,
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    created_at: new Date().toISOString(),
  });

  // Persist the SVG so the renderer can <img src="..."> it. We use a hashed
  // filename so identical SVGs are de-duplicated and so the URL is stable.
  const svgHash = crypto.createHash("sha1").update(parsed.data.svg).digest("hex").slice(0, 16);
  const svgFilename = `${svgHash}.svg`;
  const svgPublicDir = path.join(process.cwd(), "public", "uploads", "svg");
  const svgAbsPath = path.join(svgPublicDir, svgFilename);
  const svgPublicUrl = `/uploads/svg/${svgFilename}`;
  try {
    await fs.mkdir(svgPublicDir, { recursive: true });
    // Only write if missing — same SVG twice should not duplicate IO.
    try {
      await fs.access(svgAbsPath);
    } catch {
      await fs.writeFile(svgAbsPath, parsed.data.svg, "utf8");
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "svg_write_failed", message: redact((err as Error).message) },
      { status: 500 },
    );
  }

  try {
    // Run the existing campaign pipeline unchanged. We always defer the
    // active-pointer write to after we re-save the SVG-augmented plan.
    const result = await planCampaign({
      brief,
      providerName: parsed.data.ai_provider ?? readProviderName(),
      setAsActive: false,
      imageProvider: "none",
    });

    // Inject the SVG as a decorative full-bleed element into every ad's
    // manifest. We mutate in place — schema-compatible — then re-save.
    for (const concept of result.plan.concepts) {
      for (const ad of concept.ad_specs) {
        ad.manifest.elements.push({
          id: `el_user_svg_${svgHash.slice(0, 8)}`,
          type: "image",
          role: "decorative",
          source: "user-upload",
          x: 0,
          y: 0,
          width: ad.canvas_width,
          height: ad.canvas_height,
          // Above the background (z ≤ 1) but below the mockup (z ≥ 20)
          // and text layers (z ≥ 30) — sits as an "atmosphere" layer.
          z_index: 5,
          opacity: 1,
          rotation: 0,
          visible: true,
          version: 1,
          file_url: svgPublicUrl,
          // "cover" scales the SVG proportionally to fill the canvas; the
          // SVG's own preserveAspectRatio settings still apply inside.
          object_fit: "cover",
          alt_text: `user-supplied SVG (${svgHash.slice(0, 8)})`,
        });
      }
    }

    // Re-save the plan with the injected element.
    const cwd = process.cwd();
    const savedPath = await saveCampaignPlan(cwd, result.plan);

    let active = false;
    if (parsed.data.set_as_active) {
      await setActiveCampaign(cwd, result.plan.campaign_id, savedPath);
      active = true;
    }

    return NextResponse.json({
      ok: true,
      campaign_id: result.plan.campaign_id,
      plan: result.plan,
      saved_path: savedPath,
      active,
      svg: {
        url: svgPublicUrl,
        hash: svgHash,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "planner_failed",
        message: redact((err as Error).message),
      },
      { status: 500 },
    );
  }
}
