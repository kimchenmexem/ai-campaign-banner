#!/usr/bin/env tsx
/**
 * Upload code-rendered final PNGs to Cloudinary.
 * Run with: `npm run cloudinary:upload-code-renders [-- --force]`
 *
 * Reads:  data/code-render-map.generated.json
 * Writes: data/cloudinary-code-render-map.generated.json
 *
 * Cloudinary destination: brands/{brand_id}/final-renders/<format>
 * Idempotent: skips records already uploaded successfully unless --force.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { cloudinaryEnvStatus } from "@/lib/cloudinary/client";
import {
  uploadLocalFileToCloudinary,
  createCloudinaryPublicId,
  sanitizePublicIdSegment,
} from "@/lib/cloudinary/upload";

const CODE_RENDER_MAP = path.join(
  process.cwd(),
  "data",
  "code-render-map.generated.json",
);
const OUTPUT_PATH = path.join(
  process.cwd(),
  "data",
  "cloudinary-code-render-map.generated.json",
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
type CloudinaryCodeRenderMap = z.infer<typeof CloudinaryCodeRenderMapSchema>;

async function main() {
  await loadEnvLocalIfPresent();
  const force = process.argv.includes("--force");

  const env = cloudinaryEnvStatus();
  if (!env.cloud_name_present || !env.api_key_present || !env.api_secret_present) {
    console.error("✗ Cloudinary is not configured. Add CLOUDINARY_* to .env.local.");
    console.error(
      "  Run `npm run cloudinary:check` for a presence-only diagnostic (no secrets logged).",
    );
    process.exit(2);
  }

  let map: z.infer<typeof CodeRenderMapSchema>;
  try {
    const raw = await fs.readFile(CODE_RENDER_MAP, "utf8");
    map = CodeRenderMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "✗ data/code-render-map.generated.json not found. Run `npm run render:code-demo` first.",
      );
      process.exit(2);
    }
    throw err;
  }

  const folder = `brands/${map.brand_id}/final-renders`;
  const existing = await loadExistingOutputMap();
  const existingByAdId = new Map(existing?.items.map((it) => [it.ad_id, it]) ?? []);

  const items: z.infer<typeof CloudinaryCodeRenderRecordSchema>[] = [];
  let uploaded = 0,
    skipped = 0,
    failed = 0;

  console.log(
    `Cloudinary code-render upload${force ? " (--force overwrite)" : ""} — ${map.items.length} candidates ...`,
  );

  for (const r of map.items) {
    if (r.status !== "completed" || !r.output_local_path) {
      // Don't try to upload a failed render.
      items.push({
        ad_id: r.ad_id,
        format: r.format,
        local_output_path: r.output_local_path ?? "",
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        width: null,
        height: null,
        format_extension: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "failed",
        upload_error:
          r.error ?? "code render did not complete; nothing to upload",
      });
      failed += 1;
      console.log(`[${r.format}] ✗ skipped — render status=${r.status}`);
      continue;
    }

    const prior = existingByAdId.get(r.ad_id);
    if (
      !force &&
      prior &&
      prior.upload_status === "success" &&
      prior.cloudinary_public_id
    ) {
      items.push({ ...prior, upload_status: "skipped" });
      skipped += 1;
      console.log(`[${r.format}] · skipped (already uploaded)`);
      continue;
    }

    const filename = `${r.format}.png`;
    const publicId = createCloudinaryPublicId({
      folder,
      filename: sanitizePublicIdSegment(filename) + ".png",
    });
    const localAbs = path.resolve(process.cwd(), r.output_local_path);

    try {
      const result = await uploadLocalFileToCloudinary({
        localAbsPath: localAbs,
        publicId,
        tags: [
          `brand:${map.brand_id}`,
          `asset_type:final_render`,
          `source:code_renderer`,
          `format:${r.format}`,
          "preview_ready",
        ],
        overwrite: force,
        context: { brand: map.brand_id, ad_id: r.ad_id, format: r.format },
      });
      items.push({
        ad_id: r.ad_id,
        format: r.format,
        local_output_path: r.output_local_path,
        cloudinary_public_id: result.public_id,
        cloudinary_secure_url: result.secure_url,
        width: result.width ?? r.canvas_width,
        height: result.height ?? r.canvas_height,
        format_extension: result.format,
        bytes: result.bytes,
        uploaded_at: new Date().toISOString(),
        upload_status: "success",
      });
      uploaded += 1;
      console.log(`[${r.format}] ✓ ${result.public_id}`);
    } catch (err) {
      const msg = redact((err as Error).message);
      items.push({
        ad_id: r.ad_id,
        format: r.format,
        local_output_path: r.output_local_path,
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        width: null,
        height: null,
        format_extension: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "failed",
        upload_error: msg,
      });
      failed += 1;
      console.log(`[${r.format}] ✗ ${msg}`);
    }
  }

  const out: CloudinaryCodeRenderMap = CloudinaryCodeRenderMapSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: map.brand_id,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? null,
    folder,
    items,
  });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  total:    ${items.length}`);
  console.log(`  uploaded: ${uploaded}`);
  console.log(`  skipped:  ${skipped}`);
  console.log(`  failed:   ${failed}`);
  console.log("");
  console.log(`✓ Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log(`  Cloudinary folder: ${folder}`);

  if (failed > 0) process.exit(2);
}

async function loadExistingOutputMap(): Promise<CloudinaryCodeRenderMap | null> {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf8");
    return CloudinaryCodeRenderMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function redact(msg: string): string {
  return msg
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/api_secret=[^&\s)]*/gi, "api_secret=[redacted]")
    .replace(/signature=[^&\s)]*/gi, "signature=[redacted]");
}

main().catch((err) => {
  console.error("cloudinary:upload-code-renders failed:", (err as Error).message);
  process.exit(1);
});
