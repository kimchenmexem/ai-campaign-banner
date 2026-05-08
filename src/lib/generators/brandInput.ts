import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
  type AssetPreviewRecord,
} from "@/lib/preview/copyPreviewAssets";
import {
  MockupCompositeMapSchema,
  type MockupCompositeMap,
} from "@/lib/preview/composeMockupPreview";
import {
  loadMockupManifest,
  type MockupManifestEntry,
  type DeviceType,
} from "@/lib/preview/mockupManifest";
import {
  inferScreenshotContext,
  loadScreenshotTagSidecar,
  type ScreenshotTag,
} from "@/lib/preview/inferScreenshotContext";
import type {
  BrandInputAsset,
  GeneratedAssetType,
} from "@/lib/schemas/generatedAsset.schema";

// ─────────────────────────────────────────────────────────────────────────────
// brandInput — typed read-only lookups over the existing brand-intake outputs.
//
// Reads (lazily, ENOENT-tolerant):
//   - data/asset-preview-map.generated.json
//   - data/mockup-composite-map.generated.json
//   - data/cloudinary-asset-map.generated.json (best-effort URL enrichment)
//   - brand-input/mockup devices/mockup-manifest.json
//   - data/screenshot-tags.generated.json (via inferScreenshotContext)
//
// Used by the Asset Generator UI picker and by every generator that needs to
// resolve a brand-input file path → readable absolute path on disk.
// ─────────────────────────────────────────────────────────────────────────────

interface CloudinaryUrlMap {
  byOriginalLocalPath: Map<string, string>;
}

type MockupManifestMap = Map<string, MockupManifestEntry>;

export interface BrandInputContext {
  assetMap: AssetPreviewMap;
  compositeMap: MockupCompositeMap | null;
  cloudinary: CloudinaryUrlMap | null;
  mockupManifest: MockupManifestMap;
  tagSidecar: Map<string, ScreenshotTag>;
}

export async function loadBrandInputContext(
  cwd: string = process.cwd(),
): Promise<BrandInputContext> {
  const assetMap = await readAssetMap(cwd);
  const compositeMap = await readCompositeMap(cwd);
  const cloudinary = await readCloudinaryUrlMap(cwd);
  const mockupManifest = await loadMockupManifest(
    path.join(cwd, "brand-input", "mockup devices", "mockup-manifest.json"),
  );
  const tagSidecar = await loadScreenshotTagSidecar();
  return { assetMap, compositeMap, cloudinary, mockupManifest, tagSidecar };
}

// Listing — the UI picker calls this via the brand-input-assets route.
export async function listBrandInputAssets(opts: {
  cwd?: string;
  generatorType?: GeneratedAssetType;
}): Promise<BrandInputAsset[]> {
  const cwd = opts.cwd ?? process.cwd();
  const ctx = await loadBrandInputContext(cwd);
  const folders = brandInputFoldersFor(opts.generatorType);
  const items = ctx.assetMap.items.filter((it) =>
    folders.includes(it.canonical_folder_type as BrandInputAsset["canonical_folder_type"]),
  );

  const out: BrandInputAsset[] = items.map((it) =>
    enrichAsset(it, ctx),
  );
  // Stable sort by canonical_folder_type then filename so the UI groups nicely.
  out.sort((a, b) => {
    if (a.canonical_folder_type !== b.canonical_folder_type) {
      return a.canonical_folder_type.localeCompare(b.canonical_folder_type);
    }
    return a.filename.localeCompare(b.filename);
  });
  return out;
}

function enrichAsset(
  it: AssetPreviewRecord,
  ctx: BrandInputContext,
): BrandInputAsset {
  const cloudinary = ctx.cloudinary?.byOriginalLocalPath.get(it.original_local_path);
  const base: BrandInputAsset = {
    id: it.original_local_path,
    filename: it.filename,
    original_filename: it.original_filename,
    canonical_folder_type:
      it.canonical_folder_type as BrandInputAsset["canonical_folder_type"],
    public_path: it.public_path,
    cloudinary_secure_url: cloudinary,
  };
  if (it.canonical_folder_type === "mockups") {
    const entry = ctx.mockupManifest.get(it.original_filename.toLowerCase());
    if (entry) {
      base.device_type = entry.device_type;
      base.slot_source = entry.screen_slot.corners ? "perspective" : "axis_aligned";
    } else {
      // Heuristic device family from filename, same logic the renderer uses.
      base.device_type = inferDeviceFromFilename(it.original_filename);
      base.slot_source = "heuristic";
    }
  }
  if (it.canonical_folder_type === "platform_screenshots") {
    const inferred = inferScreenshotContext({
      filename: it.original_filename,
      folder: it.original_folder_name,
      tagsByFilename: ctx.tagSidecar,
    });
    base.screenshot_context = inferred.context;
  }
  return base;
}

// Resolve a path supplied by the UI/API ("/brand-input-preview/...png" or
// "brand-input/.../.png" or absolute) into an absolute filesystem path.
export function resolveBrandInputPath(cwd: string, supplied: string): string {
  if (supplied.startsWith("/")) {
    if (supplied.startsWith("/brand-input-preview/") || supplied.startsWith("/generated-")) {
      return path.join(cwd, "public", supplied.replace(/^\//, ""));
    }
    if (path.isAbsolute(supplied)) return supplied;
  }
  if (path.isAbsolute(supplied)) return supplied;
  return path.join(cwd, supplied);
}

export function brandInputFoldersFor(
  generatorType?: GeneratedAssetType,
): BrandInputAsset["canonical_folder_type"][] {
  switch (generatorType) {
    case "background":
      return ["backgrounds", "elements"];
    case "cta":
      return [];
    case "mockup":
      return ["mockups", "platform_screenshots"];
    case "trading_ui":
      return ["platform_screenshots"];
    case "fx_overlay":
      return ["elements", "backgrounds"];
    default:
      return ["backgrounds", "elements", "mockups", "platform_screenshots", "brand_logo", "powered_by_ib"];
  }
}

// ── Disk readers (ENOENT-tolerant) ───────────────────────────────────────────
async function readAssetMap(cwd: string): Promise<AssetPreviewMap> {
  const p = path.join(cwd, "data", "asset-preview-map.generated.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    return AssetPreviewMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        brand_id: "unknown",
        generated_at: new Date().toISOString(),
        public_dir: "/brand-input-preview/",
        items: [],
        skipped: [],
      };
    }
    throw err;
  }
}

async function readCompositeMap(
  cwd: string,
): Promise<MockupCompositeMap | null> {
  const p = path.join(cwd, "data", "mockup-composite-map.generated.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    return MockupCompositeMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readCloudinaryUrlMap(
  cwd: string,
): Promise<CloudinaryUrlMap | null> {
  const p = path.join(cwd, "data", "cloudinary-asset-map.generated.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw) as {
      items?: Array<{ original_local_path?: string; secure_url?: string }>;
    };
    const map = new Map<string, string>();
    for (const item of json.items ?? []) {
      if (item.original_local_path && item.secure_url) {
        map.set(item.original_local_path, item.secure_url);
      }
    }
    return { byOriginalLocalPath: map };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function inferDeviceFromFilename(name: string): DeviceType {
  const v = name.toLowerCase();
  if (/iphone|phone|mobile/.test(v)) return "phone";
  if (/ipad|tablet/.test(v)) return "tablet";
  if (/macbook|laptop|notebook/.test(v)) return "laptop";
  if (/desktop|imac|monitor/.test(v)) return "desktop";
  if (/iwatch|watch/.test(v)) return "smartwatch";
  return "unknown";
}
