import { z } from "zod";
import {
  suggestedCloudinarySubfolder,
  type CanonicalFolderType,
} from "@/lib/brandInput/folderAliases";
import type { BrandInputInventory } from "@/lib/brandInput/loadBrandInput";

// ─────────────────────────────────────────────────────────────────────────────
// Asset Import Plan.
//
// For each local file in the brand-input inventory, decide where it would go
// in Cloudinary and what tags it should carry. We do NOT upload anything in
// this step — the plan is written to data/asset-import-plan.generated.json
// for human review and later execution.
//
// Cloudinary subfolder mapping is owned by folderAliases.ts so the brand
// taxonomy lives in one place.
// ─────────────────────────────────────────────────────────────────────────────

export const AssetImportPlanItemSchema = z.object({
  local_path: z.string(),
  original_folder_name: z.string(),
  canonical_folder_type: z.string(),
  asset_type: z.string(),
  filename: z.string(),
  extension: z.string(),
  suggested_cloudinary_folder: z.string().nullable(),
  suggested_tags: z.array(z.string()),
  source: z.literal("brand_input_folder"),
  requires_approval: z.boolean(),
  // Per-item warnings — shown in the audit log without changing the asset
  // type. The folder remains authoritative; humans decide whether to move.
  warnings: z.array(z.string()).default([]),
});
export type AssetImportPlanItem = z.infer<typeof AssetImportPlanItemSchema>;

export const AssetImportPlanSchema = z.object({
  brand_id: z.string().min(1),
  generated_at: z.string(),
  items: z.array(AssetImportPlanItemSchema),
  skipped: z.array(
    z.object({
      file_path: z.string(),
      reason: z.string(),
    }),
  ),
  warnings_summary: z.object({
    total: z.number().int().nonnegative(),
    misclassification_count: z.number().int().nonnegative(),
    misclassified_paths: z.array(z.string()),
  }),
});
export type AssetImportPlan = z.infer<typeof AssetImportPlanSchema>;

// Filename-substring keywords that suggest a file is a device mockup.
// Matched case-insensitively. Substring (not word boundary) so things like
// `iwatch.png` and `mobile-mockup4.png` get flagged.
const DEVICE_KEYWORDS = [
  "iphone",
  "ipad",
  "macbook",
  "laptop",
  "desktop",
  "phone",
  "tablet",
  "smartwatch",
  "watch",
];

function detectDeviceKeyword(filename: string): string | null {
  const lower = filename.toLowerCase();
  for (const kw of DEVICE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

export interface CreatePlanOptions {
  brandId: string;
}

export function createAssetImportPlan(
  inventory: BrandInputInventory,
  opts: CreatePlanOptions,
): AssetImportPlan {
  const items: AssetImportPlanItem[] = [];
  const skipped: AssetImportPlan["skipped"] = [];
  const misclassified_paths: string[] = [];
  let warningsTotal = 0;

  for (const item of inventory.items) {
    const canonical = item.canonical_folder_type as CanonicalFolderType;
    const subfolder = suggestedCloudinarySubfolder(canonical);

    // Skip the brand-spec files — they are not Cloudinary assets.
    if (canonical === "brand_spec") {
      skipped.push({
        file_path: item.file_path,
        reason: "brand-spec files are not uploaded to Cloudinary",
      });
      continue;
    }

    if (subfolder == null) {
      skipped.push({
        file_path: item.file_path,
        reason: `no Cloudinary mapping for canonical type "${canonical}"`,
      });
      continue;
    }

    const warnings: string[] = [];
    // Misclassification check: file is in Elements/ but the filename suggests
    // a device mockup. Folder remains authoritative — only emit a warning.
    if (canonical === "elements") {
      const kw = detectDeviceKeyword(item.filename);
      if (kw) {
        warnings.push(
          `Filename suggests this may be a mockup but it is located in Elements/. (matched keyword: "${kw}")`,
        );
        misclassified_paths.push(item.file_path);
      }
    }
    warningsTotal += warnings.length;

    const cloudinaryFolder = `brands/${opts.brandId}/${subfolder}/`;
    items.push({
      local_path: item.file_path,
      original_folder_name: item.original_folder_name,
      canonical_folder_type: item.canonical_folder_type,
      asset_type: item.inferred_asset_type,
      filename: item.filename,
      extension: item.extension,
      suggested_cloudinary_folder: cloudinaryFolder,
      suggested_tags: buildTags(opts.brandId, item.inferred_asset_type, canonical, item.filename),
      source: "brand_input_folder",
      requires_approval: item.requires_approval,
      warnings,
    });
  }

  return AssetImportPlanSchema.parse({
    brand_id: opts.brandId,
    generated_at: new Date().toISOString(),
    items,
    skipped,
    warnings_summary: {
      total: warningsTotal,
      misclassification_count: misclassified_paths.length,
      misclassified_paths: misclassified_paths.sort(),
    },
  });
}

function buildTags(
  brandId: string,
  assetType: string,
  canonical: CanonicalFolderType,
  filename: string,
): string[] {
  const tags = new Set<string>([
    `brand:${brandId}`,
    `type:${assetType}`,
    `category:${canonical}`,
    "source:brand_input_folder",
  ]);

  const lower = filename.toLowerCase();
  if (/white/.test(lower)) tags.add("variant:white");
  if (/blue|colour|color/.test(lower)) tags.add("variant:color");
  if (/fav/.test(lower)) tags.add("variant:favicon");
  if (/iphone|ipad|macbook|iwatch|mobile|desktop|tablet/.test(lower))
    tags.add("device:detected-from-filename");

  return Array.from(tags).sort();
}
