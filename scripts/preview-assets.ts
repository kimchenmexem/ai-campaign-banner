#!/usr/bin/env tsx
/**
 * Local visual preview — copy brand-input assets into public/.
 * Run with: `npm run preview:assets`
 */
import {
  copyPreviewAssets,
  countPreviewAssets,
} from "@/lib/preview/copyPreviewAssets";

async function main() {
  console.log("Preview assets — copying brand-input/ into public/brand-input-preview/ ...");
  const result = await copyPreviewAssets();
  const counts = countPreviewAssets(result.map);

  console.log(`✓ Copied ${result.copied} files (skipped ${result.skipped})`);
  console.log("");
  console.log("Counts");
  console.log("─".repeat(48));
  console.log(`  Total preview assets:         ${counts.total}`);
  console.log(`  Brand logo (MEXEM):           ${counts.brand_logo}`);
  console.log(`  Powered by IB / IBKR:         ${counts.powered_by_ib}`);
  console.log(`  Backgrounds:                  ${counts.backgrounds}`);
  console.log(`  Mockups:                      ${counts.mockups}`);
  console.log(`  Platform screenshots:         ${counts.platform_screenshots}`);
  console.log(`  Decorative elements:          ${counts.decorative}`);
  if (counts.other > 0) {
    console.log(`  Other:                        ${counts.other}`);
  }

  if (result.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    console.log("─".repeat(48));
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }
}

main().catch((err) => {
  console.error("preview:assets failed:", err);
  process.exit(1);
});
