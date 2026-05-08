import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getCloudinary } from "@/lib/cloudinary/client";
import {
  AssetImportPlanSchema,
  type AssetImportPlan,
  type AssetImportPlanItem,
} from "@/lib/brandInput/createAssetImportPlan";
import {
  MockupCompositeMapSchema,
  type MockupCompositeMap,
  type AssetCompositeRecord,
} from "@/lib/preview/composeMockupPreview";

// ─────────────────────────────────────────────────────────────────────────────
// Cloudinary upload helpers.
//
// Two bulk pipelines, both idempotent:
//   - uploadAssetImportPlan()   — uploads files listed in
//                                  data/asset-import-plan.generated.json
//   - uploadMockupComposites()  — uploads PNGs listed in
//                                  data/mockup-composite-map.generated.json
//
// Idempotency contract: the bulk pipelines read their corresponding output
// map (cloudinary-asset-map / cloudinary-composite-map) and skip any record
// that already has upload_status === "success" with the same local path,
// unless `force: true` is passed.
//
// Cloudinary is asset storage. The Element Manifest is still the source of
// truth — composite_refs and original_*_path fields preserve the inputs so
// future renderers can re-composite without depending on Cloudinary.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"] as const;
export type SupportedImageExtension = (typeof SUPPORTED_IMAGE_EXTENSIONS)[number];

export function isSupportedImageExtension(ext: string): boolean {
  return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function inferCloudinaryResourceType(filename: string): "image" | "raw" {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return isSupportedImageExtension(ext) ? "image" : "raw";
}

// ── public_id construction ───────────────────────────────────────────────────
// Cloudinary public_ids must be URL-safe and stable. We sanitize the basename
// the same way the local preview copier does (lowercase, replace non
// [a-z0-9._-] with `-`, collapse repeated `-`, strip leading/trailing dots).
export function sanitizePublicIdSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\.[^.]+$/, ""); // strip the file extension (Cloudinary adds it back)
}

export interface CreatePublicIdInput {
  // Suggested folder, e.g. "brands/brand_001/logos/" — trailing slash optional.
  folder: string;
  // Original filename (basename only, with extension).
  filename: string;
}

/**
 * Build a deterministic Cloudinary public_id from a folder + filename. The
 * folder is preserved as a prefix; the filename is sanitized and the
 * extension stripped.
 */
export function createCloudinaryPublicId(input: CreatePublicIdInput): string {
  const folder = input.folder.replace(/\/+$/, "");
  const stem = sanitizePublicIdSegment(input.filename) || "asset";
  return `${folder}/${stem}`;
}

// ── Per-file upload ──────────────────────────────────────────────────────────
export interface UploadLocalFileInput {
  localAbsPath: string;
  // Full public_id including any folder path (e.g. "brands/brand_001/logos/x").
  // Do NOT pass a separate folder parameter — Cloudinary would prepend it,
  // producing a doubled path.
  publicId: string;
  resourceType?: "image" | "raw" | "auto";
  tags?: string[];
  overwrite?: boolean;
  context?: Record<string, string>;
}

export interface UploadLocalFileResult {
  secure_url: string;
  public_id: string;
  width?: number;
  height?: number;
  format: string;
  bytes: number;
  resource_type: string;
  folder?: string;
  tags?: string[];
}

export async function uploadLocalFileToCloudinary(
  input: UploadLocalFileInput,
): Promise<UploadLocalFileResult> {
  const cloudinary = getCloudinary();
  const overwrite = input.overwrite ?? false;
  const resource_type = input.resourceType ?? inferCloudinaryResourceType(input.localAbsPath);

  // The cloudinary SDK's upload() accepts a path string for local files.
  // Note: do NOT pass `folder` — the slashes in public_id already encode the
  // path. Passing `folder` causes Cloudinary to prepend it, doubling the path.
  const result = await cloudinary.uploader.upload(input.localAbsPath, {
    public_id: input.publicId,
    resource_type,
    overwrite,
    unique_filename: false,
    use_filename: false,
    invalidate: overwrite, // bust the CDN cache only when we actually overwrote
    tags: dedupeTags(input.tags ?? []),
    context: input.context,
  });

  return {
    secure_url: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
    resource_type: result.resource_type,
    folder: result.folder,
    tags: result.tags,
  };
}

function dedupeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

