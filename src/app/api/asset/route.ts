import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";

// DELETE /api/asset
//
// Body: { "public_path": "/brand-input-preview/<folder>/<filename>" }
//
// 1. Validate the path stays inside public/brand-input-preview/ (no
//    traversal — refuse anything with "..", absolute, or differing
//    prefix).
// 2. Remove the entry with that public_path from
//    data/asset-preview-map.generated.json (atomically).
// 3. Delete the file from public/brand-input-preview/<folder>/<filename>.
//    If the file is already missing on disk we still proceed — better
//    to clean up an orphan map entry than to leave it lingering.
//
// Map-write happens BEFORE file-delete: the manifest is the source of
// truth. If the file delete fails after the map was updated, the file
// becomes an unreferenced leftover (cleanup-able), which is preferable
// to a removed file that the planner still thinks exists.

const MAP_FILE = path.join(process.cwd(), "data", "asset-preview-map.generated.json");
const PUBLIC_DIR_ABS = path.join(process.cwd(), "public");
const ASSET_PREFIX = "/brand-input-preview/";

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const publicPath = (body as { public_path?: unknown })?.public_path;
  if (typeof publicPath !== "string" || !publicPath.startsWith(ASSET_PREFIX)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_public_path",
        message: `public_path must be a string starting with "${ASSET_PREFIX}".`,
      },
      { status: 400 },
    );
  }
  if (publicPath.includes("..")) {
    return NextResponse.json(
      { ok: false, error: "path_traversal_refused" },
      { status: 400 },
    );
  }

  // Resolve and re-check that the absolute path stays under public/.
  const fileAbs = path.resolve(PUBLIC_DIR_ABS, publicPath.replace(/^\//, ""));
  if (!fileAbs.startsWith(PUBLIC_DIR_ABS + path.sep)) {
    return NextResponse.json(
      { ok: false, error: "path_outside_public" },
      { status: 400 },
    );
  }

  // Read + parse the map first. Bail BEFORE touching disk if it's corrupt.
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

  const matchIndex = map.items.findIndex((it) => it.public_path === publicPath);
  if (matchIndex < 0) {
    return NextResponse.json(
      { ok: false, error: "not_found", message: `No entry with public_path ${publicPath}` },
      { status: 404 },
    );
  }
  const removed = map.items[matchIndex];

  const nextMap: AssetPreviewMap = {
    ...map,
    generated_at: new Date().toISOString(),
    items: map.items.filter((_, i) => i !== matchIndex),
  };

  // Atomic map write first.
  try {
    const tmp = `${MAP_FILE}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(nextMap, null, 2) + "\n", "utf8");
    await fs.rename(tmp, MAP_FILE);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "map_write_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  // Then file delete. Missing file is fine — orphan map entries are
  // worse than orphan files.
  let fileDeleted = false;
  try {
    await fs.unlink(fileAbs);
    fileDeleted = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      return NextResponse.json(
        {
          ok: false,
          error: "file_delete_failed",
          message: e.message,
          note: "Map entry already removed; file remains on disk and can be deleted manually.",
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, removed, file_deleted: fileDeleted });
}
