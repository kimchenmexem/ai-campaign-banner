import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import {
  inferScreenshotContext,
  loadScreenshotTagSidecar,
  loadScreenshotTagFile,
} from "@/lib/preview/inferScreenshotContext";
import { ScreenshotTagEditor } from "@/components/preview/ScreenshotTagEditor";

// Local-development tagging UI for platform screenshots. Server component
// loads inventory + current tags, then hands off to a client editor that
// POSTs back to /api/screenshot-tags.

export const dynamic = "force-dynamic";

const PREVIEW_MAP_PATH = path.join(process.cwd(), "data", "asset-preview-map.generated.json");

async function loadPreviewMap(): Promise<AssetPreviewMap | null> {
  try {
    const raw = await fs.readFile(PREVIEW_MAP_PATH, "utf8");
    return AssetPreviewMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export default async function ScreenshotTaggerPage() {
  const map = await loadPreviewMap();
  if (!map) {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Screenshot Tagger</h1>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Asset preview map not found.</p>
          <p className="mt-1">
            Run <code>npm run preview:assets</code> first, then refresh.
          </p>
        </div>
      </section>
    );
  }

  const tagMap = await loadScreenshotTagSidecar();
  const initialTags = await loadScreenshotTagFile();

  const screenshots = map.items
    .filter((i) => i.canonical_folder_type === "platform_screenshots")
    .map((record) => {
      const inferred = inferScreenshotContext({
        filename: record.original_filename,
        folder: record.original_folder_name,
        tagsByFilename: tagMap,
      });
      return {
        record,
        inferred_context: inferred.context,
        inferred_confidence: inferred.confidence,
      };
    });

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Screenshot Tagger</h1>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Tag platform screenshots with their campaign context. Tagged screenshots
          drive contextual mockup composites (one per device × context). Saves to{" "}
          <code>brand-input/Platform screenshot/screenshot-tags.json</code>.
        </p>
        <p className="max-w-2xl text-xs text-zinc-500">
          After saving, run <code>npm run preview:mockups</code> then{" "}
          <code>npm run preview:demo</code> (or <code>npm run preview:all</code>) to
          regenerate composites and the demo campaign.
        </p>
      </header>

      <ScreenshotTagEditor screenshots={screenshots} initialTags={initialTags} />
    </section>
  );
}
