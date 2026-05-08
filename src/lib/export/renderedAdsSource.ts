import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  RenderAdResultSchema,
  type RenderAdResult,
} from "@/lib/bannerbear/renderAd";

// ─────────────────────────────────────────────────────────────────────────────
// Resolves the *preferred* final rendered ad per ad_id, picking from the
// renderer outputs we have on disk:
//   1. code-rendered PNGs        (data/code-render-map.generated.json)
//   2. Bannerbear renders        (data/bannerbear-render-map.generated.json)
//   3. local preview path        (last-resort fallback — useful for the
//                                 export ZIP stage to bundle something rather
//                                 than nothing)
//
// The Element Manifest is the source of truth. The PNGs returned here are
// flat snapshots. A future ZIP exporter and any `/render/...` consumer can
// share this resolver instead of duplicating the priority order.
// ─────────────────────────────────────────────────────────────────────────────

const CODE_RENDER_MAP = path.join(
  process.cwd(),
  "data",
  "code-render-map.generated.json",
);
const CLOUDINARY_CODE_MAP = path.join(
  process.cwd(),
  "data",
  "cloudinary-code-render-map.generated.json",
);
const BANNERBEAR_RENDER_MAP = path.join(
  process.cwd(),
  "data",
  "bannerbear-render-map.generated.json",
);

const CodeRenderRecordSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  canvas_width: z.number().int().positive(),
  canvas_height: z.number().int().positive(),
  output_local_path: z.string().nullable(),
  output_public_path: z.string().nullable(),
  status: z.enum(["completed", "failed"]),
  rendered_at: z.string(),
  source: z.literal("code_renderer"),
  element_manifest_hash: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
const CodeRenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  base_url: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(CodeRenderRecordSchema),
});

const CloudinaryCodeRenderRecordSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  local_output_path: z.string(),
  cloudinary_public_id: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  format_extension: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  uploaded_at: z.string().nullable(),
  upload_status: z.enum(["success", "skipped", "failed"]),
  upload_error: z.string().optional(),
});
const CloudinaryCodeRenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  cloud_name: z.string().nullable(),
  folder: z.string(),
  items: z.array(CloudinaryCodeRenderRecordSchema),
});

const BannerbearRenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(RenderAdResultSchema),
});

export type RenderedSource = "code_renderer" | "bannerbear" | "local_preview";

export interface PreferredRenderedAd {
  ad_id: string;
  format: string;
  source: RenderedSource;
  // The URL a consumer should fetch. Cloudinary URL when available, else a
  // local public_path under public/.
  url: string;
  // True when `url` is a Cloudinary secure_url, false when it's a local path.
  cloudinary: boolean;
  // Where to find the file on disk (for ZIP export). Null for Cloudinary-only.
  local_output_path: string | null;
  // Identity bag a downstream tool can use for filenames / index entries.
  width: number | null;
  height: number | null;
  bytes: number | null;
  rendered_at: string | null;
  // For diagnostics — which other renderers produced output for this ad.
  also_available: RenderedSource[];
  notes?: string;
}

async function loadJsonOrNull<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Walk every ad in `ad_ids` and return the highest-priority rendered output
 * we have on disk. Pass an empty array (default) to get one entry per
 * unique ad_id seen across all renderer maps.
 */
export async function getPreferredRenderedAds(
  ad_ids: string[] = [],
): Promise<PreferredRenderedAd[]> {
  const codeMap = await loadJsonOrNull(CODE_RENDER_MAP, CodeRenderMapSchema);
  const cloudCodeMap = await loadJsonOrNull(
    CLOUDINARY_CODE_MAP,
    CloudinaryCodeRenderMapSchema,
  );
  const bbMap = await loadJsonOrNull(BANNERBEAR_RENDER_MAP, BannerbearRenderMapSchema);

  const codeByAd = new Map<string, z.infer<typeof CodeRenderRecordSchema>>();
  for (const r of codeMap?.items ?? []) codeByAd.set(r.ad_id, r);
  const cloudByAd = new Map<string, z.infer<typeof CloudinaryCodeRenderRecordSchema>>();
  for (const r of cloudCodeMap?.items ?? []) cloudByAd.set(r.ad_id, r);
  const bbByAd = new Map<string, RenderAdResult>();
  for (const r of bbMap?.items ?? []) bbByAd.set(r.ad_id, r);

  const allAdIds =
    ad_ids.length > 0
      ? ad_ids
      : Array.from(
          new Set([
            ...codeByAd.keys(),
            ...bbByAd.keys(),
            ...cloudByAd.keys(),
          ]),
        );

  const out: PreferredRenderedAd[] = [];
  for (const ad_id of allAdIds) {
    const code = codeByAd.get(ad_id);
    const cloud = cloudByAd.get(ad_id);
    const bb = bbByAd.get(ad_id);
    const also: RenderedSource[] = [];
    if (code?.status === "completed") also.push("code_renderer");
    if (bb?.status === "completed") also.push("bannerbear");

    // 1. Code render (Cloudinary URL preferred when uploaded).
    if (code?.status === "completed" && code.output_public_path) {
      const cloudUrl = cloud?.cloudinary_secure_url ?? null;
      out.push({
        ad_id,
        format: code.format,
        source: "code_renderer",
        url: cloudUrl ?? code.output_public_path,
        cloudinary: !!cloudUrl,
        local_output_path: code.output_local_path,
        width: code.canvas_width,
        height: code.canvas_height,
        bytes: code.bytes,
        rendered_at: code.rendered_at,
        also_available: also.filter((s) => s !== "code_renderer"),
        notes: cloudUrl ? "delivered via Cloudinary" : undefined,
      });
      continue;
    }

    // 2. Bannerbear render.
    if (bb?.status === "completed" && bb.final_render_url) {
      out.push({
        ad_id,
        format: bb.format,
        source: "bannerbear",
        url: bb.final_render_url,
        cloudinary: bb.final_render_url.startsWith("https://res.cloudinary.com/"),
        local_output_path: null,
        width: null,
        height: null,
        bytes: null,
        rendered_at: bb.rendered_at,
        also_available: also.filter((s) => s !== "bannerbear"),
      });
      continue;
    }

    // 3. Last-resort local preview. The exporter would skip this; it's here
    //    so callers can still report "no final render" in a structured way.
    out.push({
      ad_id,
      format: code?.format ?? bb?.format ?? "unknown",
      source: "local_preview",
      url: "",
      cloudinary: false,
      local_output_path: null,
      width: code?.canvas_width ?? null,
      height: code?.canvas_height ?? null,
      bytes: null,
      rendered_at: null,
      also_available: also,
      notes: "no completed renders found; consult /visual-preview",
    });
  }
  return out;
}
