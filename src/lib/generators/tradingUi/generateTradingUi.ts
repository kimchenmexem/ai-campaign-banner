import {
  TradingUiParamsSchema,
  type TradingUiParams,
} from "@/lib/schemas/generatedAsset.schema";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import { defaultPlacementRules } from "@/lib/generators/placement";

const GENERATOR_ID = "trading_ui@2.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Trading-UI generator — fintech-flavored SVG widgets, deterministic from a
// numeric seed. The variants are scoped to what an ad banner would actually
// embed: a price card, a candle chart, a portfolio donut, a ticker strip.
//
// All elements use brand colors (primary blue + accent green/red derived from
// trend). No real market data — these are stylised props.
// ─────────────────────────────────────────────────────────────────────────────

const UP_COLOR = "#2BB673";
const DOWN_COLOR = "#D81222";

export async function generateTradingUi(
  rawParams: unknown,
  ctx: GenerateContext,
): Promise<GenerateResult> {
  const params = TradingUiParamsSchema.parse(rawParams);
  const seed = params.seed ?? hashStringToSeed(JSON.stringify(params));
  const trend =
    params.trend ?? (mulberry32(seed)() > 0.45 ? "up" : "down");

  const palette = {
    bg: ctx.brandKit.colors.background[0] ?? "#00122C",
    surface: ctx.brandKit.colors.background[2] ?? "#004267",
    primary: ctx.brandKit.colors.primary[0] ?? "#204489",
    text: ctx.brandKit.colors.text[1] ?? "#FFFFFF",
    accent: ctx.brandKit.colors.accent[0] ?? "#F5C518",
    up: UP_COLOR,
    down: DOWN_COLOR,
    trendColor: trend === "up" ? UP_COLOR : DOWN_COLOR,
  };

  const svg = renderSvg(params, palette, seed, trend);

  return {
    type: "trading_ui",
    variant: params.variant,
    format: "svg",
    size: params.size,
    bytes: Buffer.from(svg, "utf8"),
    params: rawParams as Record<string, unknown>,
    brand_token_refs: [
      `color:${palette.bg}`,
      `color:${palette.primary}`,
      `color:${palette.accent}`,
    ],
    generator: GENERATOR_ID,
    seed,
    tags: ["trading_ui", params.variant, trend],
    notes: params.notes,
    render_mode: "image",
    placement_rules: defaultPlacementRules("trading_ui", params.variant),
    source_assets: [],
  };
}

interface Palette {
  bg: string;
  surface: string;
  primary: string;
  text: string;
  accent: string;
  up: string;
  down: string;
  trendColor: string;
}

function renderSvg(
  params: TradingUiParams,
  p: Palette,
  seed: number,
  trend: "up" | "down",
): string {
  switch (params.variant) {
    case "price_card":
      return renderPriceCard(params, p, seed, trend);
    case "candle_chart":
      return renderCandleChart(params, p, seed, trend);
    case "portfolio_donut":
      return renderPortfolioDonut(params, p, seed);
    case "ticker_strip":
      return renderTickerStrip(params, p, seed);
  }
}

