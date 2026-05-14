import path from "node:path";
import { promises as fs } from "node:fs";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import { AssetUploader } from "./AssetUploader";
import { AssetCard } from "./AssetCard";

export const dynamic = "force-dynamic";

async function loadMap(): Promise<AssetPreviewMap> {
  const file = path.join(process.cwd(), "data", "asset-preview-map.generated.json");
  const raw = await fs.readFile(file, "utf8");
  return AssetPreviewMapSchema.parse(JSON.parse(raw));
}

const FOLDER_DISPLAY_NAME: Record<string, string> = {
  brand_logo: "Brand logos",
  powered_by_ib: "Powered by IB",
  mockups: "Mockups",
  platform_screenshots: "Platform screenshots",
  elements: "Decorative elements",
  backgrounds: "Backgrounds",
};

const FOLDER_ORDER = [
  "brand_logo",
  "powered_by_ib",
  "mockups",
  "platform_screenshots",
  "elements",
  "backgrounds",
];

export default async function AssetsPage() {
  const map = await loadMap();

  const byFolder = new Map<string, AssetPreviewMap["items"]>();
  for (const item of map.items) {
    const arr = byFolder.get(item.canonical_folder_type) ?? [];
    arr.push(item);
    byFolder.set(item.canonical_folder_type, arr);
  }

  const orderedFolders = [
    ...FOLDER_ORDER.filter((f) => byFolder.has(f)),
    ...[...byFolder.keys()].filter((f) => !FOLDER_ORDER.includes(f)),
  ];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          All elements registered in <code className="text-xs">data/asset-preview-map.generated.json</code>.
          The renderer and campaign planner pull from this list. Upload to add a new asset; the
          file is saved to <code className="text-xs">public/brand-input-preview/&lt;type&gt;/</code> and
          the map updates atomically.
        </p>
        <p className="text-xs text-zinc-500">
          {map.items.length} assets across {byFolder.size} categories.
        </p>
      </header>

      <AssetUploader folderTypes={Object.keys(FOLDER_DISPLAY_NAME)} />

      {orderedFolders.map((folder) => {
        const items = byFolder.get(folder) ?? [];
        const display = FOLDER_DISPLAY_NAME[folder] ?? folder;
        return (
          <section
            key={folder}
            className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3"
          >
            <header className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">
                {display} <span className="text-zinc-500">({items.length})</span>
              </h2>
              <code className="text-xs text-zinc-400">{folder}</code>
            </header>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {items.map((item) => (
                <AssetCard key={item.public_path} item={item} />
              ))}
              {items.length === 0 && (
                <div className="col-span-full text-xs text-zinc-500">
                  No assets yet in this category.
                </div>
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
}
