import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import type { Element } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Per-ad "elements" ZIP — bundles every source asset that went into ONE
// rendered banner so the operator can hand it off, archive a favourite, or
// re-edit in design software.
//
// Layout inside the archive:
//
//   ad-{ad_id}.zip
//   ├── README.md                       Asset map + how to recompose
//   ├── ad-spec.json                    Slim CampaignAdSpec — useful for re-render
//   ├── manifest.json                   Element Manifest (source of truth)
//   ├── rendered.png                    Final PNG (when present)
//   ├── elements/
//   │   ├── 01_el_background.svg        One file per renderable element,
//   │   ├── 02_el_logo.png              numbered by z-index so the order
//   │   ├── 03_el_visual.png            in the folder matches stacking
//   │   ├── 04_el_generated_fx.svg
//   │   ├── 05_el_cta.svg               (CTA exported as a clean SVG of the
//   │   │                                cta-button element so designers can
//   │   │                                drop it straight into Figma)
//   │   └── ...
//   └── element_index.json              Map: filename → element id + role
//
// Inline elements (text, headline, sub, disclaimer, CTA in element-mode) are
// rendered into standalone SVG so a designer who wants the CTA-as-art can
// open it without touching the renderer.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportAdElementsResult {
  buffer: Uint8Array;
  filename: string;
  byteLength: number;
}

interface IndexEntry {
  file: string;
  element_id: string;
  role: string;
  type: string;
  source: string;
  z_index: number;
  notes?: string;
}

export async function exportAdElementsZip(args: {
  plan: CampaignPlan;
  adId: string;
  cwd?: string;
}): Promise<ExportAdElementsResult> {
  const cwd = args.cwd ?? process.cwd();
  const { plan, adId } = args;

  const ad = findAdSpec(plan, adId);
  if (!ad) {
    throw new Error(
      `ad_id "${adId}" not found in campaign ${plan.campaign_id}`,
    );
  }

  const zip = new JSZip();

  // 1. The two source-of-truth JSONs.
  zip.file(
    "ad-spec.json",
    JSON.stringify(
      {
        campaign_id: plan.campaign_id,
        ad_id: ad.ad_id,
        concept_id: ad.concept_id,
        format: ad.format,
        canvas_width: ad.canvas_width,
        canvas_height: ad.canvas_height,
        channel: ad.channel,
        visual_selection_metadata: ad.visual_selection_metadata,
        status: ad.status,
      },
      null,
      2,
    ),
  );
  zip.file("manifest.json", JSON.stringify(ad.manifest, null, 2));

  // 2. Rendered PNG (when this ad has been rasterised).
  const renderMap = await readJsonOrNull<{
    items: Array<{
      ad_id: string;
      output_local_path: string | null;
      status: string;
    }>;
  }>(
    path.join(
      cwd,
      "data",
      "campaigns",
      plan.campaign_id,
      "code-render-map.generated.json",
    ),
  );
  const renderItem = renderMap?.items.find((i) => i.ad_id === ad.ad_id) ?? null;
  if (renderItem?.status === "completed" && renderItem.output_local_path) {
    try {
      const buf = await fs.readFile(
        path.resolve(cwd, renderItem.output_local_path),
      );
      zip.file("rendered.png", buf);
    } catch {
      // skip — fine to ship an elements zip without the final PNG.
    }
  }

  // 3. Per-element files. Sort by z_index so the folder order mirrors the
  //    visual stacking (background first, CTA / disclaimer last).
  const elementsDir = zip.folder("elements")!;
  const sorted = [...ad.manifest.elements].sort(
    (a, b) => a.z_index - b.z_index,
  );
  const index: IndexEntry[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const el = sorted[i];
    if (!el.visible) continue;
    const slot = String(i + 1).padStart(2, "0");
    const entry = await writeElementToZip({
      el,
      slot,
      ad,
      zip: elementsDir,
      cwd,
    });
    if (entry) index.push(entry);
  }
  elementsDir.file("element_index.json", JSON.stringify(index, null, 2));

  // 4. README.
  zip.file(
    "README.md",
    buildReadme(plan, ad, renderItem !== null && renderItem.status === "completed", index),
  );

  const buffer = await zip.generateAsync({ type: "uint8array" });
  return {
    buffer,
    filename: `ad-${ad.ad_id}.zip`,
    byteLength: buffer.byteLength,
  };
}

