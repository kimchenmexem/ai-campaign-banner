import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  BrandInputSpecSchema,
  type BrandInputSpec,
} from "@/lib/schemas/brandInput.schema";
import {
  resolveFolderAlias,
  type CanonicalFolderType,
  type AssetType,
} from "@/lib/brandInput/folderAliases";

// ─────────────────────────────────────────────────────────────────────────────
// Brand Input loader.
//
// MVP intake reads from `brand-input/` on disk. Functions here:
//   - loadBrandSpec()        : read + validate brand-input/brand-spec/brand-spec.json
//   - validateBrandSpec()    : Zod-validate any candidate spec object
//   - scanBrandInputFolders(): walk top-level subfolders, return raw file list
//   - createBrandInputInventory(): combine scan + alias resolution into a typed
//                                  inventory ready to feed downstream tools
//
// No "server-only" import here — these helpers are also used by the
// scripts/brand-intake.ts orchestrator, which runs outside Next.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BRAND_INPUT_ROOT = path.join(process.cwd(), "brand-input");
export const DEFAULT_BRAND_SPEC_PATH = path.join(
  DEFAULT_BRAND_INPUT_ROOT,
  "brand-spec",
  "brand-spec.json",
);

// Files we always skip during folder scans — OS / IDE noise.
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);

const SUPPORTED_BACKGROUND_SIZE_KEYS = new Set([
  "1200x628",
  "1080x1080",
  "1080x1920",
  "1200x1200",
  "300x250",
  "336x280",
  "960x1200",
  "320x100",
  "320x50",
  "300x1050",
  "300x600",
  "160x600",
  "970x250",
  "728x90",
  "250x250",
]);
const BACKGROUND_SIZE_RE = /background[_-]?(\d+)x(\d+)/i;

// ── Inventory shape ──────────────────────────────────────────────────────────
export const BrandInputInventoryItemSchema = z.object({
  file_path: z.string(),
  original_folder_name: z.string(),
  canonical_folder_type: z.string(),
  inferred_asset_type: z.string(),
  filename: z.string(),
  extension: z.string(),
  source: z.literal("brand_input_folder"),
  requires_approval: z.boolean(),
  reference_approved: z.boolean(),
  notes: z.string().optional(),
});
export type BrandInputInventoryItem = z.infer<typeof BrandInputInventoryItemSchema>;

export const BrandInputInventorySchema = z.object({
  generated_at: z.string(),
  brand_input_root: z.string(),
  items: z.array(BrandInputInventoryItemSchema),
  unknown_folders: z.array(z.string()),
});
export type BrandInputInventory = z.infer<typeof BrandInputInventorySchema>;

// ── Brand spec loaders ───────────────────────────────────────────────────────
export async function loadBrandSpec(
  filePath: string = DEFAULT_BRAND_SPEC_PATH,
): Promise<BrandInputSpec> {
  const raw = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(raw);
  return validateBrandSpec(json);
}

export function validateBrandSpec(input: unknown): BrandInputSpec {
  return BrandInputSpecSchema.parse(input);
}

// ── Folder scan ──────────────────────────────────────────────────────────────
export interface ScannedFile {
  folder: string;
  relPath: string;
  filename: string;
  extension: string;
}

/**
 * Walk one level into `root` and list every file under each immediate
 * subfolder. We deliberately do not recurse — the brand intake taxonomy is
 * one folder per asset category. Nested folders inside (e.g. brand-spec/
 * eventually growing) are still handled because we recurse INSIDE each
 * top-level subfolder, but the `folder` field always reflects the top-level
 * subfolder name so alias resolution stays stable.
 */
export async function scanBrandInputFolders(
  root: string = DEFAULT_BRAND_INPUT_ROOT,
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  let topEntries: import("node:fs").Dirent[];
  try {
    topEntries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    const folderPath = path.join(root, folderName);
    const filesUnder = await listFilesRecursive(folderPath);
    for (const abs of filesUnder) {
      const rel = path.relative(process.cwd(), abs);
      const filename = path.basename(abs);
      if (SKIP_FILES.has(filename)) continue;
      const extension = path.extname(filename).replace(/^\./, "").toLowerCase();
      out.push({
        folder: folderName,
        relPath: rel,
        filename,
        extension,
      });
    }
  }
  return out;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ── Inventory builder ────────────────────────────────────────────────────────
const APPROVED_REFERENCE_FOLDERS: ReadonlySet<CanonicalFolderType> = new Set([
  // The brand owner has signed off on these as on-brand reference assets.
  "brand_logo",
  "powered_by_ib",
  "brand_spec",
]);

const REQUIRES_APPROVAL_FOLDERS: ReadonlySet<CanonicalFolderType> = new Set([
  // Candidates / raw materials that still need human review before use.
  "elements",
  "backgrounds",
  "platform_screenshots",
  "mockups",
]);

function classifyFlags(canonical: CanonicalFolderType): {
  reference_approved: boolean;
  requires_approval: boolean;
} {
  return {
    reference_approved: APPROVED_REFERENCE_FOLDERS.has(canonical),
    requires_approval: REQUIRES_APPROVAL_FOLDERS.has(canonical),
  };
}

export interface CreateInventoryOptions {
  root?: string;
}

export async function createBrandInputInventory(
  opts: CreateInventoryOptions = {},
): Promise<BrandInputInventory> {
  const root = opts.root ?? DEFAULT_BRAND_INPUT_ROOT;
  const scanned = await scanBrandInputFolders(root);
  const items: BrandInputInventoryItem[] = [];
  const unknown_folders = new Set<string>();

  for (const file of scanned) {
    const alias = resolveFolderAlias(file.folder);
    if (!alias) {
      unknown_folders.add(file.folder);
      continue;
    }
    if (alias.canonical_folder_type === "backgrounds") {
      const sizeMatch = file.filename.match(BACKGROUND_SIZE_RE);
      if (sizeMatch) {
        const sizeKey = `${sizeMatch[1]}x${sizeMatch[2]}`;
        if (!SUPPORTED_BACKGROUND_SIZE_KEYS.has(sizeKey)) continue;
      }
    }
    const flags = classifyFlags(alias.canonical_folder_type);
    items.push({
      file_path: file.relPath,
      original_folder_name: file.folder,
      canonical_folder_type: alias.canonical_folder_type,
      inferred_asset_type: alias.inferred_asset_type,
      filename: file.filename,
      extension: file.extension,
      source: "brand_input_folder",
      requires_approval: flags.requires_approval,
      reference_approved: flags.reference_approved,
    });
  }

  return BrandInputInventorySchema.parse({
    generated_at: new Date().toISOString(),
    brand_input_root: path.relative(process.cwd(), root) || ".",
    items,
    unknown_folders: Array.from(unknown_folders).sort(),
  });
}

// Convenience: count items by a given key for the intake summary.
export function countByCanonical(
  inventory: BrandInputInventory,
): Record<CanonicalFolderType, number> {
  const counts = {
    backgrounds: 0,
    brand_spec: 0,
    elements: 0,
    powered_by_ib: 0,
    brand_logo: 0,
    mockups: 0,
    platform_screenshots: 0,
  } satisfies Record<CanonicalFolderType, number>;
  for (const item of inventory.items) {
    const k = item.canonical_folder_type as CanonicalFolderType;
    if (k in counts) counts[k] += 1;
  }
  return counts;
}

// Convenience: filter by inferred asset type.
export function itemsByAssetType(
  inventory: BrandInputInventory,
  type: AssetType,
): BrandInputInventoryItem[] {
  return inventory.items.filter((i) => i.inferred_asset_type === type);
}
