#!/usr/bin/env tsx
/**
 * Code-based renderer — capture each AdSpec at exact canvas size from the
 * /render/ad/[adId] route via Playwright + headless Chromium.
 *
 * Run with: `npm run render:code-demo`
 *
 * Requirements:
 *   - dev server running at $RENDER_BASE_URL (default http://localhost:3000)
 *   - data/demo-campaign.preview.json present (run `npm run preview:demo`)
 *
 * Outputs:
 *   - public/rendered-ads/demo/<format>.png
 *   - data/code-render-map.generated.json
 *   - data/demo-campaign.code-rendered.json
 *
 * On failure for one ad the script keeps going; the failure is recorded in
 * the render map.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { chromium, type Browser } from "playwright";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import {
  DemoCampaignSchema,
  type DemoCampaign,
  type DemoAdSpec,
} from "@/lib/preview/createDemoCampaign";

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");
const RENDER_DIR = path.join(process.cwd(), "public", "rendered-ads", "demo");
const RENDER_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "code-render-map.generated.json",
);
const RENDERED_DEMO_PATH = path.join(
  process.cwd(),
  "data",
  "demo-campaign.code-rendered.json",
);

const CodeRenderRecordSchema = z.object({
  ad_id: z.string(),
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
type CodeRenderRecord = z.infer<typeof CodeRenderRecordSchema>;

const CodeRenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  base_url: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(CodeRenderRecordSchema),
});

const DEFAULT_BASE_URL = process.env.RENDER_BASE_URL ?? "http://localhost:3000";

async function main() {
  await loadEnvLocalIfPresent();
  const baseUrl = parseBaseUrl();

  console.log(`Code render — using ${baseUrl} (override with RENDER_BASE_URL or --base-url=...)`);

  const demo = await loadDemo();
  await fs.mkdir(RENDER_DIR, { recursive: true });

  // Sanity-ping the dev server so failures are clear instead of weird timeouts.
  try {
    const probe = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok && probe.status !== 404) {
      console.warn(`! ${baseUrl} returned HTTP ${probe.status} — continuing anyway.`);
    }
  } catch (err) {
    console.error(
      `✗ Could not reach ${baseUrl}: ${(err as Error).message}\n  Start the dev server (\`npm run dev\`) before running this script.`,
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const items: CodeRenderRecord[] = [];
    for (const adSpec of demo.ad_specs) {
      const rec = await renderOne(browser, adSpec, baseUrl);
      items.push(rec);
      logRender(rec);
    }

    const completed = items.filter((i) => i.status === "completed").length;
    const failed = items.length - completed;
    const map = CodeRenderMapSchema.parse({
      generated_at: new Date().toISOString(),
      brand_id: demo.brand_id,
      base_url: baseUrl,
      total: items.length,
      completed,
      failed,
      items,
    });

    await fs.writeFile(
      RENDER_MAP_PATH,
      JSON.stringify(map, null, 2) + "\n",
      "utf8",
    );
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
    if (failed > 0) process.exit(2);
  } finally {
    await browser.close();
  }
}

function parseBaseUrl(): string {
  const flag = process.argv.find((a) => a.startsWith("--base-url="));
  if (flag) return flag.slice("--base-url=".length);
  return DEFAULT_BASE_URL;
}

async function loadDemo(): Promise<DemoCampaign> {
  let raw: string;
  try {
    raw = await fs.readFile(DEMO_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "✗ data/demo-campaign.preview.json not found. Run `npm run preview:demo` first.",
      );
      process.exit(2);
    }
    throw err;
  }
  return DemoCampaignSchema.parse(JSON.parse(raw));
}

async function renderOne(
  browser: Browser,
  adSpec: DemoAdSpec,
  baseUrl: string,
): Promise<CodeRenderRecord> {
  const startedAt = new Date().toISOString();
  const format = `${adSpec.size.width}x${adSpec.size.height}`;
  const warnings: string[] = [];

  const context = await browser.newContext({
    viewport: { width: adSpec.size.width, height: adSpec.size.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  // Surface page errors / failed image requests as warnings so the render
  // record explains why a visual might be blank.
  page.on("requestfailed", (req) => {
    if (req.resourceType() === "image") {
      warnings.push(`image request failed: ${req.url()} (${req.failure()?.errorText ?? "?"})`);
    }
  });
  page.on("pageerror", (err) => warnings.push(`pageerror: ${err.message}`));

  const url = `${baseUrl}/render/ad/${encodeURIComponent(adSpec.specId)}`;
  const outputPath = path.join(RENDER_DIR, `${format}.png`);
  const publicPath = `/rendered-ads/demo/${format}.png`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Wait for all images to be decoded before screenshotting. Without this
    // the headless browser sometimes captures before remote (Cloudinary)
    // images have actually decoded, leaving blank slots.
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.evaluate(async () => {
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
    });

    const canvas = page.locator("#render-canvas");
    await canvas.waitFor({ state: "visible", timeout: 10_000 });
    await canvas.screenshot({ path: outputPath, type: "png" });

    const stat = await fs.stat(outputPath);
    const hash = await hashElementManifest(adSpec);

    return CodeRenderRecordSchema.parse({
      ad_id: adSpec.specId,
      format,
      canvas_width: adSpec.size.width,
      canvas_height: adSpec.size.height,
      output_local_path: path.relative(process.cwd(), outputPath),
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
      ad_id: adSpec.specId,
      format,
      canvas_width: adSpec.size.width,
      canvas_height: adSpec.size.height,
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

async function hashElementManifest(adSpec: DemoAdSpec): Promise<string> {
  const json = JSON.stringify(adSpec.manifest);
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function logRender(rec: CodeRenderRecord) {
  const tag = `[${rec.format}]`;
  if (rec.status === "completed") {
    const kb = rec.bytes ? `${(rec.bytes / 1024).toFixed(0)} KB` : "?";
    console.log(`${tag} ✓ ${rec.output_public_path} (${kb})`);
    if (rec.warnings.length > 0) {
      for (const w of rec.warnings) console.log(`${tag}   ! ${w}`);
    }
  } else {
    console.log(`${tag} ✗ ${rec.error ?? "unknown error"}`);
  }
}

main().catch((err) => {
  console.error("render:code-demo failed:", (err as Error).message);
  process.exit(1);
});
