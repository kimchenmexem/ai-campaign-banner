#!/usr/bin/env tsx
/**
 * Local visual preview — generate the demo campaign JSON.
 * Run with: `npm run preview:demo`
 *
 * Reads:
 *   data/brand-kit-lite.generated.json
 *   data/asset-preview-map.generated.json
 * Writes:
 *   data/demo-campaign.preview.json
 */
import path from "node:path";
import { createDemoCampaign } from "@/lib/preview/createDemoCampaign";

async function main() {
  console.log("Preview demo — generating data/demo-campaign.preview.json ...");
  const { demo, outputPath } = await createDemoCampaign();
  console.log(`✓ Wrote ${path.relative(process.cwd(), outputPath)}`);

  const sel = demo.asset_selection;
  const elementCount = demo.ad_specs.reduce((acc, s) => acc + s.manifest.elements.length, 0);

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  Brand:                        ${demo.brand_name} (${demo.brand_id})`);
  console.log(`  Ad specs generated:           ${demo.ad_specs.length}`);
  console.log(`  Total elements:               ${elementCount}`);
  console.log(`  Selected logo:                ${sel.brand_logo ?? "—"}`);
  console.log(`  Selected IBKR / Powered by IB:${sel.powered_by_ib ?? "—"}`);
  console.log(
    `  Selected background:          ${sel.background ?? `(none → ${sel.background_fill.kind === "gradient" ? "gradient fallback" : "image"})`}`,
  );
  console.log(`  Selected mockup:              ${sel.mockup ?? "—"}`);
  console.log(`  Selected platform screenshot: ${sel.platform_screenshot ?? "—"}`);
  if (sel.background_fill.kind === "gradient") {
    console.log(`  Background fill:              gradient (${sel.background_fill.css})`);
  }
  console.log("");
  if (demo.warnings.length > 0) {
    console.log("Warnings");
    console.log("─".repeat(60));
    for (const w of demo.warnings) console.log(`  ! ${w}`);
    console.log("");
  }
  console.log("Next: open /visual-preview in the browser (npm run dev).");
}

main().catch((err) => {
  console.error("preview:demo failed:", err);
  process.exit(1);
});
