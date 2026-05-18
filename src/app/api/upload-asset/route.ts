import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
  type AssetPreviewRecord,
} from "@/lib/preview/copyPreviewAssets";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";
import {
  UploadValidationError,
  validateImageUpload,
} from "@/lib/uploads/validateImageUpload";

// POST /api/upload-asset
//
// Multipart form: file (binary) + canonical_folder_type (string).
//
// 1. Validate the file (extension + size).
// 2. Save the bytes under public/brand-input-preview/<folder>/<filename>.
// 3. Atomically rewrite data/asset-preview-map.generated.json with a new
//    AssetPreviewRecord appended to items[]. The map is the canonical
//    list every consumer reads — the renderer, the campaign planner,
//    the /assets browser — so an upload that doesn't update this file
//    isn't actually "registered" with the system.
//
// Filename collision policy: refuse. The caller must rename and retry.

const MAP_FILE = path.join(process.cwd(), "data", "asset-preview-map.generated.json");
const PUBLIC_DIR_ABS = path.join(process.cwd(), "public", "brand-input-preview");

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// canonical_folder_type → asset_type. Mirrors what's in the existing map.
const FOLDER_TO_ASSET_TYPE: Record<string, string> = {
  elements: "decorative_element",
  powered_by_ib: "powered_by_ib",
  brand_logo: "brand_logo",
  platform_screenshots: "platform_screenshot",
  backgrounds: "background",
  mockups: "mockup",
};

const FOLDER_TO_DISPLAY: Record<string, string> = {
  elements: "Elements",
  powered_by_ib: "powered_by_ib",
  brand_logo: "MEXEM logo",
  platform_screenshots: "Platform Screenshots",
  backgrounds: "Backgrounds",
  mockups: "Mockups",
};

function sanitizeFilename(name: string): string {
  // Strip any path component the browser left in (e.g. Windows uploads
  // can include "C:\\fakepath\\foo.png"). Replace whitespace with hyphen.
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\s+/g, "-");
}

export async function POST(request: Request) {
  // This route writes into the repo's public/ tree and JSON map. Dev-only.
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.upload, auth);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_multipart", message: (err as Error).message },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const folderType = form.get("canonical_folder_type");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "missing_file" },
      { status: 400 },
    );
  }
  if (typeof folderType !== "string" || !(folderType in FOLDER_TO_ASSET_TYPE)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_folder_type",
        message: `canonical_folder_type must be one of: ${Object.keys(FOLDER_TO_ASSET_TYPE).join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", message: `Max ${MAX_BYTES / 1024 / 1024} MB.` },
      { status: 400 },
    );
  }

  const safeName = sanitizeFilename(file.name);
  const ext = path.extname(safeName).toLowerCase();
  // SVG is still accepted via legacy extension check (vector logos / icons).
  // Raster types must pass the full validator: MIME + magic bytes + sharp.
  const isSvg = ext === ".svg";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      {
        ok: false,
        error: "unsupported_extension",
        message: `Allowed extensions: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (!isSvg) {
    try {
      await validateImageUpload(file, { maxBytes: MAX_BYTES });
    } catch (err) {
      if (err instanceof UploadValidationError) {
        return NextResponse.json(
          { ok: false, error: err.code, message: err.message },
          { status: err.status },
        );
      }
      throw err;
    }
  }

  const folderAbs = path.join(PUBLIC_DIR_ABS, folderType);
  const destAbs = path.join(folderAbs, safeName);
  const publicPath = `/brand-input-preview/${folderType}/${safeName}`;

  try {
    await fs.access(destAbs);
    return NextResponse.json(
      {
        ok: false,
        error: "filename_collision",
        message: `${safeName} already exists in ${folderType}/. Please rename and retry.`,
      },
      { status: 409 },
    );
  } catch {
    // file does not exist — good, proceed
  }

  // Read + parse the existing map BEFORE we write anything. If parsing
  // fails we want to refuse the upload, not corrupt the map.
  let map: AssetPreviewMap;
  try {
    const raw = await fs.readFile(MAP_FILE, "utf8");
    map = AssetPreviewMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "map_read_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  try {
    await fs.mkdir(folderAbs, { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(destAbs, buf);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "file_write_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  const assetType = FOLDER_TO_ASSET_TYPE[folderType];
  const displayFolder = FOLDER_TO_DISPLAY[folderType] ?? folderType;

  const newItem: AssetPreviewRecord = {
    original_local_path: `brand-input/${displayFolder}/${safeName}`,
    public_path: publicPath,
    asset_type: assetType,
    canonical_folder_type: folderType,
    original_folder_name: displayFolder,
    filename: safeName,
    original_filename: file.name,
    suggested_tags: [
      `brand:${map.brand_id}`,
      `category:${folderType}`,
      `type:${assetType}`,
      "source:upload_via_assets_ui",
    ],
    source: "local_preview_copy",
  };

  const nextMap: AssetPreviewMap = {
    ...map,
    generated_at: new Date().toISOString(),
    items: [...map.items, newItem],
  };

  try {
    const tmp = `${MAP_FILE}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(nextMap, null, 2) + "\n", "utf8");
    await fs.rename(tmp, MAP_FILE);
  } catch (err) {
    // The file was written but the map wasn't. The file is orphaned but
    // the map is intact — caller can retry. We don't roll back the file
    // because a partial-state-then-rollback failure is worse than a
    // registered orphan.
    return NextResponse.json(
      { ok: false, error: "map_write_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, item: newItem });
}
