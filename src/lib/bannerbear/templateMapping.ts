import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const BannerbearTemplateLayerSchema = z.object({
  layerName: z.string().min(1),
  role: z.enum(["headline", "subheadline", "body", "cta", "logo", "image", "background", "other"]),
});
export type BannerbearTemplateLayer = z.infer<typeof BannerbearTemplateLayerSchema>;

export const BannerbearTemplateEntrySchema = z.object({
  channel: z.string().min(1),
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  templateUid: z.string().min(1),
  // Convention: BANNERBEAR_TEMPLATE_<W>x<H>. Listed explicitly here so the
  // file is self-documenting; the resolver checks process.env first regardless.
  envVar: z.string().optional(),
  layers: z.array(BannerbearTemplateLayerSchema).default([]),
});
export type BannerbearTemplateEntry = z.infer<typeof BannerbearTemplateEntrySchema>;

export const BannerbearTemplateMapSchema = z.object({
  version: z.string().min(1),
  notes: z.string().optional(),
  entries: z.array(BannerbearTemplateEntrySchema).default([]),
});
export type BannerbearTemplateMap = z.infer<typeof BannerbearTemplateMapSchema>;

export const DEFAULT_TEMPLATE_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "bannerbear-template-map.example.json",
);

/**
 * Read and validate a Bannerbear template map JSON file. Returns null when
 * the file does not exist (intake should still succeed without it).
 */
export async function loadBannerbearTemplateMap(
  filePath: string = DEFAULT_TEMPLATE_MAP_PATH,
): Promise<BannerbearTemplateMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return BannerbearTemplateMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Format → UID resolution ──────────────────────────────────────────────────
export const SUPPORTED_FORMATS = ["1200x628", "1080x1080", "1080x1920"] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

export function isSupportedFormat(s: string): s is SupportedFormat {
  return (SUPPORTED_FORMATS as readonly string[]).includes(s);
}

const ENV_KEY_BY_FORMAT: Record<SupportedFormat, string> = {
  "1200x628": "BANNERBEAR_TEMPLATE_1200x628",
  "1080x1080": "BANNERBEAR_TEMPLATE_1080x1080",
  "1080x1920": "BANNERBEAR_TEMPLATE_1080x1920",
};

function isPlaceholder(uid: string | undefined | null): boolean {
  return !uid || uid.startsWith("REPLACE_WITH");
}

export interface ResolvedTemplate {
  format: SupportedFormat;
  template_uid: string;
  source: "env" | "template_map";
}

/**
 * Resolve a Bannerbear template UID for one ad format. Tries env vars first,
 * then the template map JSON. Throws when nothing valid is found.
 *
 * Placeholder values starting with "REPLACE_WITH" are treated as missing.
 */
export async function getBannerbearTemplateUidForFormat(
  format: SupportedFormat,
): Promise<ResolvedTemplate> {
  // 1. Env var.
  const envKey = ENV_KEY_BY_FORMAT[format];
  const envUid = process.env[envKey];
  if (envUid && !isPlaceholder(envUid)) {
    return { format, template_uid: envUid, source: "env" };
  }

  // 2. Template map fallback — match by size only (channel is informational).
  const map = await loadBannerbearTemplateMap();
  if (map) {
    const [w, h] = format.split("x").map(Number);
    const bySize = map.entries.find(
      (e) => e.size.width === w && e.size.height === h && !isPlaceholder(e.templateUid),
    );
    if (bySize) {
      return { format, template_uid: bySize.templateUid, source: "template_map" };
    }
  }

  throw new Error(
    `No Bannerbear template UID for format ${format}. Set ${envKey} in .env.local or update data/bannerbear-template-map.example.json.`,
  );
}

export interface TemplateMapByFormat {
  format: SupportedFormat;
  template_uid: string | null;
  source: "env" | "template_map" | "missing";
  error?: string;
}

/**
 * Resolve all three formats. Each entry reports its UID + source, or `null`
 * + `source: "missing"` + an error message when no valid UID exists. Used by
 * the diagnostics script to render a complete table.
 */
export async function getTemplateMap(): Promise<TemplateMapByFormat[]> {
  const out: TemplateMapByFormat[] = [];
  for (const format of SUPPORTED_FORMATS) {
    try {
      const resolved = await getBannerbearTemplateUidForFormat(format);
      out.push({
        format,
        template_uid: resolved.template_uid,
        source: resolved.source,
      });
    } catch (err) {
      out.push({
        format,
        template_uid: null,
        source: "missing",
        error: (err as Error).message,
      });
    }
  }
  return out;
}

// ── Required + optional layer names ─────────────────────────────────────────
// Source: docs/BANNERBEAR_RENDER_WORKFLOW.md (the template-design contract).
//
// Required layers must exist on every Bannerbear template; rendering fails
// if any are missing. Optional layers improve the result when present (the
// converter emits modifications for them) but a missing optional layer just
// drops the corresponding Element silently.
export const REQUIRED_BANNERBEAR_LAYERS = [
  "background_image",
  "brand_logo",
  "product_mockup",
  "headline",
  "cta_text",
  "disclaimer",
] as const;
export type RequiredBannerbearLayer = (typeof REQUIRED_BANNERBEAR_LAYERS)[number];

export const OPTIONAL_BANNERBEAR_LAYERS = [
  "subheadline",
  "cta_button",
  "powered_by_ib",
  "decorative_1",
  "decorative_2",
] as const;
export type OptionalBannerbearLayer = (typeof OPTIONAL_BANNERBEAR_LAYERS)[number];

export function getRequiredBannerbearLayers(): {
  required: readonly string[];
  optional: readonly string[];
} {
  return {
    required: REQUIRED_BANNERBEAR_LAYERS,
    optional: OPTIONAL_BANNERBEAR_LAYERS,
  };
}

export function findTemplate(
  map: BannerbearTemplateMap,
  channel: string,
  width: number,
  height: number,
): BannerbearTemplateEntry | undefined {
  return map.entries.find(
    (e) => e.channel === channel && e.size.width === width && e.size.height === height,
  );
}
