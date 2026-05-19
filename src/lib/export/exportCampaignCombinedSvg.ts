import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

// ─────────────────────────────────────────────────────────────────────────────
// Combined-SVG export: one .svg file containing every banner in the campaign,
// arranged in a grid. Each banner is nested as a child <svg> element so it
// keeps its own viewBox + element coordinate system — that is what makes
// Figma's importer treat each banner as a separate frame.
//
// Figma behaviour (verified against current SVG importer):
//   - Each nested <svg> becomes a frame named after its data-frame-name.
//   - Text elements stay editable; image elements stay positioned correctly.
//   - <defs> inside each nested <svg> are scoped — filter/gradient IDs do
//     not collide across banners.
//
// Layout choice: 3 columns by default, gutters of 60 px, label band of
// 36 px above each cell. Row height = max banner height in that row. Each
// cell is placed at the natural banner size (no scaling) — Figma users
// usually want pixel-true canvases. Designers can resize after import.
//
// embedLocalImages defaults to FALSE for the same reason exportCampaignSvgsZip
// uses that default: a single combined file with multiple base64-embedded
// product mockups inflates past Vercel's response cap. Cloudinary refs stay
// remote and Figma fetches them on import.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportCombinedSvgResult {
  svg: string;
  filename: string;
  byteLength: number;
  succeeded: string[];
  failed: Array<{ ad_id: string; error: string }>;
}

const COLS_DEFAULT = 3;
const GUTTER_PX = 60;
const LABEL_BAND_PX = 36;
const OUTER_PAD_PX = 80;
const TITLE_BAND_PX = 56;
const LABEL_FONT = "system-ui, -apple-system, 'Helvetica Neue', sans-serif";

interface PlacedBanner {
  adId: string;
  format: string;
  conceptId: string;
  width: number;
  height: number;
  /** Raw output of exportAdSvg (the full <svg>…</svg> string). */
  rawSvg: string;
}

export async function exportCampaignCombinedSvg(args: {
  plan: CampaignPlan;
  cwd?: string;
  embedLocalImages?: boolean;
  /** Override the default 3-column grid. */
  cols?: number;
}): Promise<ExportCombinedSvgResult> {
  const { plan } = args;
  const embedLocalImages = args.embedLocalImages ?? false;
  const cols = Math.max(1, Math.min(8, args.cols ?? COLS_DEFAULT));

  const succeeded: PlacedBanner[] = [];
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
        succeeded.push({
          adId: ad.ad_id,
          format: ad.format,
          conceptId: concept.concept_id,
          width: ad.canvas_width,
          height: ad.canvas_height,
          rawSvg: result.svg,
        });
      } catch (err) {
        failed.push({ ad_id: ad.ad_id, error: (err as Error).message });
      }
    }
  }

  // ── Lay out the banners on a grid ──────────────────────────────────────
  // Row stride is computed per-row from the max banner height in that row.
  // Column stride uses the widest banner in the column for tidy alignment.
  const rows: PlacedBanner[][] = [];
  for (let i = 0; i < succeeded.length; i += cols) {
    rows.push(succeeded.slice(i, i + cols));
  }
  const colWidths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c].width);
    }
  }
  const rowHeights = rows.map((row) =>
    row.reduce((max, b) => Math.max(max, b.height), 0),
  );
  const colOffsets = colWidths.map((_, idx) =>
    colWidths.slice(0, idx).reduce((acc, w) => acc + w + GUTTER_PX, 0),
  );
  const rowOffsets = rowHeights.map((_, idx) =>
    rowHeights
      .slice(0, idx)
      .reduce((acc, h) => acc + h + LABEL_BAND_PX + GUTTER_PX, 0),
  );

  const gridWidth =
    colWidths.reduce((acc, w) => acc + w, 0) + GUTTER_PX * (cols - 1);
  const gridHeight =
    rowHeights.reduce((acc, h) => acc + h + LABEL_BAND_PX, 0) +
    GUTTER_PX * Math.max(0, rows.length - 1);

  const masterWidth = OUTER_PAD_PX * 2 + gridWidth;
  const masterHeight =
    OUTER_PAD_PX * 2 + TITLE_BAND_PX + gridHeight;

  // ── Emit master SVG ────────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${masterWidth}" height="${masterHeight}"` +
      ` viewBox="0 0 ${masterWidth} ${masterHeight}"` +
      ` data-campaign-id="${esc(plan.campaign_id)}"` +
      ` data-banner-count="${succeeded.length}">`,
  );

  // Subtle off-white background so the grid reads as a "deck" page in Figma.
  parts.push(
    `<rect width="${masterWidth}" height="${masterHeight}" fill="#FAFAFA"/>`,
  );

  // Master title.
  const titleText = `${plan.campaign_id} · ${succeeded.length} banner${succeeded.length === 1 ? "" : "s"}`;
  parts.push(
    `<text x="${OUTER_PAD_PX}" y="${OUTER_PAD_PX + 28}"` +
      ` font-family="${LABEL_FONT}" font-size="22" font-weight="600" fill="#111">${esc(titleText)}</text>`,
  );

  const gridOriginX = OUTER_PAD_PX;
  const gridOriginY = OUTER_PAD_PX + TITLE_BAND_PX;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const b = row[c];
      const cellX = gridOriginX + colOffsets[c];
      const cellY = gridOriginY + rowOffsets[r];

      // Label band above the banner.
      parts.push(
        `<g data-cell="${esc(b.adId)}">`,
        `<text x="${cellX}" y="${cellY + 20}"` +
          ` font-family="${LABEL_FONT}" font-size="13" font-weight="500" fill="#444">` +
          `${esc(b.conceptId)} · ${esc(b.format)}` +
          `</text>`,
      );

      // Nested banner SVG. Re-write the opening <svg ...> tag so the nested
      // element sits at (cellX, cellY + LABEL_BAND_PX) inside the master.
      // The original viewBox + width/height stay so Figma keeps frame size
      // pixel-accurate.
      const nested = nestSvg(b.rawSvg, cellX, cellY + LABEL_BAND_PX, b.adId, b.format);
      parts.push(nested);
      parts.push(`</g>`);
    }
  }

  parts.push(`</svg>`);

  const svg = parts.join("\n");
  const filename = `campaign-${plan.campaign_id}-figma.svg`;
  const byteLength = Buffer.byteLength(svg, "utf8");

  return {
    svg,
    filename,
    byteLength,
    succeeded: succeeded.map((b) => b.adId),
    failed,
  };
}

/** Strip any XML prolog and rewrite the outer <svg ...> opening tag so it
 *  carries the banner's grid coordinates and a Figma-friendly frame name. */
function nestSvg(raw: string, x: number, y: number, adId: string, format: string): string {
  // Drop any leading <?xml ?> prolog — multiple prologs inside one document
  // make some parsers (including stricter SVG renderers) reject the whole
  // file. The xmlns on each nested <svg> is fine to repeat.
  let body = raw.replace(/^\s*<\?xml[^>]*\?>\s*/i, "");

  // Inject x/y + data-frame-name into the opening <svg ...> tag. data-frame-name
  // gives Figma a readable name in the layers panel.
  body = body.replace(
    /<svg\b/i,
    `<svg x="${x}" y="${y}" data-frame-name="${esc(format)} · ${esc(adId)}"`,
  );

  return body;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
