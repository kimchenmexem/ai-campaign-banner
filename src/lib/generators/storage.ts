import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  GeneratedAssetIndexSchema,
  GeneratedAssetSchema,
  type GeneratedAsset,
  type GeneratedAssetIndex,
  type GeneratedAssetType,
} from "@/lib/schemas/generatedAsset.schema";
import { defaultPlacementRules } from "@/lib/generators/placement";
import type { GenerateResult } from "@/lib/generators/types";

// Phase 4 — Sharp-rendered thumbnail. Cheap (one resize per persist) and
// makes the gallery snappy when the canvas is 4096×4096. Width chosen to
// match the gallery's ~h-40 cards at 2x DPR.
const THUMB_MAX_DIMENSION = 480;

// ─────────────────────────────────────────────────────────────────────────────
// Storage layer for the Asset Generator.
//
// Two artefacts per asset:
//   1. Bytes on disk — public/generated-assets/<type-dir>/<id>.<ext>
//   2. A row in the index — data/generated-assets.generated.json
//
// `persistAsset()` does both in one call. The index is rewritten in full each
// time, which is fine for the volumes we expect (hundreds, not millions).
// ─────────────────────────────────────────────────────────────────────────────

export const ASSET_PUBLIC_DIR = "generated-assets";
export const INDEX_PATH = path.join(
  "data",
  "generated-assets.generated.json",
);

const TYPE_DIR: Record<GeneratedAssetType, string> = {
  background: "backgrounds",
  cta: "ctas",
  mockup: "mockups",
  trading_ui: "trading-ui",
  fx_overlay: "fx-overlays",
};

export function dirForType(type: GeneratedAssetType): string {
  return TYPE_DIR[type];
}

function shortId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export interface PersistAssetArgs {
  result: GenerateResult;
  cwd?: string;
}

export async function persistAsset(args: PersistAssetArgs): Promise<GeneratedAsset> {
  const cwd = args.cwd ?? process.cwd();
  const result = args.result;

  const id = `asset_${result.type}_${shortId()}`;
  const ext = result.format;
  const subdir = TYPE_DIR[result.type];
  const relPath = path.posix.join(ASSET_PUBLIC_DIR, subdir, `${id}.${ext}`);
  const absDir = path.join(cwd, "public", ASSET_PUBLIC_DIR, subdir);
  const absPath = path.join(absDir, `${id}.${ext}`);

  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(absPath, result.bytes);

  // Render the gallery thumbnail. Best-effort: if Sharp can't decode the
  // bytes (e.g. malformed SVG), we silently skip and the gallery falls back
  // to the full-resolution `url`. PNG output for cross-format consistency.
  const thumbRelPath = path.posix.join(
    ASSET_PUBLIC_DIR,
    subdir,
    `${id}.thumb.png`,
  );
  const thumbAbsPath = path.join(absDir, `${id}.thumb.png`);
  let thumbWritten = false;
  try {
    await sharp(result.bytes)
      .resize({
        width: THUMB_MAX_DIMENSION,
        height: THUMB_MAX_DIMENSION,
        fit: "inside",
        kernel: "lanczos3",
      })
      .png()
      .toFile(thumbAbsPath);
    thumbWritten = true;
  } catch {
    // Skip thumbnail; not fatal.
  }

  const asset: GeneratedAsset = GeneratedAssetSchema.parse({
    id,
    type: result.type,
    variant: result.variant,
    format: result.format,
    size: result.size,
    file_path: relPath,
    url: `/${relPath}`,
    params: result.params,
    brand_token_refs: result.brand_token_refs,
    generator: result.generator,
    seed: result.seed,
    created_at: new Date().toISOString(),
    tags: result.tags ?? [],
    notes: result.notes,
    license: "internal",
    approved: true,
    preview_thumbnail_path: thumbWritten ? `/${thumbRelPath}` : undefined,
    render_mode: result.render_mode ?? "image",
    placement_rules:
      result.placement_rules ??
      defaultPlacementRules(result.type, result.variant),
    source_assets: result.source_assets ?? [],
    element_manifest_preview: result.element_manifest_preview,
  });

  await appendToIndex(asset, cwd);
  return asset;
}

async function readIndex(cwd: string): Promise<GeneratedAssetIndex> {
  const p = path.join(cwd, INDEX_PATH);
  try {
    const raw = await fs.readFile(p, "utf8");
    return GeneratedAssetIndexSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { generated_at: new Date().toISOString(), assets: [] };
    }
    throw err;
  }
}

async function appendToIndex(asset: GeneratedAsset, cwd: string): Promise<void> {
  const index = await readIndex(cwd);
  index.assets.push(asset);
  index.generated_at = new Date().toISOString();
  const p = path.join(cwd, INDEX_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export async function listAssets(opts?: {
  cwd?: string;
  type?: GeneratedAssetType;
  limit?: number;
}): Promise<GeneratedAsset[]> {
  const cwd = opts?.cwd ?? process.cwd();
  const index = await readIndex(cwd);
  const filtered = opts?.type
    ? index.assets.filter((a) => a.type === opts.type)
    : index.assets;
  // Newest first.
  const sorted = [...filtered].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  if (typeof opts?.limit === "number") return sorted.slice(0, opts.limit);
  return sorted;
}

export async function deleteAsset(
  id: string,
  cwd: string = process.cwd(),
): Promise<{ deleted: GeneratedAsset } | null> {
  const index = await readIndex(cwd);
  const idx = index.assets.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const [removed] = index.assets.splice(idx, 1);
  index.generated_at = new Date().toISOString();

  const indexPath = path.join(cwd, INDEX_PATH);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

  // Best-effort: also unlink the bytes. The index row is the source of truth
  // for "is this asset listed?" — if the file is missing on disk we still
  // want the row gone, so we swallow ENOENT.
  const filePath = path.join(cwd, "public", removed.file_path);
  await fs.unlink(filePath).catch(() => {});
  if (removed.preview_thumbnail_path) {
    const thumbPath = path.join(
      cwd,
      "public",
      removed.preview_thumbnail_path.replace(/^\//, ""),
    );
    await fs.unlink(thumbPath).catch(() => {});
  }

  return { deleted: removed };
}

// Phase 4 — flip the `approved` flag in place. Returns the updated asset, or
// null when the id is unknown. Touches no bytes.
export async function setAssetApproval(
  id: string,
  approved: boolean,
  cwd: string = process.cwd(),
): Promise<GeneratedAsset | null> {
  const index = await readIndex(cwd);
  const idx = index.assets.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const updated: GeneratedAsset = { ...index.assets[idx], approved };
  index.assets[idx] = updated;
  index.generated_at = new Date().toISOString();
  const indexPath = path.join(cwd, INDEX_PATH);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  return updated;
}
