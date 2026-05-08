import { promises as fs } from "node:fs";
import path from "node:path";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import type { Element } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Per-banner combined SVG export — one SVG per ad, ready to drag into Figma.
//
// Layout decisions:
//   - viewBox matches canvas size; absolute coordinates flow straight from
//     the manifest. Designers can ungroup once and edit individual elements.
//   - Text elements (headline / subheadline / disclaimer / CTA label) render
//     as real <text> + <tspan> so Figma keeps them as editable text layers.
//     Emphasis split (yellow prefix + white rest) becomes two <tspan> elements
//     inside one <text>, which Figma also imports as one editable text node.
//   - Image elements (logo / mockup / FX overlay / generated visuals) embed
//     local PNG/SVG bytes as data: URIs so the file is portable. Cloudinary
//     URLs (or anything starting with `https://`) stay as remote refs —
//     Figma fetches them on import.
//   - Drop shadows on image elements (manifest.shadow) get an SVG <filter>
//     that mirrors the CSS drop-shadow used by ProductionElementLayer.
//   - CTA elements with text_align: center render with text-anchor=middle +
//     dominant-baseline=central — the same pattern used by the Asset
//     Generator's standalone CTA SVG, so centering survives in Figma.
//
// What Figma does well with this output: text remains editable; rects keep
// their fills + corner radii; image layers are positioned correctly.
//
// What Figma does less well: filter:drop-shadow renders inconsistently in
// Figma's SVG importer (sometimes outlined, sometimes ignored). Designers
// can re-add native shadows after import.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportAdSvgArgs {
  plan: CampaignPlan;
  adId: string;
  cwd?: string;
  // When true (default), reads local image files from disk and embeds them
  // as base64 data URIs so the SVG is portable. When false, leaves the
  // file_url as-is (smaller file, but only works inside this dev server).
  embedLocalImages?: boolean;
}

