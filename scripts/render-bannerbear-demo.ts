#!/usr/bin/env tsx
/**
 * Render every ad in data/demo-campaign.preview.json through Bannerbear.
 * Run with: `npm run bannerbear:render-demo`
 *
 * Continues on per-ad failures; failed ads are recorded with status="failed"
 * so the visual preview page can surface what went wrong.
 *
 * Outputs:
 *   data/bannerbear-render-map.generated.json
 *   data/demo-campaign.bannerbear-rendered.json  (demo + per-ad render summary)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import {
  renderAdWithBannerbear,
  RenderAdResultSchema,
  type RenderAdResult,
} from "@/lib/bannerbear/renderAd";

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");
const RENDER_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "bannerbear-render-map.generated.json",
);
const RENDERED_DEMO_PATH = path.join(
  process.cwd(),
  "data",
  "demo-campaign.bannerbear-rendered.json",
);

const RenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(RenderAdResultSchema),
});
type RenderMap = z.infer<typeof RenderMapSchema>;

async function main() {
  await loadEnvLocalIfPresent();
  console.log("Bannerbear demo render — reading data/demo-campaign.preview.json ...");

  let demo: DemoCampaign;
  try {
    demo = DemoCampaignSchema.parse(
      JSON.parse(await fs.readFile(DEMO_PATH, "utf8")),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "✗ data/demo-campaign.preview.json not found. Run `npm run preview:demo` first.",
      );
      process.exit(2);
    }
    throw err;
  }

  const items: RenderAdResult[] = [];
  for (const adSpec of demo.ad_specs) {
    const tag = `${adSpec.size.width}x${adSpec.size.height}`;
    process.stdout.write(`[${tag}] rendering ${adSpec.specId} ... `);
    const t0 = Date.now();
    const result = await renderAdWithBannerbear(adSpec);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.status === "completed" && result.final_render_url) {
      console.log(`✓ completed in ${elapsed}s → ${result.final_render_url}`);
    } else {
      console.log(`✗ ${result.status}${result.error ? ` (${result.error})` : ""} (${elapsed}s)`);
    }
    items.push(result);
  }

  const completed = items.filter((i) => i.status === "completed").length;
  const failed = items.length - completed;

  const map: RenderMap = RenderMapSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: demo.brand_id,
    total: items.length,
    completed,
    failed,
    items,
  });

  await fs.writeFile(RENDER_MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf8");
  await fs.writeFile(
    RENDERED_DEMO_PATH,
    JSON.stringify({ demo, renders: items }, null, 2) + "\n",
    "utf8",
  );

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  total:     ${items.length}`);
  console.log(`  completed: ${completed}`);
  console.log(`  failed:    ${failed}`);
  console.log("");
  console.log(`✓ Wrote ${path.relative(process.cwd(), RENDER_MAP_PATH)}`);
  console.log(`✓ Wrote ${path.relative(process.cwd(), RENDERED_DEMO_PATH)}`);
  console.log("");
  console.log("Next: npm run dev (if not already), then open /bannerbear-preview.");

  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("bannerbear:render-demo failed:", (err as Error).message);
  process.exit(1);
});
