#!/usr/bin/env tsx
/**
 * Upload everything in data/asset-import-plan.generated.json to Cloudinary
 * and emit data/cloudinary-asset-map.generated.json.
 * Run with: `npm run cloudinary:upload-assets [-- --force]`
 *
 * Idempotent: skips files already uploaded successfully unless --force.
 * Per-file errors are recorded; the script keeps going.
 */
import path from "node:path";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { uploadAssetImportPlan } from "@/lib/cloudinary/upload";

async function main() {
  await loadEnvLocalIfPresent();
  const force = process.argv.includes("--force");

  console.log(
    `Cloudinary asset upload${force ? " (--force overwrite)" : ""} — reading data/asset-import-plan.generated.json ...`,
  );

  const result = await uploadAssetImportPlan({
    force,
    onProgress: ({ index, total, record }) => {
      const label = record.upload_status.padEnd(11);
      const id = record.cloudinary_public_id ?? "—";
      const tag = `[${String(index).padStart(3)}/${total}]`;
      const filename = path.basename(record.local_path);
      const trailer =
        record.upload_status === "failed"
          ? ` (${record.upload_error ?? "unknown error"})`
          : "";
      console.log(`${tag} ${label} ${filename.padEnd(36)} → ${id}${trailer}`);
    },
  });

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  total:        ${result.total}`);
  console.log(`  uploaded:     ${result.uploaded}`);
  console.log(`  skipped:      ${result.skipped} (already present; pass --force to re-upload)`);
  console.log(`  unsupported:  ${result.unsupported} (extension not in image allowlist)`);
  console.log(`  failed:       ${result.failed}`);
  console.log("");
  console.log(`✓ Wrote data/cloudinary-asset-map.generated.json`);

  if (result.failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("cloudinary:upload-assets failed:", (err as Error).message);
  process.exit(1);
});
