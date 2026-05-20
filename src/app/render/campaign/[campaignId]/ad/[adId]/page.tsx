import { notFound } from "next/navigation";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { planToDemoView } from "@/lib/preview/planToDemoView";
import {
  ProductionAdCanvas,
  RENDER_CANVAS_ID,
} from "@/components/render/ProductionAdCanvas";
import { GOOGLE_FONTS_HREF } from "@/lib/i18n/language";

// /render/campaign/[campaignId]/ad/[adId]
//
// Per-campaign render page. Reads the campaign plan directly from the
// CampaignRepository (Supabase in production, JSON file in local dev) and
// renders the requested ad. This replaces the race-prone pattern where
// `renderCampaign` swapped data/demo-campaign.preview.json for /render/ad/[adId]
// to read — two concurrent renders could overwrite each other's swap.
//
// The Element Manifest is the source of truth — every position / size / style
// comes from the saved plan.

export const dynamic = "force-dynamic";

export default async function CampaignAdRenderPage({
  params,
}: {
  params: Promise<{ campaignId: string; adId: string }>;
}) {
  const { campaignId, adId } = await params;
  const plan = await loadCampaignPlanIfExists(campaignId);
  if (!plan) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p>
          Campaign <code>{campaignId}</code> not found.
        </p>
      </main>
    );
  }
  const demo = planToDemoView(plan);
  const adSpec = demo.ad_specs.find((s) => s.specId === adId);
  if (!adSpec) notFound();

  const gradientCssById =
    demo.asset_selection.background_fill.kind === "gradient"
      ? { el_background: demo.asset_selection.background_fill.css }
      : undefined;

  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            html, body { margin: 0; padding: 0; background: #000; }
            body > header, body > nav { display: none !important; }
            body > main { padding: 0 !important; max-width: none !important; }
            #${RENDER_CANVAS_ID} { box-shadow: none; }
          `,
        }}
      />
      <ProductionAdCanvas
        manifest={adSpec.manifest}
        gradientCssById={gradientCssById}
        fixedAtViewportOrigin={true}
      />
    </>
  );
}
