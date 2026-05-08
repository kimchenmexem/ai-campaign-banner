#!/usr/bin/env tsx
/**
 * Local visual preview — composite screenshots into device mockups.
 * Run with: `npm run preview:mockups`
 *
 * Reads:
 *   data/asset-preview-map.generated.json
 *   brand-input/mockup devices/mockup-manifest.json (optional)
 *   brand-input/Platform screenshot/screenshot-tags.json (optional)
 * Writes:
 *   public/generated-preview-composites/<device>-<context>.png
 *   data/mockup-composite-map.generated.json
 */
import { buildMockupCompositeMatrix } from "@/lib/preview/composeMockupPreview";

async function main() {
  console.log(
    "Preview mockups — compositing screenshots into device mockups ...",
  );
  const { map, warnings } = await buildMockupCompositeMatrix();

  console.log(`✓ Wrote ${map.composites.length} composites to ${map.output_dir}`);

  // Group composites by device for the summary.
  const byDevice = new Map<string, string[]>();
  for (const c of map.composites) {
    if (!byDevice.has(c.device_type)) byDevice.set(c.device_type, []);
    byDevice.get(c.device_type)!.push(c.screenshot_context);
  }

  console.log("");
  console.log("Composite matrix");
  console.log("─".repeat(60));
  for (const [device, contexts] of byDevice) {
    console.log(`  ${device.padEnd(12)} → ${contexts.sort().join(", ")}`);
  }

  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    console.log("─".repeat(60));
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  // Surface which composites used heuristics — a hint that mockup-manifest.json
  // would improve fidelity.
  const heuristicCount = map.composites.filter((c) => c.slot_source === "heuristic").length;
  const manifestCount = map.composites.filter((c) => c.slot_source === "explicit_manifest").length;
  console.log("");
  console.log("Provenance");
  console.log("─".repeat(60));
  console.log(`  From mockup-manifest.json:    ${manifestCount}`);
  console.log(`  From device-type heuristic:   ${heuristicCount}`);
  if (heuristicCount > 0) {
    console.log(
      "  Tip: add entries to brand-input/mockup devices/mockup-manifest.json",
    );
    console.log("       to override heuristic screen slots per mockup.");
  }
}

main().catch((err) => {
  console.error("preview:mockups failed:", err);
  process.exit(1);
});
