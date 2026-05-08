#!/usr/bin/env tsx
/**
 * Auto-seed brand-input/mockup devices/mockup-manifest.json.
 * Run with: `npm run preview:seed-mockup-manifest [-- --force]`
 *
 * No-op when a non-empty manifest already exists, unless --force is passed.
 */
import path from "node:path";
import { createMockupManifestSeed } from "@/lib/preview/createMockupManifestSeed";

async function main() {
  const force = process.argv.includes("--force");
  console.log(
    `Seed mockup manifest${force ? " (--force)" : ""} — reading data/asset-preview-map.generated.json ...`,
  );

  const result = await createMockupManifestSeed({ force });
  const rel = path.relative(process.cwd(), result.outputPath);

  switch (result.status) {
    case "kept_existing":
      console.log(
        `· ${rel} already has ${result.entries.length} entries — keeping (pass --force to overwrite).`,
      );
      break;
    case "no_mockups":
      console.warn(`! No mockups in inventory — nothing to seed.`);
      break;
    case "wrote":
      console.log(`✓ Seeded ${result.entries.length} entries → ${rel}`);
      console.log("");
      console.log("Distribution");
      console.log("─".repeat(48));
      const counts = new Map<string, number>();
      for (const e of result.entries)
        counts.set(e.device_type, (counts.get(e.device_type) ?? 0) + 1);
      for (const [k, v] of counts) console.log(`  ${k.padEnd(20)} ${v}`);
      if (result.skipped.length > 0) {
        console.log("");
        console.log("Skipped");
        console.log("─".repeat(48));
        for (const s of result.skipped)
          console.log(`  ${s.filename.padEnd(28)} ${s.reason}`);
      }
      console.log("");
      console.log(
        "Tip: open /mockup-calibrator to fine-tune the auto-seeded screen slots.",
      );
      break;
  }
}

main().catch((err) => {
  console.error("seed-mockup-manifest failed:", err);
  process.exit(1);
});