// ── Per-element exporter ────────────────────────────────────────────────────
async function writeElementToZip(args: {
  el: Element;
  slot: string;
  ad: ReturnType<typeof findAdSpec> & object;
  zip: JSZip;
  cwd: string;
}): Promise<IndexEntry | null> {
  const { el, slot, ad, zip, cwd } = args;

  // 4a. Image-bearing element: copy the bytes verbatim. Source preference:
  //     local_public_path → file_url that resolves under public/ → file_url
  //     (skipped when remote-only and we can't fetch from cwd).
  const localPath = pickLocalPath(el);
  if (localPath) {
    const abs = path.join(cwd, "public", localPath.replace(/^\//, ""));
    try {
      const buf = await fs.readFile(abs);
      const ext = path.extname(localPath) || ".png";
      const filename = `${slot}_${el.id}${ext}`;
      zip.file(filename, buf);
      return makeEntry(filename, el, sourceLabel(localPath));
    } catch {
      // fall through to inline path below
    }
  }

  // 4b. CTA in element-mode: synthesise a clean SVG so designers get the
  //     button as standalone art (real text, brand padding, fill, radius).
  if (el.type === "cta-button" && typeof el.text === "string") {
    const svg = renderCtaElementSvg(el);
    const filename = `${slot}_${el.id}.svg`;
    zip.file(filename, svg);
    return makeEntry(filename, el, "synthesised from element");
  }

  // 4c. Text / headline / subheadline / disclaimer: ship as SVG with the
  //     real font-family, weight, size, color, alignment so designers can
  //     drop them into Figma / Illustrator without retyping.
  if (
    (el.type === "text" || el.type === "legal" || typeof el.text === "string") &&
    el.text
  ) {
    const svg = renderTextElementSvg(el, { canvas_width: ad.canvas_width, canvas_height: ad.canvas_height });
    const filename = `${slot}_${el.id}.svg`;
    zip.file(filename, svg);
    return makeEntry(filename, el, "synthesised from element");
  }

  // 4d. Solid shape / decorative without bytes — emit a tiny SVG so the
  //     element still has a placeholder file and shows up in the folder.
  if (el.background_color || el.role === "decorative") {
    const svg = renderShapeElementSvg(el);
    const filename = `${slot}_${el.id}.svg`;
    zip.file(filename, svg);
    return makeEntry(filename, el, "shape from element");
  }

  // No bytes, no synthesizable content — record in index but don't emit a file.
  return null;
}

function pickLocalPath(el: Element): string | null {
  const lpp = (el as { local_public_path?: string | null }).local_public_path;
  if (lpp && lpp.startsWith("/")) return lpp;
  const fileUrl = el.file_url;
  if (fileUrl && fileUrl.startsWith("/")) return fileUrl;
  // file:// URLs (the demo's local convention) are stripped by the renderer
  // at runtime; we restore the convention here.
  if (fileUrl && fileUrl.startsWith("file://localhost")) {
    return fileUrl.slice("file://localhost".length);
  }
  return null;
}

function sourceLabel(localPath: string): string {
  if (localPath.startsWith("/brand-input-preview/")) return "brand-input";
  if (localPath.startsWith("/generated-assets/")) return "generated-asset";
  if (localPath.startsWith("/generated-preview-composites/")) return "mockup-composite";
  if (localPath.startsWith("/midjourney-uploads/")) return "midjourney-upload";
  return "local";
}

function makeEntry(file: string, el: Element, source: string): IndexEntry {
  return {
    file,
    element_id: el.id,
    role: el.role,
    type: el.type,
    source,
    z_index: el.z_index,
    notes: el.notes,
  };
}

// ── Element → SVG synth ─────────────────────────────────────────────────────
function renderCtaElementSvg(el: Element): string {
  const text = escapeXml(el.text ?? "");
  const w = el.width;
  const h = el.height;
  const r = el.border_radius ?? 0;
  const bg = el.background_color ?? "#204489";
  const fg = el.color ?? "#FFFFFF";
  const family = el.font_family ?? "Poppins";
  const weight = el.font_weight ?? 600;
  const size = el.font_size ?? 32;
  const stroke = el.border_width ? el.border_width : 0;
  const strokeColor = el.border_color ?? "transparent";
  const fill = bg === "transparent" ? "none" : bg;
  const inset = stroke / 2;
  const rx = w - 2 * inset;
  const ry = h - 2 * inset;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect x="${inset}" y="${inset}" width="${rx}" height="${ry}" rx="${r}" ry="${r}" fill="${fill}"${stroke > 0 ? ` stroke="${strokeColor}" stroke-width="${stroke}"` : ""}/>
  <text x="50%" y="50%" font-family="${family}, sans-serif" font-weight="${weight}" font-size="${size}" fill="${fg}" text-anchor="middle" dominant-baseline="central">${text}</text>
</svg>`;
}

function renderTextElementSvg(
  el: Element,
  canvas: { canvas_width: number; canvas_height: number },
): string {
  void canvas;
  const text = escapeXml(el.text ?? "");
  const w = el.width;
  const h = el.height;
  const family = el.font_family ?? "Poppins";
  const weight = el.font_weight ?? 400;
  const size = el.font_size ?? 16;
  const lh = el.line_height ?? 1.4;
  const fg = el.color ?? "#FFFFFF";
  const align = el.text_align ?? "left";
  // Two-color emphasis split (matches the renderer's headline rule).
  const useEmphasis =
    el.emphasis_text &&
    el.text &&
    el.text.startsWith(el.emphasis_text) &&
    el.emphasis_text.length > 0 &&
    el.emphasis_text.length < el.text.length;
  const emphasis = useEmphasis ? escapeXml(el.emphasis_text!) : "";
  const rest = useEmphasis ? escapeXml((el.text ?? "").slice(el.emphasis_text!.length)) : text;
  const emphasisColor = el.emphasis_color ?? "#F5C518";
  const x = align === "center" ? "50%" : align === "right" ? "100%" : "0";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const tspans = useEmphasis
    ? `<tspan fill="${emphasisColor}">${emphasis}</tspan><tspan>${rest}</tspan>`
    : text;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <text x="${x}" y="${size}" font-family="${family}, sans-serif" font-weight="${weight}" font-size="${size}" fill="${fg}" text-anchor="${anchor}" dominant-baseline="alphabetic" style="line-height: ${lh}">${tspans}</text>
</svg>`;
}

function renderShapeElementSvg(el: Element): string {
  const w = Math.max(1, el.width);
  const h = Math.max(1, el.height);
  const fill = el.background_color ?? "transparent";
  const r = el.border_radius ?? 0;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" opacity="${el.opacity}"/>
</svg>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function findAdSpec(plan: CampaignPlan, adId: string) {
  for (const concept of plan.concepts) {
    const ad = concept.ad_specs.find((a) => a.ad_id === adId);
    if (ad) return ad;
  }
  return null;
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function buildReadme(
  plan: CampaignPlan,
  ad: NonNullable<ReturnType<typeof findAdSpec>>,
  hasPng: boolean,
  index: IndexEntry[],
): string {
  const lines: string[] = [
    `# Ad elements — ${ad.ad_id}`,
    ``,
    `**Campaign:** ${plan.campaign_id} — ${plan.campaign_name}`,
    `**Concept:** ${ad.concept_id}`,
    `**Format:** ${ad.format} (${ad.canvas_width}×${ad.canvas_height})`,
    `**Channel:** ${ad.channel}`,
    `**Status:** ${ad.status}`,
    ``,
    `## Files`,
    `- \`ad-spec.json\` — slim ad spec (canvas, channel, visual provenance)`,
    `- \`manifest.json\` — Element Manifest (renderer's source of truth)`,
    hasPng ? `- \`rendered.png\` — final code-rendered banner` : `- _rendered.png missing_ — run \`npm run render:code-campaign\` to produce it`,
    `- \`elements/\` — one file per visible Element, numbered by z-index`,
    `- \`elements/element_index.json\` — filename → element id + provenance`,
    ``,
    `## Element index (z-order)`,
    ``,
  ];
  for (const e of index) {
    lines.push(
      `- **${e.file}** — \`${e.element_id}\` · role=${e.role} · type=${e.type} · source=${e.source} · z=${e.z_index}`,
    );
  }
  lines.push(
    ``,
    `## Recompose`,
    `Re-stack files in \`elements/\` in numeric order on a ${ad.canvas_width}×${ad.canvas_height} canvas using the (x, y, width, height) of each Element row in \`manifest.json\`. The renderer in this repo (\`src/components/render/ProductionElementLayer.tsx\`) does exactly that — read the manifest and you can recreate the banner pixel-for-pixel.`,
  );
  return lines.join("\n");
}
