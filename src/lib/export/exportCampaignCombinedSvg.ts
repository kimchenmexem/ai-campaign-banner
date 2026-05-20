import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

// ─────────────────────────────────────────────────────────────────────────────
// Combined-SVG export — Figma-editable.
//
// Builds ONE master SVG that contains every banner in the campaign. Banners
// are placed via <g transform="translate(x,y)"> — NOT as nested <svg>
// elements. Nesting <svg> caused Figma's importer to flatten each banner
// to a single rasterised image (lost editability); flattening to <g> keeps
// every <text> / <rect> / <image> as an individual editable object after
// import.
//
// What gets done to make this work:
//
//   1. Per banner we call exportAdSvg() and extract two regions from its
//      output — the <defs>…</defs> block and the inner banner <g>.
//   2. We collect every id="X" declaration inside the defs and rewrite
//      them to "bN_X". The same prefix is applied to every url(#X) and
//      xlink:href="#X" reference in BOTH defs and body so gradients,
//      drop-shadow filters and clip-paths keep pointing at the right
//      def even when multiple banners use overlapping auto-generated ids.
//   3. The rewritten body is wrapped in <g transform="translate(X,Y)">
//      so it lands at the right position on the master canvas. Banner
//      coordinates relative to the wrapper match the original viewBox.
//   4. All rewritten defs are merged into a single master <defs>.
//
// Layout: 3-column grid by default (override via ?cols=). Each cell has
// a small label band above the banner. Pixel-true canvases survive into
// Figma at native size.
//
// embedLocalImages defaults to FALSE so heavy product mockups stay as
// remote Cloudinary refs and the combined file stays safely under
// Vercel's response-size cap.
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
  /** Rewritten defs block (or empty string) — IDs already namespaced. */
  defs: string;
  /** Rewritten banner body wrapped in its outer <g> — IDs already namespaced. */
  body: string;
}