// ── Asset Map output schema ──────────────────────────────────────────────────
export const CloudinaryAssetRecordSchema = z.object({
  local_path: z.string(),
  original_folder_name: z.string(),
  canonical_folder_type: z.string(),
  asset_type: z.string(),
  source: z.string(),
  suggested_tags: z.array(z.string()),
  cloudinary_public_id: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  format: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  uploaded_at: z.string().nullable(),
  upload_status: z.enum(["success", "skipped", "failed", "unsupported"]),
  upload_error: z.string().optional(),
});
export type CloudinaryAssetRecord = z.infer<typeof CloudinaryAssetRecordSchema>;

export const CloudinaryAssetMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  cloud_name: z.string().nullable(),
  items: z.array(CloudinaryAssetRecordSchema),
});
export type CloudinaryAssetMap = z.infer<typeof CloudinaryAssetMapSchema>;

// ── Composite Map output schema ──────────────────────────────────────────────
export const CloudinaryCompositeRecordSchema = z.object({
  composite_id: z.string(),
  mockup_source_path: z.string(),
  screenshot_source_path: z.string(),
  screenshot_context: z.string(),
  screenshot_context_confidence: z.string(),
  slot_source: z.string(),
  device_type: z.string(),
  original_public_path: z.string(),
  cloudinary_public_id: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  format: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  uploaded_at: z.string().nullable(),
  upload_status: z.enum(["success", "skipped", "failed"]),
  upload_error: z.string().optional(),
});
export type CloudinaryCompositeRecord = z.infer<typeof CloudinaryCompositeRecordSchema>;

export const CloudinaryCompositeMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  cloud_name: z.string().nullable(),
  folder: z.string(),
  items: z.array(CloudinaryCompositeRecordSchema),
});
export type CloudinaryCompositeMap = z.infer<typeof CloudinaryCompositeMapSchema>;

// ── Bulk: assets ─────────────────────────────────────────────────────────────
export interface UploadAssetImportPlanOptions {
  cwd?: string;
  importPlanPath?: string;
  outputJsonPath?: string;
  force?: boolean;
  concurrency?: number;
  onProgress?: (msg: { index: number; total: number; record: CloudinaryAssetRecord }) => void;
}

export interface UploadAssetImportPlanResult {
  map: CloudinaryAssetMap;
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  unsupported: number;
}

export async function uploadAssetImportPlan(
  opts: UploadAssetImportPlanOptions = {},
): Promise<UploadAssetImportPlanResult> {
  const cwd = opts.cwd ?? process.cwd();
  const importPlanPath =
    opts.importPlanPath ?? path.join(cwd, "data", "asset-import-plan.generated.json");
  const outputJsonPath =
    opts.outputJsonPath ?? path.join(cwd, "data", "cloudinary-asset-map.generated.json");

  const plan: AssetImportPlan = AssetImportPlanSchema.parse(
    JSON.parse(await fs.readFile(importPlanPath, "utf8")),
  );
  const existing = await loadExistingAssetMap(outputJsonPath);
  const existingByLocal = new Map(existing?.items.map((it) => [it.local_path, it]) ?? []);

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const force = opts.force ?? false;

  const results: CloudinaryAssetRecord[] = [];
  let uploaded = 0,
    skipped = 0,
    failed = 0,
    unsupported = 0;

  // Build a slim work queue.
  const queue: { idx: number; item: AssetImportPlanItem }[] = plan.items.map((item, idx) => ({
    idx,
    item,
  }));
  const total = queue.length;

  async function worker() {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const rec = await processOne(next.item);
      results.push(rec);
      switch (rec.upload_status) {
        case "success":
          uploaded += 1;
          break;
        case "skipped":
          skipped += 1;
          break;
        case "failed":
          failed += 1;
          break;
        case "unsupported":
          unsupported += 1;
          break;
      }
      opts.onProgress?.({ index: results.length, total, record: rec });
    }
  }

  async function processOne(item: AssetImportPlanItem): Promise<CloudinaryAssetRecord> {
    const ext = item.extension.toLowerCase();
    if (!isSupportedImageExtension(ext)) {
      return {
        ...assetSkeleton(item),
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        width: null,
        height: null,
        format: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "unsupported",
        upload_error: `extension ".${ext}" not in upload allowlist`,
      };
    }

    const prior = existingByLocal.get(item.local_path);
    if (
      !force &&
      prior &&
      prior.upload_status === "success" &&
      prior.cloudinary_public_id
    ) {
      return { ...prior, upload_status: "skipped" };
    }

    const folder = (item.suggested_cloudinary_folder ?? "").replace(/\/+$/, "");
    if (!folder) {
      return {
        ...assetSkeleton(item),
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        width: null,
        height: null,
        format: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "failed",
        upload_error: "no suggested_cloudinary_folder on import plan item",
      };
    }
    const publicId = createCloudinaryPublicId({
      folder,
      filename: item.filename,
    });
    const localAbs = path.resolve(cwd, item.local_path);
    const tags = dedupeTags([
      `brand:${plan.brand_id}`,
      `asset_type:${item.asset_type}`,
      `source:${item.source}`,
      "local_intake",
      "preview_ready",
      ...item.suggested_tags,
    ]);

    try {
      const r = await uploadLocalFileToCloudinary({
        localAbsPath: localAbs,
        publicId,
        tags,
        overwrite: force,
        context: { brand: plan.brand_id, asset_type: item.asset_type },
      });
      return {
        local_path: item.local_path,
        original_folder_name: item.original_folder_name,
        canonical_folder_type: item.canonical_folder_type,
        asset_type: item.asset_type,
        source: item.source,
        suggested_tags: item.suggested_tags,
        cloudinary_public_id: r.public_id,
        cloudinary_secure_url: r.secure_url,
        width: r.width ?? null,
        height: r.height ?? null,
        format: r.format,
        bytes: r.bytes,
        uploaded_at: new Date().toISOString(),
        upload_status: "success",
      };
    } catch (err) {
      return {
        ...assetSkeleton(item),
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        width: null,
        height: null,
        format: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "failed",
        upload_error: redactErrorMessage(err),
      };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Preserve original plan order in the output map.
  const order = new Map(plan.items.map((it, i) => [it.local_path, i]));
  results.sort(
    (a, b) => (order.get(a.local_path) ?? 0) - (order.get(b.local_path) ?? 0),
  );

  const map: CloudinaryAssetMap = CloudinaryAssetMapSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: plan.brand_id,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? null,
    items: results,
  });

  await fs.writeFile(outputJsonPath, JSON.stringify(map, null, 2) + "\n", "utf8");

  return { map, total, uploaded, skipped, failed, unsupported };
}

