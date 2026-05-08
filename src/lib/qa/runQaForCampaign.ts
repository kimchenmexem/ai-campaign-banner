import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  BannerQaSchema,
  type BannerQa,
  runVisionQa,
} from "@/lib/qa/visionQa";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Run vision QA across every rendered banner in a campaign.
//
// Reads:
//   data/campaigns/<id>/code-render-map.generated.json   (rendered PNG paths)
//   data/campaigns/<id>/campaign-plan.json               (manifests)
//   docs/BANNER_REFERENCE_RULES.md                       (brand rules)
//
// Writes:
//   data/campaigns/<id>/vision-qa.generated.json
//
// Concurrency is limited to 2 in-flight requests so we stay inside Gemini's
// free-tier 15-RPM limit even on 9-banner campaigns.
// ─────────────────────────────────────────────────────────────────────────────

export const VisionQaMapSchema = z.object({
  campaign_id: z.string(),
  generated_at: z.string(),
  total: z.number().int().nonnegative(),
  with_violations: z.number().int().nonnegative(),
  banners: z.array(BannerQaSchema),
  // Aggregate counts per concept so the campaign UI can summarise without
  // walking every banner.
  concept_summary: z.array(
    z.object({
      concept_id: z.string(),
      total_banners: z.number().int().nonnegative(),
      banners_with_violations: z.number().int().nonnegative(),
      violation_count: z.number().int().nonnegative(),
      severities: z.object({
        info: z.number().int().nonnegative(),
        warn: z.number().int().nonnegative(),
        block: z.number().int().nonnegative(),
      }),
    }),
  ),
});
export type VisionQaMap = z.infer<typeof VisionQaMapSchema>;

interface RenderItem {
  ad_id: string;
  format: string;
  output_local_path: string | null;
  status: string;
}

export interface RunQaForCampaignOptions {
  cwd?: string;
  plan: CampaignPlan;
  // Re-run even if a vision-qa file already exists. Default true — operators
  // hit "Run QA" expecting fresh results.
  refresh?: boolean;
  // Throttle. Gemini free-tier on gemini-2.5-flash is 5 RPM, so default
  // concurrency=1 + 13s gap between calls keeps us inside the limit
  // even on a 9-banner campaign. Bump when on a paid tier.
  concurrency?: number;
  // Minimum delay between consecutive calls inside a single worker, in ms.
  pacingMs?: number;
}

export interface RunQaForCampaignResult {
  map: VisionQaMap;
  saved_path: string;
  errors: Array<{ ad_id: string; message: string }>;
}

export async function runQaForCampaign(
  opts: RunQaForCampaignOptions,
): Promise<RunQaForCampaignResult> {
  const cwd = opts.cwd ?? process.cwd();
  const plan = opts.plan;
  const concurrency = opts.concurrency ?? 1;
  const pacingMs = opts.pacingMs ?? 13_000;

  // 1. Locate the render map.
  const renderMapPath = path.join(
    cwd,
    "data",
    "campaigns",
    plan.campaign_id,
    "code-render-map.generated.json",
  );
  let renderMap: { items: RenderItem[] };
  try {
    const raw = await fs.readFile(renderMapPath, "utf8");
    renderMap = JSON.parse(raw);
  } catch {
    throw new Error(
      `No render map for campaign ${plan.campaign_id}. Run \`npm run render:code-campaign -- --campaign-id=${plan.campaign_id}\` first.`,
    );
  }

  // 2. Build (ad_id → manifest) lookup from the plan.
  const adToManifest = new Map<string, import("@/lib/schemas/elementManifest.schema").ElementManifest>();
  const adToConcept = new Map<string, string>();
  for (const c of plan.concepts) {
    for (const ad of c.ad_specs) {
      adToManifest.set(ad.ad_id, ad.manifest);
      adToConcept.set(ad.ad_id, c.concept_id);
    }
  }

  // 3. Iterate over rendered banners, throttled. Skip ones that didn't
  //    complete (no PNG to QA). Errors are recorded per-ad without aborting
  //    the whole run.
  const candidates = renderMap.items.filter(
    (it) => it.status === "completed" && it.output_local_path,
  );
  const errors: Array<{ ad_id: string; message: string }> = [];
  const banners: BannerQa[] = [];

  // Tiny worker pool — kept inline so we don't add a `p-limit` dep.
  // Each worker waits `pacingMs` between successive calls so a single
  // worker on free-tier (5 RPM) stays inside the limit. Concurrency
  // multiplies by N — keep it 1 unless on paid tier.
  let cursor = 0;
  async function worker(workerId: number): Promise<void> {
    let lastCallAt = 0;
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const item = candidates[i];
      const manifest = adToManifest.get(item.ad_id);
      if (!manifest) {
        errors.push({
          ad_id: item.ad_id,
          message: "manifest missing on plan",
        });
        continue;
      }
      // Respect per-worker pacing.
      const elapsed = Date.now() - lastCallAt;
      const wait = lastCallAt === 0 ? 0 : Math.max(0, pacingMs - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCallAt = Date.now();
      try {
        const png = path.resolve(cwd, item.output_local_path!);
        const banner = await runVisionQa({
          pngAbsPath: png,
          manifest,
          format: item.format,
          adId: item.ad_id,
          cwd,
        });
        banners.push(banner);
      } catch (err) {
        errors.push({
          ad_id: item.ad_id,
          message: (err as Error).message,
        });
      }
    }
    void workerId;
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, (_, i) =>
      worker(i),
    ),
  );

  // 4. Concept-level aggregate.
  const conceptStats = new Map<
    string,
    {
      total: number;
      withViolations: number;
      violations: number;
      severities: { info: number; warn: number; block: number };
    }
  >();
  for (const b of banners) {
    const conceptId = adToConcept.get(b.ad_id) ?? "(unknown)";
    const s = conceptStats.get(conceptId) ?? {
      total: 0,
      withViolations: 0,
      violations: 0,
      severities: { info: 0, warn: 0, block: 0 },
    };
    s.total += 1;
    s.violations += b.violations.length;
    if (b.violations.length > 0) s.withViolations += 1;
    for (const v of b.violations) {
      s.severities[v.severity ?? "warn"] += 1;
    }
    conceptStats.set(conceptId, s);
  }

  const map: VisionQaMap = VisionQaMapSchema.parse({
    campaign_id: plan.campaign_id,
    generated_at: new Date().toISOString(),
    total: banners.length,
    with_violations: banners.filter((b) => b.violations.length > 0).length,
    banners,
    concept_summary: [...conceptStats.entries()].map(([conceptId, s]) => ({
      concept_id: conceptId,
      total_banners: s.total,
      banners_with_violations: s.withViolations,
      violation_count: s.violations,
      severities: s.severities,
    })),
  });

  const savedPath = path.join(
    cwd,
    "data",
    "campaigns",
    plan.campaign_id,
    "vision-qa.generated.json",
  );
  await fs.writeFile(savedPath, JSON.stringify(map, null, 2) + "\n", "utf8");

  return { map, saved_path: savedPath, errors };
}

export async function loadCampaignVisionQa(
  campaignId: string,
  cwd: string = process.cwd(),
): Promise<VisionQaMap | null> {
  const p = path.join(cwd, "data", "campaigns", campaignId, "vision-qa.generated.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    return VisionQaMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
