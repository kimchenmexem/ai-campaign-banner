import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import {
  TAG_SIDECAR_FILE_PATH,
  loadScreenshotTagFile,
  writeScreenshotTagFile,
  type ScreenshotContext,
  type ScreenshotTag,
} from "@/lib/preview/inferScreenshotContext";

// ─────────────────────────────────────────────────────────────────────────────
// Auto-seed brand-input/Platform screenshot/screenshot-tags.json so the
// preview pipeline produces *contextual* composites immediately, even before
// a human walks /screenshot-tagger.
//
// Logic:
//   - First screenshot  → stocks
//   - Second screenshot → etfs
//   - Third screenshot  → charts
//   - Fourth screenshot → green_data
//   - Remaining         → general_platform
//
// Every seeded entry carries a `notes` line marking it auto-seeded so a
// reviewer can find them quickly. Existing tag files are preserved unless
// `force: true` is passed (or `--force` on the CLI).
// ─────────────────────────────────────────────────────────────────────────────

const SEED_PRIORITY: ScreenshotContext[] = ["stocks", "etfs", "charts", "green_data"];

const SEED_NOTE = "auto-seeded; requires human review";

export interface SeedScreenshotTagsOptions {
  cwd?: string;
  assetMapPath?: string;
  outputPath?: string;
  force?: boolean;
}

export interface SeedScreenshotTagsResult {
  status: "wrote" | "kept_existing" | "no_screenshots";
  tags: ScreenshotTag[];
  outputPath: string;
}

export async function createScreenshotTagSeed(
  opts: SeedScreenshotTagsOptions = {},
): Promise<SeedScreenshotTagsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const assetMapPath =
    opts.assetMapPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const outputPath = opts.outputPath ?? TAG_SIDECAR_FILE_PATH;

  const map: AssetPreviewMap = AssetPreviewMapSchema.parse(
    JSON.parse(await fs.readFile(assetMapPath, "utf8")),
  );

  // Preserve existing tags unless --force.
  if (!opts.force) {
    const existing = await loadScreenshotTagFile(outputPath);
    if (existing.length > 0) {
      return { status: "kept_existing", tags: existing, outputPath };
    }
  }

  const screenshots = map.items
    .filter((i) => i.canonical_folder_type === "platform_screenshots")
    .sort((a, b) => a.original_filename.localeCompare(b.original_filename));

  if (screenshots.length === 0) {
    return { status: "no_screenshots", tags: [], outputPath };
  }

  const tags: ScreenshotTag[] = screenshots.map((s, idx) => {
    const context: ScreenshotContext =
      idx < SEED_PRIORITY.length ? SEED_PRIORITY[idx] : "general_platform";
    return {
      filename: s.original_filename,
      context,
      notes: SEED_NOTE,
    };
  });

  await writeScreenshotTagFile(tags, outputPath);
  return { status: "wrote", tags, outputPath };
}
