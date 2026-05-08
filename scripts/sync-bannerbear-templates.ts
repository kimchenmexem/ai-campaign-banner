#!/usr/bin/env tsx
/**
 * Snapshot all 3 Bannerbear templates and emit
 * data/bannerbear-template-snapshots.generated.json.
 * Run with: `npm run bannerbear:sync-templates`
 */
import path from "node:path";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { syncAllBannerbearTemplates } from "@/lib/bannerbear/syncTemplate";

async function main() {
  await loadEnvLocalIfPresent();
  console.log("Bannerbear sync — fetching all configured templates ...");
  const { file, outputPath } = await syncAllBannerbearTemplates();

  console.log(`✓ Wrote ${path.relative(process.cwd(), outputPath)}`);
  console.log("");
  console.log("Snapshots");
  console.log("─".repeat(72));
  for (const s of file.snapshots) {
    const reqMissing = s.missing_required_layers;
    const optMissing = s.missing_optional_layers;
    const tag =
      reqMissing.length === 0 ? "✓" : "✗";
    console.log(
      `${tag} ${s.format.padEnd(11)} ${s.template_uid.padEnd(20)} ${s.template_name} (${s.width}×${s.height})`,
    );
    if (reqMissing.length > 0) {
      console.log(`    missing required: ${reqMissing.join(", ")}`);
    }
    if (optMissing.length > 0) {
      console.log(`    missing optional: ${optMissing.join(", ")}`);
    }
    if (reqMissing.length === 0 && optMissing.length === 0) {
      console.log(`    all required + optional layers present`);
    }
  }

  if (file.errors.length > 0) {
    console.log("");
    console.log("Errors");
    console.log("─".repeat(72));
    for (const e of file.errors) {
      console.log(`✗ ${e.format.padEnd(11)} ${e.template_uid ?? "—"}: ${e.message}`);
    }
    process.exit(2);
  }

  // Exit non-zero if any required layer is missing on any template — these
  // will block production renders.
  const anyRequiredMissing = file.snapshots.some((s) => s.missing_required_layers.length > 0);
  if (anyRequiredMissing) process.exit(3);
}

main().catch((err) => {
  console.error("bannerbear:sync-templates failed:", (err as Error).message);
  process.exit(1);
});
