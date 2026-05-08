import sharp from "sharp";
import {
  BackgroundParamsSchema,
  type BackgroundParams,
} from "@/lib/schemas/generatedAsset.schema";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import type { SourceAssetRef } from "@/lib/schemas/generatedAsset.schema";
import { defaultPlacementRules } from "@/lib/generators/placement";
import { resolveBrandInputPath } from "@/lib/generators/brandInput";

const GENERATOR_ID = "background@2.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Background generator — three source modes:
//
//   generated_only           pure SVG, brand colors. Output is SVG.
//   brand_input_only         the brand-input image, resized + safe-area-tinted
//                            for legibility. Output is PNG.
//   brand_input_plus_generated
//                            brand-input image + a generated overlay
//                            (gradient, vignette, mesh) on top. Output is PNG.
//
// `overlay_mode` controls the composite behaviour when source_mode mixes:
//   replace → ignore the generator, just rewrite the brand-input image
//   scrim   → generated layer at overlay_opacity (default 0.55 — readable)
//   tint    → solid first-color overlay at overlay_opacity (default 0.35)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateBackground(
  rawParams: unknown,
  ctx: GenerateContext,
): Promise<GenerateResult> {
  const params = BackgroundParamsSchema.parse(rawParams);
  const colors = resolveColors(params, ctx);
  if (colors.length < 1) {
    throw new Error("Background generator requires at least one color in the brand kit.");
  }

  const seed = params.seed ?? hashStringToSeed(JSON.stringify(params));

  if (params.source_mode === "generated_only") {
    const svg = renderSvg(params, colors, seed);
    return {
      type: "background",
      variant: params.variant,
      format: "svg",
      size: params.size,
      bytes: Buffer.from(svg, "utf8"),
      params: rawParams as Record<string, unknown>,
      brand_token_refs: colors.map((c) => `color:${c}`),
      generator: GENERATOR_ID,
      seed,
      tags: ["background", params.variant, "generated_only"],
      notes: params.notes,
      render_mode: "image",
      placement_rules: defaultPlacementRules("background", params.variant),
      source_assets: [],
    };
  }

  // Brand-input branches require a path.
  if (!params.brand_input_background_path) {
    throw new Error(
      `source_mode "${params.source_mode}" requires brand_input_background_path. Pick a file via the Asset Generator picker.`,
    );
  }
  const brandPath = resolveBrandInputPath(ctx.cwd, params.brand_input_background_path);

  const sourceRef: SourceAssetRef = {
    source_type: "brand_input",
    id: params.brand_input_background_path,
    path: params.brand_input_background_path.replace(/^\//, ""),
    public_path: params.brand_input_background_path.startsWith("/")
      ? params.brand_input_background_path
      : undefined,
    role: "background",
  };

  // Always-on resize step — the brand-input image is `cover`-fit into the
  // requested canvas. lanczos3 keeps text-shaped detail crisp.
  const baseBuffer = await sharp(brandPath)
    .resize({
      width: params.size.width,
      height: params.size.height,
      fit: "cover",
      position: "centre",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();

  if (params.source_mode === "brand_input_only" || params.overlay_mode === "replace") {
    return {
      type: "background",
      variant: `${params.variant}_brand_input`,
      format: "png",
      size: params.size,
      bytes: baseBuffer,
      params: rawParams as Record<string, unknown>,
      brand_token_refs: [],
      generator: GENERATOR_ID,
      seed,
      tags: ["background", "brand_input_only"],
      notes: params.notes,
      render_mode: "image",
      placement_rules: defaultPlacementRules("background", params.variant),
      source_assets: [sourceRef],
    };
  }

  // brand_input_plus_generated — composite the generator SVG on top.
  const overlayOpacity =
    params.overlay_opacity ?? (params.overlay_mode === "tint" ? 0.35 : 0.55);
  const overlaySvg =
    params.overlay_mode === "tint"
      ? renderTint(params.size, colors[0], overlayOpacity)
      : wrapSvgOpacity(renderSvg(params, colors, seed), overlayOpacity);

  const composed = await sharp(baseBuffer)
    .composite([{ input: Buffer.from(overlaySvg, "utf8"), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return {
    type: "background",
    variant: `${params.variant}_${params.overlay_mode}`,
    format: "png",
    size: params.size,
    bytes: composed,
    params: rawParams as Record<string, unknown>,
    brand_token_refs: colors.map((c) => `color:${c}`),
    generator: GENERATOR_ID,
    seed,
    tags: ["background", params.variant, params.overlay_mode],
    notes: params.notes,
    render_mode: "image",
    placement_rules: defaultPlacementRules("background", params.variant),
    source_assets: [sourceRef],
  };
}

function resolveColors(
  params: BackgroundParams,
  ctx: GenerateContext,
): string[] {
  if (params.colors && params.colors.length >= 1) return params.colors;
  if (ctx.brandKit.colors.background.length > 0) return ctx.brandKit.colors.background;
  return ctx.brandKit.colors.primary;
}

function renderSvg(
  params: BackgroundParams,
  colors: string[],
  seed: number,
): string {
  const { width, height } = params.size;
  const angle = params.angle_deg ?? 135;

  switch (params.variant) {
    case "linear_gradient":
      return renderLinearGradient(width, height, colors, angle);
    case "radial_gradient":
      return renderRadialGradient(width, height, colors);
    case "mesh_gradient":
      return renderMeshGradient(width, height, colors, seed);
    case "vignette":
      return renderVignette(width, height, colors[0]);
    case "diagonal_split":
      return renderDiagonalSplit(width, height, colors);
  }
}

function svgWrap(width: number, height: number, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${body}
</svg>`;
}

function wrapSvgOpacity(svg: string, opacity: number): string {
  // Wrap the existing <svg> root contents in a <g opacity="..."> so the final
  // composite respects the requested overlay opacity. Cheaper than re-rendering.
  const o = clamp(opacity, 0, 1);
  return svg.replace(
    /(<svg[^>]*>)/,
    `$1<g opacity="${o.toFixed(3)}">`,
  ).replace("</svg>", "</g></svg>");
}

function renderTint(
  size: { width: number; height: number },
  color: string,
  opacity: number,
): string {
  const o = clamp(opacity, 0, 1).toFixed(3);
  const body = `  <rect width="${size.width}" height="${size.height}" fill="${color}" fill-opacity="${o}"/>`;
  return svgWrap(size.width, size.height, body);
}

function renderLinearGradient(
  width: number,
  height: number,
  colors: string[],
  angle: number,
): string {
  const stops = buildStops(colors);
  const rad = ((angle - 90) * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height);
  const x1 = cx - Math.cos(rad) * r;
  const y1 = cy - Math.sin(rad) * r;
  const x2 = cx + Math.cos(rad) * r;
  const y2 = cy + Math.sin(rad) * r;
  const body = `  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}">
${stops}
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>`;
  return svgWrap(width, height, body);
}

function renderRadialGradient(
  width: number,
  height: number,
  colors: string[],
): string {
  const stops = buildStops(colors);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height) * 0.7;
  const body = `  <defs>
    <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
${stops}
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>`;
  return svgWrap(width, height, body);
}

function renderMeshGradient(
  width: number,
  height: number,
  colors: string[],
  seed: number,
): string {
  const rng = mulberry32(seed);
  const c0 = colors[0];
  const c1 = colors[Math.min(1, colors.length - 1)];
  const c2 = colors[Math.min(2, colors.length - 1)];
  const blobs = [
    { cx: rng() * width, cy: rng() * height, r: Math.max(width, height) * 0.6, color: c1 },
    { cx: rng() * width, cy: rng() * height, r: Math.max(width, height) * 0.45, color: c2 },
    { cx: rng() * width, cy: rng() * height, r: Math.max(width, height) * 0.5, color: colors[colors.length - 1] },
  ];
  const defs = blobs
    .map(
      (b, i) => `    <radialGradient id="b${i}" gradientUnits="userSpaceOnUse" cx="${b.cx.toFixed(2)}" cy="${b.cy.toFixed(2)}" r="${b.r.toFixed(2)}">
      <stop offset="0%" stop-color="${b.color}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${b.color}" stop-opacity="0"/>
    </radialGradient>`,
    )
    .join("\n");
  const rects = blobs
    .map((_, i) => `  <rect width="${width}" height="${height}" fill="url(#b${i})"/>`)
    .join("\n");
  const body = `  <defs>
${defs}
  </defs>
  <rect width="${width}" height="${height}" fill="${c0}"/>
${rects}`;
  return svgWrap(width, height, body);
}

function renderVignette(
  width: number,
  height: number,
  baseColor: string,
): string {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height) * 0.7;
  const body = `  <defs>
    <radialGradient id="v" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="55%" stop-color="${baseColor}" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.65"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${baseColor}"/>
  <rect width="${width}" height="${height}" fill="url(#v)"/>`;
  return svgWrap(width, height, body);
}

function renderDiagonalSplit(
  width: number,
  height: number,
  colors: string[],
): string {
  const c0 = colors[0];
  const c1 = colors[Math.min(1, colors.length - 1)];
  const body = `  <rect width="${width}" height="${height}" fill="${c0}"/>
  <polygon points="${width},0 ${width},${height} 0,${height}" fill="${c1}"/>`;
  return svgWrap(width, height, body);
}

function buildStops(colors: string[]): string {
  if (colors.length === 1) {
    return `      <stop offset="0%" stop-color="${colors[0]}"/>
      <stop offset="100%" stop-color="${colors[0]}"/>`;
  }
  return colors
    .map((c, i) => {
      const offset = (i / (colors.length - 1)) * 100;
      return `      <stop offset="${offset.toFixed(2)}%" stop-color="${c}"/>`;
    })
    .join("\n");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function hashStringToSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
