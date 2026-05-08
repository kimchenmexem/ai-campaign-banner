#!/usr/bin/env tsx
/**
 * Auto-seed brand-input/Platform screenshot/screenshot-tags.json.
 * Run with: `npm run preview:seed-screenshot-tags [-- --force]`
 *
 * No-op when a non-empty tag file already exists, unless --force is passed.
 */
import path from "node:path";
import { createScreenshotTagSeed } from "@/lib/preview/createScreenshotTagSeed";

async function main() {
  const force = process.argv.includes("--force");
  console.log(
    `Seed screenshot tags${force ? " (--force)" : ""} — reading data/asset-preview-map.generated.json ...`,
  );

  const result = await createScreenshotTagSeed({ force });
  const rel = path.relative(process.cwd(), result.outputPath);

  switch (result.status) {
    case "kept_existing":
      console.log(`· ${rel} already has ${result.tags.length} tags — keeping (pass --force to overwrite).`);
      break;
    case "no_screenshots":
      console.warn(`! No platform_screenshots in inventory — nothing to seed.`);
      break;
    case "wrote":
      console.log(`✓ Seeded ${result.tags.length} tags → ${rel}`);
      console.log("");
      console.log("Distribution");
      console.log("─".repeat(48));
      const counts = new Map<string, number>();
      for (const t of result.tags)
        counts.set(t.context, (counts.get(t.context) ?? 0) + 1);
      for (const [k, v] of counts) console.log(`  ${k.padEnd(20)} ${v}`);
      console.log("");
      console.log(
        "Tip: open /screenshot-tagger to review and refine the auto-seeded contexts.",
      );
      break;
  }
}

main().catch((err) => {
  console.error("seed-screenshot-tags failed:", err);
  process.exit(1);
});
