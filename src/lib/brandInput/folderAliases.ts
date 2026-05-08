// ─────────────────────────────────────────────────────────────────────────────
// Brand Input folder alias mapping.
//
// The local `brand-input/` folder uses human-friendly names ("MEXEM logo",
// "Platform screenshot", "mockup devices") that vary in case, spaces, and
// pluralization. This module canonicalizes those names so the rest of the
// pipeline can speak in stable identifiers.
//
// Authoritative mapping for the actual folders that exist today:
//   "background"          → backgrounds          → background
//   "brand-spec"          → brand_spec           → brand_spec_file
//   "Elements"            → elements             → decorative_element
//   "IBKR logo"           → powered_by_ib        → powered_by_ib
//   "MEXEM logo"          → brand_logo           → brand_logo
//   "mockup devices"      → mockups              → mockup
//   "Platform screenshot" → platform_screenshots → platform_screenshot
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalFolderType =
  | "backgrounds"
  | "brand_spec"
  | "elements"
  | "powered_by_ib"
  | "brand_logo"
  | "mockups"
  | "platform_screenshots";

export type AssetType =
  | "background"
  | "brand_spec_file"
  | "decorative_element"
  | "powered_by_ib"
  | "brand_logo"
  | "mockup"
  | "platform_screenshot";

export interface FolderAlias {
  canonical_folder_type: CanonicalFolderType;
  inferred_asset_type: AssetType;
}

// Lower-case, dash-joined keys. Compare against a normalized form of any
// incoming folder name (see `canonicalize` below). Keep both singular and
// plural variants so renames like "mockups" → "mockup" don't break.
const ALIAS_TABLE: Record<string, FolderAlias> = {
  background: { canonical_folder_type: "backgrounds", inferred_asset_type: "background" },
  backgrounds: { canonical_folder_type: "backgrounds", inferred_asset_type: "background" },

  "brand-spec": { canonical_folder_type: "brand_spec", inferred_asset_type: "brand_spec_file" },
  "brand-specs": { canonical_folder_type: "brand_spec", inferred_asset_type: "brand_spec_file" },
  brandspec: { canonical_folder_type: "brand_spec", inferred_asset_type: "brand_spec_file" },

  element: { canonical_folder_type: "elements", inferred_asset_type: "decorative_element" },
  elements: { canonical_folder_type: "elements", inferred_asset_type: "decorative_element" },

  "ibkr-logo": {
    canonical_folder_type: "powered_by_ib",
    inferred_asset_type: "powered_by_ib",
  },
  "ibkr-logos": {
    canonical_folder_type: "powered_by_ib",
    inferred_asset_type: "powered_by_ib",
  },
  "powered-by-ib": {
    canonical_folder_type: "powered_by_ib",
    inferred_asset_type: "powered_by_ib",
  },

  "mexem-logo": { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },
  "mexem-logos": { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },
  "brand-logo": { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },
  "brand-logos": { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },
  logo: { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },
  logos: { canonical_folder_type: "brand_logo", inferred_asset_type: "brand_logo" },

  "mockup-device": { canonical_folder_type: "mockups", inferred_asset_type: "mockup" },
  "mockup-devices": { canonical_folder_type: "mockups", inferred_asset_type: "mockup" },
  mockup: { canonical_folder_type: "mockups", inferred_asset_type: "mockup" },
  mockups: { canonical_folder_type: "mockups", inferred_asset_type: "mockup" },

  "platform-screenshot": {
    canonical_folder_type: "platform_screenshots",
    inferred_asset_type: "platform_screenshot",
  },
  "platform-screenshots": {
    canonical_folder_type: "platform_screenshots",
    inferred_asset_type: "platform_screenshot",
  },
  screenshot: {
    canonical_folder_type: "platform_screenshots",
    inferred_asset_type: "platform_screenshot",
  },
  screenshots: {
    canonical_folder_type: "platform_screenshots",
    inferred_asset_type: "platform_screenshot",
  },
};

// Lower-case, collapse runs of whitespace / underscore / hyphen into a single
// "-". So "MEXEM logo" → "mexem-logo", "mockup_devices" → "mockup-devices",
// "Platform Screenshot " → "platform-screenshot".
function canonicalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Resolve a real folder name (anything from `fs.readdir`) to its canonical
 * type and inferred asset type. Returns null when the folder is unknown so
 * callers can decide whether to skip or warn.
 */
export function resolveFolderAlias(folderName: string): FolderAlias | null {
  const key = canonicalize(folderName);
  return (
    ALIAS_TABLE[key] ??
    ALIAS_TABLE[key.replace(/s$/, "")] ??
    ALIAS_TABLE[key + "s"] ??
    null
  );
}

/**
 * Reverse lookup: canonical type → suggested Cloudinary subfolder under
 * `brands/{brand_id}/`. Used by the asset import plan.
 */
export function suggestedCloudinarySubfolder(
  canonical: CanonicalFolderType,
): string | null {
  switch (canonical) {
    case "brand_logo":
      return "logos";
    case "powered_by_ib":
      return "powered-by-ib";
    case "backgrounds":
      return "backgrounds";
    case "platform_screenshots":
      return "screenshots";
    case "mockups":
      return "mockups";
    case "elements":
      return "elements";
    case "brand_spec":
      return null; // brand-spec files do not get uploaded to Cloudinary
    default:
      return null;
  }
}
