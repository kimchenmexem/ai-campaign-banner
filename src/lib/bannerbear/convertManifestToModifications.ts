import { z } from "zod";
import {
  BannerbearModificationSchema,
  type BannerbearModification,
} from "@/lib/schemas/bannerbear.schema";
import type {
  Element,
  ElementManifest,
} from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Element Manifest → Bannerbear modifications.
//
// One-way: read the manifest, emit modifications. Bannerbear's response is
// never converted back into manifest fields. The manifest is the source of
// truth.
//
// Layer name resolution priority (per element):
//   1. element.bannerbear.layer_name        (explicit, demo-authored)
//   2. role-based fallback                  (matches the template-design contract)
// CTAs are special: they emit two modifications when both
// `text_layer_name` + `button_layer_name` are present.
//
// Returns the modifications plus a diagnostics object so callers can surface
// missing/skipped layers without re-walking the manifest.
// ─────────────────────────────────────────────────────────────────────────────

// Role → canonical Bannerbear layer name. Used when the element's
// `bannerbear` block is missing or doesn't name a layer.
const ROLE_TO_LAYER: Record<string, string> = {
  background: "background_image",
  logo: "brand_logo",
  "hero-image": "product_mockup",
  "supporting-image": "product_mockup",
  product_visual: "product_mockup",
  headline: "headline",
  subheadline: "subheadline",
  cta: "cta_text",
  "legal-disclaimer": "disclaimer",
  // decorative slots: assigned in order (decorative_1, decorative_2)
};

const TEXT_ROLES = new Set([
  "headline",
  "subheadline",
  "body",
  "cta",
  "legal-disclaimer",
]);

const IMAGE_ROLES = new Set([
  "background",
  "logo",
  "hero-image",
  "supporting-image",
  "product_visual",
  "decorative",
]);

