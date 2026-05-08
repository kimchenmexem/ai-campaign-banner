#!/usr/bin/env tsx
/**
 * Upload local mockup composites (public/generated-preview-composites/*.png)
 * to Cloudinary and emit data/cloudinary-composite-map.generated.json.
 * Run with: `npm run cloudinary:upload-composites [-- --force]`
 *
 * Cloudinary destination: brands/{brand_id}/generated-composites/<composite_id>
 * (the brand_id is read from data/asset-import-plan.generated.json — run
 * `npm run brand:intake` first if it's missing.)
 */
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { uploadMockupComposites } from "@/lib/cloudinary/upload";

async function main() {
  await loadEnvLocalIfPresent();
  const force = process.argv.includes("--force");

  console.log(
    `Cloudinary composite upload${force ? " (--force overwrite)" : ""} — reading data/mockup-composite-map.generated.json ...`,
  );

  const result = await uploadMockupComposites({
    force,
    onProgress: ({ index, total, record }) => {
      const label = record.upload_status.padEnd(11);
      const id = record.cloudinary_public_id ?? "—";
      const tag = `[${String(index).padStart(2)}/${total}]`;
      const trailer =
        record.upload_status === "failed"
          ? ` (${record.upload_error ?? "unknown error"})`
          : "";
      console.log(`${tag} ${label} ${record.composite_id.padEnd(28)} → ${id}${trailer}`);
    },
  });

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  total:        ${result.total}`);
  console.log(`  uploaded:     ${result.uploaded}`);
  console.log(`  skipped:      ${result.skipped} (already present; pass --force to re-upload)`);
  console.log(`  failed:       ${result.failed}`);
  console.log("");
  console.log(`✓ Wrote data/cloudinary-composite-map.generated.json`);
  console.log(`  Cloudinary folder: ${result.map.folder}`);

  if (result.failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("cloudinary:upload-composites failed:", (err as Error).message);
  process.exit(1);
});
