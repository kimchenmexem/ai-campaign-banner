import type {
  GeneratedAssetType,
  PlacementRules,
} from "@/lib/schemas/generatedAsset.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Default placement rules per generator type. These describe how the banner
// renderer should position the asset when adopting it into a manifest.
//
// Numbers chosen to match the existing renderer:
//   - z_index 0 / 1   for backgrounds (under everything)
//   - z_index 25-30   for hero/product visuals
//   - z_index 50      for CTA buttons (matches createDemoCampaign el_cta)
//   - z_index 60      for FX overlays (above visuals, below text)
// ─────────────────────────────────────────────────────────────────────────────

export function defaultPlacementRules(
  type: GeneratedAssetType,
  variant?: string,
): PlacementRules {
  switch (type) {
    case "background":
      return {
        compatible_roles: ["background"],
        recommended_z_index: 0,
        safe_area_required: false,
        bleed_allowed: true,
        object_fit: "cover",
        object_position: "center",
        max_width_ratio: 1,
        max_height_ratio: 1,
        preferred_compositions: ["any"],
      };
    case "cta":
      return {
        compatible_roles: ["cta"],
        recommended_z_index: 50,
        safe_area_required: true,
        bleed_allowed: variant === "bottom_band",
        object_fit: "contain",
        object_position: "center",
        min_width: 180,
        min_height: 56,
        max_width_ratio: variant === "bottom_band" ? 1 : 0.8,
        padding_hint: { top: 14, right: 36, bottom: 14, left: 36 },
        preferred_compositions:
          variant === "bottom_band"
            ? ["bottom_band"]
            : ["text_leading", "split_text_visual"],
      };
    case "mockup":
      return {
        compatible_roles: ["product_visual", "hero-image", "supporting-image"],
        recommended_z_index: 30,
        safe_area_required: false,
        bleed_allowed: true,
        object_fit: "contain",
        object_position: "center",
        max_width_ratio: 0.65,
        max_height_ratio: 0.85,
        preferred_compositions: [
          "split_text_visual",
          "hero_left_mockup_right",
          "centered_mockup_with_headline",
        ],
      };
    case "trading_ui":
      return {
        compatible_roles: ["decorative", "supporting-image"],
        recommended_z_index: 35,
        safe_area_required: true,
        bleed_allowed: false,
        object_fit: "contain",
        object_position: "center",
        max_width_ratio: 0.55,
        max_height_ratio: 0.6,
        preferred_compositions: ["split_text_visual"],
      };
    case "fx_overlay":
      return {
        compatible_roles: ["decorative"],
        recommended_z_index: 60,
        safe_area_required: false,
        bleed_allowed: true,
        object_fit: "cover",
        object_position: "center",
        max_width_ratio: 1,
        max_height_ratio: 1,
        preferred_compositions: ["any"],
      };
  }
}
