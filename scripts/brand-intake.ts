#!/usr/bin/env tsx
/**
 * Brand intake orchestrator.
 *
 * Run with: `npm run brand:intake`
 *
 * Steps:
 *  1. Load .env.local if present (so BANNERBEAR_TEMPLATE_* env vars are seen).
 *  2. Read + validate brand-input/brand-spec/brand-spec.json.
 *  3. Scan brand-input/ folders, applying folder alias mapping.
 *  4. Load data/bannerbear-template-map.example.json (optional).
 *  5. Convert to BrandKitLite (with provenance), write data/brand-kit-lite.generated.json.
 *  6. Build asset import plan, write data/asset-import-plan.generated.json.
 *  7. Print a detailed summary.
 *
 * Does NOT upload anything. Inventory + plan only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadBrandSpec,
  createBrandInputInventory,
  countByCanonical,
  DEFAULT_BRAND_SPEC_PATH,
} from "@/lib/brandInput/loadBrandInput";
import { convertBrandInputToBrandKitWithProvenance } from "@/lib/brandInput/convertBrandInputToBrandKit";
import { createAssetImportPlan } from "@/lib/brandInput/createAssetImportPlan";
import { loadBannerbearTemplateMap } from "@/lib/bannerbear/templateMapping";
import type { ProvenanceEntry } from "@/lib/schemas/brandKit.schema";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "data");
const BRAND_KIT_OUT = path.join(OUT_DIR, "brand-kit-lite.generated.json");
const IMPORT_PLAN_OUT = path.join(OUT_DIR, "asset-import-plan.generated.json");
const ENV_LOCAL = path.join(ROOT, ".env.local");

async function main() {
  console.log("Brand intake — reading brand-input/ ...");

  // ── Load .env.local if present (Node 20.12+ ships process.loadEnvFile). ──
  await loadEnvLocalIfPresent();

  const brandSpecFound = await fileExists(DEFAULT_BRAND_SPEC_PATH);
  if (!brandSpecFound) {
    console.error(`✗ brand-spec.json NOT found at ${rel(DEFAULT_BRAND_SPEC_PATH)}`);
    process.exit(1);
  }

  const spec = await loadBrandSpec();
  console.log(`✓ Loaded brand spec for ${spec.brand_name} (${spec.brand_id})`);

  const inventory = await createBrandInputInventory();
  const counts = countByCanonical(inventory);
  console.log(`✓ Scanned brand-input/: ${inventory.items.length} files indexed`);
  if (inventory.unknown_folders.length > 0) {
    console.warn(
      `! Unknown folders skipped: ${inventory.unknown_folders.join(", ")}`,
    );
  }

  const templateMap = await loadBannerbearTemplateMap();
  if (templateMap) {
    console.log(`✓ Loaded Bannerbear template map (${templateMap.entries.length} entries)`);
  } else {
    console.log("· No Bannerbear template map found (optional)");
  }

  let brandKitGenerationPassed = false;
  let result: Awaited<ReturnType<typeof convertBrandInputToBrandKitWithProvenance>> | null = null;
  try {
    result = convertBrandInputToBrandKitWithProvenance(spec, inventory, {
      templateMap,
      env: process.env,
    });
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(BRAND_KIT_OUT, JSON.stringify(result.kit, null, 2) + "\n", "utf8");
    brandKitGenerationPassed = true;
    console.log(`✓ Wrote ${rel(BRAND_KIT_OUT)}`);
  } catch (err) {
    console.error("✗ BrandKitLite generation failed.");
    console.error(err);
  }

  const plan = createAssetImportPlan(inventory, { brandId: spec.brand_id });
  await fs.writeFile(IMPORT_PLAN_OUT, JSON.stringify(plan, null, 2) + "\n", "utf8");
  console.log(
    `✓ Wrote ${rel(IMPORT_PLAN_OUT)} (${plan.items.length} items, ${plan.skipped.length} skipped)`,
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\nSummary");
  console.log("─".repeat(60));
  console.log(`  brand-spec.json found:        ${brandSpecFound ? "yes" : "no"}`);
  console.log(`  Brand Kit Lite generation:    ${brandKitGenerationPassed ? "passed" : "FAILED"}`);
  console.log(`  MEXEM logo files:             ${counts.brand_logo}`);
  console.log(`  IBKR logo files:              ${counts.powered_by_ib}`);
  console.log(`  background files:             ${counts.backgrounds}`);
  console.log(`  Platform screenshot files:    ${counts.platform_screenshots}`);
  console.log(`  mockup device files:          ${counts.mockups}`);
  console.log(`  Elements files:               ${counts.elements}`);
  console.log(`  brand-spec files:             ${counts.brand_spec}`);
  console.log("");
  console.log(`  Asset plan warnings (total):  ${plan.warnings_summary.total}`);
  console.log(
    `  Possibly misclassified files: ${plan.warnings_summary.misclassification_count}`,
  );
  if (plan.warnings_summary.misclassified_paths.length > 0) {
    for (const p of plan.warnings_summary.misclassified_paths) {
      console.log(`    - ${p}`);
    }
  }
  console.log("");

  if (result) {
    console.log(`  design_defaults source:       ${result.design_defaults_source}`);
    if (result.design_defaults_source !== "brand_spec") {
      const mvpFields = countMvpDefaultPaths(result.provenance);
      console.log(
        `    (${mvpFields} field(s) using MVP defaults — review before shipping)`,
      );
    }
    console.log(
      `  IBKR-AI policy:               blocked=${result.ibkr_ai_policy.blocked}, source=${result.ibkr_ai_policy.source}`,
    );
    const templateProv = result.provenance.find(
      (p) => p.path === "layout.allowed_templates",
    );
    if (templateProv) {
      console.log(
        `  layout.allowed_templates:     source=${templateProv.source}${templateProv.needs_review ? " (NEEDS REVIEW)" : ""}`,
      );
    }
    const reviewCount = result.provenance.filter((p) => p.needs_review).length;
    console.log(`  Provenance entries needing review: ${reviewCount}`);
  }
  console.log("");

  if (!brandKitGenerationPassed) process.exit(2);
}

function countMvpDefaultPaths(provenance: ProvenanceEntry[]): number {
  return provenance.filter((p) => p.source === "mvp_default").length;
}

async function loadEnvLocalIfPresent() {
  if (!(await fileExists(ENV_LOCAL))) return;
  // Node 20.12+ has process.loadEnvFile. Older Node falls back to a tiny
  // in-script parser so the script never crashes on missing API.
  const lf = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof lf === "function") {
    try {
      lf(ENV_LOCAL);
      console.log("✓ Loaded .env.local");
      return;
    } catch (err) {
      console.warn(`! Failed to load .env.local via process.loadEnvFile: ${(err as Error).message}`);
    }
  }
  // Fallback: KEY=VALUE lines, ignoring comments.
  const raw = await fs.readFile(ENV_LOCAL, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  console.log("✓ Loaded .env.local (fallback parser)");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function rel(p: string): string {
  return path.relative(ROOT, p) || p;
}

main().catch((err) => {
  console.error("Brand intake failed:", err);
  process.exit(1);
});
