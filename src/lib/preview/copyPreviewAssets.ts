import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AssetImportPlanSchema,
  type AssetImportPlan,
} from "@/lib/brandInput/createAssetImportPlan";

// ─────────────────────────────────────────────────────────────────────────────
// Local Visual Preview — asset copier.
//
// Reads the brand intake's asset import plan, copies the image files into
// public/brand-input-preview/<canonical_folder_type>/<sanitized-filename>, and
// emits data/asset-preview-map.generated.json so the demo campaign generator
// (and the React preview) can resolve URLs without touching the source files.
//
// This is a TEMPORARY visual preview — it is not the production asset store.
// Cloudinary remains the future production destination. The Element Manifest
// is still the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export const PREVIEW_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"] as const;
export type PreviewImageExtension = (typeof PREVIEW_IMAGE_EXTENSIONS)[number];

export const PREVIEW_PUBLIC_DIR = "brand-input-preview"; // under /public

export const AssetPreviewRecordSchema = z.object({
  original_local_path: z.string(),
  public_path: z.string(), // e.g. "/brand-input-preview/brand_logo/logo-blue-p.png"
  asset_type: z.string(),
  canonical_folder_type: z.string(),
  original_folder_name: z.string(),
  filename: z.string(), // sanitized filename written under public/
  original_filename: z.string(),
  suggested_tags: z.array(z.string()),
  source: z.literal("local_preview_copy"),
});
export type AssetPreviewRecord = z.infer<typeof AssetPreviewRecordSchema>;

export const AssetPreviewMapSchema = z.object({
  brand_id: z.string().min(1),
  generated_at: z.string(),
  public_dir: z.string(),
  items: z.array(AssetPreviewRecordSchema),
  skipped: z.array(
    z.object({
      original_local_path: z.string(),
      reason: z.string(),
    }),
  ),
});
export type AssetPreviewMap = z.infer<typeof AssetPreviewMapSchema>;

export interface CopyPreviewAssetsOptions {
  cwd?: string;
  importPlanPath?: string;
  outputJsonPath?: string;
}

export interface CopyPreviewAssetsResult {
  map: AssetPreviewMap;
  copied: number;
  skipped: number;
  warnings: string[];
}

/**
 * Sanitize a filename for use under public/. URL-safe, case-insensitive,
 * collisions broken by an integer suffix injected upstream.
 */
export function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  const cleanStem = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (cleanStem || "asset") + ext.replace(/[^a-z0-9.]/g, "");
}

function isPreviewableExtension(ext: string): boolean {
  return (PREVIEW_IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export async function copyPreviewAssets(
  opts: CopyPreviewAssetsOptions = {},
): Promise<CopyPreviewAssetsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const importPlanPath =
    opts.importPlanPath ?? path.join(cwd, "data", "asset-import-plan.generated.json");
  const outputJsonPath =
    opts.outputJsonPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const publicRoot = path.join(cwd, "public", PREVIEW_PUBLIC_DIR);

  const planRaw = await fs.readFile(importPlanPath, "utf8");
  const plan: AssetImportPlan = AssetImportPlanSchema.parse(JSON.parse(planRaw));

  await fs.mkdir(publicRoot, { recursive: true });

  const items: AssetPreviewRecord[] = [];
  const skipped: AssetPreviewMap["skipped"] = [];
  const warnings: string[] = [];

  // Track sanitized filename usage per (canonical_folder_type) so collisions
  // across "macbook 2.png" → "macbook-2.png" don't overwrite each other.
  const usedNames = new Map<string, Set<string>>();
  function reserveName(canonical: string, sanitized: string): string {
    const key = canonical;
    if (!usedNames.has(key)) usedNames.set(key, new Set());
    const set = usedNames.get(key)!;
    if (!set.has(sanitized)) {
      set.add(sanitized);
      return sanitized;
    }
    const dot = sanitized.lastIndexOf(".");
    const stem = dot === -1 ? sanitized : sanitized.slice(0, dot);
    const ext = dot === -1 ? "" : sanitized.slice(dot);
    let i = 2;
    let candidate = `${stem}-${i}${ext}`;
    while (set.has(candidate)) {
      i += 1;
      candidate = `${stem}-${i}${ext}`;
    }
    set.add(candidate);
    return candidate;
  }

  for (const item of plan.items) {
    if (!isPreviewableExtension(item.extension)) {
      skipped.push({
        original_local_path: item.local_path,
        reason: `extension ".${item.extension}" not in preview allowlist`,
      });
      continue;
    }

    const canonical = item.canonical_folder_type;
    const subdir = path.join(publicRoot, canonical);
    await fs.mkdir(subdir, { recursive: true });

    const sanitized = reserveName(canonical, sanitizeFilename(item.filename));
    const destAbs = path.join(subdir, sanitized);
    const sourceAbs = path.resolve(cwd, item.local_path);

    try {
      await fs.copyFile(sourceAbs, destAbs);
    } catch (err) {
      const reason = (err as Error).message;
      warnings.push(`Could not copy ${item.local_path}: ${reason}`);
      skipped.push({ original_local_path: item.local_path, reason });
      continue;
    }

    items.push({
      original_local_path: item.local_path,
      public_path: `/${PREVIEW_PUBLIC_DIR}/${canonical}/${sanitized}`,
      asset_type: item.asset_type,
      canonical_folder_type: canonical,
      original_folder_name: item.original_folder_name,
      filename: sanitized,
      original_filename: item.filename,
      suggested_tags: item.suggested_tags,
      source: "local_preview_copy",
    });
  }

  const map: AssetPreviewMap = AssetPreviewMapSchema.parse({
    brand_id: plan.brand_id,
    generated_at: new Date().toISOString(),
    public_dir: `/${PREVIEW_PUBLIC_DIR}/`,
    items,
    skipped,
  });

  await fs.writeFile(outputJsonPath, JSON.stringify(map, null, 2) + "\n", "utf8");

  return {
    map,
    copied: items.length,
    skipped: skipped.length,
    warnings,
  };
}

export interface PreviewAssetCounts {
  total: number;
  brand_logo: number;
  powered_by_ib: number;
  backgrounds: number;
  mockups: number;
  platform_screenshots: number;
  decorative: number;
  other: number;
}

export function countPreviewAssets(map: AssetPreviewMap): PreviewAssetCounts {
  const counts: PreviewAssetCounts = {
    total: map.items.length,
    brand_logo: 0,
    powered_by_ib: 0,
    backgrounds: 0,
    mockups: 0,
    platform_screenshots: 0,
    decorative: 0,
    other: 0,
  };
  for (const it of map.items) {
    switch (it.canonical_folder_type) {
      case "brand_logo":
        counts.brand_logo += 1;
        break;
      case "powered_by_ib":
        counts.powered_by_ib += 1;
        break;
      case "backgrounds":
        counts.backgrounds += 1;
        break;
      case "mockups":
        counts.mockups += 1;
        break;
      case "platform_screenshots":
        counts.platform_screenshots += 1;
        break;
      case "elements":
        counts.decorative += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  return counts;
}