function svgWrap(width: number, height: number, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${body}
</svg>`;
}

function renderPriceCard(
  params: TradingUiParams,
  p: Palette,
  seed: number,
  trend: "up" | "down",
): string {
  const { width, height } = params.size;
  const rng = mulberry32(seed);
  const ticker = (params.ticker ?? "AAPL").toUpperCase();
  const price = (50 + rng() * 350).toFixed(2);
  const changePct = ((trend === "up" ? 1 : -1) * (0.2 + rng() * 4.8)).toFixed(2);
  const r = Math.min(width, height) * 0.06;
  const padding = Math.min(width, height) * 0.08;
  const titleSize = Math.floor(height * 0.14);
  const priceSize = Math.floor(height * 0.34);
  const subSize = Math.floor(height * 0.12);
  const arrow = trend === "up" ? "▲" : "▼";
  const sparkPath = sparklinePath({
    x: padding,
    y: height - padding - height * 0.25,
    width: width - padding * 2,
    height: height * 0.2,
    seed,
    trend,
    points: 24,
  });

  const body = `  <rect width="${width}" height="${height}" rx="${r}" ry="${r}" fill="${p.surface}"/>
  <text x="${padding}" y="${padding + titleSize}" font-family="Poppins, sans-serif" font-weight="700" font-size="${titleSize}" fill="${p.text}">${escapeXml(ticker)}</text>
  <text x="${padding}" y="${padding + titleSize + priceSize + 8}" font-family="Poppins, sans-serif" font-weight="700" font-size="${priceSize}" fill="${p.text}">$${price}</text>
  <text x="${padding}" y="${padding + titleSize + priceSize + subSize + 24}" font-family="Poppins, sans-serif" font-weight="600" font-size="${subSize}" fill="${p.trendColor}">${arrow} ${changePct}%</text>
  <path d="${sparkPath}" fill="none" stroke="${p.trendColor}" stroke-width="${Math.max(2, height * 0.012)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svgWrap(width, height, body);
}

function renderCandleChart(
  params: TradingUiParams,
  p: Palette,
  seed: number,
  trend: "up" | "down",
): string {
  const { width, height } = params.size;
  const padding = Math.min(width, height) * 0.08;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const r = Math.min(width, height) * 0.04;
  const candleCount = 18;
  const gap = innerW / candleCount;
  const candleW = gap * 0.55;
  const rng = mulberry32(seed);
  const drift = trend === "up" ? 1 : -1;
  let level = 0.5;
  const candles: string[] = [];
  // Soft horizontal grid lines for chart feel.
  const grid: string[] = [];
  for (let i = 1; i < 5; i++) {
    const y = padding + (innerH / 5) * i;
    grid.push(
      `  <line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="${p.text}" stroke-opacity="0.08" stroke-width="1"/>`,
    );
  }
  for (let i = 0; i < candleCount; i++) {
    const open = level;
    level = clamp(level + (rng() - 0.5) * 0.18 + drift * 0.025, 0.05, 0.95);
    const close = level;
    const high = Math.min(0.97, Math.max(open, close) + rng() * 0.06);
    const low = Math.max(0.03, Math.min(open, close) - rng() * 0.06);
    const isUp = close >= open;
    const color = isUp ? p.up : p.down;
    const x = padding + i * gap + (gap - candleW) / 2;
    const yOpen = padding + (1 - open) * innerH;
    const yClose = padding + (1 - close) * innerH;
    const yHigh = padding + (1 - high) * innerH;
    const yLow = padding + (1 - low) * innerH;
    const yTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(2, Math.abs(yClose - yOpen));
    const wickX = x + candleW / 2;
    candles.push(
      `  <line x1="${wickX}" y1="${yHigh}" x2="${wickX}" y2="${yLow}" stroke="${color}" stroke-width="${Math.max(1, candleW * 0.18)}"/>`,
    );
    candles.push(
      `  <rect x="${x}" y="${yTop}" width="${candleW}" height="${bodyH}" fill="${color}" rx="2" ry="2"/>`,
    );
  }
  const body = `  <rect width="${width}" height="${height}" rx="${r}" ry="${r}" fill="${p.surface}"/>
${grid.join("\n")}
${candles.join("\n")}`;
  return svgWrap(width, height, body);
}

