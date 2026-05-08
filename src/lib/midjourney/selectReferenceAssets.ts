import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
  type AssetPreviewRecord,
} from "@/lib/preview/copyPreviewAssets";
import {
  CloudinaryAssetMapSchema,
  type CloudinaryAssetMap,
} from "@/lib/cloudinary/upload";

// ─────────────────────────────────────────────────────────────────────────────
// Reference asset classifier — decides which existing brand assets are safe
// to use as Midjourney reference inputs (style refs, image-prompt refs) and
// which must NEVER be used.
//
// Hard rules (encoded in classifyAsset):
//   - brand_logo / powered_by_ib / mockups / platform_screenshots → AVOID.
//     Never use the brand logo as input — Midjourney will produce a fake one.
//     Never use platform screenshots — Midjourney will produce fake UI text.
//     Never use device mockups — Midjourney will produce fake mockups with
//     fake UI inside.
//   - backgrounds → STYLE REFERENCE. Brand-approved abstract atmosphere.
//   - elements (decorative) → STYLE REFERENCE if filename doesn't suggest a
//     device mockup; AVOID otherwise (the device-named files in Elements/
//     are mis-filed mockups — same warning the asset import plan emits).
//
// The classifier never decides what role a reference plays in a specific
// prompt — that's the job of createReferencePack.ts. This file is the broad
// safety filter.
// ─────────────────────────────────────────────────────────────────────────────

export const MidjourneyReferenceRoleSchema = z.enum([
  "style_reference",
  "image_prompt_reference",
  "avoid_for_midjourney",
]);
export type MidjourneyReferenceRole = z.infer<typeof MidjourneyReferenceRoleSchema>;

export const MidjourneyClassifiedAssetSchema = z.object({
  local_path: z.string(),
  public_path: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  cloudinary_public_id: z.string().nullable(),
  filename: z.string(),
  asset_type: z.string(), // e.g. "background", "brand_logo", "decorative_element"
  canonical_folder_type: z.string(),
  midjourney_role: MidjourneyReferenceRoleSchema,
  reason: z.string(),
});
export type MidjourneyClassifiedAsset = z.infer<typeof MidjourneyClassifiedAssetSchema>;

const DEFAULT_PREVIEW_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "asset-preview-map.generated.json",
);
const DEFAULT_CLOUDINARY_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "cloudinary-asset-map.generated.json",
);
const OPTIONAL_EXAMPLES_DIR = path.join(process.cwd(), "brand-input", "examples");

// Filenames in `Elements/` that look like a device mockup. Mirrors the asset
// import plan's misclassification keywords — kept in sync with what
// createAssetImportPlan.ts already warns about so reviewers see one rule.
const DEVICE_KEYWORDS = [
  "iphone",
  "ipad",
  "macbook",
  "laptop",
  "desktop",
  "phone",
  "tablet",
  "smartwatch",
  "watch",
  "mockup",
];

// Reasons surfaced in the reference pack so a reviewer can audit "why was
// this asset usable as MJ input?". Keep them human-readable.
const REASONS = {
  brand_logo:
    "Brand logos must never seed Midjourney — would produce a counterfeit logo. The real logo is composited as a separate layer.",
  powered_by_ib:
    "IBKR / Powered-by-IB logo must never be MJ-generated for trademark + provenance reasons.",
  platform_screenshot:
    "Real platform UI; using as reference would produce fake-text fake-UI imagery.",
  mockup:
    "Device frames + UI inside. Midjourney would produce realistic-but-fake devices — keep the real mockup file as a separate compositing layer.",
  background_style:
    "Brand-approved abstract background. Safe as Midjourney style reference — Midjourney can match atmosphere/colors without copying any text or logo.",
  element_style:
    "Decorative element from brand-input/Elements/. Safe as Midjourney style reference — abstract enough that MJ won't reproduce text or logos.",
  element_device:
    "Filename in brand-input/Elements/ suggests a device mockup. Treated as AVOID until manually moved to brand-input/mockup devices/.",
  examples_style:
    "From brand-input/examples/ — brand-approved style benchmark. Safe as Midjourney style reference.",
  unclassified:
    "Unclassified canonical type — avoiding by default. Add a rule in selectReferenceAssets.ts if you want to allow this category.",
} as const;

