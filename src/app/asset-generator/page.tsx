import { GENERATOR_REGISTRY } from "@/lib/generators/registry";
import { listAssets } from "@/lib/generators/storage";
import { computeAssetUsage } from "@/lib/generators/usage";
import { AssetGeneratorTabs } from "./AssetGeneratorTabs";

// /asset-generator
//
// Standalone section — produces reusable creative assets (NOT full banners).
// Server component loads the registry + recent assets + usage map, then
// hands them to the client tabs which call the per-type POST endpoints.

export default async function AssetGeneratorPage() {
  const recent = await listAssets({ limit: 60 });
  // Phase 4 — pre-compute usage so the gallery's "used in campaign" filter
  // doesn't need a separate round-trip on first render.
  const usage = await computeAssetUsage();
  const usageMap: Record<string, string[]> = {};
  for (const [id, cids] of usage.byAssetId) usageMap[id] = cids;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Asset Generator</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Reusable creative building blocks — backgrounds, CTA buttons, device
          mockups, trading-UI widgets, FX overlays. Deterministic SVG/PNG, brand
          colors only, no AI calls.
        </p>
      </header>
      <AssetGeneratorTabs
        registry={GENERATOR_REGISTRY}
        initialRecent={recent}
        initialUsage={usageMap}
      />
    </section>
  );
}
