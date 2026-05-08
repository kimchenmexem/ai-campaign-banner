import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BrandKitLiteSchema,
  type BrandKitLite,
  type AssetTypeKey,
  type AssetTypeRule,
  type Cta,
} from "@/lib/schemas/brandKit.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Brand Kit Lite — load and query helpers.
//
// MVP storage: a single JSON file under data/. Later this moves to Supabase
// (one row per brand). The helpers below take a `BrandKitLite` so callers can
// inject test fixtures without touching disk.
//
// Server-only because the loader uses node:fs. UI surfaces should fetch the
// kit through a route handler that calls loadBrandKit() server-side.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BRAND_KIT_PATH = path.join(
  process.cwd(),
  "data",
  "brand-kit-lite.example.json",
);

/**
 * Load a Brand Kit Lite from disk and validate it. Throws if the file is
 * missing, unparseable, or fails schema validation.
 */
export async function loadBrandKit(
  filePath: string = DEFAULT_BRAND_KIT_PATH,
): Promise<BrandKitLite> {
  const raw = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(raw);
  return validateBrandKit(json);
}

/**
 * Validate an unknown value against BrandKitLiteSchema. Throws ZodError on
 * failure; the parsed kit on success carries every defaulted field filled in.
 */
export function validateBrandKit(input: unknown): BrandKitLite {
  return BrandKitLiteSchema.parse(input);
}

/**
 * Flat list of every approved hex color across primary / secondary / accent /
 * background / text / disclaimer. `forbidden` is excluded by definition.
 * Gradient stop colors are included so the QA layer can check element fills
 * against the full approved palette.
 */
export function getAllowedColors(kit: BrandKitLite): string[] {
  const c = kit.colors;
  const flat = [
    ...c.primary,
    ...c.secondary,
    ...c.accent,
    ...c.background,
    ...c.text,
    ...c.disclaimer,
    ...c.allowed_gradients.flatMap((g) => g.stops.map((s) => s.color)),
  ];
  return Array.from(new Set(flat.map((h) => h.toLowerCase())));
}

/**
 * Distinct list of approved font families (headline + body + cta + disclaimer).
 */
export function getAllowedFonts(kit: BrandKitLite): string[] {
  const f = kit.typography.families;
  return Array.from(new Set([f.headline, f.body, f.cta, f.disclaimer]));
}

/**
 * Default disclaimer string. Returns "" when none is configured — callers
 * must check `kit.legal.risk_warning_required` to decide whether the empty
 * value is acceptable.
 */
export function getDefaultDisclaimer(kit: BrandKitLite): string {
  return kit.legal.default_disclaimer;
}

/**
 * Bannerbear template UIDs (or template names) the brand has approved.
 */
export function getAllowedTemplates(kit: BrandKitLite): string[] {
  return kit.layout.allowed_templates;
}

/**
 * The CTA style block — colors, radius, padding, minimum size, allowed copy.
 */
export function getCtaStyle(kit: BrandKitLite): Cta {
  return kit.cta;
}

/**
 * The complete disclaimer rule set: legal flags plus placement and per-format
 * sizing pulled from typography. Useful for QA.
 */
export function getDisclaimerRules(kit: BrandKitLite) {
  return {
    risk_warning_required: kit.legal.risk_warning_required,
    default_disclaimer: kit.legal.default_disclaimer,
    min_disclaimer_font_size: kit.legal.min_disclaimer_font_size,
    must_appear_in_all_formats: kit.legal.disclaimer_must_appear_in_all_formats,
    legal_claim_rules: kit.legal.legal_claim_rules,
    placement: kit.layout.disclaimer_placement_rules,
    text_rules: kit.typography.disclaimer_text_rules,
    color_palette: kit.colors.disclaimer,
  };
}

/**
 * Lookup the rule for a given asset type. Returns a deny-by-default record
 * when the kit doesn't list the type explicitly, so callers always get a
 * non-null result.
 */
export function getAssetTypeRule(
  kit: BrandKitLite,
  type: AssetTypeKey,
): AssetTypeRule {
  return (
    kit.approved_asset_types?.[type] ?? {
      allowed: false,
      requires_legal_review: true,
      forbidden: [],
    }
  );
}
