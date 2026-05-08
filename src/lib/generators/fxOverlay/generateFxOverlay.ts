import sharp from "sharp";
import {
  FxOverlayParamsSchema,
  type FxOverlayParams,
  type SourceAssetRef,
} from "@/lib/schemas/generatedAsset.schema";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import { defaultPlacementRules } from "@/lib/generators/placement";
import { resolveBrandInputPath } from "@/lib/generators/brandInput";

const GENERATOR_ID = "fx_overlay@2.0.0";

// Hard cap. The user's spec said "opacity is not too high" so we clamp the
// overlay strength to 0.7 — anything stronger drowns out the underlying art.
const MAX_FX_INTENSITY = 0.7;

// ─────────────────────────────────────────────────────────────────────────────
// FX overlay generator — transparent decorative overlays.
//
// Variants:
//   - glow            radial color glow at center
//   - vignette        dark radial vignette around the edges
//   - corner_swoosh   diagonal accent stroke from one corner
//   - light_ray       angled light beam
//   - noise_grain     monochrome noise (PNG only — Sharp linear/noise)
//
// Default output is SVG. `noise_grain` is PNG-only because SVG can't produce
// noise without an enormous filter chain that not every renderer supports.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateFxOverlay(
  rawParams: unknown,
  ctx: GenerateContext,
): Promise<GenerateResult> {
  const params = FxOverlayParamsSchema.parse(rawParams);
  const intensity = clamp(params.intensity ?? 0.5, 0, MAX_FX_INTENSITY);
  const color =
    params.color ??
    (params.variant === "corner_swoosh"
      ? (ctx.brandKit.colors.accent[0] ?? "#F5C518")
      : "#FFFFFF");
  const seed = params.seed ?? hashStringToSeed(JSON.stringify(params));

  // Compositing path requires PNG output. noise_grain is always PNG.
  const wantsBrandInput =
    params.source_mode !== "generated_only" &&
    params.brand_input_element_paths.length > 0;
  const outFormat: "svg" | "png" =
    params.variant === "noise_grain" || wantsBrandInput
      ? "png"
      : (params.format ?? "svg");

  let bytes: Buffer;
  const sourceAssets: SourceAssetRef[] = [];

  if (outFormat === "png" && params.variant === "noise_grain") {
    bytes = await renderNoisePng(params, intensity);
  } else if (wantsBrandInput) {
    const baseRef = params.brand_input_element_paths[0];
    const baseAbs = resolveBrandInputPath(ctx.cwd, baseRef);
    sourceAssets.push({
      source_type: "brand_input",
      id: baseRef,
      public_path: baseRef.startsWith("/") ? baseRef : undefined,
      role: "decorative",
    });
    // Render the FX as PNG, composite ABOVE the resized brand-input element.
    const fxSvg = renderSvg(params, color, intensity, seed);
    const fxPng = await sharp(Buffer.from(fxSvg, "utf8"))
      .resize(params.size.width, params.size.height, { fit: "cover" })
      .png()
      .toBuffer();
    const baseResized = await sharp(baseAbs)
      .resize(params.size.width, params.size.height, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: "lanczos3",
      })
      .png()
      .toBuffer();
    bytes = await sharp(baseResized)
      .composite([{ input: fxPng, top: 0, left: 0 }])
      .png()
      .toBuffer();
  } else if (outFormat === "png") {
    const svg = renderSvg(params, color, intensity, seed);
    bytes = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  } else {
    bytes = Buffer.from(renderSvg(params, color, intensity, seed), "utf8");
  }

  return {
    type: "fx_overlay",
    variant: params.variant,
    format: outFormat,
    size: params.size,
    bytes,
    params: rawParams as Record<string, unknown>,
    brand_token_refs: [`color:${color}`],
    generator: GENERATOR_ID,
    seed,
    tags: ["fx_overlay", params.variant],
    notes: params.notes,
    render_mode: "image",
    placement_rules: defaultPlacementRules("fx_overlay", params.variant),
    source_assets: sourceAssets,
  };
}

