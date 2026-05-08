import { promises as fs } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import {
  ProductionAdCanvas,
  RENDER_CANVAS_ID,
} from "@/components/render/ProductionAdCanvas";
import { GOOGLE_FONTS_HREF } from "@/lib/i18n/language";

// /render/ad/[adId]
//
// Production render route. Designed to be screenshotted by Playwright at
// the AdSpec's exact canvas size, with no app chrome influencing the output.
//
// The page intentionally:
//   - Uses `position: fixed; top: 0; left: 0` for the canvas (via
//     ProductionAdCanvas) so it escapes the parent layout's max-width and
//     padding.
//   - Sets a `--render-page` body class (via inline <style>) so the headless
//     capture environment can hide the nav/header if anyone visits manually.
//   - Resolves Cloudinary URLs and `file://localhost/...` URLs identically
//     because ProductionElementLayer strips the `file://localhost` prefix.
//
// The Element Manifest is the source of truth. Nothing on this page invents
// positions, sizes, or styling — every value comes from the manifest.

export const dynamic = "force-dynamic";

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");

async function loadDemoOrNull(): Promise<DemoCampaign | null> {
  try {
    const raw = await fs.readFile(DEMO_PATH, "utf8");
    return DemoCampaignSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export default async function RenderAdPage({
  params,
}: {
  params: Promise<{ adId: string }>;
}) {
  const { adId } = await params;
  const demo = await loadDemoOrNull();
  if (!demo) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p>data/demo-campaign.preview.json not found.</p>
        <p>Run <code>npm run preview:demo</code> first.</p>
      </main>
    );
  }
  const adSpec = demo.ad_specs.find((s) => s.specId === adId);
  if (!adSpec) notFound();

  const gradientCssById =
    demo.asset_selection.background_fill.kind === "gradient"
      ? { el_background: demo.asset_selection.background_fill.css }
      : undefined;

  return (
    <>
      {/* Load every supported language's primary font in one request so
          Hebrew / Arabic / Latin glyphs all render natively in headless
          Chromium. Without this, non-Latin scripts fall back to system
          fonts and the brand identity collapses. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      {/* Hide whatever nav/header the parent layout injects so a manual
          visit (browser, not Playwright) is also chrome-free. The Playwright
          capture targets #render-canvas directly, so this is belt-and-suspenders. */}
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