export const ConversionDiagnosticsSchema = z.object({
  mapped_layers: z.array(z.string()),
  missing_layers: z.array(z.string()),
  local_url_errors: z.array(z.string()),
  unsupported_properties: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ConversionDiagnostics = z.infer<typeof ConversionDiagnosticsSchema>;

export interface ConversionResult {
  modifications: BannerbearModification[];
  diagnostics: ConversionDiagnostics;
}

/**
 * Public-only URL guard. Bannerbear renders fetch image URLs server-side, so
 * relative paths and `file://` URLs would fail with a confusing 422 from
 * Bannerbear. Catch them up front with a clear message.
 */
function ensurePublicUrl(url: string | undefined, layerName: string): string {
  if (!url) {
    throw new Error(`No file_url on element targeting layer "${layerName}".`);
  }
  if (url.startsWith("/") || url.startsWith("file://")) {
    throw new Error(
      `Bannerbear requires public URLs (got "${url}" for layer "${layerName}"). ` +
        "Run `npm run cloudinary:upload-all` and `npm run preview:demo`, then retry.",
    );
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`Unsupported file_url scheme for layer "${layerName}": ${url}`);
  }
  return url;
}

interface DecorativeCounter {
  next: number; // 0 → decorative_1, 1 → decorative_2, then stop
}

/**
 * Convert one Element to zero, one, or two Bannerbear modifications.
 * - Background, logo, image elements         → 1 image_url modification
 * - Text elements (headline/subheadline/etc) → 1 text modification
 * - CTA element with both layer names        → 2 modifications (button + text)
 * - Decorative shapes                        → 1 modification (color), capped at 2
 * Elements with `bannerbear.modification_type === "none"` are skipped.
 */
export function convertElementToModifications(
  el: Element,
  diagnostics: ConversionDiagnostics,
  decorativeCounter: DecorativeCounter,
): BannerbearModification[] {
  const out: BannerbearModification[] = [];
  const bb = el.bannerbear;

  // Skip explicit opt-outs.
  if (bb?.modification_type === "none") return [];

  // ── CTA: emit two modifications when both layer names are present. ───────
  if (bb?.button_layer_name && bb?.text_layer_name && el.role === "cta") {
    if (el.background_color) {
      const buttonMod = BannerbearModificationSchema.parse({
        name: bb.button_layer_name,
        background_color: el.background_color,
      });
      out.push(buttonMod);
      diagnostics.mapped_layers.push(bb.button_layer_name);
    } else {
      diagnostics.warnings.push(
        `CTA element "${el.id}" has no background_color — skipping ${bb.button_layer_name}.`,
      );
    }
    if (el.text) {
      const textMod = BannerbearModificationSchema.parse({
        name: bb.text_layer_name,
        text: el.text,
        ...(el.color ? { color: el.color } : {}),
      });
      out.push(textMod);
      diagnostics.mapped_layers.push(bb.text_layer_name);
    } else {
      diagnostics.missing_layers.push(bb.text_layer_name);
    }
    return out;
  }

  // ── Resolve a single layer name. ─────────────────────────────────────────
  let layerName = bb?.layer_name;
  if (!layerName) {
    if (el.role === "decorative") {
      const slot = decorativeCounter.next;
      if (slot >= 2) {
        diagnostics.warnings.push(
          `Element "${el.id}" is decorative but only 2 decorative_* slots exist — dropped.`,
        );
        return [];
      }
      decorativeCounter.next += 1;
      layerName = `decorative_${slot + 1}`;
    } else {
      layerName = ROLE_TO_LAYER[el.role];
    }
  }
  if (!layerName) {
    diagnostics.warnings.push(
      `Element "${el.id}" (role=${el.role}) has no Bannerbear mapping — skipped.`,
    );
    return [];
  }

  // ── Image elements. ──────────────────────────────────────────────────────
  if (
    bb?.modification_type === "image_url" ||
    IMAGE_ROLES.has(el.role) ||
    el.type === "background" ||
    el.type === "logo" ||
    el.type === "image"
  ) {
    const url = ensurePublicUrl(el.file_url, layerName);
    const mod = BannerbearModificationSchema.parse({
      name: layerName,
      image_url: url,
    });
    out.push(mod);
    diagnostics.mapped_layers.push(layerName);
    return out;
  }

  // ── Text elements. ───────────────────────────────────────────────────────
  if (
    bb?.modification_type === "text" ||
    TEXT_ROLES.has(el.role) ||
    el.type === "text" ||
    el.type === "legal" ||
    typeof el.text === "string"
  ) {
    if (!el.text) {
      diagnostics.warnings.push(
        `Element "${el.id}" maps to "${layerName}" but has no text — skipped.`,
      );
      diagnostics.missing_layers.push(layerName);
      return [];
    }
    const mod = BannerbearModificationSchema.parse({
      name: layerName,
      text: el.text,
      ...(el.color ? { color: el.color } : {}),
    });
    out.push(mod);
    diagnostics.mapped_layers.push(layerName);

    // Note typography fields the manifest holds but Bannerbear doesn't
    // accept — keeps future renderers honest about what got dropped.
    const dropped: string[] = [];
    if (el.font_family) dropped.push("font_family");
    if (el.font_size) dropped.push("font_size");
    if (el.line_height) dropped.push("line_height");
    if (el.letter_spacing) dropped.push("letter_spacing");
    if (el.text_align) dropped.push("text_align");
    if (dropped.length > 0) {
      diagnostics.unsupported_properties.push(
        `${layerName}: ${dropped.join(",")}`,
      );
    }
    return out;
  }

  // ── Color/shape (e.g. background-as-shape with a solid color). ───────────
  if (bb?.modification_type === "color" && el.color) {
    const mod = BannerbearModificationSchema.parse({
      name: layerName,
      color: el.color,
    });
    out.push(mod);
    diagnostics.mapped_layers.push(layerName);
    return out;
  }
  if (bb?.modification_type === "background_color" && el.background_color) {
    const mod = BannerbearModificationSchema.parse({
      name: layerName,
      background_color: el.background_color,
    });
    out.push(mod);
    diagnostics.mapped_layers.push(layerName);
    return out;
  }

  diagnostics.warnings.push(
    `Element "${el.id}" (role=${el.role}, type=${el.type}) didn't match any branch — skipped.`,
  );
  return [];
}

/**
 * Walk the manifest in z-index order, emit modifications, accumulate
 * diagnostics. Catches `ensurePublicUrl` errors and records them under
 * `local_url_errors` so the caller can decide whether to abort the render
 * or proceed with what it has.
 */
export function convertElementManifestToBannerbearModifications(
  manifest: ElementManifest,
): ConversionResult {
  const diagnostics: ConversionDiagnostics = {
    mapped_layers: [],
    missing_layers: [],
    local_url_errors: [],
    unsupported_properties: [],
    warnings: [],
  };
  const decorativeCounter: DecorativeCounter = { next: 0 };
  const ordered = [...manifest.elements].sort((a, b) => a.z_index - b.z_index);

  const modifications: BannerbearModification[] = [];
  for (const el of ordered) {
    if (!el.visible) continue;
    try {
      const mods = convertElementToModifications(el, diagnostics, decorativeCounter);
      for (const m of mods) modifications.push(m);
    } catch (err) {
      diagnostics.local_url_errors.push((err as Error).message);
    }
  }

  return { modifications, diagnostics };
}

// Legacy compat for callers that just want the modifications array.
export function convertManifestToModifications(
  manifest: ElementManifest,
): BannerbearModification[] {
  return convertElementManifestToBannerbearModifications(manifest).modifications;
}

export function convertElementToModification(
  el: Element,
): BannerbearModification | null {
  const diagnostics: ConversionDiagnostics = {
    mapped_layers: [],
    missing_layers: [],
    local_url_errors: [],
    unsupported_properties: [],
    warnings: [],
  };
  const decorativeCounter: DecorativeCounter = { next: 0 };
  const mods = convertElementToModifications(el, diagnostics, decorativeCounter);
  return mods[0] ?? null;
}