export async function exportCampaignCombinedSvg(args: {
  plan: CampaignPlan;
  cwd?: string;
  embedLocalImages?: boolean;
  cols?: number;
}): Promise<ExportCombinedSvgResult> {
  const { plan } = args;
  const embedLocalImages = args.embedLocalImages ?? false;
  const cols = Math.max(1, Math.min(8, args.cols ?? COLS_DEFAULT));

  const succeeded: PlacedBanner[] = [];
  const failed: Array<{ ad_id: string; error: string }> = [];

  let bannerIndex = 0;
  for (const concept of plan.concepts) {
    for (const ad of concept.ad_specs) {
      try {
        const result = await exportAdSvg({
          plan,
          adId: ad.ad_id,
          cwd: args.cwd,
          embedLocalImages,
        });
        const prefix = `b${bannerIndex}_`;
        const { defs, body } = extractAndNamespace(result.svg, prefix);
        succeeded.push({
          adId: ad.ad_id,
          format: ad.format,
          conceptId: concept.concept_id,
          width: ad.canvas_width,
          height: ad.canvas_height,
          defs,
          body,
        });
        bannerIndex++;
      } catch (err) {
        failed.push({ ad_id: ad.ad_id, error: (err as Error).message });
      }
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────
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
  const masterHeight = OUTER_PAD_PX * 2 + TITLE_BAND_PX + gridHeight;

  // ── Compose master SVG ─────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
      ` width="${masterWidth}" height="${masterHeight}"` +
      ` viewBox="0 0 ${masterWidth} ${masterHeight}"` +
      ` data-campaign-id="${esc(plan.campaign_id)}"` +
      ` data-banner-count="${succeeded.length}">`,
  );

  // Merged defs — every banner's gradients + filters with namespaced IDs.
  const mergedDefs = succeeded.map((b) => b.defs).filter(Boolean).join("\n");
  if (mergedDefs.length > 0) {
    parts.push(`<defs>\n${mergedDefs}\n</defs>`);
  }

  // Page background (helps the deck read as a Figma page).
  parts.push(
    `<rect width="${masterWidth}" height="${masterHeight}" fill="#FAFAFA"/>`,
  );

  // Title.
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
      const bannerOriginY = cellY + LABEL_BAND_PX;

      parts.push(
        `<g data-frame-name="${esc(b.format)} · ${esc(b.conceptId)}">`,
        `<title>${esc(b.format)} · ${esc(b.conceptId)}</title>`,
        // Label band text above the banner.
        `<text x="${cellX}" y="${cellY + 20}"` +
          ` font-family="${LABEL_FONT}" font-size="13" font-weight="500" fill="#444">${esc(b.conceptId)} · ${esc(b.format)}</text>`,
        // The banner body — already rewritten + ID-namespaced. translate()
        // is what positions every element on the master canvas; the banner's
        // own coordinates (0..W, 0..H) flow through unchanged so Figma sees
        // pixel-true element positions.
        `<g transform="translate(${cellX} ${bannerOriginY})">`,
        b.body,
        `</g>`,
        `</g>`,
      );
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

// ─── ID-namespace helpers ──────────────────────────────────────────────────
//
// exportAdSvg uses auto-generated def IDs like "shadow_<hash>" or
// "bg_gradient_<idx>". When we merge multiple banners into one master we
// must rewrite those IDs (and every url(#…) reference to them) with a
// per-banner prefix or two banners will collide on the same gradient or
// drop-shadow filter.

/**
 * Extract the <defs>…</defs> + the inner banner <g> from a single-banner
 * SVG. Both regions are returned with every id="…" declared inside the
 * defs rewritten to `${prefix}id`, and every matching url(#id) /
 * xlink:href="#id" reference rewritten the same way.
 */
function extractAndNamespace(rawSvg: string, prefix: string): { defs: string; body: string } {
  // 1. Drop the XML prolog if present — the master writes its own.
  const noProlog = rawSvg.replace(/^\s*<\?xml[^>]*\?>\s*/i, "");

  // 2. Pull out everything between the opening <svg ...> and the matching
  //    </svg>. We treat the contents inside that pair as the document
  //    body for further processing.
  const inner = stripOuterSvg(noProlog);

  // 3. Pull out the <defs>…</defs> block if present.
  const { defs: defsRaw, rest } = extractDefs(inner);

  // 4. Find every id="X" declared in defs. We DELIBERATELY do NOT rewrite
  //    IDs declared in the body — only def-declared IDs participate in the
  //    rename. Element IDs like "el_logo" can stay distinct across banners
  //    (Figma reads them as layer names) and the body never points to
  //    them via url(#…).
  const defIds = collectIds(defsRaw);

  const rewriteRefs = (s: string): string => {
    let out = s;
    for (const id of defIds) {
      const newId = `${prefix}${id}`;
      // Rewrite id="X" (only inside defs — see below for split).
      // url(#X) refs — both in defs (gradient stop chains) and body.
      out = replaceAll(out, `url(#${id})`, `url(#${newId})`);
      out = replaceAll(out, `url("#${id}")`, `url("#${newId}")`);
      out = replaceAll(out, `url('#${id}')`, `url('#${newId}')`);
      // xlink:href="#X" — used by some <use> elements.
      out = replaceAll(out, `xlink:href="#${id}"`, `xlink:href="#${newId}"`);
      out = replaceAll(out, `href="#${id}"`, `href="#${newId}"`);
    }
    return out;
  };

  const renamedDefs = defsRaw
    ? defIds.reduce(
        (acc, id) => replaceAll(acc, `id="${id}"`, `id="${prefix}${id}"`),
        rewriteRefs(defsRaw),
      )
    : "";

  const renamedBody = rewriteRefs(rest);

  return { defs: renamedDefs, body: renamedBody };
}

/**
 * Strip the outer <svg>…</svg> wrapper and return the inner string. The
 * exportAdSvg output is well-formed; we accept a single top-level <svg>
 * pair.
 */
function stripOuterSvg(s: string): string {
  const openMatch = s.match(/<svg\b[^>]*>/i);
  if (!openMatch) return s;
  const openEnd = (openMatch.index ?? 0) + openMatch[0].length;
  const closeIdx = s.lastIndexOf("</svg>");
  if (closeIdx < 0 || closeIdx < openEnd) return s.slice(openEnd);
  return s.slice(openEnd, closeIdx);
}

function extractDefs(s: string): { defs: string; rest: string } {
  // Match the first <defs>…</defs> only — exportAdSvg emits at most one.
  const match = s.match(/<defs\b[^>]*>([\s\S]*?)<\/defs>/i);
  if (!match) return { defs: "", rest: s };
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const inner = match[1];
  const rest = (s.slice(0, start) + s.slice(end)).trim();
  return { defs: inner, rest };
}

/** Return every id="X" value declared in the input string. */
function collectIds(s: string): string[] {
  const out: string[] = [];
  const re = /\bid="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