function classifyAsset(asset: AssetPreviewRecord): {
  role: MidjourneyReferenceRole;
  reason: string;
} {
  const fname = asset.original_filename.toLowerCase();
  switch (asset.canonical_folder_type) {
    case "brand_logo":
      return { role: "avoid_for_midjourney", reason: REASONS.brand_logo };
    case "powered_by_ib":
      return { role: "avoid_for_midjourney", reason: REASONS.powered_by_ib };
    case "platform_screenshots":
      return { role: "avoid_for_midjourney", reason: REASONS.platform_screenshot };
    case "mockups":
      return { role: "avoid_for_midjourney", reason: REASONS.mockup };
    case "backgrounds":
      return { role: "style_reference", reason: REASONS.background_style };
    case "elements": {
      const looksLikeDevice = DEVICE_KEYWORDS.some((k) => fname.includes(k));
      if (looksLikeDevice) {
        return { role: "avoid_for_midjourney", reason: REASONS.element_device };
      }
      return { role: "style_reference", reason: REASONS.element_style };
    }
    case "brand_spec":
      return {
        role: "avoid_for_midjourney",
        reason: "brand-spec text files are not images.",
      };
    default:
      return { role: "avoid_for_midjourney", reason: REASONS.unclassified };
  }
}

// ── Loaders ─────────────────────────────────────────────────────────────────
async function loadPreviewMapOrEmpty(
  filePath: string,
): Promise<AssetPreviewMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return AssetPreviewMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
async function loadCloudinaryMapOrEmpty(
  filePath: string,
): Promise<CloudinaryAssetMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return CloudinaryAssetMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

async function listExamplesDirectoryIfPresent(
  dir: string = OPTIONAL_EXAMPLES_DIR,
): Promise<{ filename: string; absPath: string }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: { filename: string; absPath: string }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      out.push({ filename: e.name, absPath: path.join(dir, e.name) });
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
export interface SelectReferenceAssetsOptions {
  cwd?: string;
  previewMapPath?: string;
  cloudinaryAssetMapPath?: string;
  examplesDir?: string;
}

export interface SelectReferenceAssetsResult {
  classified: MidjourneyClassifiedAsset[];
  // Convenience grouping; mirrors `classified` filtered by role.
  by_role: Record<MidjourneyReferenceRole, MidjourneyClassifiedAsset[]>;
}

/**
 * Walk the asset preview map (and optionally brand-input/examples/) and
 * classify every asset for Midjourney-reference suitability. The Cloudinary
 * map is joined in when present so each entry carries a public URL.
 */
export async function selectReferenceAssets(
  opts: SelectReferenceAssetsOptions = {},
): Promise<SelectReferenceAssetsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const previewMap = await loadPreviewMapOrEmpty(
    opts.previewMapPath ?? DEFAULT_PREVIEW_MAP_PATH,
  );
  const cloudinaryMap = await loadCloudinaryMapOrEmpty(
    opts.cloudinaryAssetMapPath ?? DEFAULT_CLOUDINARY_MAP_PATH,
  );
  const examplesDir = opts.examplesDir ?? OPTIONAL_EXAMPLES_DIR;

  const cloudinaryByLocalPath = new Map<
    string,
    { secure_url: string; public_id: string }
  >();
  for (const it of cloudinaryMap?.items ?? []) {
    if (
      it.upload_status === "success" &&
      it.cloudinary_secure_url &&
      it.cloudinary_public_id
    ) {
      cloudinaryByLocalPath.set(it.local_path, {
        secure_url: it.cloudinary_secure_url,
        public_id: it.cloudinary_public_id,
      });
    }
  }

  const classified: MidjourneyClassifiedAsset[] = [];

  // Pass 1: items from the preview map (which is the canonical inventory).
  for (const item of previewMap?.items ?? []) {
    const { role, reason } = classifyAsset(item);
    const cloud = cloudinaryByLocalPath.get(item.original_local_path);
    classified.push({
      local_path: item.original_local_path,
      public_path: item.public_path,
      cloudinary_secure_url: cloud?.secure_url ?? null,
      cloudinary_public_id: cloud?.public_id ?? null,
      filename: item.original_filename,
      asset_type: item.asset_type,
      canonical_folder_type: item.canonical_folder_type,
      midjourney_role: role,
      reason,
    });
  }

  // Pass 2: optional brand-input/examples/ — flat directory of brand-approved
  // visual benchmarks. These are NOT in the preview map (they're not part of
  // the brand-input taxonomy) so we surface them here.
  const examples = await listExamplesDirectoryIfPresent(examplesDir);
  for (const ex of examples) {
    const localPath = path.relative(cwd, ex.absPath);
    classified.push({
      local_path: localPath,
      public_path: null,
      cloudinary_secure_url: null,
      cloudinary_public_id: null,
      filename: ex.filename,
      asset_type: "brand_example",
      canonical_folder_type: "examples",
      midjourney_role: "style_reference",
      reason: REASONS.examples_style,
    });
  }

  const by_role: SelectReferenceAssetsResult["by_role"] = {
    style_reference: [],
    image_prompt_reference: [],
    avoid_for_midjourney: [],
  };
  for (const c of classified) by_role[c.midjourney_role].push(c);

  return { classified, by_role };
}
