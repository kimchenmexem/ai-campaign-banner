import type { Element } from "@/lib/schemas/elementManifest.schema";
import type {
  GeneratedAsset,
  GeneratedAssetType,
  GeneratedAssetFormat,
  PlacementRules,
  RenderMode,
  SourceAssetRef,
} from "@/lib/schemas/generatedAsset.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Generator contract.
//
// Every concrete generator (background, cta, mockup, trading-ui, fx-overlay)
// implements a `generate(params, ctx)` function that returns the bytes plus
// enough metadata for the storage layer to write a GeneratedAsset row.
//
// Generators do NOT touch the filesystem themselves — the API route hands the
// bytes to `storage.persistAsset()` so writes are centralised.
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateContext {
  // Project working directory (process.cwd() in production). Tests can pass a
  // tmp dir to keep their writes isolated.
  cwd: string;
  // Resolved brand kit (already loaded by the route).
  brandKit: BrandKitLite;
}

export interface GenerateResult {
  type: GeneratedAssetType;
  variant: string;
  format: GeneratedAssetFormat;
  size: { width: number; height: number };
  // The exact bytes that will be written under
  //   public/generated-assets/<type>/<id>.<ext>
  bytes: Buffer;
  // The validated params blob the caller submitted, recorded verbatim on the
  // GeneratedAsset row so a reader can reproduce the asset later.
  params: Record<string, unknown>;
  brand_token_refs: string[];
  generator: string;
  seed: number;
  tags?: string[];
  notes?: string;
  // ── v2 compatibility fields ────────────────────────────────────────────
  // How a banner renderer should consume the bytes. Defaults to "image" when
  // the generator omits it.
  render_mode?: RenderMode;
  // Renderer-compatible placement defaults. Defaults to
  // `defaultPlacementRules(type, variant)` when the generator omits it.
  placement_rules?: PlacementRules;
  // Provenance — every brand-input file or upstream generated asset this
  // generation pulled from. Empty when the asset is fully synthetic.
  source_assets?: SourceAssetRef[];
  // For element-mode CTAs (and future element-mode generators): the canonical
  // ElementManifest row a banner builder should adopt verbatim. Validated
  // against the same Element schema as a real manifest entry.
  element_manifest_preview?: Element;
}

export type GeneratedAssetWithoutIo = Omit<
  GeneratedAsset,
  "id" | "file_path" | "url" | "created_at"
>;

// Tiny structural type for the slice of brand-kit-lite the generators need.
// Keeping this narrow lets us avoid importing the much bigger brandKit schema
// here and keeps the generators portable.
export interface BrandKitLite {
  brand_id: string;
  colors: {
    primary: string[];
    accent: string[];
    background: string[];
    text: string[];
  };
  typography?: {
    families?: { headline?: string; body?: string; cta?: string };
    line_heights?: { headline?: number; body?: number; cta?: number; disclaimer?: number };
    letter_spacing?: { headline?: number; body?: number; cta?: number; disclaimer?: number };
  };
  cta?: {
    button_background_color?: string;
    button_text_color?: string;
    border_radius?: number;
    padding?: { top?: number; right?: number; bottom?: number; left?: number };
    minimum_size?: { width?: number; height?: number };
    allowed_texts?: string[];
  };
}