function assetSkeleton(item: AssetImportPlanItem): Pick<
  CloudinaryAssetRecord,
  | "local_path"
  | "original_folder_name"
  | "canonical_folder_type"
  | "asset_type"
  | "source"
  | "suggested_tags"
> {
  return {
    local_path: item.local_path,
    original_folder_name: item.original_folder_name,
    canonical_folder_type: item.canonical_folder_type,
    asset_type: item.asset_type,
    source: item.source,
    suggested_tags: item.suggested_tags,
  };
}

async function loadExistingAssetMap(filePath: string): Promise<CloudinaryAssetMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return CloudinaryAssetMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Bulk: composites ─────────────────────────────────────────────────────────
export interface UploadMockupCompositesOptions {
  cwd?: string;
  compositeMapPath?: string;
  outputJsonPath?: string;
  brandId?: string; // override; otherwise inferred from asset import plan
  force?: boolean;
  concurrency?: number;
  onProgress?: (msg: {
    index: number;
    total: number;
    record: CloudinaryCompositeRecord;
  }) => void;
}

export interface UploadMockupCompositesResult {
  map: CloudinaryCompositeMap;
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

const COMPOSITE_FOLDER_SUFFIX = "generated-composites";

export async function uploadMockupComposites(
  opts: UploadMockupCompositesOptions = {},
): Promise<UploadMockupCompositesResult> {
  const cwd = opts.cwd ?? process.cwd();
  const compositeMapPath =
    opts.compositeMapPath ??
    path.join(cwd, "data", "mockup-composite-map.generated.json");
  const outputJsonPath =
    opts.outputJsonPath ??
    path.join(cwd, "data", "cloudinary-composite-map.generated.json");

  const composites: MockupCompositeMap = MockupCompositeMapSchema.parse(
    JSON.parse(await fs.readFile(compositeMapPath, "utf8")),
  );

  const inferredBrandId = opts.brandId ?? (await inferBrandId(cwd));
  if (!inferredBrandId) {
    throw new Error(
      "Could not determine brand_id. Pass options.brandId or run `npm run brand:intake` first.",
    );
  }
  const brandId: string = inferredBrandId;

  const folder = `brands/${brandId}/${COMPOSITE_FOLDER_SUFFIX}`;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const force = opts.force ?? false;

  const existing = await loadExistingCompositeMap(outputJsonPath);
  const existingById = new Map(existing?.items.map((it) => [it.composite_id, it]) ?? []);

  const results: CloudinaryCompositeRecord[] = [];
  let uploaded = 0,
    skipped = 0,
    failed = 0;

  const queue = [...composites.composites];
  const total = queue.length;

  async function worker() {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const rec = await processOne(next);
      results.push(rec);
      switch (rec.upload_status) {
        case "success":
          uploaded += 1;
          break;
        case "skipped":
          skipped += 1;
          break;
        case "failed":
          failed += 1;
          break;
      }
      opts.onProgress?.({ index: results.length, total, record: rec });
    }
  }

