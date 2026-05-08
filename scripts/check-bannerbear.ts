#!/usr/bin/env tsx
/**
 * Bannerbear diagnostics. Verifies env vars, fetches all 3 templates with
 * extended=true, prints what each template exposes, and compares against the
 * required + optional layer contract.
 * Run with: `npm run bannerbear:check`
 *
 * Exits non-zero if a required layer is missing from any template.
 * Never logs the API key.
 */
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { bannerbearEnvStatus, getBannerbearTemplate } from "@/lib/bannerbear/client";
import {
  getTemplateMap,
  REQUIRED_BANNERBEAR_LAYERS,
  OPTIONAL_BANNERBEAR_LAYERS,
} from "@/lib/bannerbear/templateMapping";

async function main() {
  console.log("Bannerbear diagnostics — no renders will be performed.\n");
  await loadEnvLocalIfPresent();

  const env = bannerbearEnvStatus();
  const ok = (b: boolean) => (b ? "yes" : "NO");
  console.log("Environment");
  console.log("─".repeat(60));
  console.log(`  BANNERBEAR_API_KEY:               ${ok(env.api_key_present)}`);
  console.log(
    `  BANNERBEAR_TEMPLATE_1200x628:     ${ok(env.template_1200x628_present)}`,
  );
  console.log(
    `  BANNERBEAR_TEMPLATE_1080x1080:    ${ok(env.template_1080x1080_present)}`,
  );
  console.log(
    `  BANNERBEAR_TEMPLATE_1080x1920:    ${ok(env.template_1080x1920_present)}`,
  );

  if (!env.api_key_present) {
    console.error("\n✗ BANNERBEAR_API_KEY is missing. Add it to .env.local.");
    process.exit(2);
  }

  const map = await getTemplateMap();
  const missingTemplates = map.filter((m) => !m.template_uid);
  if (missingTemplates.length === 3) {
    console.error(
      "\n✗ No template UIDs configured. Set BANNERBEAR_TEMPLATE_<W>x<H> in .env.local.",
    );
    process.exit(3);
  }

  let anyRequiredMissing = false;
  for (const entry of map) {
    console.log("");
    console.log(`Template — ${entry.format}`);
    console.log("─".repeat(60));
    if (!entry.template_uid) {
      console.log(`  ✗ ${entry.error ?? "no UID configured"}`);
      anyRequiredMissing = true;
      continue;
    }
    console.log(`  uid:    ${entry.template_uid}  (source: ${entry.source})`);
    try {
      const t = await getBannerbearTemplate(entry.template_uid, true);
      console.log(`  name:   ${t.name}`);
      console.log(`  size:   ${t.width}×${t.height}`);
      const layerNames = (t.available_modifications ?? [])
        .map((m) => String((m as { name?: string }).name ?? ""))
        .filter(Boolean);
      console.log(
        `  layers: ${layerNames.length} (${layerNames.join(", ")})`,
      );
      const missingRequired = REQUIRED_BANNERBEAR_LAYERS.filter(
        (n) => !layerNames.includes(n),
      );
      const missingOptional = OPTIONAL_BANNERBEAR_LAYERS.filter(
        (n) => !layerNames.includes(n),
      );
      if (missingRequired.length === 0) {
        console.log(`  ✓ all required layers present`);
      } else {
        console.log(`  ✗ missing required: ${missingRequired.join(", ")}`);
        anyRequiredMissing = true;
      }
      if (missingOptional.length > 0) {
        console.log(`  · missing optional: ${missingOptional.join(", ")}`);
      }
    } catch (err) {
      console.log(`  ✗ template fetch failed: ${(err as Error).message}`);
      anyRequiredMissing = true;
    }
  }

  console.log("");
  if (anyRequiredMissing) {
    console.error(
      "✗ One or more templates are missing required layers. Edit them in the Bannerbear dashboard before running renders.",
    );
    process.exit(4);
  }
  console.log("✓ Bannerbear diagnostics passed.");
}

main().catch((err) => {
  console.error("bannerbear:check failed:", (err as Error).message);
  process.exit(1);
});
