import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { chromium, type Browser } from "playwright";
import {
  type CampaignAdSpec,
  type CampaignPlan,
} from "@/lib/schemas/aiCampaignPlan.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Code-render every (concept × format) ad in a CampaignPlan via Playwright.
//
// Reads through the per-campaign render route
// `/render/campaign/[campaignId]/ad/[adId]` which loads the plan via the
// CampaignRepository — so no global mutable file is involved and two
// concurrent renders cannot cross-contaminate.
//
// Previous behavior (replaced):
//   - Wrote a temp demo file at data/demo-campaign.preview.json so the global
//     /render/ad/[adId] page could read it.
//   - Restored a backup at the end.
//   - Race: two renders running at once would overwrite each other's swap.
//   - Cleanup hole: when no backup existed, the temp file was left behind.
//
// New behavior:
//   - Render hits /render/campaign/{campaign_id}/ad/{ad_id}, which loads the
//     plan from the repository. Nothing global is touched.
// ─────────────────────────────────────────────────────────────────────────────

export const CodeRenderRecordSchema = z.object({
  ad_id: z.string(),
  campaign_id: z.string().nullable(),
  concept_id: z.string().nullable(),
  format: z.string(),
  canvas_width: z.number().int().positive(),
  canvas_height: z.number().int().positive(),
  output_local_path: z.string().nullable(),
  output_public_path: z.string().nullable(),
  status: z.enum(["completed", "failed"]),
  rendered_at: z.string(),
  source: z.literal("code_renderer"),
  element_manifest_hash: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
export type CodeRenderRecord = z.infer<typeof CodeRenderRecordSchema>;

export const RenderMapSchema = z.object({
  generated_at: z.string(),
  campaign_id: z.string().nullable(),
  base_url: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(CodeRenderRecordSchema),
});
export type RenderMap = z.infer<typeof RenderMapSchema>;

export interface RenderCampaignOptions {
  cwd?: string;
  // Logger called once per ad. Defaults to a no-op.
  onProgress?: (rec: CodeRenderRecord) => void;
  // Phase: vision QA. Default true — runs Gemini Vision QA right after the
  // PNGs land. No-op when GEMINI_API_KEY is missing (just logs a warning).
  // Set false to skip even when the key is present (e.g. when batch-rendering
  // many campaigns for an export).
  runVisionQa?: boolean;
}

export interface RenderCampaignResult {
  map: RenderMap;
  output_dir: string;
  // Saved path to data/campaigns/<id>/vision-qa.generated.json when QA ran.
  // null when skipped (no key, runVisionQa=false, or QA threw).
  vision_qa_saved_path?: string | null;
}

export async function renderCampaign(
  plan: CampaignPlan,
  baseUrl: string,
  opts: RenderCampaignOptions = {},
): Promise<RenderCampaignResult> {
  const cwd = opts.cwd ?? process.cwd();
  await ensureBaseReachable(baseUrl);

  const outDir = path.join(cwd, "public", "rendered-ads", "campaigns", plan.campaign_id);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const records: CodeRenderRecord[] = [];
    for (const concept of plan.concepts) {
      for (const ad of concept.ad_specs) {
        const rec = await renderOne(
          browser,
          ad,
          plan.campaign_id,
          concept.concept_id,
          baseUrl,
          outDir,
          cwd,
        );
        records.push(rec);
        opts.onProgress?.(rec);
      }
    }

    const completed = records.filter((r) => r.status === "completed").length;
    const failed = records.length - completed;
    const map = RenderMapSchema.parse({
      generated_at: new Date().toISOString(),
      campaign_id: plan.campaign_id,
      base_url: baseUrl,
      total: records.length,
      completed,
      failed,
      items: records,
    });

    const dataDir = path.join(cwd, "data", "campaigns", plan.campaign_id);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "code-render-map.generated.json"),
      JSON.stringify(map, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "campaign.code-rendered.json"),
      JSON.stringify({ plan, renders: records }, null, 2) + "\n",
      "utf8",
    );

    // Phase 4 — auto-run Gemini Vision QA on the just-rendered PNGs.
    // Skipped when the key is missing or the caller opted out, so a
    // dev without GEMINI_API_KEY still gets a working render path.
    let visionQaSavedPath: string | null = null;
    const runQa = opts.runVisionQa !== false;
    if (runQa && process.env.GEMINI_API_KEY && completed > 0) {
      try {
        const { runQaForCampaign } = await import("@/lib/qa/runQaForCampaign");
        const qa = await runQaForCampaign({ plan, cwd });
        visionQaSavedPath = qa.saved_path;
      } catch (err) {
        // Don't fail the render. Operators can re-run from the campaign
        // page or via `npm run qa:campaign`.
        console.warn("vision QA failed:", (err as Error).message);
      }
    }

    return {
      map,
      output_dir: outDir,
      vision_qa_saved_path: visionQaSavedPath,
    };
  } finally {
    await browser.close();
  }
}

