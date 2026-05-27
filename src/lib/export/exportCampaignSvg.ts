import { promises as fs } from "node:fs";
import path from "node:path";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

export interface ExportCampaignSvgArgs {
  plan: CampaignPlan;
  cwd?: string;
  embedLocalImages?: boolean;
  source?: "rendered" | "editable";
}

export interface ExportCampaignSvgResult {
  svg: string;
  filename: string;
  byteLength: number;
  adCount: number;
  source: "rendered" | "editable";
}

interface PlacedAd {
  adId: string;
  conceptId: string;
  conceptName: string;
  format: string;
  width: number;
  height: number;
  x: number;
  y: number;
  labelY: number;
}

const SHEET_PADDING = 80;
const AD_GAP = 80;
const ROW_GAP = 160;
const CONCEPT_LABEL_HEIGHT = 46;
const AD_LABEL_HEIGHT = 44;

export async function exportCampaignSvg(
  args: ExportCampaignSvgArgs,
): Promise<ExportCampaignSvgResult> {
  const cwd = args.cwd ?? process.cwd();
  const embedLocalImages = args.embedLocalImages ?? true;
  const source = args.source ?? "editable";
  const { plan } = args;
  const renderedImages =
    source === "rendered"
      ? await loadRenderedImages(cwd, plan.campaign_id)
      : new Map<string, string>();

  const placed = placeAds(plan);
  const canvasWidth =
    placed.length === 0
      ? 1200
      : Math.max(...placed.map((p) => p.x + p.width)) + SHEET_PADDING;
  const canvasHeight =
    placed.length === 0
      ? 800
      : Math.max(...placed.map((p) => p.y + p.height)) + SHEET_PADDING;

  const pieces: string[] = [];
  pieces.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  pieces.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${fmtNum(canvasWidth)} ${fmtNum(canvasHeight)}" width="${fmtNum(canvasWidth)}" height="${fmtNum(canvasHeight)}" data-mexem-export="campaign-all-banners" data-mexem-campaign-id="${escAttr(plan.campaign_id)}">`,
  );
  pieces.push(`  <title>${escXml(plan.campaign_name)} / all banners</title>`);
  pieces.push(
    `  <desc>Combined SVG export for campaign ${escXml(plan.campaign_id)}. Contains ${placed.length} banner artboards arranged by concept.</desc>`,
  );
  pieces.push(`  <rect width="100%" height="100%" fill="#F4F4F5"/>`);
  pieces.push(
    `  <text x="${SHEET_PADDING}" y="42" font-family="Inter, system-ui, sans-serif" font-size="24" font-weight="700" fill="#18181B">${escXml(plan.campaign_name)}</text>`,
  );
  pieces.push(
    `  <text x="${SHEET_PADDING}" y="70" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#52525B">${escXml(plan.campaign_id)} · ${plan.concepts.length} concepts · ${placed.length} banners</text>`,
  );

  let lastConceptId: string | null = null;
  for (let i = 0; i < placed.length; i += 1) {
    const item = placed[i];
    if (item.conceptId !== lastConceptId) {
      pieces.push(
        `  <text x="${SHEET_PADDING}" y="${fmtNum(item.labelY - AD_LABEL_HEIGHT - 16)}" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="#18181B">${escXml(item.conceptName)}</text>`,
      );
      pieces.push(
        `  <text x="${SHEET_PADDING}" y="${fmtNum(item.labelY - AD_LABEL_HEIGHT + 8)}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#71717A">${escXml(item.conceptId)}</text>`,
      );
      lastConceptId = item.conceptId;
    }

    pieces.push(
      `  <g id="${escAttr(sanitizeId(`${item.adId}-artboard`))}" data-ad-id="${escAttr(item.adId)}" data-concept-id="${escAttr(item.conceptId)}" data-format="${escAttr(item.format)}" data-render-source="${source}">`,
    );
    pieces.push(
      `    <text x="${fmtNum(item.x)}" y="${fmtNum(item.labelY)}" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="700" fill="#27272A">${escXml(item.format)}</text>`,
    );
    pieces.push(
      `    <text x="${fmtNum(item.x)}" y="${fmtNum(item.labelY + 18)}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#71717A">${fmtNum(item.width)}×${fmtNum(item.height)}</text>`,
    );
    pieces.push(
      `    <rect x="${fmtNum(item.x - 1)}" y="${fmtNum(item.y - 1)}" width="${fmtNum(item.width + 2)}" height="${fmtNum(item.height + 2)}" fill="none" stroke="#A1A1AA" stroke-width="1"/>`,
    );
    const renderedHref = renderedImages.get(item.adId);
    if (renderedHref) {
      pieces.push(
        `    <image href="${escAttr(renderedHref)}" xlink:href="${escAttr(renderedHref)}" x="${fmtNum(item.x)}" y="${fmtNum(item.y)}" width="${fmtNum(item.width)}" height="${fmtNum(item.height)}" preserveAspectRatio="none"/>`,
      );
    } else {
      const adSvg = await exportAdSvg({
        plan,
        adId: item.adId,
        cwd,
        embedLocalImages,
      });
      const inner = prefixSvgIds(extractSvgInner(adSvg.svg), `ad${i + 1}_`);
      pieces.push(
        `    <svg x="${fmtNum(item.x)}" y="${fmtNum(item.y)}" width="${fmtNum(item.width)}" height="${fmtNum(item.height)}" viewBox="0 0 ${fmtNum(item.width)} ${fmtNum(item.height)}" overflow="visible">`,
      );
      pieces.push(inner);
      pieces.push(`    </svg>`);
    }
    pieces.push(`  </g>`);
  }

  pieces.push(`</svg>`);

  const svg = pieces.join("\n") + "\n";
  return {
    svg,
    filename: `campaign-${plan.campaign_id}-all-banners.svg`,
    byteLength: Buffer.byteLength(svg, "utf8"),
    adCount: placed.length,
    source,
  };
}

