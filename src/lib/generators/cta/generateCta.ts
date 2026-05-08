import {
  CtaParamsSchema,
  type CtaParams,
} from "@/lib/schemas/generatedAsset.schema";
import type { Element } from "@/lib/schemas/elementManifest.schema";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import { defaultPlacementRules } from "@/lib/generators/placement";

const GENERATOR_ID = "cta@2.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// CTA generator — renderer-compatible.
//
// Two output modes:
//   element (default)
//     The asset's bytes are a small preview SVG that mirrors what the banner
//     renderer would produce (real <text>, mathematical centering, brand-kit
//     padding, accent yellow for bottom_band, etc.). The interesting payload
//     is `element_manifest_preview` — a fully-validated cta-button Element
//     row with the exact field names the renderer reads in
//     ProductionElementLayer (text, font_*, padding, border_radius,
//     background_color, color, text_align: "center"). A campaign builder can
//     copy this row straight into a manifest.
//
//   svg
//     Standalone SVG download. Same centered text, but no element_manifest
//     payload. Use this when you want to drop the file into a slide deck or
//     ship it as a static image.
//
// Brand-kit binding (always-on for both modes):
//   - colors  → kit.colors.primary[0] / [1] / kit.colors.accent[0]/[2]
//   - padding → kit.cta.padding
//   - radius  → kit.cta.border_radius (override allowed)
//   - font    → kit.typography.families.cta
//   - sizing  → respects kit.cta.minimum_size (validated below)
//
// Centering fix: text-anchor=middle + dominant-baseline=central is the only
// reliable cross-browser combo. The previous y = height/2 + fontSize/3 with
// dominant-baseline=middle double-shifted the baseline.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateCta(
  rawParams: unknown,
  ctx: GenerateContext,
): Promise<GenerateResult> {
  const params = CtaParamsSchema.parse(rawParams);
  const palette = resolvePalette(params, ctx);
  const padding = resolvePadding(params, ctx);
  const minSize = resolveMinimumSize(ctx);

  // ── Validation ──────────────────────────────────────────────────────────
  if (params.size.width < minSize.width) {
    throw new Error(
      `CTA width ${params.size.width} below brand minimum ${minSize.width}.`,
    );
  }
  if (params.size.height < minSize.height) {
    throw new Error(
      `CTA height ${params.size.height} below brand minimum ${minSize.height}.`,
    );
  }
  // Char-budget fit check — same heuristic the renderer uses
  // (createDemoCampaign.ts: ctaCharBudgetPx = ceil(fontSize * 0.58 * len)).
  const charBudget = Math.ceil(palette.fontSize * 0.58 * decoratedText(params).length);
  const innerWidth = Math.max(
    0,
    params.size.width - (padding.left ?? 0) - (padding.right ?? 0),
  );
  if (charBudget > innerWidth) {
    const suggested = Math.ceil(charBudget + (padding.left ?? 0) + (padding.right ?? 0));
    throw new Error(
      `CTA text "${params.text}" doesn't fit at fontSize ${palette.fontSize} inside ${params.size.width}px (needs ~${suggested}px). Either shorten the text, lower font_size, or grow width.`,
    );
  }

  const seed = hashStringToSeed(JSON.stringify(params));
  const text = decoratedText(params);
  const svgBytes = renderCtaSvg({ params, palette, padding, text });

  if (params.output_mode === "svg") {
    return {
      type: "cta",
      variant: params.variant,
      format: "svg",
      size: params.size,
      bytes: Buffer.from(svgBytes, "utf8"),
      params: rawParams as Record<string, unknown>,
      brand_token_refs: brandTokenRefsFor(params, palette),
      generator: GENERATOR_ID,
      seed,
      tags: ["cta", params.variant, "svg"],
      notes: params.notes,
      render_mode: "svg",
      placement_rules: defaultPlacementRules("cta", params.variant),
      source_assets: [],
    };
  }

  // element mode — produce the renderer-compatible Element row.
  const element = buildElementPreview({
    params,
    palette,
    padding,
    text,
  });

  return {
    type: "cta",
    variant: params.variant,
    format: "svg",
    size: params.size,
    bytes: Buffer.from(svgBytes, "utf8"),
    params: rawParams as Record<string, unknown>,
    brand_token_refs: brandTokenRefsFor(params, palette),
    generator: GENERATOR_ID,
    seed,
    tags: ["cta", params.variant, "element"],
    notes: params.notes,
    render_mode: "element",
    placement_rules: defaultPlacementRules("cta", params.variant),
    source_assets: [],
    element_manifest_preview: element,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
interface CtaPalette {
  bg: string;
  fg: string;
  border: string;
  borderWidth: number;
  borderRadius: number;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

interface Padding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

function resolvePalette(params: CtaParams, ctx: GenerateContext): CtaPalette {
  const brandPrimary = ctx.brandKit.colors.primary[0] ?? "#204489";
  const brandWhite = ctx.brandKit.colors.primary[1] ?? "#FFFFFF";
  const accent = ctx.brandKit.colors.accent[0] ?? "#F5C518";
  const accentText = ctx.brandKit.colors.accent[2] ?? "#000000";

  const isAccent = params.variant.startsWith("accent_") || params.variant === "bottom_band";
  const isOutline = params.variant === "outline";
  const isPill = params.variant.endsWith("_pill");
  const isBand = params.variant === "bottom_band";

  const bg =
    params.background_color ??
    (isAccent ? accent : isOutline ? "transparent" : brandPrimary);
  const fg =
    params.text_color ??
    (isAccent ? accentText : isOutline ? brandPrimary : brandWhite);
  const border = params.border_color ?? (isOutline ? brandPrimary : "transparent");
  const borderWidth = params.border_width ?? (isOutline ? 4 : 0);
  const kitRadius = ctx.brandKit.cta?.border_radius ?? 0;
  const borderRadius =
    params.border_radius ??
    (isBand ? 0 : isPill ? Math.floor(params.size.height / 2) : kitRadius);

  // Typography binds the brand kit, then overrides if the caller passed any.
  const fontFamily =
    params.font_family ??
    ctx.brandKit.typography?.families?.cta ??
    "Poppins";
  const fontWeight = params.font_weight ?? (isBand ? 700 : 600);
  // The renderer uses ~42% of height for CTA font size when no override; that
  // matches createDemoCampaign's layout.cta.fontSize relationship to height.
  const fontSize =
    params.font_size ?? Math.max(16, Math.floor(params.size.height * 0.42));
  const lineHeight = ctx.brandKit.typography?.line_heights?.cta ?? 1.1;
  const letterSpacing = ctx.brandKit.typography?.letter_spacing?.cta ?? 0;

  return {
    bg,
    fg,
    border,
    borderWidth,
    borderRadius,
    fontFamily,
    fontWeight,
    fontSize,
    lineHeight,
    letterSpacing,
  };
}

function resolvePadding(_params: CtaParams, ctx: GenerateContext): Padding {
  const kit = ctx.brandKit.cta?.padding;
  if (kit) return { ...kit };
  return { top: 14, right: 36, bottom: 14, left: 36 };
}

function resolveMinimumSize(
  ctx: GenerateContext,
): { width: number; height: number } {
  const kit = ctx.brandKit.cta?.minimum_size;
  return {
    width: kit?.width ?? 180,
    height: kit?.height ?? 56,
  };
}

function decoratedText(params: CtaParams): string {
  if (params.arrow === "none") return params.text;
  // Mirror createDemoCampaign's arrow logic. Renderer wins at banner-build
  // time per language; this is preview-only.
  const arrowGlyph = "›";
  if (params.arrow === "rtl") return `${arrowGlyph} ${params.text}`;
  // ltr / auto default → arrow trails
  return `${params.text} ${arrowGlyph}`;
}

function brandTokenRefsFor(params: CtaParams, palette: CtaPalette): string[] {
  const refs = ["color.cta-bg", "color.cta-fg", "font.cta"];
  if (params.variant === "bottom_band") refs.push("color.accent-yellow");
  if (palette.borderWidth > 0) refs.push("color.cta-border");
  return refs;
}

// ── Element preview (renderer-compatible cta-button) ────────────────────────
function buildElementPreview(args: {
  params: CtaParams;
  palette: CtaPalette;
  padding: Padding;
  text: string;
}): Element {
  const { params, palette, padding, text } = args;
  const element: Element = {
    id: "el_cta_preview",
    type: "cta-button",
    role: "cta",
    source: "inline-text",
    x: 0,
    y: 0,
    width: params.size.width,
    height: params.size.height,
    z_index: 50,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    text,
    font_family: palette.fontFamily,
    font_weight: palette.fontWeight,
    font_size: palette.fontSize,
    line_height: palette.lineHeight,
    letter_spacing: palette.letterSpacing,
    text_align: "center",
    color: palette.fg,
    background_color: palette.bg,
    border_radius: palette.borderRadius,
    padding,
    brand_token_refs: brandTokenRefsFor(params, palette),
    uses_approved_color: true,
    uses_approved_font: true,
  };
  if (palette.borderWidth > 0) {
    element.border_width = palette.borderWidth;
    element.border_color = palette.border;
  }
  return element;
}

// ── SVG renderer (fixed centering) ──────────────────────────────────────────
function renderCtaSvg(args: {
  params: CtaParams;
  palette: CtaPalette;
  padding: Padding;
  text: string;
}): string {
  const { params, palette, text } = args;
  const { width, height } = params.size;
  const safeText = escapeXml(text);

  const strokeAttrs =
    palette.borderWidth > 0
      ? ` stroke="${palette.border}" stroke-width="${palette.borderWidth}"`
      : "";
  const fillAttr = palette.bg === "transparent" ? ` fill="none"` : ` fill="${palette.bg}"`;
  const inset = palette.borderWidth / 2;
  const rectX = inset;
  const rectY = inset;
  const rectW = Math.max(0, width - 2 * inset);
  const rectH = Math.max(0, height - 2 * inset);
  const rect = `  <rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" rx="${palette.borderRadius}" ry="${palette.borderRadius}"${fillAttr}${strokeAttrs}/>`;

  // Centering: use 50% / 50% with dominant-baseline=central. Browsers and the
  // SVG → PNG rasterisers we ship to all honour this combo. The previous
  // y = height/2 + fontSize/3 was a manual baseline that double-shifted when
  // dominant-baseline was already set.
  const letterSpacingAttr =
    palette.letterSpacing !== 0
      ? ` letter-spacing="${palette.letterSpacing}"`
      : "";
  const text_ = `  <text x="50%" y="50%" font-family="${palette.fontFamily}, sans-serif" font-weight="${palette.fontWeight}" font-size="${palette.fontSize}" fill="${palette.fg}" text-anchor="middle" dominant-baseline="central"${letterSpacingAttr}>${safeText}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${rect}
${text_}
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hashStringToSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