// CSS-gradient parser. The renderer stores the active background gradient
// as a string on `el_background.notes` (e.g. "Preview-only CSS gradient:
// linear-gradient(305deg, #00122C 0%, #002B4B 14%, …)"). Parses that into
// the structured form an SVG <linearGradient> def needs.
interface ParsedGradient {
  angleDeg: number;
  stops: Array<{ color: string; position: number }>; // position 0..1
}
function parseLinearGradientNotes(notes: string | undefined): ParsedGradient | null {
  if (!notes) return null;
  const match = notes.match(/linear-gradient\(\s*([-\d.]+)deg\s*,\s*([^)]+)\)/);
  if (!match) return null;
  const angleDeg = Number.parseFloat(match[1]);
  const stops: ParsedGradient["stops"] = [];
  for (const part of match[2].split(",")) {
    const m = part.trim().match(/^(#?[0-9a-fA-F]{3,8})\s+([\d.]+)%$/);
    if (!m) continue;
    stops.push({ color: m[1], position: Number.parseFloat(m[2]) / 100 });
  }
  if (stops.length < 2) return null;
  return { angleDeg, stops };
}

export interface ExportAdSvgResult {
  svg: string;
  filename: string;
  byteLength: number;
}

export async function exportAdSvg(
  args: ExportAdSvgArgs,
): Promise<ExportAdSvgResult> {
  const cwd = args.cwd ?? process.cwd();
  const embedLocalImages = args.embedLocalImages ?? true;

  const ad = findAdSpec(args.plan, args.adId);
  if (!ad) {
    throw new Error(
      `ad_id "${args.adId}" not found in campaign ${args.plan.campaign_id}`,
    );
  }
  const { width, height } = { width: ad.canvas_width, height: ad.canvas_height };

  // Stable z-order. Lower z renders first (background), higher last (CTA).
  const sorted = [...ad.manifest.elements]
    .filter((e) => e.visible !== false)
    .sort((a, b) => a.z_index - b.z_index);

  // We may need <filter id="..."> defs for drop-shadows + a <linearGradient>
  // def when the background uses a CSS gradient (which the renderer stores
  // on el_background.notes — see parseLinearGradientNotes). Collect both
  // up-front so the <defs> block can be emitted at the top.
  const shadowDefs = new Map<string, string>();
  const gradientDefs: string[] = [];

  const groups: string[] = [];
  let elementIndex = 0;
  for (const el of sorted) {
    elementIndex += 1;
    const body = await renderElement({
      el,
      cwd,
      embedLocalImages,
      shadowDefs,
      gradientDefs,
      canvasWidth: width,
      canvasHeight: height,
      label: `${String(elementIndex).padStart(2, "0")}-${el.id}`,
      layerName: deriveLayerName(el, elementIndex),
    });
    if (body) groups.push(body);
  }

  const defsItems = [...gradientDefs, ...shadowDefs.values()];
  const defsBlock =
    defsItems.length > 0
      ? `<defs>\n${defsItems.join("\n")}\n</defs>\n`
      : "";

  // Top-level banner frame: gives Figma a single named outer layer
  // ("Banner / <format>") that designers can move/duplicate as one unit.
  const bannerGroupTitle = `Banner / ${ad.format}`;
  const bannerGroupId = `banner-${sanitizeIdForSvg(ad.format)}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
     data-mexem-export="ad-banner"
     data-mexem-campaign-id="${escAttr(args.plan.campaign_id)}"
     data-mexem-ad-id="${escAttr(ad.ad_id)}"
     data-mexem-format="${escAttr(ad.format)}">
${defsBlock}<g id="${escAttr(bannerGroupId)}">
  <title>${escXml(bannerGroupTitle)}</title>
${groups.join("\n")}
</g>
</svg>
`;

  const filename = `${ad.ad_id}.svg`;
  return { svg, filename, byteLength: Buffer.byteLength(svg, "utf8") };
}

// Derives a human-readable layer name. Figma reads this from `<title>` and
// from `id=` — both surfaces are written so designers see something like
// "03 · Headline" in the layers panel instead of "el_text_headline".
function deriveLayerName(el: Element, index: number): string {
  const numbered = String(index).padStart(2, "0");
  const role = el.role ?? "element";
  const roleLabel = role
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const text = typeof el.text === "string" ? el.text.trim() : "";
  const preview =
    text.length > 0
      ? ` "${text.slice(0, 32)}${text.length > 32 ? "…" : ""}"`
      : "";
  return `${numbered} · ${roleLabel}${preview}`;
}

// Sanitised id suitable for Figma layer naming + SVG id rules.
function sanitizeIdForSvg(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Common opener for all element groups — sets a friendly id, a <title>
// (the canonical Figma layer name), and the standard data-* breadcrumbs.
function openGroup(el: Element, label: string, layerName: string): string {
  const idAttr = sanitizeIdForSvg(label);
  return `  <g id="${escAttr(idAttr)}" data-element="${escAttr(label)}" data-role="${escAttr(el.role)}" transform="translate(${fmtNum(el.x)} ${fmtNum(el.y)})" opacity="${fmtNum(el.opacity)}">
    <title>${escXml(layerName)}</title>`;
}

// ── Per-element rendering ──────────────────────────────────────────────────
async function renderElement(args: {
  el: Element;
  cwd: string;
  embedLocalImages: boolean;
  shadowDefs: Map<string, string>;
  gradientDefs: string[];
  canvasWidth: number;
  canvasHeight: number;
  label: string;
  layerName: string;
}): Promise<string | null> {
  const { el, cwd, embedLocalImages, shadowDefs, gradientDefs, label, layerName } = args;

  // 1. Background special path FIRST — when the role is background, prefer a
  //    real <linearGradient> if the renderer's CSS gradient is recorded on
  //    el.notes. This was the missing-background bug: el_background only
  //    carries the fallback `background_color` solid; the actual gradient
  //    lives in `notes`.
  if (el.role === "background" && !el.file_url) {
    const grad = parseLinearGradientNotes(el.notes);
    if (grad) {
      return renderBackgroundGradient(el, grad, gradientDefs, label, layerName);
    }
    // Solid-color background.
    return renderShapeElement(el, label, layerName);
  }

  // 2. SVG data-URI elements (motifs, scrims, brand patterns) inline as
  //    native SVG groups. This is the difference between Figma seeing a
  //    flat <image> and Figma seeing editable vector paths it can recolor,
  //    re-stroke, or break apart. We accept both the URL-encoded and the
  //    base64 data URI forms.
  if (typeof el.file_url === "string" && /^data:image\/svg\+xml/i.test(el.file_url)) {
    const inlined = inlineSvgFromDataUri(el.file_url, el, label, layerName);
    if (inlined) return inlined;
    // Fall through to the image path if decoding failed for any reason.
  }

  // 3. Image-bearing elements — keep position via translate, embed bytes.
  if (
    el.file_url ||
    (el as { local_public_path?: string | null }).local_public_path
  ) {
    return await renderImageElement({ el, cwd, embedLocalImages, shadowDefs, label, layerName });
  }

  // 3. CTA button — rect + centered text.
  if (el.type === "cta-button" && typeof el.text === "string") {
    return renderCtaElement(el, label, layerName);
  }

  // 4. Text / headline / subheadline / disclaimer.
  if (
    (el.type === "text" || el.type === "legal" || typeof el.text === "string") &&
    el.text
  ) {
    return renderTextElement(el, label, layerName);
  }

  // 5. Shape / decorative without bytes.
  if (el.background_color || el.role === "decorative") {
    return renderShapeElement(el, label, layerName);
  }

  // No content we know how to render — skip silently.
  return null;
}

// Background gradient renderer. Emits a <linearGradient> def into the
// shared defs list and returns a <rect fill="url(#bg-grad-N)"> as the
// element's body. The gradient direction is converted from CSS angle
// convention (0° = up) to SVG's userSpaceOnUse coordinate system.
function renderBackgroundGradient(
  el: Element,
  grad: ParsedGradient,
  gradientDefs: string[],
  label: string,
  layerName: string,
): string {
  const id = `bg-grad-${gradientDefs.length + 1}`;
  // CSS angle 0° points up; SVG x1/y1 → x2/y2 directs the gradient flow.
  // Conversion: SVG flow direction = CSS angle - 90°.
  const rad = ((grad.angleDeg - 90) * Math.PI) / 180;
  const w = el.width;
  const h = el.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.max(w, h);
  const x1 = cx - Math.cos(rad) * r;
  const y1 = cy - Math.sin(rad) * r;
  const x2 = cx + Math.cos(rad) * r;
  const y2 = cy + Math.sin(rad) * r;
  const stops = grad.stops
    .map(
      (s) =>
        `      <stop offset="${(s.position * 100).toFixed(2)}%" stop-color="${escAttr(s.color)}"/>`,
    )
    .join("\n");
  gradientDefs.push(
    `  <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmtNum(x1)}" y1="${fmtNum(y1)}" x2="${fmtNum(x2)}" y2="${fmtNum(y2)}">
${stops}
  </linearGradient>`,
  );
  return `${openGroup(el, label, layerName)}
    <rect width="${fmtNum(w)}" height="${fmtNum(h)}" fill="url(#${id})"/>
  </g>`;
}

async function renderImageElement(args: {
  el: Element;
  cwd: string;
  embedLocalImages: boolean;
  shadowDefs: Map<string, string>;
  label: string;
  layerName: string;
}): Promise<string> {
  const { el, cwd, embedLocalImages, shadowDefs, label, layerName } = args;
  const localPath = (el as { local_public_path?: string | null }).local_public_path;
  const fileUrl = el.file_url;

  // Source preference (operator decision after the 2026-05-07 logo-not-
  // showing-in-Figma report):
  //   1. local_public_path → on-disk file under public/ → embed as base64
  //      data URI. Reliable in Figma. THIS IS PREFERRED for all assets
  //      with a local mirror — even when a Cloudinary URL exists, we
  //      prefer local because Figma's SVG importer doesn't always fetch
  //      remote URLs (CORS, offline use, sand-boxed).
  //   2. file_url that's already a `data:` URI (motifs / inline SVG) →
  //      pass through verbatim.
  //   3. file_url that resolves under public/ → same as #1.
  //   4. file_url that's a remote URL (Cloudinary) → leave for Figma to
  //      fetch. Falls back to "broken image" if Figma can't reach it.
  let href: string;
  if (embedLocalImages) {
    if (localPath && localPath.startsWith("/")) {
      href = await tryEmbedDataUri(cwd, localPath, fileUrl ?? "");
    } else if (fileUrl?.startsWith("data:")) {
      href = fileUrl;
    } else if (fileUrl?.startsWith("file://localhost")) {
      const stripped = fileUrl.slice("file://localhost".length);
      href = await tryEmbedDataUri(cwd, stripped, fileUrl);
    } else if (fileUrl?.startsWith("/")) {
      href = await tryEmbedDataUri(cwd, fileUrl, fileUrl);
    } else if (fileUrl) {
      href = fileUrl;
    } else {
      // Image element with no usable source — render a placeholder rect
      // so the layout doesn't shift.
      return renderShapeElement(el, label, layerName);
    }
  } else {
    href = fileUrl ?? localPath ?? "";
  }

  // SVG <image> uses preserveAspectRatio to control object-fit. Our
  // renderer uses CSS object-fit; map the closest equivalents.
  const fit = el.object_fit ?? "contain";
  const par = mapObjectFitToPreserveAspectRatio(fit);

  // Optional drop-shadow.
  let filterAttr = "";
  if (el.shadow) {
    const filterId = registerDropShadow(shadowDefs, el.shadow);
    filterAttr = ` filter="url(#${filterId})"`;
  }

  // Logo elements anchor top-left (mirrors the renderer's objectPosition).
  // <image> doesn't have object-position; anchoring top-left is the default
  // when preserveAspectRatio is "xMinYMin". For other roles we default to
  // mid alignment.
  const isLogo = el.role === "logo" || el.type === "logo";
  const parFinal = isLogo ? "xMinYMin meet" : par;

  return `${openGroup(el, label, layerName)}
    <image href="${escAttr(href)}" xlink:href="${escAttr(href)}" width="${fmtNum(el.width)}" height="${fmtNum(el.height)}" preserveAspectRatio="${parFinal}"${filterAttr}/>
  </g>`;
}

function renderTextElement(el: Element, label: string, layerName: string): string {
  // Figma's SVG importer reliably keeps `<text>` editable when the structure
  // stays SIMPLE: one <text> per line of text, no `dy`-based stacking,
  // no `dominant-baseline`. Multi-line text is therefore emitted as N
  // sibling `<text>` elements with explicit y values. Emphasis splits stay
  // inside ONE <text> as two sibling <tspan>s — Figma handles that fine.
  const family = el.font_family ?? "Poppins";
  const weight = el.font_weight ?? 400;
  const size = el.font_size ?? 16;
  const lh = el.line_height ?? 1.4;
  const fg = el.color ?? "#FFFFFF";
  const align = el.text_align ?? "left";
  const text = el.text ?? "";
  const useEmphasis =
    el.emphasis_text &&
    text.startsWith(el.emphasis_text) &&
    el.emphasis_text.length > 0 &&
    el.emphasis_text.length < text.length;
  const emphasisColor = el.emphasis_color ?? "#F5C518";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const anchorX = align === "center" ? el.width / 2 : align === "right" ? el.width : 0;
  const lines = wrapText(text, size, el.width);
  const lineHeightPx = size * lh;
  // First baseline ~= 1em below box top so glyphs fit inside the bbox.
  const firstBaselineY = size;
  const baseFontAttrs = `font-family="${escAttr(family)}, sans-serif" font-weight="${weight}" font-size="${size}"`;

  // Helper that emits one <text> for one line.
  function lineText(line: string, lineIndex: number, isEmphasis: boolean): string {
    const y = firstBaselineY + lineIndex * lineHeightPx;
    if (isEmphasis && el.emphasis_text && line.startsWith(el.emphasis_text)) {
      // Split first line into two <tspan>s — emphasis prefix + rest.
      const prefix = el.emphasis_text;
      const rest = line.slice(prefix.length);
      // No dy/x on tspans — Figma keeps colored split editable.
      return `    <text ${baseFontAttrs} fill="${escAttr(fg)}" text-anchor="${anchor}" x="${fmtNum(anchorX)}" y="${fmtNum(y)}" xml:space="preserve"><tspan fill="${escAttr(emphasisColor)}">${escXml(prefix)}</tspan>${rest.length > 0 ? `<tspan>${escXml(rest)}</tspan>` : ""}</text>`;
    }
    return `    <text ${baseFontAttrs} fill="${escAttr(fg)}" text-anchor="${anchor}" x="${fmtNum(anchorX)}" y="${fmtNum(y)}" xml:space="preserve">${escXml(line)}</text>`;
  }

  const textElements: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Only the first line carries the emphasis split (matches the renderer's
    // rule that emphasis_text is a prefix of text).
    const isEmphasisLine = useEmphasis === true && i === 0;
    textElements.push(lineText(lines[i], i, isEmphasisLine));
  }

  return `${openGroup(el, label, layerName)}
${textElements.join("\n")}
  </g>`;
}

function renderCtaElement(el: Element, label: string, layerName: string): string {
  const family = el.font_family ?? "Poppins";
  const weight = el.font_weight ?? 600;
  const size = el.font_size ?? 32;
  const fg = el.color ?? "#FFFFFF";
  const bg = el.background_color ?? "#204489";
  const r = el.border_radius ?? 0;
  const stroke = el.border_width ?? 0;
  const strokeColor = el.border_color ?? "transparent";
  const text = el.text ?? "";
  const w = el.width;
  const h = el.height;
  const inset = stroke / 2;
  const fillAttr = bg === "transparent" ? `fill="none"` : `fill="${escAttr(bg)}"`;
  const strokeAttrs =
    stroke > 0 ? ` stroke="${escAttr(strokeColor)}" stroke-width="${stroke}"` : "";
  // Center the text vertically in the button by computing the baseline
  // manually. dominant-baseline="central" was prettier in raw browsers but
  // Figma's SVG importer occasionally outlines text when that attribute is
  // present. The factor 0.36 lands roughly at optical center for sans-serif
  // (matches the visual centering of CSS line-height).
  const baselineY = h / 2 + size * 0.36;
  return `${openGroup(el, label, layerName)}
    <rect x="${fmtNum(inset)}" y="${fmtNum(inset)}" width="${fmtNum(Math.max(0, w - 2 * inset))}" height="${fmtNum(Math.max(0, h - 2 * inset))}" rx="${r}" ry="${r}" ${fillAttr}${strokeAttrs}/>
    <text x="${fmtNum(w / 2)}" y="${fmtNum(baselineY)}" font-family="${escAttr(family)}, sans-serif" font-weight="${weight}" font-size="${size}" fill="${escAttr(fg)}" text-anchor="middle" xml:space="preserve">${escXml(text)}</text>
  </g>`;
}

function renderShapeElement(el: Element, label: string, layerName: string): string {
  const w = Math.max(1, el.width);
  const h = Math.max(1, el.height);
  const fill = el.background_color ?? "transparent";
  const r = el.border_radius ?? 0;
  return `${openGroup(el, label, layerName)}
    <rect width="${fmtNum(w)}" height="${fmtNum(h)}" rx="${r}" ry="${r}" fill="${escAttr(fill)}"/>
  </g>`;
}

// ── SVG-data-URI inlining ──────────────────────────────────────────────────
// Decodes a `data:image/svg+xml;{utf8,base64}` href back into raw SVG markup,
// rewrites internal ids to a per-element namespace (so two motifs using
// `id="g"` don't collide in the export), and emits a `<g>` containing the
// inner draw operations. Result: every chart silhouette / gradient orb /
// node network ships into Figma as native paths/circles/gradients the
// designer can edit, instead of an opaque <image> raster.
function inlineSvgFromDataUri(
  dataUri: string,
  el: Element,
  label: string,
  layerName: string,
): string | null {
  let inner: string;
  const utf8Match = dataUri.match(/^data:image\/svg\+xml;utf8,(.+)$/i);
  const utf8CharsetMatch = dataUri.match(/^data:image\/svg\+xml;charset=utf-8,(.+)$/i);
  const b64Match = dataUri.match(/^data:image\/svg\+xml;base64,(.+)$/i);
  try {
    if (utf8Match) {
      inner = decodeURIComponent(utf8Match[1]);
    } else if (utf8CharsetMatch) {
      inner = decodeURIComponent(utf8CharsetMatch[1]);
    } else if (b64Match) {
      inner = Buffer.from(b64Match[1], "base64").toString("utf8");
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const open = inner.match(/<svg\b[^>]*>/i);
  if (!open || open.index === undefined) return null;
  const bodyStart = open.index + open[0].length;
  const bodyEnd = inner.lastIndexOf("</svg>");
  if (bodyEnd < bodyStart) return null;
  const body = inner.slice(bodyStart, bodyEnd);

  // Read intrinsic size to scale into the element box.
  const wMatch = open[0].match(/\bwidth=["']?([\d.]+)/i);
  const hMatch = open[0].match(/\bheight=["']?([\d.]+)/i);
  const innerWidth = wMatch ? Number.parseFloat(wMatch[1]) : el.width;
  const innerHeight = hMatch ? Number.parseFloat(hMatch[1]) : el.height;
  const sx = innerWidth > 0 ? el.width / innerWidth : 1;
  const sy = innerHeight > 0 ? el.height / innerHeight : 1;

  // Namespace ids so multiple inlined motifs (gradients, filters) don't
  // collide. Rewrites both `id="X"` and `url(#X)` references.
  const prefix = `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-`;
  const collected = new Set<string>();
  const idRegex = /\bid=["']([^"'#]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(body)) !== null) collected.add(m[1]);
  let scoped = body;
  for (const id of collected) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scoped = scoped
      .replace(new RegExp(`\\bid=["']${safe}["']`, "g"), `id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${prefix}${id})`);
  }

  const scale = sx !== 1 || sy !== 1 ? ` scale(${fmtNum(sx)} ${fmtNum(sy)})` : "";
  const transform = `translate(${fmtNum(el.x)} ${fmtNum(el.y)})${scale}`;
  const idAttr = sanitizeIdForSvg(label);
  return `  <g id="${escAttr(idAttr)}" data-element="${escAttr(label)}" data-role="${escAttr(el.role)}" transform="${transform}" opacity="${fmtNum(el.opacity)}">
    <title>${escXml(layerName)}</title>
${scoped}
  </g>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function tryEmbedDataUri(
  cwd: string,
  publicPath: string,
  fallbackUrl: string,
): Promise<string> {
  try {
    const abs = path.join(cwd, "public", publicPath.replace(/^\//, ""));
    const buf = await fs.readFile(abs);
    const ext = path.extname(publicPath).toLowerCase().replace(".", "");
    const mime =
      ext === "svg" ? "image/svg+xml"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    // Fall back to whatever URL we had — Figma will fetch on import.
    return fallbackUrl || publicPath;
  }
}

function mapObjectFitToPreserveAspectRatio(fit: string): string {
  // Approximate mapping. SVG's preserveAspectRatio is align + meetOrSlice.
  // - cover    → "xMidYMid slice"
  // - contain  → "xMidYMid meet"
  // - fill     → "none" (stretch)
  // - none     → "xMidYMid meet"
  // - scale-down → treat as contain.
  switch (fit) {
    case "cover":
      return "xMidYMid slice";
    case "fill":
      return "none";
    default:
      return "xMidYMid meet";
  }
}

interface ShadowSpec {
  x?: number;
  y?: number;
  blur?: number;
  color?: string;
}

function registerDropShadow(
  defs: Map<string, string>,
  shadow: ShadowSpec,
): string {
  const x = shadow.x ?? 0;
  const y = shadow.y ?? 0;
  const blur = shadow.blur ?? 4;
  const color = shadow.color ?? "rgba(0,0,0,0.4)";
  const key = `${x}-${y}-${blur}-${color}`;
  if (defs.has(key)) {
    const existing = defs.get(key)!;
    const m = existing.match(/id="([^"]+)"/);
    if (m) return m[1];
  }
  const id = `shadow-${defs.size + 1}`;
  // SVG `feDropShadow` provides a 1:1 equivalent of CSS drop-shadow.
  const svg = `  <filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="${x}" dy="${y}" stdDeviation="${blur / 2}" flood-color="${escAttr(color)}"/>
  </filter>`;
  defs.set(key, svg);
  return id;
}

function wrapText(text: string, fontSize: number, boxWidth: number): string[] {
  // Mirrors createDemoCampaign's countWrappedLines word-wrap heuristic.
  const charWidthRatio = 0.55;
  const charsPerLine = Math.max(1, Math.floor(boxWidth / (fontSize * charWidthRatio)));
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) {
      current = w;
    } else if (current.length + 1 + w.length <= charsPerLine) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function findAdSpec(plan: CampaignPlan, adId: string) {
  for (const concept of plan.concepts) {
    const ad = concept.ad_specs.find((a) => a.ad_id === adId);
    if (ad) return ad;
  }
  return null;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
