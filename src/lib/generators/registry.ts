import type { GeneratorRegistryEntry } from "@/lib/schemas/generatedAsset.schema";
import { defaultPlacementRules } from "@/lib/generators/placement";

// Static registry — the source of truth for what generators exist and what
// each one accepts. The Asset Generator UI calls GET /api/generators/registry
// to populate its tabs without hard-coding labels in the client.

export const GENERATOR_REGISTRY: GeneratorRegistryEntry[] = [
  {
    id: "background",
    type: "background",
    label: "Backgrounds",
    description:
      "Brand-locked backgrounds. Generate from scratch or composite a generated overlay onto a brand-input/background image.",
    variants: [
      "linear_gradient",
      "radial_gradient",
      "mesh_gradient",
      "vignette",
      "diagonal_split",
    ],
    default_size: { width: 1080, height: 1080 },
    output_format: "svg",
    api_path: "/api/generators/background",
    source_modes: ["generated_only", "brand_input_only", "brand_input_plus_generated"],
    default_source_mode: "brand_input_plus_generated",
    output_modes: ["image"],
    default_output_mode: "image",
    brand_input_folders: ["backgrounds", "elements"],
    default_placement_rules: defaultPlacementRules("background"),
  },
  {
    id: "cta",
    type: "cta",
    label: "CTA Buttons",
    description:
      "Renderer-compatible CTA buttons. element mode (default) returns a cta-button Element row a banner can adopt verbatim. svg mode returns a flat SVG download.",
    variants: [
      "primary_pill",
      "primary_block",
      "outline",
      "accent_pill",
      "accent_block",
      "bottom_band",
    ],
    default_size: { width: 480, height: 96 },
    output_format: "svg",
    api_path: "/api/generators/cta",
    source_modes: ["generated_only"],
    default_source_mode: "generated_only",
    output_modes: ["element", "svg"],
    default_output_mode: "element",
    brand_input_folders: [],
    default_placement_rules: defaultPlacementRules("cta"),
  },
  {
    id: "mockup",
    type: "mockup",
    label: "Device Mockups",
    description:
      "Composites a brand-input/Platform screenshot inside a brand-input/mockup devices/ device using the calibrated screen slot (perspective + axis-aligned).",
    variants: ["phone", "tablet", "laptop", "desktop", "smartwatch"],
    default_size: { width: 1600, height: 1200 },
    output_format: "png",
    api_path: "/api/generators/mockup",
    source_modes: ["brand_input_only"],
    default_source_mode: "brand_input_only",
    output_modes: ["composite"],
    default_output_mode: "composite",
    brand_input_folders: ["mockups", "platform_screenshots"],
    default_placement_rules: defaultPlacementRules("mockup"),
  },
  {
    id: "trading_ui",
    type: "trading_ui",
    label: "Trading UI",
    description:
      "Stylised fintech widgets — price cards, candle charts, portfolio donuts, ticker strips. Deterministic SVG. Placement rules limit them to ≤55% of canvas width.",
    variants: ["price_card", "candle_chart", "portfolio_donut", "ticker_strip"],
    default_size: { width: 720, height: 480 },
    output_format: "svg",
    api_path: "/api/generators/trading-ui",
    source_modes: ["generated_only"],
    default_source_mode: "generated_only",
    output_modes: ["image"],
    default_output_mode: "image",
    brand_input_folders: [],
    default_placement_rules: defaultPlacementRules("trading_ui"),
  },
  {
    id: "fx_overlay",
    type: "fx_overlay",
    label: "FX Overlays",
    description:
      "Transparent overlays — glow / vignette / corner swoosh / light ray / grain. Optionally composite atop a brand-input/Elements image. Intensity clamped to 0.7.",
    variants: ["glow", "vignette", "corner_swoosh", "light_ray", "noise_grain"],
    default_size: { width: 1080, height: 1080 },
    output_format: "svg",
    api_path: "/api/generators/fx-overlay",
    source_modes: ["generated_only", "brand_input_plus_generated"],
    default_source_mode: "generated_only",
    output_modes: ["image"],
    default_output_mode: "image",
    brand_input_folders: ["elements", "backgrounds"],
    default_placement_rules: defaultPlacementRules("fx_overlay"),
  },
];

export function findRegistryEntry(
  id: string,
): GeneratorRegistryEntry | undefined {
  return GENERATOR_REGISTRY.find((g) => g.id === id);
}