  async function processOne(c: AssetCompositeRecord): Promise<CloudinaryCompositeRecord> {
    const prior = existingById.get(c.composite_id);
    if (
      !force &&
      prior &&
      prior.upload_status === "success" &&
      prior.cloudinary_public_id
    ) {
      return { ...prior, upload_status: "skipped" };
    }
    const publicId = `${folder}/${sanitizePublicIdSegment(c.composite_id)}`;
    const localAbs = path.resolve(cwd, "public" + c.public_path);
    const tags = dedupeTags([
      `brand:${brandId}`,
      `asset_type:mockup_composite`,
      "source:local_mockup_composite",
      "local_intake",
      "preview_ready",
      `device:${c.device_type}`,
      `screenshot_context:${c.screenshot_context}`,
    ]);

    try {
      const r = await uploadLocalFileToCloudinary({
        localAbsPath: localAbs,
        publicId,
        tags,
        overwrite: force,
        context: {
          brand: brandId,
          composite_id: c.composite_id,
          device_type: c.device_type,
          screenshot_context: c.screenshot_context,
        },
      });
      return {
        composite_id: c.composite_id,
        mockup_source_path: c.mockup_source_path,
        screenshot_source_path: c.screenshot_source_path,
        screenshot_context: c.screenshot_context,
        screenshot_context_confidence: c.screenshot_context_confidence,
        slot_source: c.slot_source,
        device_type: c.device_type,
        original_public_path: c.public_path,
        cloudinary_public_id: r.public_id,
        cloudinary_secure_url: r.secure_url,
        format: r.format,
        bytes: r.bytes,
        uploaded_at: new Date().toISOString(),
        upload_status: "success",
      };
    } catch (err) {
      return {
        composite_id: c.composite_id,
        mockup_source_path: c.mockup_source_path,
        screenshot_source_path: c.screenshot_source_path,
        screenshot_context: c.screenshot_context,
        screenshot_context_confidence: c.screenshot_context_confidence,
        slot_source: c.slot_source,
        device_type: c.device_type,
        original_public_path: c.public_path,
        cloudinary_public_id: null,
        cloudinary_secure_url: null,
        format: null,
        bytes: null,
        uploaded_at: null,
        upload_status: "failed",
        upload_error: redactErrorMessage(err),
      };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Preserve original order.
  const order = new Map(composites.composites.map((c, i) => [c.composite_id, i]));
  results.sort((a, b) => (order.get(a.composite_id) ?? 0) - (order.get(b.composite_id) ?? 0));

  const map: CloudinaryCompositeMap = CloudinaryCompositeMapSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: brandId,
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? null,
    folder,
    items: results,
  });

  await fs.writeFile(outputJsonPath, JSON.stringify(map, null, 2) + "\n", "utf8");
  return { map, total, uploaded, skipped, failed };
}

async function loadExistingCompositeMap(
  filePath: string,
): Promise<CloudinaryCompositeMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return CloudinaryCompositeMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function inferBrandId(cwd: string): Promise<string | null> {
  try {
    const planPath = path.join(cwd, "data", "asset-import-plan.generated.json");
    const plan = AssetImportPlanSchema.parse(
      JSON.parse(await fs.readFile(planPath, "utf8")),
    );
    return plan.brand_id;
  } catch {
    return null;
  }
}

// ── Error redaction ──────────────────────────────────────────────────────────
// Cloudinary error messages can include the request URL, which embeds the
// API key. Strip it.
const SECRET_PATTERNS: RegExp[] = [
  /api_key=[^&\s)]*/gi,
  /api_secret=[^&\s)]*/gi,
  /signature=[^&\s)]*/gi,
];
function redactErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const re of SECRET_PATTERNS) msg = msg.replace(re, (m) => m.split("=")[0] + "=[redacted]");
  return msg;
}
