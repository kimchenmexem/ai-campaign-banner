import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import { loadMockupManifestArray } from "@/lib/preview/mockupManifest";
import { MockupCalibrator } from "@/components/preview/MockupCalibrator";

// Local-development calibrator. Server component reads the inventory + the
// current mockup-manifest.json, hands off to a client editor that POSTs to
// /api/mockup-manifest.

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

export default async function MockupCalibratorPage() {
  const map = await loadPreviewMap();
  if (!map) {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Mockup Calibrator</h1>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Asset preview map not found.</p>
          <p className="mt-1">
            Run <code>npm run preview:assets</code> first, then refresh.
          </p>
        </div>
      </section>
    );
  }

  const initialEntries = await loadMockupManifestArray();
  const mockups = map.items
    .filter((i) => i.canonical_folder_type === "mockups")
    .sort((a, b) => a.original_filename.localeCompare(b.original_filename));

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Mockup Calibrator</h1>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Define the screen rectangle inside each device mockup. Drag the rectangle to
          reposition; type into the fields for precise pixel values. Saves to{" "}
          <code>brand-input/mockup devices/mockup-manifest.json</code>.
        </p>
        <p className="max-w-2xl text-xs text-zinc-500">
          After saving, run <code>npm run preview:mockups</code> (or{" "}
          <code>npm run preview:all</code>) to recomposite with the updated slots.
        </p>
      </header>

      <MockupCalibrator mockups={mockups} initialEntries={initialEntries} />
    </section>
  );
}
