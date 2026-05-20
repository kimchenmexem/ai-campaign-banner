import { chromium, type Browser } from "playwright";
import { PDFDocument } from "pdf-lib";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

// ─────────────────────────────────────────────────────────────────────────────
// PDF export — the reliable way to land in Figma.
//
// We tried two SVG paths and Figma's SVG importer fought both:
//   1. Nested <svg> → Figma rasterised each banner to a single image.
//   2. Flat <g transform> with namespaced IDs → import worked but
//      designers reported deep nesting and inconsistent editability.
//
// PDF is the well-trodden path for "many banners → one Figma file":
//   - Render each banner SVG into a Playwright page sized to the banner's
//     exact pixel dimensions, then call page.pdf() with no margins.
//   - The PDF Chromium produces preserves <text> as real PDF text strokes,
//     not outlines, AND keeps vector shapes vector. No rasterisation.
//   - Merge per-banner single-page PDFs into one multi-page PDF using
//     pdf-lib.
//   - Figma's PDF importer creates ONE NATIVE FRAME per page. Each frame
//     contains real Figma text nodes (still editable), real vector shapes,
//     and real images. No drilling through groups; no "Detach Instance"
//     dance. This is the format Figma's importer was actually designed for.
//
// Performance: Chromium boot + per-banner page render ≈ 0.6-1.0s. A
// 9-banner campaign takes 8-15s end-to-end. Fits inside Vercel's 60s
// serverless timeout (maxDuration on the route is set to 90 for headroom).
//
// Embedding policy: same as the SVG exporter — embedLocalImages defaults
// to FALSE so Cloudinary refs stay remote. Chromium fetches them while
// rendering each PDF page, so the PDF still ends up with real image data
// inside; size stays sane (no double base64 inflation in the SVG layer).
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportCampaignPdfResult {
  pdf: Uint8Array;
  filename: string;
  byteLength: number;
  succeeded: string[];
  failed: Array<{ ad_id: string; error: string }>;
}

interface BannerPage {
  adId: string;
  format: string;
  width: number;
  height: number;
  svg: string;
}

export async function exportCampaignPdf(args: {
  plan: CampaignPlan;
  cwd?: string;
  embedLocalImages?: boolean;
}): Promise<ExportCampaignPdfResult> {
  const { plan } = args;
  const embedLocalImages = args.embedLocalImages ?? false;

  // ── 1. Generate every banner SVG ─────────────────────────────────────
  const banners: BannerPage[] = [];
  const failed: Array<{ ad_id: string; error: string }> = [];

  for (const concept of plan.concepts) {
    for (const ad of concept.ad_specs) {
      try {
        const result = await exportAdSvg({
          plan,
          adId: ad.ad_id,
          cwd: args.cwd,
          embedLocalImages,
        });
        banners.push({
          adId: ad.ad_id,
          format: ad.format,
          width: ad.canvas_width,
          height: ad.canvas_height,
          svg: result.svg,
        });
      } catch (err) {
        failed.push({ ad_id: ad.ad_id, error: (err as Error).message });
      }
    }
  }

  // ── 2. Spin up Playwright once, render each banner → single-page PDF ──
  let browser: Browser | null = null;
  const perBannerPdfs: Array<{ adId: string; bytes: Uint8Array }> = [];

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const banner of banners) {
      try {
        // Wrap SVG in HTML so Chromium sets the page dimensions correctly.
        // body { margin:0 } prevents the renderer from clipping to a
        // smaller box than the SVG viewBox. width/height on the <svg>
        // are already authoritative; html/body just stop their default
        // 8px margin.
        const html = wrapSvgInHtml(banner.svg, banner.width, banner.height);
        await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });

        // page.pdf with width/height matching the banner gives one page
        // at the banner's native pixel size. printBackground keeps the
        // banner's background gradient/colour intact (default treats
        // background-color as background-only and strips it).
        const bytes = await page.pdf({
          width: `${banner.width}px`,
          height: `${banner.height}px`,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          printBackground: true,
          preferCSSPageSize: false,
        });
        perBannerPdfs.push({ adId: banner.adId, bytes: new Uint8Array(bytes) });
      } catch (err) {
        failed.push({ ad_id: banner.adId, error: (err as Error).message });
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  // ── 3. Merge per-banner PDFs into one document ────────────────────────
  const mergedDoc = await PDFDocument.create();
  const succeeded: string[] = [];

  for (const single of perBannerPdfs) {
    try {
      const src = await PDFDocument.load(single.bytes);
      const pages = await mergedDoc.copyPages(src, src.getPageIndices());
      for (const p of pages) mergedDoc.addPage(p);
      succeeded.push(single.adId);
    } catch (err) {
      failed.push({ ad_id: single.adId, error: `pdf merge failed: ${(err as Error).message}` });
    }
  }

  // Title metadata — surfaces in Figma's "Imported from" hint.
  mergedDoc.setTitle(`${plan.campaign_id} — banners`);
  mergedDoc.setCreator("MEXEM AI Campaign Banner");
  mergedDoc.setSubject(`${succeeded.length} banner${succeeded.length === 1 ? "" : "s"}`);

  const mergedBytes = await mergedDoc.save();

  return {
    pdf: mergedBytes,
    filename: `campaign-${plan.campaign_id}-figma.pdf`,
    byteLength: mergedBytes.byteLength,
    succeeded,
    failed,
  };
}

function wrapSvgInHtml(svg: string, width: number, height: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; }
  svg { display: block; width: ${width}px; height: ${height}px; }
  /* Fonts that the SVG references — fall back to system stack if the
     branded face isn't on the renderer's font path. Chromium will pick
     up Helvetica/Arial as fallbacks which still render as native PDF
     text (not paths). */
  body { font-family: 'Poppins', 'Heebo', 'Cairo', 'Noto Sans', system-ui, sans-serif; }
</style>
</head><body>${svg}</body></html>`;
}