function renderPortfolioDonut(
  params: TradingUiParams,
  p: Palette,
  seed: number,
): string {
  const { width, height } = params.size;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.4;
  const inner = radius * 0.55;
  const rng = mulberry32(seed);
  const sliceCount = 4;
  const weights = Array.from({ length: sliceCount }, () => 0.5 + rng());
  const total = weights.reduce((a, b) => a + b, 0);
  const fractions = weights.map((w) => w / total);
  const colors = [p.primary, p.accent, p.up, "#FFFFFF"];
  let start = -Math.PI / 2;
  const arcs: string[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const sweep = fractions[i] * Math.PI * 2;
    const end = start + sweep;
    arcs.push(donutArcPath(cx, cy, radius, inner, start, end, colors[i % colors.length]));
    start = end;
  }
  const labelSize = Math.floor(Math.min(width, height) * 0.08);
  const body = `  <rect width="${width}" height="${height}" rx="${Math.min(width, height) * 0.04}" fill="${p.surface}"/>
${arcs.join("\n")}
  <circle cx="${cx}" cy="${cy}" r="${inner * 0.7}" fill="${p.surface}"/>
  <text x="${cx}" y="${cy + labelSize / 3}" font-family="Poppins, sans-serif" font-weight="700" font-size="${labelSize}" fill="${p.text}" text-anchor="middle">Portfolio</text>`;
  return svgWrap(width, height, body);
}

function renderTickerStrip(
  params: TradingUiParams,
  p: Palette,
  seed: number,
): string {
  const { width, height } = params.size;
  const rng = mulberry32(seed);
  const tickers = ["AAPL", "MSFT", "TSLA", "NVDA", "AMZN", "GOOG", "META", "BRK.B"];
  const padding = Math.min(width, height) * 0.18;
  const itemW = width / tickers.length;
  const fontSize = Math.floor(height * 0.28);
  const subSize = Math.floor(height * 0.22);
  const items: string[] = tickers.map((t, i) => {
    const x = i * itemW + itemW / 2;
    const up = rng() > 0.4;
    const change = ((up ? 1 : -1) * (0.1 + rng() * 4)).toFixed(2);
    return `  <text x="${x}" y="${height / 2 - 4}" text-anchor="middle" font-family="Poppins, sans-serif" font-weight="700" font-size="${fontSize}" fill="${p.text}">${t}</text>
  <text x="${x}" y="${height / 2 + subSize + 4}" text-anchor="middle" font-family="Poppins, sans-serif" font-weight="600" font-size="${subSize}" fill="${up ? p.up : p.down}">${up ? "+" : ""}${change}%</text>`;
  });
  void padding;
  const body = `  <rect width="${width}" height="${height}" rx="0" fill="${p.bg}"/>
${items.join("\n")}`;
  return svgWrap(width, height, body);
}

// ── Geometry helpers ────────────────────────────────────────────────────────
function donutArcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
  fill: string,
): string {
  const x1 = cx + Math.cos(startAngle) * outerR;
  const y1 = cy + Math.sin(startAngle) * outerR;
  const x2 = cx + Math.cos(endAngle) * outerR;
  const y2 = cy + Math.sin(endAngle) * outerR;
  const x3 = cx + Math.cos(endAngle) * innerR;
  const y3 = cy + Math.sin(endAngle) * innerR;
  const x4 = cx + Math.cos(startAngle) * innerR;
  const y4 = cy + Math.sin(startAngle) * innerR;
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const d = [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    "Z",
  ].join(" ");
  return `  <path d="${d}" fill="${fill}"/>`;
}

function sparklinePath(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  seed: number;
  trend: "up" | "down";
  points: number;
}): string {
  const rng = mulberry32(args.seed * 31 + 7);
  const drift = args.trend === "up" ? 1 : -1;
  let level = 0.5;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < args.points; i++) {
    level = clamp(level + (rng() - 0.5) * 0.18 + drift * 0.02, 0.05, 0.95);
    const x = args.x + (i / (args.points - 1)) * args.width;
    const y = args.y + (1 - level) * args.height;
    xs.push(x);
    ys.push(y);
  }
  const parts: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    parts.push(`${i === 0 ? "M" : "L"} ${xs[i].toFixed(2)} ${ys[i].toFixed(2)}`);
  }
  return parts.join(" ");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
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

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
