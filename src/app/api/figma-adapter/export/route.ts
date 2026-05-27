import JSZip from "jszip";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildFigmaAdapterCombinedSvg,
  loadFigmaAdapterCampaignIfExists,
} from "@/lib/figmaAdapter/campaign";

const QuerySchema = z.object({
  campaign_id: z.string().min(1),
  type: z.enum(["combined", "zip"]).default("combined"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    campaign_id: url.searchParams.get("campaign_id"),
    type: url.searchParams.get("type") ?? "combined",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const campaign = await loadFigmaAdapterCampaignIfExists(parsed.data.campaign_id);
  if (!campaign) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
        message: `Figma Adapter campaign ${parsed.data.campaign_id} not found.`,
      },
      { status: 404 },
    );
  }

  if (parsed.data.type === "zip") {
    const zip = new JSZip();
    zip.file(
      "figma-adapter-campaign.generated.json",
      JSON.stringify(campaign, null, 2) + "\n",
    );
    zip.file("all-banners.svg", buildFigmaAdapterCombinedSvg(campaign.variants));
    for (const variant of campaign.variants) {
      zip.file(
        `svgs/${variant.language}/${variant.format}.svg`,
        variant.svg.endsWith("\n") ? variant.svg : `${variant.svg}\n`,
      );
    }
    const buffer = await zip.generateAsync({ type: "uint8array" });
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename="${campaign.campaign_id}-figma-adapter.zip"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const svg = buildFigmaAdapterCombinedSvg(campaign.variants);
  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(svg)),
      "Content-Disposition": `attachment; filename="${campaign.campaign_id}-all-banners.svg"`,
      "Cache-Control": "no-store",
    },
  });
}
