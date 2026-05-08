#!/usr/bin/env tsx
/**
 * MEXEM Pack v1 — curated starter pack of generated assets.
 *
 *   12 backgrounds  (4 institutional blue, 3 dark trading,
 *                    3 global investing, 2 clean ETF)
 *    8 CTAs         (element-mode, EN + HE, short + long)
 *    8 FX overlays  (glow, vignette, market lines, particles, glass)
 *    8 trading-UI   (candle / watchlist / ETF / portfolio / ticker /
 *                    order ticket / futures / forex)
 *    6 mockups      (phone + screenshot, laptop + screenshot, multi-device)
 *
 * Every row tagged "pack:mexem-v1" + role-specific tags. approved=true on
 * persist (default). Thumbnails written by the storage layer.
 *
 * Run with:  npx tsx scripts/build-mexem-asset-pack.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadBrandKit,
  generateBackground,
  generateCta,
  generateMockup,
  generateTradingUi,
  generateFxOverlay,
  persistAsset,
  type GenerateResult,
} from "@/lib/generators";
import type {
  BackgroundParams,
  CtaParams,
  FxOverlayParams,
  GeneratedAsset,
  MockupParams,
  TradingUiParams,
} from "@/lib/schemas/generatedAsset.schema";

interface PackEntry {
  recipe: string; // human-readable role description
  tags: string[];
  recommended_use: string;
}

interface BuiltAsset {
  asset: GeneratedAsset;
  recipe: string;
  recommended_use: string;
}

// ─── Spec lists ──────────────────────────────────────────────────────────────
const BG_RECIPES: Array<{
  recipe: string;
  recommended_use: string;
  params: BackgroundParams;
  extraTags?: string[];
}> = [
  // 4 institutional blue gradients
  {
    recipe: "institutional-blue-1",
    recommended_use: "Conservative awareness banners; deep navy → mid blue",
    params: {
      variant: "linear_gradient",
      size: { width: 1600, height: 900 },
      angle_deg: 135,
      colors: ["#00122C", "#004267", "#005D8D"],
      seed: 1001,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:institutional", "tone:trustworthy"],
  },
  {
    recipe: "institutional-blue-2",
    recommended_use: "Mid-funnel ads; horizontal navy ramp",
    params: {
      variant: "linear_gradient",
      size: { width: 1600, height: 900 },
      angle_deg: 90,
      colors: ["#00122C", "#002B4B", "#006291"],
      seed: 1002,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:institutional", "tone:premium"],
  },
  {
    recipe: "institutional-blue-3-radial",
    recommended_use: "Hero + CTA-centered layouts; spotlight effect",
    params: {
      variant: "radial_gradient",
      size: { width: 1080, height: 1080 },
      colors: ["#005D8D", "#002B4B", "#00122C"],
      seed: 1003,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:institutional", "tone:premium"],
  },
  {
    recipe: "institutional-blue-4-mesh",
    recommended_use: "Soft brand-blue mesh — pairs well with white headlines",
    params: {
      variant: "mesh_gradient",
      size: { width: 1080, height: 1080 },
      colors: ["#00122C", "#004267", "#005786", "#006A97"],
      seed: 1004,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:institutional", "tone:friendly"],
  },

  // 3 dark trading backgrounds
  {
    recipe: "dark-trading-1-vignette",
    recommended_use: "Power-user trading concepts; near-black with vignette",
    params: {
      variant: "vignette",
      size: { width: 1200, height: 628 },
      colors: ["#00122C"],
      seed: 2001,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:dark-trading", "tone:serious"],
  },
  {
    recipe: "dark-trading-2-mesh",
    recommended_use: "Trading dashboards / candle hero; deep mesh",
    params: {
      variant: "mesh_gradient",
      size: { width: 1200, height: 628 },
      colors: ["#000000", "#00122C", "#002B4B"],
      seed: 2002,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:dark-trading", "tone:serious"],
  },
  {
    recipe: "dark-trading-3-radial",
    recommended_use: "Centered product visuals on near-black",
    params: {
      variant: "radial_gradient",
      size: { width: 1080, height: 1920 },
      colors: ["#002B4B", "#00122C", "#000000"],
      seed: 2003,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:dark-trading", "tone:serious"],
  },

  // 3 global investing backgrounds
  {
    recipe: "global-investing-1-diagonal",
    recommended_use: "Geographic / global theme — diagonal split, blue + accent",
    params: {
      variant: "diagonal_split",
      size: { width: 1200, height: 628 },
      colors: ["#004267", "#F5C518"],
      seed: 3001,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:global", "tone:bold"],
  },
  {
    recipe: "global-investing-2-mesh",
    recommended_use: "International equities concepts — wide blue mesh",
    params: {
      variant: "mesh_gradient",
      size: { width: 1200, height: 628 },
      colors: ["#00122C", "#005786", "#006A97", "#F5C518"],
      seed: 3002,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:global", "tone:bold"],
  },
  {
    recipe: "global-investing-3-linear",
    recommended_use: "Market-open hero; blue → accent ramp at 45°",
    params: {
      variant: "linear_gradient",
      size: { width: 1080, height: 1080 },
      angle_deg: 45,
      colors: ["#002B4B", "#005D8D", "#F5C518"],
      seed: 3003,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:global", "tone:bold"],
  },

  // 2 clean ETF backgrounds
  {
    recipe: "clean-etf-1-radial-light",
    recommended_use: "ETF / passive product banners — calm spotlight",
    params: {
      variant: "radial_gradient",
      size: { width: 1080, height: 1080 },
      colors: ["#006291", "#004267", "#00122C"],
      seed: 4001,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:clean-etf", "tone:calm"],
  },
  {
    recipe: "clean-etf-2-linear",
    recommended_use: "ETF list / explainer; soft horizontal ramp",
    params: {
      variant: "linear_gradient",
      size: { width: 1200, height: 628 },
      angle_deg: 180,
      colors: ["#006291", "#005D8D", "#004267"],
      seed: 4002,
      source_mode: "generated_only",
      overlay_mode: "scrim",
    },
    extraTags: ["palette:clean-etf", "tone:calm"],
  },
];

const CTA_RECIPES: Array<{
  recipe: string;
  recommended_use: string;
  params: CtaParams;
  extraTags?: string[];
}> = [
  // 4 English (short + long, mixed variants)
  {
    recipe: "cta-en-short-pill",
    recommended_use: "Primary action, English, short copy. Generic awareness.",
    params: {
      variant: "primary_pill",
      text: "Start now",
      size: { width: 480, height: 96 },
      output_mode: "element",
      arrow: "ltr",
    },
    extraTags: ["lang:en", "length:short", "weight:standard"],
  },
  {
    recipe: "cta-en-medium-block",
    recommended_use: "Primary block, English, medium copy. Conversion banners.",
    params: {
      variant: "primary_block",
      text: "Open an account",
      size: { width: 560, height: 96 },
      output_mode: "element",
      arrow: "ltr",
    },
    extraTags: ["lang:en", "length:medium", "weight:standard"],
  },
  {
    recipe: "cta-en-long-bottom-band",
    recommended_use: "Bottom-band yellow CTA across the canvas; high-conversion",
    params: {
      variant: "bottom_band",
      text: "Start trading global markets",
      size: { width: 1200, height: 110 },
      output_mode: "element",
      arrow: "none",
    },
    extraTags: ["lang:en", "length:long", "weight:loud", "placement:bottom_band"],
  },
  {
    recipe: "cta-en-ghost-outline",
    recommended_use: "Ghost / outline CTA on rich photographic backgrounds",
    params: {
      variant: "outline",
      text: "Learn more",
      size: { width: 480, height: 96 },
      output_mode: "element",
      arrow: "ltr",
    },
    extraTags: ["lang:en", "length:short", "weight:ghost"],
  },

  // 4 Hebrew (short + long, mixed)
  {
    recipe: "cta-he-short-pill",
    recommended_use: "Hebrew primary, short copy",
    params: {
      variant: "primary_pill",
      text: "התחל לסחור",
      size: { width: 480, height: 96 },
      output_mode: "element",
      arrow: "rtl",
    },
    extraTags: ["lang:he", "length:short", "weight:standard"],
  },
  {
    recipe: "cta-he-medium-block",
    recommended_use: "Hebrew primary, medium copy. Conversion banners.",
    params: {
      variant: "primary_block",
      text: "פתח חשבון מסחר",
      size: { width: 560, height: 96 },
      output_mode: "element",
      arrow: "rtl",
    },
    extraTags: ["lang:he", "length:medium", "weight:standard"],
  },
  {
    recipe: "cta-he-long-bottom-band",
    recommended_use: "Hebrew bottom-band yellow CTA",
    params: {
      variant: "bottom_band",
      text: "סחר בשווקים הגלובליים בביטחון",
      size: { width: 1200, height: 110 },
      output_mode: "element",
      arrow: "none",
    },
    extraTags: ["lang:he", "length:long", "weight:loud", "placement:bottom_band"],
  },
  {
    recipe: "cta-he-accent-pill",
    recommended_use: "Hebrew accent pill — yellow on dark",
    params: {
      variant: "accent_pill",
      text: "גלה עוד",
      size: { width: 360, height: 96 },
      output_mode: "element",
      arrow: "rtl",
    },
    extraTags: ["lang:he", "length:short", "weight:accent"],
  },
];

const FX_RECIPES: Array<{
  recipe: string;
  recommended_use: string;
  params: FxOverlayParams;
  extraTags?: string[];
}> = [
  {
    recipe: "fx-glow-center",
    recommended_use: "Soft white glow behind hero subjects",
    params: {
      variant: "glow",
      size: { width: 1200, height: 628 },
      intensity: 0.5,
      color: "#FFFFFF",
      seed: 5001,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:glow", "intent:focus"],
  },
  {
    recipe: "fx-glow-accent",
    recommended_use: "Yellow brand-accent glow — bottom-band emphasis",
    params: {
      variant: "glow",
      size: { width: 1200, height: 628 },
      intensity: 0.55,
      color: "#F5C518",
      seed: 5002,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:glow", "intent:cta-emphasis"],
  },
  {
    recipe: "fx-vignette-soft",
    recommended_use: "Soft vignette to push attention to center",
    params: {
      variant: "vignette",
      size: { width: 1200, height: 628 },
      intensity: 0.5,
      seed: 5003,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:vignette", "intent:focus"],
  },
  {
    recipe: "fx-vignette-strong",
    recommended_use: "Strong vignette for cinematic / serious banners",
    params: {
      variant: "vignette",
      size: { width: 1200, height: 628 },
      intensity: 0.7,
      seed: 5004,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:vignette", "intent:cinematic"],
  },
  {
    recipe: "fx-market-lines-tl",
    recommended_use: "Brand-yellow market line sweeping out of top-left",
    params: {
      variant: "corner_swoosh",
      size: { width: 1200, height: 628 },
      intensity: 0.45,
      color: "#F5C518",
      seed: 0, // forces TL corner via `seed % 4 === 0`
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:market-lines", "intent:directional"],
  },
  {
    recipe: "fx-market-lines-br",
    recommended_use: "Brand-yellow market line sweeping out of bottom-right",
    params: {
      variant: "corner_swoosh",
      size: { width: 1200, height: 628 },
      intensity: 0.45,
      color: "#F5C518",
      seed: 2, // forces BR corner
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:market-lines", "intent:directional"],
  },
  {
    recipe: "fx-particles-grain",
    recommended_use: "Subtle film grain — adds texture to flat gradients",
    params: {
      variant: "noise_grain",
      size: { width: 1200, height: 628 },
      intensity: 0.18,
      seed: 5005,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:particles", "intent:texture"],
  },
  {
    recipe: "fx-glass-light-ray",
    recommended_use: "Diagonal light ray — glass / premium reflection feel",
    params: {
      variant: "light_ray",
      size: { width: 1200, height: 628 },
      intensity: 0.4,
      color: "#FFFFFF",
      seed: 5006,
      source_mode: "generated_only",
      brand_input_element_paths: [],
    },
    extraTags: ["effect:glass-reflection", "intent:premium"],
  },
];

const TUI_RECIPES: Array<{
  recipe: string;
  recommended_use: string;
  params: TradingUiParams;
  extraTags?: string[];
}> = [
  {
    recipe: "tui-candle-up",
    recommended_use: "Bullish candle chart hero",
    params: {
      variant: "candle_chart",
      size: { width: 720, height: 480 },
      ticker: "AAPL",
      seed: 7001,
      trend: "up",
    },
    extraTags: ["widget:candle-chart", "trend:up"],
  },
  {
    recipe: "tui-watchlist",
    recommended_use: "Multi-ticker watchlist strip — works as bottom band",
    params: {
      variant: "ticker_strip",
      size: { width: 1200, height: 96 },
      seed: 7002,
    },
    extraTags: ["widget:watchlist", "shape:strip"],
  },
  {
    recipe: "tui-etf-card",
    recommended_use: "ETF price card (e.g. VTI / IWDA / SPY)",
    params: {
      variant: "price_card",
      size: { width: 480, height: 320 },
      ticker: "VTI",
      seed: 7003,
      trend: "up",
    },
    extraTags: ["widget:etf-card", "shape:card"],
  },
  {
    recipe: "tui-portfolio-donut",
    recommended_use: "Portfolio composition / allocation card",
    params: {
      variant: "portfolio_donut",
      size: { width: 480, height: 480 },
      seed: 7004,
    },
    extraTags: ["widget:portfolio-card", "shape:square"],
  },
  {
    recipe: "tui-market-ticker",
    recommended_use: "Indices / market-open ticker strip",
    params: {
      variant: "ticker_strip",
      size: { width: 1200, height: 80 },
      seed: 7005,
    },
    extraTags: ["widget:market-ticker", "shape:strip"],
  },
  {
    recipe: "tui-order-ticket",
    recommended_use: "Pseudo order-ticket card (price + change)",
    params: {
      variant: "price_card",
      size: { width: 520, height: 320 },
      ticker: "TSLA",
      seed: 7006,
      trend: "down",
    },
    extraTags: ["widget:order-ticket", "shape:card"],
  },
  {
    recipe: "tui-futures-panel",
    recommended_use: "Futures-style candle panel (e.g. ES, NQ)",
    params: {
      variant: "candle_chart",
      size: { width: 720, height: 480 },
      ticker: "ES",
      seed: 7007,
      trend: "down",
    },
    extraTags: ["widget:futures-panel", "trend:down"],
  },
  {
    recipe: "tui-forex-pair",
    recommended_use: "Forex pair price card (e.g. EUR/USD)",
    params: {
      variant: "price_card",
      size: { width: 480, height: 320 },
      ticker: "EURUSD",
      seed: 7008,
      trend: "up",
    },
    extraTags: ["widget:forex-pair", "shape:card"],
  },
];

const MOCKUP_RECIPES: Array<{
  recipe: string;
  recommended_use: string;
  params: MockupParams;
  extraTags?: string[];
}> = [
  {
    recipe: "mock-phone-1-stocks",
    recommended_use: "Phone with stock app screenshot",
    params: {
      device: "phone",
      mockup_path: "/brand-input-preview/mockups/iphone-1.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/apple_stock_mobileapp.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:phone", "context:stocks"],
  },
  {
    recipe: "mock-phone-2-order-dialog",
    recommended_use: "Phone with order dialog",
    params: {
      device: "phone",
      mockup_path: "/brand-input-preview/mockups/iphone-2.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/order-dialog-light.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:phone", "context:order-flow"],
  },
  {
    recipe: "mock-phone-3-asml",
    recommended_use: "Phone with single-stock detail (ASML)",
    params: {
      device: "phone",
      mockup_path: "/brand-input-preview/mockups/iphone-3.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/asml_holding.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:phone", "context:single-stock"],
  },
  {
    recipe: "mock-laptop-1-desktop",
    recommended_use: "Laptop with full desktop platform screenshot",
    params: {
      device: "laptop",
      mockup_path: "/brand-input-preview/mockups/mockup-macbook.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/desktop2.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:laptop", "context:desktop-platform"],
  },
  {
    recipe: "mock-tablet-1-charts",
    recommended_use: "Tablet with order-dialog screenshot (charts context)",
    params: {
      device: "tablet",
      mockup_path: "/brand-input-preview/mockups/ipad-3.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/order-dialog-light.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:tablet", "context:charts"],
  },
  {
    recipe: "mock-tablet-2-signin",
    recommended_use: "Tablet with sign-in / onboarding screen",
    params: {
      device: "tablet",
      mockup_path: "/brand-input-preview/mockups/ipad-4.png",
      screenshot_path:
        "/brand-input-preview/platform_screenshots/application_signin_page.png",
      source_mode: "brand_input_only",
    },
    extraTags: ["device:tablet", "context:onboarding"],
  },
];

// ── Helper that runs one recipe through its generator + persistAsset ────────
async function buildOne<P>(
  generator: (p: unknown, ctx: { cwd: string; brandKit: import("@/lib/generators").BrandKitLite }) => Promise<GenerateResult>,
  params: P,
  ctx: { cwd: string; brandKit: import("@/lib/generators").BrandKitLite },
  packTags: string[],
  recipe: string,
  recommended_use: string,
): Promise<BuiltAsset> {
  const result = await generator(params, ctx);
  result.tags = [...(result.tags ?? []), ...packTags, "pack:mexem-v1", `recipe:${recipe}`];
  const asset = await persistAsset({ result });
  return { asset, recipe, recommended_use };
}

async function main() {
  const brandKit = await loadBrandKit();
  const ctx = { cwd: process.cwd(), brandKit };
  console.log("Building MEXEM Pack v1");
  console.log("─".repeat(72));

  const built: BuiltAsset[] = [];
  const failed: Array<{ recipe: string; reason: string }> = [];

  async function runBatch<P, R extends { recipe: string; recommended_use: string; params: P; extraTags?: string[] }>(
    label: string,
    recipes: R[],
    generator: (p: unknown, ctx: { cwd: string; brandKit: import("@/lib/generators").BrandKitLite }) => Promise<GenerateResult>,
  ) {
    console.log(`\n${label} (${recipes.length}):`);
    for (const r of recipes) {
      try {
        const b = await buildOne(generator, r.params, ctx, r.extraTags ?? [], r.recipe, r.recommended_use);
        built.push(b);
        console.log(`  ✓ ${r.recipe.padEnd(38)} → ${b.asset.id}`);
      } catch (err) {
        const reason = (err as Error).message;
        failed.push({ recipe: r.recipe, reason });
        console.log(`  ✗ ${r.recipe.padEnd(38)} → ${reason.slice(0, 80)}`);
      }
    }
  }

  await runBatch("Backgrounds", BG_RECIPES, generateBackground);
  await runBatch("CTAs", CTA_RECIPES, generateCta);
  await runBatch("FX overlays", FX_RECIPES, generateFxOverlay);
  await runBatch("Trading UI", TUI_RECIPES, generateTradingUi);
  await runBatch("Mockups", MOCKUP_RECIPES, generateMockup);

  // ── Summary table ────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(110));
  console.log("MEXEM Pack v1 — summary");
  console.log("═".repeat(110));
  const header = ["id", "type", "variant", "size", "tags", "recommended use"];
  const rows = built.map((b) => [
    b.asset.id,
    b.asset.type,
    b.asset.variant,
    `${b.asset.size.width}×${b.asset.size.height}`,
    (b.asset.tags ?? []).filter((t) => !t.startsWith("recipe:")).join(", "),
    b.recommended_use,
  ]);
  printTable(header, rows);

  // ── Persist a manifest of the pack so the showcase script can find ids ──
  const manifestPath = path.join(process.cwd(), "data", "mexem-pack-v1.generated.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        pack_id: "mexem-v1",
        built: built.map((b) => ({
          id: b.asset.id,
          type: b.asset.type,
          variant: b.asset.variant,
          recipe: b.recipe,
          recommended_use: b.recommended_use,
          tags: b.asset.tags,
          approved: b.asset.approved,
        })),
        failed,
      },
      null,
      2,
    ) + "\n",
  );

  // ── QA: counts by type / approved ───────────────────────────────────────
  const counts: Record<string, number> = {};
  for (const b of built) counts[b.asset.type] = (counts[b.asset.type] ?? 0) + 1;
  console.log("\nCounts by type:");
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(14)} ${n}`);
  const unapproved = built.filter((b) => b.asset.approved === false);
  console.log(`Approved: ${built.length - unapproved.length}/${built.length}`);
  if (failed.length > 0) {
    console.log(`Failed:   ${failed.length}`);
    for (const f of failed) console.log(`  · ${f.recipe}: ${f.reason}`);
  }
  console.log(`Manifest: ${path.relative(process.cwd(), manifestPath)}`);
}

function printTable(header: string[], rows: string[][]) {
  // Truncate noisy columns so the table stays readable.
  const TRUNC: Record<number, number> = { 0: 26, 4: 32, 5: 36 };
  const cells = [header, ...rows].map((row) =>
    row.map((c, i) => {
      const t = TRUNC[i] ?? 0;
      if (t > 0 && c.length > t) return c.slice(0, t - 1) + "…";
      return c;
    }),
  );
  const widths = header.map((_, col) => Math.max(...cells.map((r) => r[col].length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(cells[0]));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (let i = 1; i < cells.length; i++) console.log(fmt(cells[i]));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