async function loadRenderedImages(
  cwd: string,
  campaignId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const renderMapPath = path.join(
    cwd,
    "data",
    "campaigns",
    campaignId,
    "code-render-map.generated.json",
  );
  const renderMap = await readJsonOrNull<{
    items: Array<{
      ad_id: string;
      output_local_path: string | null;
      status: string;
    }>;
  }>(renderMapPath);
  if (!renderMap) return map;
  for (const item of renderMap.items) {
    if (item.status !== "completed" || !item.output_local_path) continue;
    try {
      const abs = path.resolve(cwd, item.output_local_path);
      const buf = await fs.readFile(abs);
      map.set(item.ad_id, `data:image/png;base64,${buf.toString("base64")}`);
    } catch {
      // Missing PNGs fall back to the editable manifest SVG for that ad.
    }
  }
  return map;
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function placeAds(plan: CampaignPlan): PlacedAd[] {
  const placed: PlacedAd[] = [];
  let y = SHEET_PADDING + 50;
  for (const concept of plan.concepts) {
    const rowTop = y + CONCEPT_LABEL_HEIGHT;
    const labelY = rowTop + AD_LABEL_HEIGHT - 22;
    const adY = rowTop + AD_LABEL_HEIGHT;
    let x = SHEET_PADDING;
    let rowHeight = 0;
    for (const ad of concept.ad_specs) {
      placed.push({
        adId: ad.ad_id,
        conceptId: concept.concept_id,
        conceptName: concept.name,
        format: ad.format,
        width: ad.canvas_width,
        height: ad.canvas_height,
        x,
        y: adY,
        labelY,
      });
      x += ad.canvas_width + AD_GAP;
      rowHeight = Math.max(rowHeight, ad.canvas_height);
    }
    y = adY + rowHeight + ROW_GAP;
  }
  return placed;
}

function extractSvgInner(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open || open.index === undefined) return svg;
  const bodyStart = open.index + open[0].length;
  const bodyEnd = svg.lastIndexOf("</svg>");
  return bodyEnd > bodyStart ? svg.slice(bodyStart, bodyEnd).trim() : svg;
}

function prefixSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  const idRegex = /\bid=(["'])([^"']+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(svg)) !== null) ids.add(match[2]);

  let out = svg;
  for (const id of ids) {
    const safe = escapeRegExp(id);
    const prefixed = `${prefix}${id}`;
    out = out
      .replace(new RegExp(`\\bid=(["'])${safe}\\1`, "g"), `id="${prefixed}"`)
      .replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${prefixed})`)
      .replace(
        new RegExp(`\\b((?:xlink:)?href)=(["'])#${safe}\\2`, "g"),
        (_m, attr) => `${attr}="#${prefixed}"`,
      );
  }
  return out;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return escXml(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