async function renderOne(
  browser: Browser,
  ad: CampaignAdSpec,
  campaign_id: string,
  concept_id: string,
  baseUrl: string,
  outDir: string,
  cwd: string,
): Promise<CodeRenderRecord> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];

  const context = await browser.newContext({
    viewport: { width: ad.canvas_width, height: ad.canvas_height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("requestfailed", (req) => {
    if (req.resourceType() === "image") {
      warnings.push(`image request failed: ${req.url()} (${req.failure()?.errorText ?? "?"})`);
    }
  });
  page.on("pageerror", (err) => warnings.push(`pageerror: ${err.message}`));

  // Per-campaign render route — no global file swap, safe under concurrency.
  const url = `${baseUrl}/render/campaign/${encodeURIComponent(campaign_id)}/ad/${encodeURIComponent(ad.ad_id)}`;
  const filename = `${concept_id}_${ad.format}.png`;
  const outputPath = path.join(outDir, filename);
  const publicPath = `/rendered-ads/campaigns/${campaign_id}/${filename}`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.evaluate(async () => {
      // Wait for every embedded image to decode...
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
        ),
      );
      // ...AND every web font to be ready, so Hebrew/Arabic/Latin glyphs
      // are all painted from the right family before the screenshot. Without
      // this, non-Latin scripts can flash in a fallback for the first frame.
      if ("fonts" in document) {
        await (document as Document & { fonts: { ready: Promise<unknown> } })
          .fonts.ready;
      }
    });
    const canvas = page.locator("#render-canvas");
    await canvas.waitFor({ state: "visible", timeout: 10_000 });
    await canvas.screenshot({ path: outputPath, type: "png" });

    const stat = await fs.stat(outputPath);
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(ad.manifest))
      .digest("hex")
      .slice(0, 16);

    return CodeRenderRecordSchema.parse({
      ad_id: ad.ad_id,
      campaign_id,
      concept_id,
      format: ad.format,
      canvas_width: ad.canvas_width,
      canvas_height: ad.canvas_height,
      output_local_path: path.relative(cwd, outputPath),
      output_public_path: publicPath,
      status: "completed",
      rendered_at: startedAt,
      source: "code_renderer",
      element_manifest_hash: hash,
      bytes: stat.size,
      warnings,
    });
  } catch (err) {
    return CodeRenderRecordSchema.parse({
      ad_id: ad.ad_id,
      campaign_id,
      concept_id,
      format: ad.format,
      canvas_width: ad.canvas_width,
      canvas_height: ad.canvas_height,
      output_local_path: null,
      output_public_path: null,
      status: "failed",
      rendered_at: startedAt,
      source: "code_renderer",
      element_manifest_hash: null,
      bytes: null,
      warnings,
      error: (err as Error).message,
    });
  } finally {
    await context.close();
  }
}

async function ensureBaseReachable(baseUrl: string): Promise<void> {
  try {
    const probe = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok && probe.status !== 404) {
      // Non-fatal — the route may answer 200 only on specific paths.
      return;
    }
  } catch (err) {
    throw new Error(
      `Could not reach ${baseUrl}: ${(err as Error).message}. Start \`npm run dev\` first or set RENDER_BASE_URL.`,
    );
  }
}