function renderSvg(
  params: FxOverlayParams,
  color: string,
  intensity: number,
  seed: number,
): string {
  const { width, height } = params.size;
  switch (params.variant) {
    case "glow":
      return renderGlow(width, height, color, intensity);
    case "vignette":
      return renderVignette(width, height, intensity);
    case "corner_swoosh":
      return renderCornerSwoosh(width, height, color, intensity, seed);
    case "light_ray":
      return renderLightRay(width, height, color, intensity);
    case "noise_grain":
      // Should be unreachable — handled by PNG path — fall back to glow.
      return renderGlow(width, height, color, intensity);
  }
}

function svgWrap(width: number, height: number, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${body}
</svg>`;
}

function renderGlow(
  width: number,
  height: number,
  color: string,
  intensity: number,
): string {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height) * 0.6;
  const alpha = clamp(intensity, 0, 1).toFixed(3);
  const body = `  <defs>
    <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="0%" stop-color="${color}" stop-opacity="${alpha}"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>`;
  return svgWrap(width, height, body);
}

function renderVignette(
  width: number,
  height: number,
  intensity: number,
): string {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(width, height) * 0.7;
  const alpha = clamp(intensity, 0, 1).toFixed(3);
  const body = `  <defs>
    <radialGradient id="v" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="${alpha}"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#v)"/>`;
  return svgWrap(width, height, body);
}

function renderCornerSwoosh(
  width: number,
  height: number,
  color: string,
  intensity: number,
  seed: number,
): string {
  const alpha = clamp(intensity, 0, 1).toFixed(3);
  const sw = Math.max(8, height * 0.08);
  // Pick a corner based on seed: 0 TL, 1 TR, 2 BR, 3 BL.
  const corner = seed % 4;
  const m = Math.min(width, height) * 0.25;
  const paths: Record<number, string> = {
    0: `M 0 ${m} Q ${width * 0.4} ${-m} ${width} ${height * 0.35}`,
    1: `M ${width} ${m} Q ${width * 0.6} ${-m} 0 ${height * 0.35}`,
    2: `M ${width} ${height - m} Q ${width * 0.6} ${height + m} 0 ${height * 0.65}`,
    3: `M 0 ${height - m} Q ${width * 0.4} ${height + m} ${width} ${height * 0.65}`,
  };
  const body = `  <path d="${paths[corner]}" fill="none" stroke="${color}" stroke-opacity="${alpha}" stroke-width="${sw}" stroke-linecap="round"/>`;
  return svgWrap(width, height, body);
}

function renderLightRay(
  width: number,
  height: number,
  color: string,
  intensity: number,
): string {
  const alpha = clamp(intensity * 0.6, 0, 1).toFixed(3);
  const body = `  <defs>
    <linearGradient id="ray" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${width}" y2="${height}">
      <stop offset="0%" stop-color="${color}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${color}" stop-opacity="${alpha}"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <polygon points="0,0 ${width * 0.15},0 ${width * 0.55},${height} ${width * 0.4},${height}" fill="url(#ray)"/>
  <polygon points="${width * 0.45},0 ${width * 0.6},0 ${width * 0.95},${height} ${width * 0.8},${height}" fill="url(#ray)" opacity="0.7"/>`;
  return svgWrap(width, height, body);
}

async function renderNoisePng(
  params: FxOverlayParams,
  intensity: number,
): Promise<Buffer> {
  const { width, height } = params.size;
  // Create transparent canvas, then composite gaussian noise on top with the
  // requested alpha. Sharp's `noise` operation isn't exposed; instead we
  // create a single-channel random buffer and use it as an alpha mask.
  const channels = 4;
  const buf = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const v = Math.floor(Math.random() * 256);
    const off = i * channels;
    buf[off] = v;
    buf[off + 1] = v;
    buf[off + 2] = v;
    buf[off + 3] = Math.floor(intensity * 255);
  }
  return await sharp(buf, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
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
