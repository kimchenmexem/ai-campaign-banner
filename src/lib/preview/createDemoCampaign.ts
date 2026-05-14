import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LANG_META } from "@/lib/i18n/language";
import {
  BrandKitLiteSchema,
  type BrandKitLite,
} from "@/lib/schemas/brandKit.schema";
import {
  ElementManifestSchema,
  type Element,
  type ElementManifest,
} from "@/lib/schemas/elementManifest.schema";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
  type AssetPreviewRecord,
} from "@/lib/preview/copyPreviewAssets";
import {
  MockupCompositeMapSchema,
  type MockupCompositeMap,
  type AssetCompositeRecord,
} from "@/lib/preview/composeMockupPreview";
import {
  inferScreenshotContext,
  loadScreenshotTagSidecar,
  type ScreenshotContext,
  type ScreenshotContextConfidence,
  type ScreenshotTag,
} from "@/lib/preview/inferScreenshotContext";
import {
  DEFAULT_RENDERER_HINTS,
  type RendererHints,
} from "@/lib/ai/mapVisualSpecToInternals";
import type { DeviceType } from "@/lib/preview/mockupManifest";
import {
  CloudinaryAssetMapSchema,
  CloudinaryCompositeMapSchema,
  type CloudinaryAssetMap,
  type CloudinaryCompositeMap,
} from "@/lib/cloudinary/upload";
import {
  loadMidjourneyUploads,
  filterApproved,
} from "@/lib/midjourney/loadUploads";
import {
  loadMidjourneyAssignments,
  findAssignmentForSlot,
} from "@/lib/midjourney/loadAssignments";
import type {
  MidjourneyAssignment,
  MidjourneyAssignmentFormat,
  MidjourneyUpload,
} from "@/lib/schemas/midjourney.schema";
import { provenanceFromAsset } from "@/lib/generators/generatedAssetResolver";

// ─────────────────────────────────────────────────────────────────────────────
// Demo campaign generator.
//
// Reads:
//   data/brand-kit-lite.generated.json
//   data/asset-preview-map.generated.json
// Produces:
//   data/demo-campaign.preview.json
//
// One campaign × three ad sizes × one Figma-ready Element Manifest each.
// All text is real text. Logo / mockup are real image elements. CTA is a
// real button element. Disclaimer is a real text element. Backgrounds use a
// real asset when available, otherwise a CSS gradient sourced from the kit.
//
// This is a TEMPORARY visual preview. Bannerbear will later render from these
// same manifests; Figma will later import from them. Nothing here is the
// source of truth — the manifest is.
// ─────────────────────────────────────────────────────────────────────────────

// The schemas in elementManifest.schema.ts are exported via brandKit.schema?
// They aren't — fix the import.
// (Inlined re-imports below to avoid touching the schema barrel.)

export const DemoBackgroundFillSchema = z.union([
  z.object({
    kind: z.literal("image"),
    public_path: z.string(),
    asset_record_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal("gradient"),
    css: z.string(),
    stops: z.array(z.object({ color: z.string(), position: z.number() })),
    angle_deg: z.number(),
  }),
]);
export type DemoBackgroundFill = z.infer<typeof DemoBackgroundFillSchema>;

export const DemoMidjourneySelectionSchema = z.object({
  // upload_id for whichever upload (if any) drove each slot.
  background_upload_id: z.string().nullable(),
  decorative_upload_ids: z.array(z.string()),
  hero_upload_id: z.string().nullable(),
});
export type DemoMidjourneySelection = z.infer<typeof DemoMidjourneySelectionSchema>;

export const DemoAssetSelectionSchema = z.object({
  brand_logo: z.string().nullable(),
  powered_by_ib: z.string().nullable(),
  background: z.string().nullable(),
  mockup: z.string().nullable(),
  platform_screenshot: z.string().nullable(),
  background_fill: DemoBackgroundFillSchema,
  midjourney: DemoMidjourneySelectionSchema.default({
    background_upload_id: null,
    decorative_upload_ids: [],
    hero_upload_id: null,
  }),
});
export type DemoAssetSelection = z.infer<typeof DemoAssetSelectionSchema>;

// Per-ad-spec composite metadata. Lives at the demo level only — it is not
// part of the production Element Manifest schema. Captures full traceability
// for the visual element so a reviewer can see which mockup + screenshot
// combination produced the rendered image.
//
// Selection vs. desired:
//   - desired_context  = the concept this ad was *meant* to represent
//   - selected_context = the screenshot context we actually used (may differ
//                        when the desired context wasn't available)
//   - fallback_used    = true iff selected_context !== desired_context
export const DemoCompositeMetadataSchema = z.object({
  desired_context: z.string(),
  selected_context: z.string(),
  intended_device_type: z.string(),
  fallback_used: z.boolean(),
  fallback_kind: z.enum(["composite", "mockup_only", "screenshot_only", "none"]),
  // Categorical confidence for the selected screenshot's context.
  screenshot_context_confidence: z
    .enum(["explicit_tag", "folder_match", "filename_match", "fallback_general"])
    .nullable(),
  // Slot provenance for the selected mockup.
  mockup_slot_source: z.enum(["explicit_manifest", "heuristic"]).nullable(),
  composite_id: z.string().nullable(),
  composite_public_path: z.string().nullable(),
  mockup_source_path: z.string().nullable(),
  mockup_filename: z.string().nullable(),
  screenshot_source_path: z.string().nullable(),
  screenshot_filename: z.string().nullable(),
  notes: z.string().optional(),
});
export type DemoCompositeMetadata = z.infer<typeof DemoCompositeMetadataSchema>;

export const DemoAdSpecSchema = z.object({
  specId: z.string(),
  channel: z.string(),
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  bannerbearTemplateUid: z.string(),
  copy: z.object({
    headline: z.string(),
    subheadline: z.string(),
    cta: z.string(),
    disclaimer: z.string(),
  }),
  composite_metadata: DemoCompositeMetadataSchema,
  manifest: ElementManifestSchema,
});
export type DemoAdSpec = z.infer<typeof DemoAdSpecSchema>;

export const DemoCampaignSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  brand_name: z.string(),
  campaign: z.object({
    id: z.string(),
    title: z.string(),
    headline: z.string(),
    subheadline: z.string(),
    cta_text: z.string(),
    disclaimer: z.string(),
  }),
  asset_selection: DemoAssetSelectionSchema,
  ad_specs: z.array(DemoAdSpecSchema).min(1),
  warnings: z.array(z.string()),
});
export type DemoCampaign = z.infer<typeof DemoCampaignSchema>;

const HEADLINE = "Trade global markets with confidence";
const SUBHEADLINE =
  "Access stocks, ETFs and advanced platform tools from one powerful trading environment.";
const FALLBACK_CTA = "Start now";

export interface CreateDemoCampaignOptions {
  cwd?: string;
  brandKitPath?: string;
  assetMapPath?: string;
  compositeMapPath?: string;
  cloudinaryAssetMapPath?: string;
  cloudinaryCompositeMapPath?: string;
  outputPath?: string;
}

// Resolved URL for a single visual asset. Used by buildElements to set the
// Element's file_url + delivery_source + cloudinary_public_id at the same time.
interface ResolvedVisualUrl {
  file_url: string; // What the renderer should fetch.
  local_public_path: string | null;
  cloudinary_public_id: string | null;
  delivery_source: "cloudinary" | "local_preview";
}

// Per-ad concept assignment. Drives which mockup + screenshot combination
// each format pulls from the composite map. `fallback_contexts` lets the
// picker try secondary contexts before degrading to general_platform.
interface AdConceptPlan {
  device_type: DeviceType;
  context: ScreenshotContext;
  fallback_contexts?: ScreenshotContext[];
}

const AD_CONCEPT_BY_SIZE: Record<string, AdConceptPlan> = {
  "1200x628": { device_type: "laptop", context: "stocks" },
  "1080x1080": { device_type: "tablet", context: "etfs" },
  "1080x1920": {
    device_type: "phone",
    context: "charts",
    fallback_contexts: ["green_data"],
  },
};

export interface CreateDemoCampaignResult {
  demo: DemoCampaign;
  outputPath: string;
}

export async function createDemoCampaign(
  opts: CreateDemoCampaignOptions = {},
): Promise<CreateDemoCampaignResult> {
  const cwd = opts.cwd ?? process.cwd();
  const brandKitPath =
    opts.brandKitPath ?? path.join(cwd, "data", "brand-kit-lite.generated.json");
  const assetMapPath =
    opts.assetMapPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const compositeMapPath =
    opts.compositeMapPath ??
    path.join(cwd, "data", "mockup-composite-map.generated.json");
  const cloudinaryAssetMapPath =
    opts.cloudinaryAssetMapPath ??
    path.join(cwd, "data", "cloudinary-asset-map.generated.json");
  const cloudinaryCompositeMapPath =
    opts.cloudinaryCompositeMapPath ??
    path.join(cwd, "data", "cloudinary-composite-map.generated.json");
  const outputPath =
    opts.outputPath ?? path.join(cwd, "data", "demo-campaign.preview.json");

  const kit = BrandKitLiteSchema.parse(JSON.parse(await fs.readFile(brandKitPath, "utf8")));
  const assets = AssetPreviewMapSchema.parse(
    JSON.parse(await fs.readFile(assetMapPath, "utf8")),
  );
  const compositeMap = await loadCompositeMap(compositeMapPath);
  const tagSidecar = await loadScreenshotTagSidecar();
  const cloudinaryAssetMap = await loadCloudinaryAssetMap(cloudinaryAssetMapPath);
  const cloudinaryCompositeMap = await loadCloudinaryCompositeMap(cloudinaryCompositeMapPath);
  const cloudinaryDelivery = buildCloudinaryDelivery(
    cloudinaryAssetMap,
    cloudinaryCompositeMap,
    assets,
  );
  const midjourneyUploads = await loadMidjourneyUploads();
  const approvedUploads = filterApproved(midjourneyUploads.uploads);
  const approvedById = new Map(approvedUploads.map((u) => [u.upload_id, u]));
  const midjourneyAssignmentsFile = await loadMidjourneyAssignments();
  // Only assignments referencing approved uploads are honored.
  const activeAssignments = midjourneyAssignmentsFile.assignments.filter(
    (a) => a.active && approvedById.has(a.upload_id),
  );

  const warnings: string[] = [];
  if (!compositeMap) {
    warnings.push(
      "No mockup-composite-map.generated.json — run `npm run preview:mockups` first to enable composite visuals. Falling back to raw mockup or screenshot.",
    );
  }
  if (!cloudinaryAssetMap && !cloudinaryCompositeMap) {
    warnings.push(
      "No Cloudinary upload maps found — every visual element uses local_preview delivery. Run `npm run cloudinary:upload-all` to switch to Cloudinary URLs.",
    );
  }
  const selection = pickAssets(assets, kit, warnings, approvedUploads);

  const ctaText = kit.cta.allowed_texts[0] ?? FALLBACK_CTA;
  if (!kit.cta.allowed_texts[0]) {
    warnings.push(`No allowed_texts in brand kit cta — using fallback "${FALLBACK_CTA}"`);
  }
  const disclaimerText = kit.legal.default_disclaimer || "";
  if (!disclaimerText) warnings.push("Brand kit has no default_disclaimer — emitting empty string");

  const campaignId = "campaign_demo_001";
  const conceptId = "concept_demo_001";

  const sizes: Array<{ name: string; width: number; height: number; channel: string }> = [
    { name: "1200x628", width: 1200, height: 628, channel: "leaderboard" },
    { name: "1080x1080", width: 1080, height: 1080, channel: "instagram-feed" },
    { name: "1080x1920", width: 1080, height: 1920, channel: "instagram-story" },
  ];

  const ad_specs: DemoAdSpec[] = sizes.map((s) => {
    const plan = AD_CONCEPT_BY_SIZE[s.name] ?? {
      device_type: "tablet" as DeviceType,
      context: "general_platform" as ScreenshotContext,
    };
    const visual = pickVisualForSpec({
      plan,
      selection,
      assets,
      compositeMap,
      tagSidecar,
      warnings,
    });
    return buildAdSpec({
      campaignId,
      conceptId,
      brandKit: kit,
      selection,
      visual,
      cloudinaryDelivery,
      midjourneyById: approvedById,
      midjourneyAssignments: activeAssignments,
      copy: {
        headline: HEADLINE,
        subheadline: SUBHEADLINE,
        cta: ctaText,
        disclaimer: disclaimerText,
      },
      size: { name: s.name, width: s.width, height: s.height },
      channel: s.channel,
    });
  });

  const demo: DemoCampaign = DemoCampaignSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: kit.brand_id,
    brand_name: kit.brand_name,
    campaign: {
      id: campaignId,
      title: "Demo: Trade global markets with confidence",
      headline: HEADLINE,
      subheadline: SUBHEADLINE,
      cta_text: ctaText,
      disclaimer: disclaimerText,
    },
    asset_selection: selection,
    ad_specs,
    warnings,
  });

  await fs.writeFile(outputPath, JSON.stringify(demo, null, 2) + "\n", "utf8");
  return { demo, outputPath };
}

// ── Composite map loader ────────────────────────────────────────────────────

async function loadCompositeMap(filePath: string): Promise<MockupCompositeMap | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return MockupCompositeMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadCloudinaryAssetMap(
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

export async function loadCloudinaryCompositeMap(
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

// ── Cloudinary delivery resolver ────────────────────────────────────────────
// Builds two indexes that let us map any local public_path or composite path
// to a Cloudinary record. Used by `resolveDelivery` below.
interface CloudinaryDelivery {
  // local_public_path → cloudinary record from cloudinary-asset-map.
  byLocalPath: Map<string, { secure_url: string; public_id: string }>;
  // composite original_public_path → cloudinary record from cloudinary-composite-map.
  byCompositePath: Map<string, { secure_url: string; public_id: string }>;
}

export function buildCloudinaryDelivery(
  assetMap: CloudinaryAssetMap | null,
  compositeMap: CloudinaryCompositeMap | null,
  assets: AssetPreviewMap,
): CloudinaryDelivery {
  const byLocalPath = new Map<string, { secure_url: string; public_id: string }>();
  if (assetMap) {
    // The asset map keys by `local_path` (e.g. "brand-input/MEXEM logo/...").
    // The visual element file_urls reference the public_path (e.g.
    // "/brand-input-preview/brand_logo/logo-blue-p.png"). Bridge the two via
    // the AssetPreviewMap.
    const previewByLocal = new Map<string, AssetPreviewRecord>();
    for (const r of assets.items) previewByLocal.set(r.original_local_path, r);
    for (const item of assetMap.items) {
      if (
        item.upload_status !== "success" ||
        !item.cloudinary_secure_url ||
        !item.cloudinary_public_id
      ) {
        continue;
      }
      const preview = previewByLocal.get(item.local_path);
      if (!preview) continue;
      byLocalPath.set(preview.public_path, {
        secure_url: item.cloudinary_secure_url,
        public_id: item.cloudinary_public_id,
      });
    }
  }

  const byCompositePath = new Map<string, { secure_url: string; public_id: string }>();
  if (compositeMap) {
    for (const item of compositeMap.items) {
      if (
        item.upload_status !== "success" ||
        !item.cloudinary_secure_url ||
        !item.cloudinary_public_id
      ) {
        continue;
      }
      byCompositePath.set(item.original_public_path, {
        secure_url: item.cloudinary_secure_url,
        public_id: item.cloudinary_public_id,
      });
    }
  }
  return { byLocalPath, byCompositePath };
}

/**
 * Resolve a local public_path to a delivery descriptor. Cloudinary wins when
 * an upload exists; otherwise we emit a `file://localhost/...` URL that the
 * preview renderer turns back into the local public_path.
 */
function resolveDelivery(
  publicPath: string,
  delivery: CloudinaryDelivery,
  isComposite: boolean,
): ResolvedVisualUrl {
  const lookup = isComposite
    ? delivery.byCompositePath.get(publicPath)
    : delivery.byLocalPath.get(publicPath);
  if (lookup) {
    return {
      file_url: lookup.secure_url,
      local_public_path: publicPath,
      cloudinary_public_id: lookup.public_id,
      delivery_source: "cloudinary",
    };
  }
  return {
    file_url: absolutePreviewUrl(publicPath),
    local_public_path: publicPath,
    cloudinary_public_id: null,
    delivery_source: "local_preview",
  };
}

// ── Per-spec visual selection ───────────────────────────────────────────────

interface VisualForSpec {
  metadata: DemoCompositeMetadata;
  visual_public_path: string | null;
  // The role to assign on the manifest element. "hero-image" when we have a
  // composite or mockup; "supporting-image" when we have a screenshot only.
  manifest_role: "hero-image" | "supporting-image";
  // Free-form alt text.
  alt_text: string;
}

interface PickVisualArgs {
  plan: AdConceptPlan;
  selection: DemoAssetSelection;
  assets: AssetPreviewMap;
  compositeMap: MockupCompositeMap | null;
  tagSidecar: Map<string, ScreenshotTag>;
  warnings: string[];
}

export function pickVisualForSpec(args: PickVisualArgs): VisualForSpec {
  const { plan, selection, assets, compositeMap, tagSidecar, warnings } = args;

  // ── Brand-input PRIORITY chain (operator decision 2026-05-08, revised) ────
  //
  // The runtime composite path (empty mockup × platform screenshot) is
  // DISABLED for now. The current calibration produces too many cross-context
  // fallbacks (e.g. tablet stocks/etfs/general_platform all collapsing to the
  // same `Order dialog (Light).png` because there's no aspect-ratio-correct
  // tablet screenshot for those contexts). brand-input/Elements/ already
  // contains pre-composited devices with embedded screenshots
  // (3-iphone.png, ipad.png, macbook.png, iwatch.png) — those land cleaner
  // than runtime composites do until the screenshot library is calibrated
  // and the heuristic mockup slots are made explicit.
  //
  // To re-enable: just delete this skip block. `fromComposite` and the full
  // 4-step fallback chain remain wired below.
  //
  // Picker bias while this is in effect:
  //   1. Device-shaped image from Elements/   (3-iphone.png, ipad.png, …)
  //   2. Hero image from Elements/            (HERO IMAGE.png, materials*, …)
  //   3. Raw screenshot from Platform screenshot/
  //   4. Global selection fallback.
  const COMPOSITES_DISABLED = true;

  if (!COMPOSITES_DISABLED && compositeMap) {
    // 1. Exact match — desired device, desired context.
    const exact = compositeMap.composites.find(
      (c) =>
        c.device_type === plan.device_type && c.screenshot_context === plan.context,
    );
    if (exact) return fromComposite(plan, exact);

    // 2. Same device, plan.fallback_contexts in order.
    for (const fallbackCtx of plan.fallback_contexts ?? []) {
      const hit = compositeMap.composites.find(
        (c) =>
          c.device_type === plan.device_type &&
          c.screenshot_context === fallbackCtx,
      );
      if (hit) {
        warnings.push(
          `No composite for (${plan.device_type}, ${plan.context}) — using ${plan.device_type}/${fallbackCtx} fallback.`,
        );
        return fromComposite(plan, hit);
      }
    }

    // 3. Same device, general_platform fallback.
    const sameDeviceGeneral = compositeMap.composites.find(
      (c) =>
        c.device_type === plan.device_type &&
        c.screenshot_context === "general_platform",
    );
    if (sameDeviceGeneral) {
      warnings.push(
        `No composite for (${plan.device_type}, ${plan.context}) — using ${plan.device_type}/general_platform composite.`,
      );
      return fromComposite(plan, sameDeviceGeneral);
    }

    // 4. Same context, any device.
    const ctxOnly = compositeMap.composites.find(
      (c) => c.screenshot_context === plan.context,
    );
    if (ctxOnly) {
      warnings.push(
        `No composite with device=${plan.device_type} for context "${plan.context}" — using ${ctxOnly.device_type} composite instead.`,
      );
      return fromComposite(plan, ctxOnly);
    }
  }

  // Composite path skipped (or no composite available) → use Elements/-only.
  const elementMockups = assets.items.filter(
    (i) =>
      i.canonical_folder_type === "elements" &&
      deviceTypeFromAsset(i) !== "unknown",
  );
  // Prefer the LARGEST file per device type. brand-input/Elements/ contains
  // both empty bezel mockups (small files, ~50–300 KB) and pre-populated
  // devices with platform screenshots embedded (large files, ~400 KB–2.5 MB).
  // Larger byte size correlates with "populated screen" in this codebase
  // because empty bezels compress dramatically. Sorting by size descending
  // makes the picker robust to filename changes (otherwise it relies on
  // alphabetical-first happening to land on the populated file).
  const mockupPool = [...elementMockups].sort(
    (a, b) => safeFileBytes(b) - safeFileBytes(a),
  );
  const mockup =
    mockupPool.find((m) => deviceTypeFromAsset(m) === plan.device_type) ??
    mockupPool[0];

  const screenshots = assets.items.filter(
    (i) => i.canonical_folder_type === "platform_screenshots",
  );
  const screenshotPick =
    screenshots.find(
      (s) =>
        inferScreenshotContext({
          filename: s.original_filename,
          folder: s.original_folder_name,
          tagsByFilename: tagSidecar,
        }).context === plan.context,
    ) ?? screenshots[0];

  const inferredForPick = screenshotPick
    ? inferScreenshotContext({
        filename: screenshotPick.original_filename,
        folder: screenshotPick.original_folder_name,
        tagsByFilename: tagSidecar,
      })
    : null;

  if (mockup && screenshotPick) {
    // Elements/-only mode: composites are intentionally skipped, so the
    // selected screenshot rides along on the metadata for traceability but
    // is not composited into the mockup. Visual element points at the raw
    // Elements/ device PNG.
    return buildMetadata({
      plan,
      selected_context: inferredForPick?.context ?? "general_platform",
      screenshot_context_confidence: inferredForPick?.confidence ?? null,
      mockup_slot_source: null,
      fallback_kind: "mockup_only",
      composite: null,
      mockup,
      screenshot: screenshotPick,
      visual_public_path: mockup.public_path,
      manifest_role: "hero-image",
      alt_text: "Product mockup",
      notes: `Elements/-only: ${mockup.original_filename}; screenshot ${screenshotPick.original_filename} on metadata only.`,
    });
  }
  if (mockup && !screenshotPick) {
    warnings.push(
      `No screenshot found for context "${plan.context}" — using mockup-only fallback.`,
    );
    return buildMetadata({
      plan,
      selected_context: "general_platform",
      screenshot_context_confidence: null,
      mockup_slot_source: null,
      fallback_kind: "mockup_only",
      composite: null,
      mockup,
      screenshot: null,
      visual_public_path: mockup.public_path,
      manifest_role: "hero-image",
      alt_text: "Product mockup",
      notes: "No composite and no contextual screenshot — using mockup alone.",
    });
  }
  if (!mockup && screenshotPick) {
    warnings.push(
      `No mockup available — using raw screenshot for context "${plan.context}".`,
    );
    return buildMetadata({
      plan,
      selected_context: inferredForPick?.context ?? "general_platform",
      screenshot_context_confidence: inferredForPick?.confidence ?? null,
      mockup_slot_source: null,
      fallback_kind: "screenshot_only",
      composite: null,
      mockup: null,
      screenshot: screenshotPick,
      visual_public_path: screenshotPick.public_path,
      manifest_role: "supporting-image",
      alt_text: "Platform screenshot",
      notes: "No mockup available — using screenshot alone.",
    });
  }

  // ── Hero-image fallback from brand-input/Elements/ ──────────────────────
  // Before giving up, look for a non-device hero image the brand supplied
  // (HERO IMAGE.png, materials*, middle*, left_*, etc.). These aren't device
  // mockups but they're production-ready imagery that should appear in a
  // banner instead of leaving the visual slot empty.
  const heroElement = assets.items.find(
    (i) =>
      i.canonical_folder_type === "elements" &&
      /(hero|materials|middle|left_|width_|shutterstock)/i.test(i.original_filename),
  );
  if (heroElement) {
    warnings.push(
      `Using brand-input/Elements/${heroElement.original_filename} as hero image (no mockup or screenshot matched).`,
    );
    return buildMetadata({
      plan,
      selected_context: "general_platform",
      screenshot_context_confidence: null,
      mockup_slot_source: null,
      fallback_kind: "mockup_only",
      composite: null,
      mockup: null,
      screenshot: null,
      visual_public_path: heroElement.public_path,
      manifest_role: "hero-image",
      alt_text: "Brand hero image",
      notes: `Source: brand-input/Elements/${heroElement.original_filename}`,
    });
  }

  // Nothing usable — fall back to global selection.
  if (selection.mockup) {
    return buildMetadata({
      plan,
      selected_context: "general_platform",
      screenshot_context_confidence: null,
      mockup_slot_source: null,
      fallback_kind: "mockup_only",
      composite: null,
      mockup: null,
      screenshot: null,
      visual_public_path: selection.mockup,
      manifest_role: "hero-image",
      alt_text: "Product mockup",
    });
  }
  if (selection.platform_screenshot) {
    return buildMetadata({
      plan,
      selected_context: "general_platform",
      screenshot_context_confidence: null,
      mockup_slot_source: null,
      fallback_kind: "screenshot_only",
      composite: null,
      mockup: null,
      screenshot: null,
      visual_public_path: selection.platform_screenshot,
      manifest_role: "supporting-image",
      alt_text: "Platform screenshot",
    });
  }

  warnings.push(`No visual available for ad ${plan.device_type}/${plan.context}.`);
  return buildMetadata({
    plan,
    selected_context: "general_platform",
    screenshot_context_confidence: null,
    mockup_slot_source: null,
    fallback_kind: "none",
    composite: null,
    mockup: null,
    screenshot: null,
    visual_public_path: null,
    manifest_role: "hero-image",
    alt_text: "",
  });
}

function fromComposite(
  plan: AdConceptPlan,
  composite: AssetCompositeRecord,
): VisualForSpec {
  const selectedContext = composite.screenshot_context as ScreenshotContext;
  return {
    metadata: {
      desired_context: plan.context,
      selected_context: selectedContext,
      intended_device_type: plan.device_type,
      fallback_used: selectedContext !== plan.context,
      fallback_kind: "composite",
      screenshot_context_confidence: composite.screenshot_context_confidence,
      mockup_slot_source: composite.slot_source,
      composite_id: composite.composite_id,
      composite_public_path: composite.public_path,
      mockup_source_path: composite.mockup_source_path,
      mockup_filename: composite.mockup_original_filename,
      screenshot_source_path: composite.screenshot_source_path,
      screenshot_filename: composite.screenshot_original_filename,
    },
    visual_public_path: composite.public_path,
    manifest_role: "hero-image",
    alt_text: "Product mockup with platform screenshot",
  };
}

interface BuildMetadataArgs {
  plan: AdConceptPlan;
  selected_context: ScreenshotContext;
  screenshot_context_confidence: ScreenshotContextConfidence | null;
  mockup_slot_source: "explicit_manifest" | "heuristic" | null;
  fallback_kind: "composite" | "mockup_only" | "screenshot_only" | "none";
  composite: AssetCompositeRecord | null;
  mockup: AssetPreviewRecord | null;
  screenshot: AssetPreviewRecord | null;
  visual_public_path: string | null;
  manifest_role: "hero-image" | "supporting-image";
  alt_text: string;
  notes?: string;
}

function buildMetadata(args: BuildMetadataArgs): VisualForSpec {
  const {
    plan,
    selected_context,
    screenshot_context_confidence,
    mockup_slot_source,
    fallback_kind,
    composite,
    mockup,
    screenshot,
    visual_public_path,
    manifest_role,
    alt_text,
    notes,
  } = args;
  return {
    metadata: {
      desired_context: plan.context,
      selected_context,
      intended_device_type: plan.device_type,
      fallback_used: selected_context !== plan.context,
      fallback_kind,
      screenshot_context_confidence,
      mockup_slot_source,
      composite_id: composite?.composite_id ?? null,
      composite_public_path: composite?.public_path ?? null,
      mockup_source_path: mockup?.original_local_path ?? null,
      mockup_filename: mockup?.original_filename ?? null,
      screenshot_source_path: screenshot?.original_local_path ?? null,
      screenshot_filename: screenshot?.original_filename ?? null,
      ...(notes ? { notes } : {}),
    },
    visual_public_path,
    manifest_role,
    alt_text,
  };
}

// ── CTA palette picker ─────────────────────────────────────────────────────
// Honors the AI's `cta_strategy` intent (standard / ghost / accent) while
// drawing from the brand kit's `cta.variants[]` list when present. The
// "standard" path PRNG-picks across the non-ghost / non-accent variants so
// a 3-spec campaign can land on different (still on-brand) looks.

interface CtaPaletteResult {
  bg: string;
  fg: string;
  borderWidth?: number;
  borderColor?: string;
  borderRadius?: number;
  variantId?: string;
}

function ctaSeedToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) >>> 0;
}

function pickCtaPalette(args: {
  ctaStyle: "standard" | "ghost" | "accent" | string | undefined;
  brandKit: BrandKitLite;
  headlineColor: string;
  accentColor: string;
  seedKey: string;
  // Effective canvas background color. When provided, the palette is
  // post-filtered to guarantee the CTA fill never falls below WCAG-AA
  // 3:1 contrast against the background (the "no buttons in the
  // background color" rule). Transparent fills are exempt (their
  // visibility is governed by the border color).
  canvasBg?: string;
}): CtaPaletteResult {
  const { ctaStyle, brandKit, headlineColor, accentColor, seedKey, canvasBg } = args;
  const variants = brandKit.cta.variants ?? [];
  const fallbackDefault: CtaPaletteResult = {
    bg: brandKit.cta.button_background_color,
    fg: brandKit.cta.button_text_color,
    borderRadius: brandKit.cta.border_radius,
  };

  const variantToPalette = (v: NonNullable<typeof variants>[number]): CtaPaletteResult => ({
    bg: v.background_color,
    fg: v.text_color,
    borderRadius: v.border_radius,
    ...(v.border_width != null
      ? { borderWidth: v.border_width, borderColor: v.border_color ?? headlineColor }
      : {}),
    variantId: v.id,
  });

  // Brand discipline: CTA fill must never match the canvas background.
  // Returns the highest-contrast variant against the canvas if the
  // seed-picked one is below 3:1, else returns the original palette.
  const MIN_CTA_BG_CONTRAST = 3.0;
  const enforceContrast = (palette: CtaPaletteResult): CtaPaletteResult => {
    if (!canvasBg) return palette;
    if (palette.bg === "transparent") return palette; // border governs visibility
    if (contrastRatio(palette.bg, canvasBg) >= MIN_CTA_BG_CONTRAST) return palette;
    // Find any variant with sufficient contrast — prefer the highest.
    const ranked = variants
      .filter((v) => v.background_color !== "transparent")
      .map((v) => ({ v, ratio: contrastRatio(v.background_color, canvasBg) }))
      .filter((x) => x.ratio >= MIN_CTA_BG_CONTRAST)
      .sort((a, b) => b.ratio - a.ratio);
    if (ranked.length > 0) return variantToPalette(ranked[0].v);
    // No variant clears the bar — fall back to a derived high-contrast
    // pair so the CTA is at least visible.
    const fg = pickHighContrast(canvasBg, ["#FFFFFF", "#000000"], "#FFFFFF");
    const bg = fg === "#FFFFFF" ? "#FFFFFF" : "#0A1A2E";
    return { bg, fg: fg === "#FFFFFF" ? "#0A1A2E" : "#FFFFFF", borderRadius: palette.borderRadius };
  };

  // Ghost intent → first variant whose id signals ghost/outline. Falls back
  // to the legacy "transparent + headline color" recipe.
  if (ctaStyle === "ghost") {
    const hit = variants.find((v) => /ghost|outline/i.test(v.id));
    if (hit) return enforceContrast(variantToPalette(hit));
    return enforceContrast({
      bg: "transparent",
      fg: headlineColor,
      borderWidth: 2,
      borderColor: headlineColor,
      variantId: "ghost-derived",
    });
  }

  // Accent intent → first variant tagged accent/yellow. Falls back to the
  // brand's first accent color filled.
  if (ctaStyle === "accent") {
    const hit = variants.find((v) => /accent|yellow|loud/i.test(v.id));
    if (hit) return enforceContrast(variantToPalette(hit));
    return enforceContrast({
      bg: accentColor,
      fg: pickHighContrast(accentColor, ["#FFFFFF", "#000000"], "#FFFFFF"),
      variantId: "accent-derived",
    });
  }

  // Standard intent → pick from the "regular" variants (anything that's
  // NOT a ghost or accent variant). Deterministic on seedKey so the same
  // (campaign, concept, format) always lands on the same look — but two
  // formats in the same concept can differ.
  const regulars = variants.filter((v) => !/ghost|outline|accent|yellow|loud/i.test(v.id));
  if (regulars.length > 0) {
    const pick = regulars[ctaSeedToInt(seedKey) % regulars.length];
    return enforceContrast(variantToPalette(pick));
  }
  return enforceContrast(fallbackDefault);
}

function deviceTypeFromAsset(asset: AssetPreviewRecord): DeviceType {
  const v = asset.original_filename.toLowerCase();
  if (/iphone|phone|mobile/.test(v)) return "phone";
  if (/ipad|tablet/.test(v)) return "tablet";
  if (/macbook|laptop|notebook/.test(v)) return "laptop";
  if (/desktop|imac|monitor/.test(v)) return "desktop";
  if (/iwatch|watch/.test(v)) return "smartwatch";
  return "unknown";
}

// Return the byte size of an asset's source file (relative to cwd).
// Returns 0 on any error so the sort comparator stays well-behaved.
const fileBytesCache = new Map<string, number>();
function safeFileBytes(asset: AssetPreviewRecord): number {
  const key = asset.original_local_path;
  const cached = fileBytesCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const abs = path.resolve(process.cwd(), key);
    const bytes = statSync(abs).size;
    fileBytesCache.set(key, bytes);
    return bytes;
  } catch {
    fileBytesCache.set(key, 0);
    return 0;
  }
}

// ── Asset selection ─────────────────────────────────────────────────────────

export function pickAssets(
  assets: AssetPreviewMap,
  kit: BrandKitLite,
  warnings: string[],
  approvedUploads: MidjourneyUpload[] = [],
): DemoAssetSelection {
  const byCanonical = (canonical: string): AssetPreviewRecord[] =>
    assets.items.filter((i) => i.canonical_folder_type === canonical);

  const logoCandidates = byCanonical("brand_logo").filter(
    (i) => !/fav/i.test(i.original_filename),
  );
  const logoOnLight = logoCandidates.find((i) => /blue|colour|color/i.test(i.original_filename));
  const logoOnDark = logoCandidates.find((i) => /white/i.test(i.original_filename));
  const brand_logo =
    (logoOnLight ?? logoCandidates[0])?.public_path ?? null;
  if (!brand_logo) warnings.push("No brand_logo asset found in preview map");

  const ibkrCandidates = byCanonical("powered_by_ib").filter(
    (i) => !/fav/i.test(i.original_filename),
  );
  const ibkrPick =
    ibkrCandidates.find((i) => /white/i.test(i.original_filename)) ?? ibkrCandidates[0];
  const powered_by_ib = ibkrPick?.public_path ?? null;
  if (!powered_by_ib) warnings.push("No powered_by_ib asset found in preview map");

  // ── Approved Midjourney uploads override the default backgrounds. ───────
  const mjBackgrounds = approvedUploads.filter((u) => u.intended_use === "background");
  const mjBackground = mjBackgrounds[0] ?? null; // first wins; UI picks order
  const mjDecoratives = approvedUploads
    .filter((u) => u.intended_use === "decorative")
    .slice(0, 2); // demo emits up to 2 decoratives
  const mjHero = approvedUploads.find((u) => u.intended_use === "hero_visual") ?? null;

  const default_background_asset = byCanonical("backgrounds")[0]?.public_path ?? null;
  const background_asset =
    mjBackground?.cloudinary_secure_url ??
    mjBackground?.public_path ??
    default_background_asset;
  // Note: when a Midjourney upload drives the background, the upload_id is
  // recorded on el_background.midjourney for full traceability — no
  // warning is emitted because this is the designed behaviour when MJ
  // uploads exist in the inventory.
  void mjBackground;

  const mockup = byCanonical("mockups")[0]?.public_path ?? null;
  const platform_screenshot = byCanonical("platform_screenshots")[0]?.public_path ?? null;
  if (!mockup && !platform_screenshot) {
    warnings.push("No mockup or platform_screenshot available — leaving visual area empty");
  }

  const background_fill: DemoBackgroundFill = background_asset
    ? { kind: "image", public_path: background_asset }
    : gradientFromKit(kit, warnings);

  return {
    brand_logo,
    powered_by_ib,
    background: background_asset,
    mockup,
    platform_screenshot,
    background_fill,
    midjourney: {
      background_upload_id: mjBackground?.upload_id ?? null,
      decorative_upload_ids: mjDecoratives.map((u) => u.upload_id),
      hero_upload_id: mjHero?.upload_id ?? null,
    },
  };

  // Light/dark logo intent is recorded for future swap-by-bg-luminance logic.
  void logoOnDark;
}

function gradientFromKit(kit: BrandKitLite, warnings: string[]): DemoBackgroundFill {
  const grad = kit.colors.allowed_gradients[0];
  if (!grad || grad.stops.length < 2) {
    warnings.push(
      "No background asset and no allowed_gradient — emitting solid #00122C fallback",
    );
    return {
      kind: "gradient",
      angle_deg: 135,
      stops: [
        { color: "#00122C", position: 0 },
        { color: "#005D8D", position: 1 },
      ],
      css: "linear-gradient(135deg, #00122C 0%, #005D8D 100%)",
    };
  }
  const angle = grad.angle_deg ?? 135;
  const stopsCss = grad.stops
    .map((s) => `${s.color} ${Math.round(s.position * 100)}%`)
    .join(", ");
  return {
    kind: "gradient",
    angle_deg: angle,
    stops: grad.stops.map((s) => ({ color: s.color, position: s.position })),
    css: `linear-gradient(${angle}deg, ${stopsCss})`,
  };
}

// ── Ad spec builder ─────────────────────────────────────────────────────────

// Three layout variants. The planner picks one per concept index so the
// ads in a single campaign vary structurally, not just chromatically.
//   text_leading  — text on the left/top, visual to the side/below (default)
//   visual_leading — visual on the left/top, text on the other side/below
//   hero_overlay   — visual fills the canvas, copy overlays at the bottom
// Layout-only — copy and assets stay identical across compositions.
export type CompositionKind = "text_leading" | "visual_leading" | "hero_overlay";

// Templates are a SECOND axis of variation: which elements are present.
//   mockup_hero       — text + device mockup composite (the original demo
//                       look). Background is a brand gradient.
//   pattern_immersive — Brand gradient + a clean SVG geometric pattern
//                       (diagonal lines in brand accent) covering the
//                       canvas. NO mockup. Text and CTA overlay at the
//                       bottom. The "modern editorial" treatment.
//   editorial_type    — Brand-color block background. NO mockup, NO
//                       pattern. Pure typographic ad with either a stat
//                       block (when AI emits one) or a geometric accent.
//   photo_immersive   — Legacy: AI-generated photographic bg fills the
//                       canvas. Disabled in the default cycle because
//                       auto-generated photography bled text glyphs and
//                       fought the brand palette. Still in the union so
//                       a future operator override can opt back in with
//                       hand-curated Midjourney uploads.
// Each template pulls from the same brand kit but renders a structurally
// different ad. The planner cycles through them per concept so a single
// campaign produces 3 distinct design families — all on-brand, all
// text-free in the imagery.
export type TemplateKind =
  | "mockup_hero"
  | "pattern_immersive"
  | "editorial_type"
  | "photo_immersive";

// Pattern variants for `pattern_immersive`. Picked randomly per campaign
// so two campaigns side-by-side don't both have the same diagonal-line
// rhythm — the brand identity stays consistent (same brand-accent color,
// same opacity range), only the geometric language varies.
export type PatternStyle =
  | "diagonal_lines"
  | "diagonal_lines_reverse"
  | "vertical_bars"
  | "dot_grid"
  | "concentric_arcs";

// Generated design motifs — algorithmic SVG illustrations layered behind
// the content to make every ad feel hand-designed, not assembled. Each
// motif is rendered to an SVG data URI in brand colors. The planner picks
// one per concept (sometimes context-aware, sometimes random) and the
// renderer slots it as a decorative element at z-index 8 — above the
// background, below the foreground content.
export type DesignMotif =
  | "chart_silhouette"     // smooth ascending area-chart curve
  | "abstract_bars"        // staggered vertical bars (data-viz)
  | "axis_grid"            // subtle graph-paper background
  | "wave_curve"           // sinuous curve sweeping across the canvas
  | "gradient_orb"         // glowing radial blob
  | "node_network"         // dots connected by faint lines
  | "arc_meter"            // half-circle gauge
  | "ticker_strip"         // ticker-bar of varying widths (text-free)
  | "none";                // explicit "no motif" so the random pool can
                           // still produce clean, motif-less ads

interface BuildAdSpecArgs {
  campaignId: string;
  conceptId: string;
  brandKit: BrandKitLite;
  selection: DemoAssetSelection;
  visual: VisualForSpec;
  cloudinaryDelivery: CloudinaryDelivery;
  midjourneyById: Map<string, MidjourneyUpload>;
  midjourneyAssignments: MidjourneyAssignment[];
  copy: { headline: string; headline_emphasis?: string; subheadline: string; cta: string; disclaimer: string };
  size: { name: string; width: number; height: number };
  channel: string;
  composition?: CompositionKind;
  template?: TemplateKind;
  // Output language. Drives text-align (RTL flips to right), CTA arrow
  // direction, font stack, and the per-script charWidthRatio used by
  // fitFontToBox. Default "en" preserves existing behavior.
  language?: import("@/lib/i18n/language").Language;
  // Pattern variant for pattern_immersive (ignored by other templates).
  patternStyle?: PatternStyle;
  // Generated brand-color SVG illustration to layer behind the content.
  // Adds an additional designed surface to every ad — chart silhouette,
  // wave curve, bar arrangement, etc — so concepts feel composed rather
  // than just-rearranged. "none" means skip.
  motif?: DesignMotif;
  // Optional typographic accents the AI requested for this concept. The
  // builder renders only the fields that are present and uses the layout's
  // negative space — no field, no element.
  designElements?: {
    eyebrow?: string;
    stat?: { number: string; label: string };
    kicker?: string;
  };
  // Step 6 — scalar adjustments derived from the AI Visual Planner's
  // VisualLayoutSpec. When omitted, falls back to DEFAULT_RENDERER_HINTS
  // (all multipliers 1.0, all booleans false) which preserves today's
  // behavior. See src/lib/ai/mapVisualSpecToInternals.ts for the mapping.
  rendererHints?: RendererHints;
  // Phase 3 — optional. Lets the operator inject already-generated assets
  // (CTA element, generated background, generated mockup composite, FX
  // overlay, trading-UI widget). Null/undefined → today's behavior verbatim.
  generatedAssetResolver?: import("@/lib/generators/generatedAssetResolver").GeneratedAssetResolver | null;
  // Phase 4 — sink for QA warnings produced inside buildElements. Mutated
  // in place. The campaign planner pulls these out into the plan's
  // `generated_assets_warnings` field. Pass an empty array; the builder
  // pushes strings.
  qaWarnings?: string[];
}

// ── Per-spec Midjourney resolver ─────────────────────────────────────────────
// Honors explicit assignments for this format. When an assignment exists for
// a (format, role) slot, it overrides the global default selection. Returns
// the resolved upload + the source assignment (if any) so the element
// builder can stamp `assignment_id` + `target_element_role` on the manifest.
interface ResolvedMidjourneySlot {
  upload_id: string | null;
  assignment: MidjourneyAssignment | null;
}
interface ResolvedMidjourneyForSpec {
  background: ResolvedMidjourneySlot;
  // Position-preserving array: index 0 = decorative_1, index 1 = decorative_2.
  // Either index can be null when no assignment + no global fallback exists.
  // buildElements honors the index → target_element_role mapping so a
  // decorative_2-only assignment renders in slot 2, not slot 1.
  decoratives: [ResolvedMidjourneySlot | null, ResolvedMidjourneySlot | null];
  hero: ResolvedMidjourneySlot;
}

function resolveMidjourneyForSpec(
  globalSelection: DemoAssetSelection["midjourney"],
  format: MidjourneyAssignmentFormat,
  assignments: MidjourneyAssignment[],
  approvedById: Map<string, MidjourneyUpload>,
): ResolvedMidjourneyForSpec {
  // Background — assignment wins over global.
  const bgAssignment = findAssignmentForSlot(assignments, format, "background");
  const background: ResolvedMidjourneySlot = bgAssignment
    ? { upload_id: bgAssignment.upload_id, assignment: bgAssignment }
    : { upload_id: globalSelection.background_upload_id, assignment: null };

  // Decoratives — slot 1 + slot 2 each resolved independently.
  // Track which globalSelection ids the slot-1 fallback consumed so slot 2
  // doesn't pick the same upload.
  const usedFromGlobal = new Set<string>();
  const dec1Assignment = findAssignmentForSlot(assignments, format, "decorative_1");
  const dec2Assignment = findAssignmentForSlot(assignments, format, "decorative_2");

  let slot1: ResolvedMidjourneySlot | null = null;
  if (dec1Assignment && approvedById.has(dec1Assignment.upload_id)) {
    slot1 = { upload_id: dec1Assignment.upload_id, assignment: dec1Assignment };
    usedFromGlobal.add(dec1Assignment.upload_id);
  } else {
    const fallback = globalSelection.decorative_upload_ids[0];
    if (fallback) {
      slot1 = { upload_id: fallback, assignment: null };
      usedFromGlobal.add(fallback);
    }
  }

  let slot2: ResolvedMidjourneySlot | null = null;
  if (dec2Assignment && approvedById.has(dec2Assignment.upload_id)) {
    slot2 = { upload_id: dec2Assignment.upload_id, assignment: dec2Assignment };
    usedFromGlobal.add(dec2Assignment.upload_id);
  } else {
    const fallback = globalSelection.decorative_upload_ids.find(
      (id) => !usedFromGlobal.has(id),
    );
    if (fallback) {
      slot2 = { upload_id: fallback, assignment: null };
      usedFromGlobal.add(fallback);
    }
  }
  const decoratives: ResolvedMidjourneyForSpec["decoratives"] = [slot1, slot2];

  // Hero — assignment wins; otherwise fall back to global hero. Note: the
  // existing pickVisualForSpec already prefers the mockup composite when
  // available; this override only kicks in via `pickVisualForSpec` reading
  // back the hero upload, which it already does for fallbacks.
  const heroAssignment = findAssignmentForSlot(assignments, format, "hero_visual");
  const hero: ResolvedMidjourneySlot = heroAssignment
    ? { upload_id: heroAssignment.upload_id, assignment: heroAssignment }
    : { upload_id: globalSelection.hero_upload_id, assignment: null };

  return { background, decoratives, hero };
}

export function buildAdSpec(args: BuildAdSpecArgs): DemoAdSpec {
  const {
    campaignId,
    conceptId,
    brandKit,
    selection,
    visual,
    cloudinaryDelivery,
    midjourneyById,
    midjourneyAssignments,
    copy,
    size,
    channel,
  } = args;
  const specId = `spec_demo_${size.name}`;
  const manifestId = `manifest_demo_${size.name}`;
  const templateUid = pickTemplateUid(brandKit, size) ?? `placeholder_${size.name}`;

  // Resolve per-spec Midjourney slot bindings from active assignments.
  // Format-specific assignments win over format=null; assignments win over
  // the global default selection.
  const specFormat = (size.name === "1200x628" ||
  size.name === "1080x1080" ||
  size.name === "1080x1920"
    ? size.name
    : null) as MidjourneyAssignmentFormat;
  const resolvedMidjourney = resolveMidjourneyForSpec(
    selection.midjourney,
    specFormat,
    midjourneyAssignments,
    midjourneyById,
  );

  const composition = args.composition ?? "text_leading";
  const template = args.template ?? "mockup_hero";
  const rendererHints = args.rendererHints ?? DEFAULT_RENDERER_HINTS;
  const baseLayoutRaw = computeLayout(size, brandKit, composition, rendererHints);
  // Carry the spec text→CTA gap into ComputedLayout so applyCtaPlacement
  // can use it when re-anchoring the CTA below the subheadline. Without
  // this, downstream uses a 20px default and the MEXEM spec gap is lost.
  const specSectionGaps =
    brandKit.layout.section_gaps_per_format?.[
      size.name as keyof NonNullable<typeof brandKit.layout.section_gaps_per_format>
    ];
  const specTextToCtaGap = specSectionGaps?.text_to_cta;
  const specLogoToTextGap = specSectionGaps?.logo_to_text;
  const baseLayout: ComputedLayout = {
    ...baseLayoutRaw,
    ...(specTextToCtaGap != null ? { textToCtaGap: specTextToCtaGap } : {}),
    ...(specLogoToTextGap != null ? { logoToTextGap: specLogoToTextGap } : {}),
  };
  const densityLayout = applyDensityToLayout(baseLayout, rendererHints);
  // Pre-compute the rendered CTA width and bake it into the layout BEFORE
  // composition placement runs. buildElements grows the CTA box to fit the
  // CTA text (Math.max with ctaSafeWidth), which means a placement like
  // bottom_center computed against the small computeLayout-default width
  // would render off-center. Mirroring the same character-budget formula
  // here keeps placement and rendered box aligned.
  const ctaTextLen = Math.max(8, copy.cta?.length ?? 12);
  const ctaCharBudgetPx = Math.ceil(densityLayout.cta.fontSize * 0.58 * ctaTextLen);
  const PRE_CTA_BREATHING = 128; // 96 px breathing + ~32 px arrow + space
  const finalCtaWidth = Math.max(
    densityLayout.cta.width,
    ctaCharBudgetPx + PRE_CTA_BREATHING,
  );
  const ctaSizedLayout: ComputedLayout = {
    ...densityLayout,
    cta: { ...densityLayout.cta, width: finalCtaWidth },
  };
  const langForLayout = LANG_META[args.language ?? "en"];
  const layout = applyCompositionFromSpec(
    ctaSizedLayout,
    size,
    rendererHints,
    langForLayout.rtl,
  );
  const elements = buildElements({
    campaignId,
    conceptId,
    size,
    layout,
    selection,
    visual,
    cloudinaryDelivery,
    midjourneyById,
    midjourney: resolvedMidjourney,
    brandKit,
    copy,
    composition,
    template,
    language: args.language ?? "en",
    patternStyle: args.patternStyle,
    motif: args.motif,
    designElements: args.designElements,
    rendererHints,
    generatedAssetResolver: args.generatedAssetResolver ?? null,
    qaWarnings: args.qaWarnings,
  });

  const manifest: ElementManifest = ElementManifestSchema.parse({
    manifestId,
    specId,
    conceptId,
    campaignId,
    bannerbearTemplateUid: templateUid,
    size: { width: size.width, height: size.height },
    elements,
    generatedAt: new Date().toISOString(),
    schemaVersion: "1.0.0",
  });

  return {
    specId,
    channel,
    size: { width: size.width, height: size.height },
    bannerbearTemplateUid: templateUid,
    copy,
    composite_metadata: visual.metadata,
    manifest,
  };
}

function pickTemplateUid(
  brandKit: BrandKitLite,
  size: { width: number; height: number },
): string | null {
  // brand kit's allowed_templates is a flat list. Without a size-keyed map at
  // this layer we cannot pick the right one — that's a future intake step.
  return brandKit.layout.allowed_templates[0] ?? null;
}

// ── Layout math ─────────────────────────────────────────────────────────────

interface ComputedLayout {
  margin: { top: number; right: number; bottom: number; left: number };
  riskWarningHeight: number;
  riskWarningBottomGap: number;
  logo: { x: number; y: number; width: number; height: number };
  ibkrLogo: { x: number; y: number; width: number; height: number } | null;
  headline: { x: number; y: number; width: number; height: number; fontSize: number };
  subheadline: { x: number; y: number; width: number; height: number; fontSize: number };
  cta: { x: number; y: number; width: number; height: number; fontSize: number };
  visual: { x: number; y: number; width: number; height: number } | null;
  riskWarning: { x: number; y: number; width: number; height: number; fontSize: number };
  // MEXEM spec — propagate per-format text→CTA gap so that the
  // downstream applyCtaPlacement / final snap-pass honors the spec gap
  // when repositioning the CTA relative to the subheadline (otherwise
  // bottom-anchor logic uses a 20px default and ignores spec values).
  textToCtaGap?: number;
  // MEXEM spec — same idea for logo→headline. The historic formula uses
  // `innerTop + logoH + gap` but the logo can sit higher than innerTop
  // (LOGO_CORNER_INSET = min(m.top, m.left)), so the rendered gap drifts
  // from the spec by `(innerTop - logo.y)`. The final snap-pass corrects
  // it by re-anchoring headline to `logo.y + logo.height + gap` and
  // sliding the dependent subheadline+CTA by the same delta.
  logoToTextGap?: number;
}

// ── Format classifier ───────────────────────────────────────────────────────
// Every layout / typography / logo decision in this file used to be gated on
// `size.name === "1200x628" / "1080x1080" / "1080x1920"`. That worked when
// only 3 formats existed, but adding new sizes (1200x675, 1500x500, etc.)
// silently fell through into whichever else-branch was last — so a 1500×500
// wide banner accidentally got a 1080×1920 portrait layout.
//
// `classifyFormat` derives the routing intent from aspect ratio + absolute
// height instead of from a magic string. Buckets:
//   - ultra_wide : AR > 2.5  (1500x500 = 3.0)
//   - wide       : AR ≥ 1.4  (1200x628 = 1.91, 1200x675 = 1.78, 1920x1080 = 1.78)
//   - square     : 0.95–1.05 (1080x1080, 1200x1200)
//   - portrait   : 0.65–0.94 (1080x1350)
//   - tall_portrait : AR < 0.65 (1080x1920 = 0.5625)
// height_class is independent — drives "is this canvas vertically tight?" so
// even a wide format gets aggressive font caps when the canvas is short.
type FormatBucket =
  | "ultra_wide"
  | "wide"
  | "square"
  | "portrait"
  | "tall_portrait";
type FormatHeightClass = "tight" | "medium" | "tall";

function classifyFormat(size: { width: number; height: number }): {
  bucket: FormatBucket;
  height_class: FormatHeightClass;
  is_wideish: boolean; // wide || ultra_wide — the "landscape" group
} {
  const ar = size.width / size.height;
  const bucket: FormatBucket =
    ar > 2.5
      ? "ultra_wide"
      : ar >= 1.4
        ? "wide"
        : ar >= 0.95
          ? "square"
          : ar >= 0.65
            ? "portrait"
            : "tall_portrait";
  const height_class: FormatHeightClass =
    size.height < 720 ? "tight" : size.height < 1280 ? "medium" : "tall";
  return {
    bucket,
    height_class,
    is_wideish: bucket === "wide" || bucket === "ultra_wide",
  };
}

function computeLayout(
  size: { name: string; width: number; height: number },
  kit: BrandKitLite,
  composition: CompositionKind = "text_leading",
  hints: RendererHints = DEFAULT_RENDERER_HINTS,
): ComputedLayout {
  const fmt = classifyFormat(size);
  const rawM = kit.layout.outer_margins?.[size.name as "1200x628" | "1080x1080" | "1080x1920"] ?? {
    top: 71,
    right: 50,
    bottom: 180,
    left: 50,
  };
  // Step 6 — apply spacing.padding multiplier to outer margins. Each side is
  // floored so disclaimer-clearance / safe-area commitments hold even when
  // the AI asks for "tight" padding. The bottom floor is the strictest: the
  // disclaimer band sits inside this margin and the renderer assumes ≥70%
  // of the original bottom margin to fit it without clipping.
  const SIDE_FLOOR = 24;
  const m = {
    top: Math.max(SIDE_FLOOR, Math.round(rawM.top * hints.marginMultiplier)),
    right: Math.max(SIDE_FLOOR, Math.round(rawM.right * hints.marginMultiplier)),
    bottom: Math.max(
      Math.round(rawM.bottom * 0.7),
      Math.round(rawM.bottom * hints.marginMultiplier),
    ),
    left: Math.max(SIDE_FLOOR, Math.round(rawM.left * hints.marginMultiplier)),
  };

  const rawSizes = kit.typography.sizes_per_format?.[
    size.name as "1200x628" | "1080x1080" | "1080x1920"
  ];
  const baseHeadline = rawSizes?.headline ?? 100;
  const baseCta = rawSizes?.cta ?? 35;
  const baseBody = rawSizes?.body ?? 35;
  const baseRisk = rawSizes?.disclaimer ?? 35;

  const minRisk = kit.legal.min_disclaimer_font_size ?? 14;

  // Scale the headline down for vertically-tight formats. The original 3
  // sizes (1200x628 wide-tight, 1080x1080 square, 1080x1920 portrait-tall)
  // keep their historic caps verbatim. New formats are routed through the
  // bucket+height classifier:
  //   - ultra_wide (1500x500)   : 56  — very tight, 3:1 AR
  //   - wide+tight (1200x675)   : 64  — same as 1200x628
  //   - wide+medium (1920x1080) : 110 — full HD has room, near-cap=brand kit value
  //   - square+wide (1200x1200) : 96  — slightly bigger than 1080x1080
  //   - portrait (1080x1350)    : 100 — uncapped (4:5 still has vertical room)
  //   - tall_portrait (1080x1920): uncapped
  let headlineSize = baseHeadline;
  if (size.name === "1200x628") headlineSize = Math.min(baseHeadline, 64);
  else if (size.name === "1080x1080") headlineSize = Math.min(baseHeadline, 84);
  else if (size.name === "1080x1920") {/* keep full headline */}
  else if (fmt.bucket === "ultra_wide") headlineSize = Math.min(baseHeadline, 56);
  else if (fmt.bucket === "wide" && fmt.height_class === "tight")
    headlineSize = Math.min(baseHeadline, 64);
  else if (fmt.bucket === "wide") headlineSize = Math.min(baseHeadline, 110);
  else if (fmt.bucket === "square") headlineSize = Math.min(baseHeadline, 96);
  // portrait + tall_portrait: no cap.

  // Step 6 — apply hierarchy.emphasis_level × text_strategy.headline_scale.
  // Floor at the per-format readable minimum so "compact" can't make the
  // headline disappear; ceiling at +50% over the per-format cap so "hero"
  // still has fitFontToBox shrink-to-fit room downstream.
  const HEADLINE_FLOOR = 36;
  headlineSize = Math.round(headlineSize * hints.headlineSizeMultiplier);
  headlineSize = Math.max(HEADLINE_FLOOR, headlineSize);

  // Scale CTA / body / risk per format. The brand kit defaults the
  // disclaimer to 35px AND sets `min_disclaimer_font_size: 35` (a config
  // mistake — that field is meant for the legal floor, not body size).
  // We ignore the brand kit's stated minimum and hard-cap each format to
  // a "small but readable" size, with a built-in 12px legal floor that's
  // safely above the typical securities-disclaimer requirements (8-10pt).
  const LEGAL_DISCLAIMER_FLOOR = 12;
  // CTA / body / disclaimer scale-down per format. Original 3 keep their
  // historic numbers; new formats route through the bucket classifier.
  let ctaSize = baseCta;
  let bodySize = baseBody;
  let disclaimerCap: number;
  if (size.name === "1200x628") {
    ctaSize = Math.min(baseCta, 28);
    // Body cap was 22 — too close to the disclaimer's 14 (only the
    // disclaimer is meant to be that small). Bumped to 28 so the
    // subheadline reads as readable supporting copy, not legal microtype.
    bodySize = Math.min(baseBody, 28);
    disclaimerCap = 14;
  } else if (size.name === "1080x1080") {
    disclaimerCap = 18;
  } else if (size.name === "1080x1920") {
    disclaimerCap = 22;
  } else if (fmt.bucket === "ultra_wide") {
    // 1500x500 — tight vertical. Body still bumped slightly above the
    // disclaimer cap so the hierarchy reads.
    ctaSize = Math.min(baseCta, 24);
    bodySize = Math.min(baseBody, 22);
    disclaimerCap = 12;
  } else if (fmt.bucket === "wide" && fmt.height_class === "tight") {
    // 1200x675 — same envelope as 1200x628 (incl. bumped body cap).
    ctaSize = Math.min(baseCta, 28);
    bodySize = Math.min(baseBody, 28);
    disclaimerCap = 14;
  } else if (fmt.bucket === "wide") {
    // 1920x1080 — generous. Keep brand-kit values, allow bigger disclaimer.
    disclaimerCap = 22;
  } else if (fmt.bucket === "square") {
    // 1200x1200 — slightly more breathing room than 1080x1080.
    disclaimerCap = 20;
  } else {
    // portrait / tall_portrait (1080x1350) — same envelope as 1080x1920.
    disclaimerCap = 22;
  }
  let riskSize = Math.max(LEGAL_DISCLAIMER_FLOOR, Math.min(baseRisk, disclaimerCap));
  // Reference minRisk so the explicit-unused-vars rule stays quiet — its
  // value is honored only when smaller than disclaimerCap (typical case).
  if (minRisk < disclaimerCap) riskSize = Math.max(minRisk, riskSize);

  const innerLeft = m.left;
  const innerRight = size.width - m.right;
  const innerTop = m.top;
  const innerBottom = size.height - m.bottom;

  const riskWarningHeight = Math.round(riskSize * 1.6);
  const riskWarningBottomGap = Math.round(m.bottom / 2);

  // MEXEM spec — per-format section gaps win when present. Defaults match
  // the prior hardcoded values (48 logo→headline, 20 sub→CTA) so formats
  // without an entry keep the historic look.
  const specGaps =
    kit.layout.section_gaps_per_format?.[
      size.name as keyof NonNullable<typeof kit.layout.section_gaps_per_format>
    ];
  const GAP_LOGO_TO_TEXT = specGaps?.logo_to_text ?? 48;
  const GAP_TEXT_TO_CTA = specGaps?.text_to_cta ?? 20;

  // MEXEM spec — per-format element box dimensions. Text width, CTA
  // width/height, and risk-message width/height come from the spec when
  // present; otherwise the existing derived values are used.
  const specElements =
    kit.layout.element_sizes_per_format?.[
      size.name as keyof NonNullable<typeof kit.layout.element_sizes_per_format>
    ];
  const SPEC_TEXT_WIDTH = specElements?.text?.width
    ? Math.round(specElements.text.width)
    : undefined;
  const SPEC_CTA_WIDTH = specElements?.cta?.width
    ? Math.round(specElements.cta.width)
    : undefined;
  const SPEC_CTA_HEIGHT = specElements?.cta?.height
    ? Math.round(specElements.cta.height)
    : undefined;
  const SPEC_RISK_WIDTH = specElements?.risk_message?.width
    ? Math.round(specElements.risk_message.width)
    : undefined;
  const SPEC_RISK_HEIGHT = specElements?.risk_message?.height
    ? Math.round(specElements.risk_message.height)
    : undefined;
  // When the spec risk-message width is narrower than the canvas (e.g.
  // 1080x1920 has a 938-wide risk band on a 1080 canvas), center the band
  // horizontally. Otherwise stick to the existing left-anchor at innerLeft.
  const RISK_X = SPEC_RISK_WIDTH
    ? Math.round((size.width - SPEC_RISK_WIDTH) / 2)
    : undefined;
  // MEXEM spec — product_visual dimensions per format. Wired into the
  // "phone right" / visual-leading branches that already place the visual
  // on the right edge of the canvas. Branches that put the visual at a
  // bottom-full-width band (1080x1920 / 960x1200 in the spec) are NOT
  // overridden here — they need composition-aware positioning which
  // arrives with the variant selector (data captured under
  // composition_variants_per_format awaiting that work).
  const SPEC_VISUAL_WIDTH = specElements?.product_visual?.width
    ? Math.round(specElements.product_visual.width)
    : undefined;
  const SPEC_VISUAL_HEIGHT = specElements?.product_visual?.height
    ? Math.round(specElements.product_visual.height)
    : undefined;

  // MEXEM spec — explicit logo box per format wins when present. Falls
  // back to the canvas-percent + variant-aspect derivation otherwise.
  const logoOverride =
    kit.logo.size_per_format?.[size.name as keyof NonNullable<typeof kit.logo.size_per_format>];
  const logoH = logoOverride ? Math.round(logoOverride.height) : pickLogoHeight(size, hints);
  // Logo aspect ratio depends on which MEXEM variant pickBrandLogoVariant
  // will pick at render time:
  //   - LANDSCAPE banners (1200x628) use "logo-white-v.png" — wide wordmark
  //     with the "Powered by IB" sub-line laid out horizontally. ~4:1 ratio.
  //   - SQUARE / PORTRAIT banners (1080x1080, 1080x1920) use "logo-white-p.png"
  //     — wordmark with the sub-line STACKED below it. ~1.6:1 ratio.
  //
  // Setting the bbox to the wrong ratio + object-fit:contain produced a
  // visible asymmetry on portrait: the logo bounding box was at (50,50)
  // but the visible wordmark was centered inside an oversized 352×88 box,
  // landing at x≈200. The visible distance from the left edge no longer
  // matched the 50 px top inset. Match the bbox to the actual variant.
  const isPortraitVariant = size.height > size.width; // matches pickBrandLogoVariant's choice
  const logoAspect = isPortraitVariant ? 1.6 : 4;
  const logoW = logoOverride
    ? Math.round(logoOverride.width)
    : Math.round(logoH * logoAspect);
  // Brand rule (operator-set): MEXEM logo lives in the top-LEFT corner
  // with EQUAL distance from the top edge and the left edge. The kit's
  // m.top / m.left may differ; we use a single LOGO_CORNER_INSET so the
  // corner inset is symmetric. inset is taken from the smaller of the
  // two so the logo never crashes into the kit's safe area.
  // MEXEM spec — per-format override for centered/right-anchored layouts
  // (1080x1920 + 960x1200 want logo top-center per spec).
  const LOGO_CORNER_INSET = Math.max(24, Math.min(m.top, m.left));
  const logoPos =
    kit.layout.logo_position_per_format?.[
      size.name as keyof NonNullable<typeof kit.layout.logo_position_per_format>
    ] ?? "top-left";
  const logoX =
    logoPos === "top-center"
      ? Math.round((size.width - logoW) / 2)
      : logoPos === "top-right"
        ? size.width - LOGO_CORNER_INSET - logoW
        : LOGO_CORNER_INSET;
  const logo = {
    x: logoX,
    y: LOGO_CORNER_INSET,
    width: logoW,
    height: logoH,
  };

  // IBKR partner badge — top-RIGHT corner on any wide / ultra-wide format
  // (mirror of MEXEM top-left), bottom-right corner on square / portrait /
  // tall_portrait. Same equal-inset rule on landscape so both corners read
  // as a paired set. Was hard-coded to "1200x628" before; now uses the
  // format bucket so 1200x675, 1500x500, 1920x1080 also get the top-right
  // pairing.
  const ibkrW = Math.round(logoW * 0.7);
  const ibkrH = Math.round(logoH * 0.7);
  const ibkrLogo: ComputedLayout["ibkrLogo"] =
    fmt.is_wideish
      ? {
          x: size.width - LOGO_CORNER_INSET - ibkrW,
          y: LOGO_CORNER_INSET,
          width: ibkrW,
          height: ibkrH,
        }
      : {
          x: innerRight - ibkrW,
          y: innerBottom - ibkrH,
          width: ibkrW,
          height: ibkrH,
        };

  // Lay out per-format. The original 3 formats (1200x628 / 1080x1080 /
  // 1080x1920) had dedicated branches; new formats route into the closest
  // bucket here so they inherit the right composition + spacing logic
  // instead of falling through to the portrait fallback.
  //
  //   wide / ultra_wide  → wide-banner branch  (1200x628, 1200x675,
  //                                              1500x500, 1920x1080)
  //   square             → square branch        (1080x1080, 1200x1200)
  //   portrait / tall_portrait → portrait fall-through  (1080x1350,
  //                                                       1080x1920)
  if (fmt.is_wideish) {
    const ctaH = SPEC_CTA_HEIGHT ?? Math.max(56, Math.round(ctaSize * 2));
    const ctaW = SPEC_CTA_WIDTH ?? Math.max(180, Math.round(ctaSize * 8));
    const headlineH = Math.round(headlineSize * 1.2 * 2); // up to 2 lines
    const subH = Math.round(bodySize * 1.4 * 2); // up to 2 lines

    if (composition === "visual_leading") {
      // Brand rule (operator-set, see BANNER_REFERENCE_RULES.md): the text
      // BLOCK must always sit on the reading-start side of the canvas (left
      // for LTR / right for RTL) or centered — NEVER on the reading-end
      // side. Earlier this branch placed the text block on the RIGHT for
      // visual_leading, which both violated the rule and parked the
      // headline directly under the top-right yellow decoratives — yellow
      // emphasis text disappeared into yellow shapes (see report 2026-05).
      //
      // Layout below mirrors the previous version: text on the LEFT,
      // visual on the RIGHT. The composition name still means "lead with
      // the visual in the AI's mental model"; the rendered layout just
      // honours the text-position invariant. RTL formats can flip back via
      // a separate guard later if needed.
      const visualW = SPEC_VISUAL_WIDTH ?? Math.round((size.width - m.left - m.right) * 0.45);
      const visualX = innerRight - visualW;
      const visualY = innerTop + 8;
      const visualH = SPEC_VISUAL_HEIGHT ?? innerBottom - visualY;
      const textX = innerLeft;
      const textWidth = SPEC_TEXT_WIDTH ?? visualX - textX - 24;
      const headlineY = innerTop + logoH + GAP_LOGO_TO_TEXT;
      const subY = headlineY + headlineH + 12;
      const ctaY = subY + subH + GAP_TEXT_TO_CTA;
      return {
        margin: m,
        riskWarningHeight,
        riskWarningBottomGap,
        logo,
        ibkrLogo,
        headline: { x: textX, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
        subheadline: { x: textX, y: subY, width: textWidth, height: subH, fontSize: bodySize },
        cta: { x: textX, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
        visual: { x: visualX, y: visualY, width: visualW, height: visualH },
        riskWarning: {
          x: RISK_X ?? innerLeft,
          y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
          width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
          height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
          fontSize: riskSize,
        },
      };
    }

    if (composition === "hero_overlay") {
      // Visual fills the canvas; text sits anchored at the bottom-left,
      // sized down so it stays in a comfortable reading band over the image.
      const heroHeadlineSize = Math.round(headlineSize * 0.85);
      const heroHeadlineH = Math.round(heroHeadlineSize * 1.2 * 2);
      // Sub box height: 2 lines worth (matches the other compositions in this
      // branch). Was 1 line (bodySize*1.35) which forced fitFontToBox to
      // shrink the font to fit any sub text that wraps — the result on
      // 1200x628 was the subheadline rendering at ~20px, indistinguishable
      // from the disclaimer. The wide+tight branch still fits both the
      // headline and logo above this taller sub box (headlineY ≈ 164 on
      // 1200x628 vs logo bottom ≈ 106).
      const heroSubH = Math.round(bodySize * 1.4 * 2);
      const ctaY2 = innerBottom - ctaH;
      const subY2 = ctaY2 - heroSubH - 12;
      const headlineY2 = subY2 - heroHeadlineH - 8;
      const textWidth = SPEC_TEXT_WIDTH ?? Math.round((size.width - m.left - m.right) * 0.6);
      return {
        margin: m,
        riskWarningHeight,
        riskWarningBottomGap,
        logo,
        ibkrLogo,
        headline: { x: innerLeft, y: headlineY2, width: textWidth, height: heroHeadlineH, fontSize: heroHeadlineSize },
        subheadline: { x: innerLeft, y: subY2, width: textWidth, height: heroSubH, fontSize: bodySize },
        cta: { x: innerLeft, y: ctaY2, width: ctaW, height: ctaH, fontSize: ctaSize },
        visual: { x: 0, y: 0, width: size.width, height: size.height },
        riskWarning: {
          x: RISK_X ?? innerLeft,
          y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
          width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
          height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
          fontSize: riskSize,
        },
      };
    }

    // Default: text_leading — text on the left, visual on the right.
    const textWidth = SPEC_TEXT_WIDTH ?? Math.round((size.width - m.left - m.right) * 0.55);
    const headlineX = innerLeft;
    const headlineY = innerTop + logoH + GAP_LOGO_TO_TEXT;
    const subY = headlineY + headlineH + 12;
    const ctaY = subY + subH + GAP_TEXT_TO_CTA;
    const visualX = innerLeft + textWidth + 24;
    const visualY = innerTop + 8;
    const visualW = SPEC_VISUAL_WIDTH ?? innerRight - visualX;
    const visualH = SPEC_VISUAL_HEIGHT ?? innerBottom - visualY;
    return {
      margin: m,
      riskWarningHeight,
      riskWarningBottomGap,
      logo,
      ibkrLogo,
      headline: { x: headlineX, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
      subheadline: { x: headlineX, y: subY, width: textWidth, height: subH, fontSize: bodySize },
      cta: { x: headlineX, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
      visual: { x: visualX, y: visualY, width: visualW, height: visualH },
      riskWarning: {
        x: RISK_X ?? innerLeft,
        y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
        width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
        height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
        fontSize: riskSize,
      },
    };
  }

  if (fmt.bucket === "square") {
    const textWidth = SPEC_TEXT_WIDTH ?? size.width - m.left - m.right;
    const headlineH = Math.round(headlineSize * 1.15 * 2);
    const subH = Math.round(bodySize * 1.4 * 2);
    const ctaH = SPEC_CTA_HEIGHT ?? Math.max(72, Math.round(ctaSize * 2.2));
    const ctaW = SPEC_CTA_WIDTH ?? Math.max(220, Math.round(ctaSize * 9));

    if (composition === "visual_leading") {
      // Visual on top, text + CTA below. The visualH must leave room for
      // the text-plus-CTA stack — otherwise CTA gets clamped onto the
      // subheadline by applyCompositionFromSpec downstream. We compute
      // the required text-stack height first and back-solve visualH from
      // what's left, with a 240 px floor so the visual stays usable.
      const visualY = innerTop + logoH + 16;
      const TEXT_STACK_GAPS = 24 + 16 + 16; // visual→headline + headline→sub + sub→CTA
      const requiredTextH = headlineH + subH + ctaH + TEXT_STACK_GAPS;
      const availableForVisual = innerBottom - visualY - requiredTextH;
      const VISUAL_H_FLOOR = 240;
      const VISUAL_H_DEFAULT = 380;
      const visualH = Math.max(
        VISUAL_H_FLOOR,
        Math.min(VISUAL_H_DEFAULT, availableForVisual),
      );
      const headlineY = visualY + visualH + 24;
      const subY = headlineY + headlineH + 16;
      const ctaY = subY + subH + (specGaps?.text_to_cta ?? 16);
      return {
        margin: m,
        riskWarningHeight,
        riskWarningBottomGap,
        logo,
        ibkrLogo,
        headline: { x: innerLeft, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
        subheadline: { x: innerLeft, y: subY, width: textWidth, height: subH, fontSize: bodySize },
        cta: { x: innerLeft, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
        visual: { x: innerLeft, y: visualY, width: textWidth, height: visualH },
        riskWarning: {
          x: RISK_X ?? innerLeft,
          y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
          width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
          height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
          fontSize: riskSize,
        },
      };
    }

    if (composition === "hero_overlay") {
      // Visual fills the square; text + CTA overlay the lower third.
      const heroHeadlineSize = Math.round(headlineSize * 0.9);
      const heroHeadlineH = Math.round(heroHeadlineSize * 1.15 * 2);
      const ctaY2 = innerBottom - ctaH;
      const subY2 = ctaY2 - subH - 16;
      const headlineY2 = subY2 - heroHeadlineH - 12;
      return {
        margin: m,
        riskWarningHeight,
        riskWarningBottomGap,
        logo,
        ibkrLogo,
        headline: { x: innerLeft, y: headlineY2, width: textWidth, height: heroHeadlineH, fontSize: heroHeadlineSize },
        subheadline: { x: innerLeft, y: subY2, width: textWidth, height: subH, fontSize: bodySize },
        cta: { x: innerLeft, y: ctaY2, width: ctaW, height: ctaH, fontSize: ctaSize },
        visual: { x: 0, y: 0, width: size.width, height: size.height },
        riskWarning: {
          x: RISK_X ?? innerLeft,
          y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
          width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
          height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
          fontSize: riskSize,
        },
      };
    }

    // Default: text_leading — text on top, visual below, CTA at the bottom.
    const headlineY = innerTop + logoH + (specGaps?.logo_to_text ?? 56);
    const subY = headlineY + headlineH + 16;
    const visualY = subY + subH + 24;
    const visualH = Math.max(280, innerBottom - visualY - 120);
    const ctaY = visualY + visualH + 16;
    return {
      margin: m,
      riskWarningHeight,
      riskWarningBottomGap,
      logo,
      ibkrLogo,
      headline: { x: innerLeft, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
      subheadline: { x: innerLeft, y: subY, width: textWidth, height: subH, fontSize: bodySize },
      cta: { x: innerLeft, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
      visual: { x: innerLeft, y: visualY, width: textWidth, height: visualH },
      riskWarning: {
        x: RISK_X ?? innerLeft,
        y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
        width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
        height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
        fontSize: riskSize,
      },
    };
  }

  // 1080x1920
  const textWidth = SPEC_TEXT_WIDTH ?? size.width - m.left - m.right;
  const headlineH = Math.round(headlineSize * 1.1 * 3);
  const subH = Math.round(bodySize * 1.4 * 3);
  const ctaH = SPEC_CTA_HEIGHT ?? Math.max(80, Math.round(ctaSize * 2.4));
  const ctaW = SPEC_CTA_WIDTH ?? Math.max(260, Math.round(ctaSize * 10));

  if (composition === "visual_leading") {
    // Visual fills the upper portion of the story; text + CTA below. As
    // with 1080x1080, back-solve visualH from the required text-stack
    // height so CTA never lands below the disclaimer band. 600 px floor
    // keeps the visual genuinely "leading" rather than a thumbnail.
    const visualY = innerTop + logoH + 24;
    const TEXT_STACK_GAPS = 40 + 20 + 28;
    const requiredTextH = headlineH + subH + ctaH + TEXT_STACK_GAPS;
    const availableForVisual = innerBottom - visualY - requiredTextH;
    const VISUAL_H_FLOOR = 600;
    const VISUAL_H_DEFAULT = 700;
    const visualH = Math.max(
      VISUAL_H_FLOOR,
      Math.min(VISUAL_H_DEFAULT, availableForVisual),
    );
    const headlineY = visualY + visualH + 40;
    const subY = headlineY + headlineH + 20;
    const ctaY = subY + subH + (specGaps?.text_to_cta ?? 28);
    const ctaX = innerLeft + Math.round((textWidth - ctaW) / 2);
    return {
      margin: m,
      riskWarningHeight,
      riskWarningBottomGap,
      logo,
      ibkrLogo,
      headline: { x: innerLeft, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
      subheadline: { x: innerLeft, y: subY, width: textWidth, height: subH, fontSize: bodySize },
      cta: { x: ctaX, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
      visual: { x: innerLeft, y: visualY, width: textWidth, height: visualH },
      riskWarning: {
        x: RISK_X ?? innerLeft,
        y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
        width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
        height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
        fontSize: riskSize,
      },
    };
  }

  if (composition === "hero_overlay") {
    // 1080x1920 hero_overlay redesigned to vertically-center the text block
    // instead of bottom-anchoring it. The original "text overlays lower
    // third" left ~1100px of dead space above the headline on portrait
    // story formats. Now we compute the block height (headline + sub +
    // gaps + CTA) and center it vertically inside the inner area, with
    // the disclaimer still anchored to the bottom margin. Result: top
    // and bottom negative space are roughly balanced — composed, not
    // empty.
    const heroHeadlineSize = Math.round(headlineSize * 0.9);
    const heroHeadlineH = Math.round(heroHeadlineSize * 1.1 * 3);
    const ctaX = innerLeft + Math.round((textWidth - ctaW) / 2);
    const blockHeight = heroHeadlineH + 24 + subH + 32 + ctaH;
    // Center the block vertically inside the inner area, then nudge it
    // 8% lower-of-center so the eye reads "logo on top, focal text below
    // mid, breath at the bottom" — better tension than dead-center.
    const innerH = innerBottom - innerTop;
    const blockTop = innerTop + Math.round((innerH - blockHeight) / 2 + innerH * 0.04);
    const headlineY2 = blockTop;
    const subY2 = headlineY2 + heroHeadlineH + 24;
    const ctaY2 = subY2 + subH + (specGaps?.text_to_cta ?? 32);
    return {
      margin: m,
      riskWarningHeight,
      riskWarningBottomGap,
      logo,
      ibkrLogo,
      headline: { x: innerLeft, y: headlineY2, width: textWidth, height: heroHeadlineH, fontSize: heroHeadlineSize },
      subheadline: { x: innerLeft, y: subY2, width: textWidth, height: subH, fontSize: bodySize },
      cta: { x: ctaX, y: ctaY2, width: ctaW, height: ctaH, fontSize: ctaSize },
      visual: { x: 0, y: 0, width: size.width, height: size.height },
      riskWarning: {
        x: RISK_X ?? innerLeft,
        y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
        width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
        height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
        fontSize: riskSize,
      },
    };
  }

  // Default: text_leading — text on top, visual middle, CTA bottom.
  const headlineY = innerTop + logoH + (specGaps?.logo_to_text ?? 64);
  const subY = headlineY + headlineH + 24;
  const visualY = subY + subH + 48;
  const visualH = Math.max(480, Math.min(900, size.height - visualY - 320));
  const ctaX = innerLeft + Math.round((textWidth - ctaW) / 2);
  const ctaY = visualY + visualH + 32;

  return {
    margin: m,
    riskWarningHeight,
    riskWarningBottomGap,
    logo,
    ibkrLogo,
    headline: { x: innerLeft, y: headlineY, width: textWidth, height: headlineH, fontSize: headlineSize },
    subheadline: { x: innerLeft, y: subY, width: textWidth, height: subH, fontSize: bodySize },
    cta: { x: ctaX, y: ctaY, width: ctaW, height: ctaH, fontSize: ctaSize },
    visual: { x: innerLeft, y: visualY, width: textWidth, height: visualH },
    riskWarning: {
      x: RISK_X ?? innerLeft,
      y: size.height - m.bottom + riskWarningBottomGap - riskWarningHeight,
      width: SPEC_RISK_WIDTH ?? size.width - m.left - m.right,
      height: SPEC_RISK_HEIGHT ?? riskWarningHeight,
      fontSize: riskSize,
    },
  };
}

// Step 6 — pure post-pass that re-spaces the headline / subheadline / CTA
// stack according to hints.innerGapMultiplier (driven by spacing.density).
// Kept as a post-pass instead of threading the multiplier through every
// per-format layout branch — that would touch ~30 inline gap constants
// across 6 layout permutations and make the layout math harder to read.
//
// Safety: the CTA can only move within the band between subheadline and
// the disclaimer's top edge. When the multiplier would push it past the
// disclaimer's ceiling, we clamp instead of letting the CTA crash into
// legal copy. That makes "minimal" always work and "rich" degrade
// gracefully on already-tight layouts (e.g., 1200x628 hero_overlay).
function applyDensityToLayout(
  layout: ComputedLayout,
  hints: RendererHints,
): ComputedLayout {
  const m = hints.innerGapMultiplier;
  if (m === 1) return layout;
  const headlineBottom = layout.headline.y + layout.headline.height;
  const subBottom = layout.subheadline.y + layout.subheadline.height;
  const gapHeadlineToSub = layout.subheadline.y - headlineBottom;
  const gapSubToCta = layout.cta.y - subBottom;
  // Floor each gap so blocks never collide. Ceiling so absurd values don't
  // produce ugly empty space when fonts shrink.
  const newGapHeadlineToSub = Math.max(4, Math.round(gapHeadlineToSub * m));
  const newGapSubToCta = Math.max(8, Math.round(gapSubToCta * m));
  const newSubY = headlineBottom + newGapHeadlineToSub;
  const naiveCtaY = newSubY + layout.subheadline.height + newGapSubToCta;
  // Clamp the CTA so it can't slide under the disclaimer band.
  const ctaCeiling = layout.riskWarning.y - layout.cta.height - 24;
  const safeCtaY = Math.min(naiveCtaY, ctaCeiling);
  return {
    ...layout,
    subheadline: { ...layout.subheadline, y: newSubY },
    cta: { ...layout.cta, y: safeCtaY },
  };
}

// Step 7 — pure post-pass that adjusts horizontal anchors, visual region
// size/position, CTA placement, and CTA width based on the spec's
// composition fields. Runs AFTER applyDensityToLayout so density gaps are
// preserved when CTA placement is "auto".
//
// Design constraints (per Step 7 brief):
//   - No new format/composition branches in computeLayout. Each adjustment
//     is a numeric mutation on layout.{element}.{x,y,width}.
//   - Every output position is clamped against innerLeft / innerRight /
//     riskWarning so the disclaimer band, logo edge, and inner safe area
//     stay protected even on hostile spec values.
//   - Unsafe combinations (CTA top_right colliding with the IBKR badge,
//     headline_position=center with too-narrow text) downgrade to the
//     closest safe alternative rather than failing.
//   - RTL-aware: headline_position=left in Hebrew anchors the block to
//     the right (reading start). Same for ctaPlacement.{bottom_left,
//     bottom_right, inline_with_headline, top_right}.
//
// When every Step-7 hint is "auto" / "normal" the function returns the
// input layout unchanged (DEFAULT_RENDERER_HINTS path), preserving today's
// pixel-identical output.
function applyCompositionFromSpec(
  layout: ComputedLayout,
  size: { width: number; height: number },
  hints: RendererHints,
  isRtl: boolean,
): ComputedLayout {
  // No early-return on allAuto — the logo-clearance clamp at the bottom
  // of this function is ALWAYS-ON (it's a safety guarantee, not a hint).
  // computeLayout's hero_overlay branch can produce a headline.y above
  // the logo when the headline is unusually tall (Step 6 hero+bold scale
  // on a tight format like 1200x628). The clamp catches that case.
  const m = layout.margin;
  const innerLeft = m.left;
  const innerRight = size.width - m.right;
  const innerW = innerRight - innerLeft;
  const ctaCeiling = layout.riskWarning.y - 24;

  let next: ComputedLayout = {
    ...layout,
    headline: { ...layout.headline },
    subheadline: { ...layout.subheadline },
    cta: { ...layout.cta },
    visual: layout.visual ? { ...layout.visual } : null,
  };

  // hero_overlay-style layouts use a full-canvas "visual" region (the
  // background fills the canvas; text floats over it). Resizing or
  // swapping that region would break the composition — visual_position
  // and visual_weight only apply to side-by-side layouts (mockup_hero
  // text_leading / visual_leading). Detection: visual covers ≥95% of
  // both axes.
  const visualIsFullCanvas =
    next.visual !== null &&
    next.visual.width >= size.width * 0.95 &&
    next.visual.height >= size.height * 0.95;

  // Stacked layouts (1080x1080 / 1080x1920 default text_leading: visual
  // BELOW the text, full-inner-width) are not side-by-side. visual_weight
  // and visual_position swap logic assumes a horizontal pairing and would
  // incorrectly carve the headline into a narrow column. Detect by
  // checking whether visual is vertically separated from headline.
  const visualIsStacked =
    next.visual !== null &&
    !visualIsFullCanvas &&
    (next.visual.y >= next.headline.y + next.headline.height ||
      next.visual.y + next.visual.height <= next.headline.y);

  // ── 1. visual_position swap (left/right/background) ─────────────────────
  // left/right: when the existing layout has the visual on one side and
  // the spec asks for the other, swap their x-anchors.
  //
  // Step 10 — "background": no-op for layouts already full-canvas
  // (pattern_immersive / editorial_type / any hero_overlay-shaped output);
  // silently downgrade for side-panel layouts (mockup_hero text/visual_
  // leading) where there's no full-canvas-mockup builder. The downgrade
  // path produces today's behavior — visual remains a side panel — so
  // the spec value is informational rather than destructive.
  if (
    next.visual &&
    (hints.visualPosition === "left" || hints.visualPosition === "right") &&
    !visualIsFullCanvas &&
    !visualIsStacked
  ) {
    const visualOnLeftToday =
      next.visual.x + next.visual.width / 2 < next.headline.x + next.headline.width / 2;
    const wantsLeft = hints.visualPosition === "left";
    if (visualOnLeftToday !== wantsLeft) {
      const oldVisualX = next.visual.x;
      const oldTextX = next.headline.x;
      next.visual.x = oldTextX;
      next.headline.x = oldVisualX;
      next.subheadline.x = oldVisualX;
      // CTA only follows when its placement is "auto" — explicit ctaPlacement
      // wins below.
      if (hints.ctaPlacement === "auto") next.cta.x = oldVisualX;
    }
  }
  // visualPosition=="background" is intentionally a no-op here — the
  // layout is already configured per template. Pattern_immersive and
  // editorial_type already render a full-canvas decorative; mockup_hero
  // keeps its side-panel mockup (downgrade path). Step 5's layout_type
  // is the place to ask for a full-canvas-mockup transformation.

  // ── 2. visual_weight scale ───────────────────────────────────────────────
  // Resize the visual region as a percentage of the inner content area.
  // Falls back to "auto" when the resize would leave too little room for
  // the text (TEXT_FLOOR_PX). Floors / ceilings keep both regions usable.
  if (
    next.visual &&
    hints.visualWeight !== "auto" &&
    !visualIsFullCanvas &&
    !visualIsStacked
  ) {
    const PCT_MAP = { subtle: 0.3, balanced: 0.5, dominant: 0.62 } as const;
    const TEXT_FLOOR_PX = 240;
    const targetVisualW = Math.round(innerW * PCT_MAP[hints.visualWeight]);
    const visualOnLeft = next.visual.x <= innerLeft + 4;
    const proposedTextW = innerW - targetVisualW - 24;
    if (proposedTextW >= TEXT_FLOOR_PX) {
      if (visualOnLeft) {
        next.visual.width = targetVisualW;
        next.headline.x = innerLeft + targetVisualW + 24;
        next.headline.width = innerRight - next.headline.x;
        next.subheadline.x = next.headline.x;
        next.subheadline.width = next.headline.width;
        if (hints.ctaPlacement === "auto") next.cta.x = next.headline.x;
      } else {
        const newVisualX = innerRight - targetVisualW;
        next.visual.x = newVisualX;
        next.visual.width = targetVisualW;
        next.headline.width = newVisualX - next.headline.x - 24;
        next.subheadline.width = next.headline.width;
      }
    }
    // else: silently skip — fits-in-canvas guarantee beats the spec hint.
  }

  // ── 3. headline_position horizontal anchor ──────────────────────────────
  // Brand rule (operator-set): the text BLOCK must always sit on the
  // reading-start side of the canvas (left for LTR / right for RTL) or
  // CENTERED — never on the reading-end side. When the AI's spec asks for
  // a reading-end anchor we silently downgrade to "center" so the visual
  // emphasis intent (move the eye away from the start corner) survives,
  // but yellow emphasis text never lands under the yellow corner motifs.
  //
  // RTL flip first: in Hebrew/Arabic the spec is written in reading order,
  // so spec.left = "near reading start" = visually right. We honor that.
  // After the flip, "right" in LTR / "left" in RTL = reading-end → downgrade.
  if (
    hints.headlinePosition === "left" ||
    hints.headlinePosition === "right" ||
    hints.headlinePosition === "center"
  ) {
    let mode = hints.headlinePosition;
    if (isRtl && mode === "left") mode = "right";
    else if (isRtl && mode === "right") mode = "left";
    // Reading-end downgrade. After the RTL swap above, "right" is always
    // visually reading-end in LTR and "left" is visually reading-end in
    // RTL. Both collapse to "center".
    if ((!isRtl && mode === "right") || (isRtl && mode === "left")) {
      mode = "center";
    }
    const headlineW = next.headline.width;
    let newX: number;
    if (mode === "center") newX = Math.round((size.width - headlineW) / 2);
    else if (mode === "left") newX = innerLeft;
    else newX = innerRight - headlineW;
    // Clamp inside safe area.
    newX = Math.max(innerLeft, Math.min(newX, innerRight - headlineW));
    next.headline.x = newX;
    next.subheadline.x = newX;
    if (hints.ctaPlacement === "auto") next.cta.x = newX;
  }

  // ── 4. cta_width override (must run before placement so x-anchors are
  // computed against the FINAL cta.width) ─────────────────────────────────
  if (hints.ctaWidth !== "auto") {
    if (hints.ctaWidth === "fixed") {
      const FIXED_FLOOR = 180;
      next.cta.width = Math.max(FIXED_FLOOR, layout.cta.width);
    } else if (hints.ctaWidth === "full_text_block") {
      next.cta.width = Math.max(next.headline.width, layout.cta.width);
    }
    // fit_text → keep computeLayout's value; the per-element ctaSafeWidth
    // logic in buildElements still grows the box to fit text length.
  }

  // ── 5. cta_placement ─────────────────────────────────────────────────────
  if (hints.ctaPlacement !== "auto") {
    const placement = applyCtaPlacement({
      placement: hints.ctaPlacement,
      layout: next,
      innerLeft,
      innerRight,
      ctaCeiling,
      isRtl,
    });
    next.cta.x = placement.x;
    next.cta.y = placement.y;
    // bottom_band requires special handling — full canvas width, sharp
    // corners. Per the operator's brand rule "CTA always above disclaimer,
    // disclaimer always at the bottom", the band is positioned RIGHT ABOVE
    // the disclaimer band rather than at the very bottom edge. The
    // disclaimer occupies the navy strip below the yellow band.
    if (hints.ctaPlacement === "bottom_band") {
      const BAND_HEIGHT = Math.max(72, Math.round(size.height * 0.13));
      const BAND_DISCLAIMER_GAP = 8;
      next.cta.x = 0;
      next.cta.width = size.width;
      next.cta.height = BAND_HEIGHT;
      // Disclaimer top edge:
      next.cta.y = next.riskWarning.y - BAND_HEIGHT - BAND_DISCLAIMER_GAP;
    }
  }

  // Always clamp the CTA to safe bounds, even when the spec didn't move
  // it — the visual_weight / headline_position adjustments above could
  // have shifted text widths in ways that put the CTA off-canvas on
  // already-tight format/composition combos.
  // The bottom_band placement is intentionally exempt — it uses the full
  // canvas width and anchors past the inner safe area on purpose.
  if (hints.ctaPlacement !== "bottom_band") {
    next.cta.x = Math.max(innerLeft, Math.min(next.cta.x, innerRight - next.cta.width));
    next.cta.y = Math.min(next.cta.y, ctaCeiling - next.cta.height);
  }

  // Always-on subheadline-vs-CTA non-overlap.
  //
  // Two cases handled:
  //
  //   A) CTA below subheadline (placement: bottom_left/center/right /
  //      below_subheadline / auto). The bottom-anchored CTA can land
  //      INSIDE the subheadline's box when sub runs long. Try to push
  //      CTA down to clear sub; if the disclaimer blocks that, shrink
  //      the subheadline box to fit above the CTA.
  //
  //   B) CTA above subheadline (placement: below_headline / top_right /
  //      inline_with_headline). The CTA tucks under the headline but its
  //      bottom edge can extend into the (still-rendered) subheadline's
  //      region. Push the subheadline DOWN below the CTA's bottom; if
  //      that pushes sub past the disclaimer ceiling, shrink sub.
  //
  // Skipped when hints.suppressSubheadline is true.
  if (!hints.suppressSubheadline) {
    const MIN_CTA_GAP = 16;
    const SUB_BOX_FLOOR = 36;
    const subTop = next.subheadline.y;
    const subBottom = subTop + next.subheadline.height;
    const ctaTop = next.cta.y;
    const ctaBottom = ctaTop + next.cta.height;
    const ctaTopFloor = ctaCeiling - next.cta.height;
    const subBottomCeiling = ctaCeiling - 16;

    if (ctaTop >= subTop && ctaTop < subBottom + MIN_CTA_GAP) {
      // Case A — CTA below sub, overlapping or too close.
      const pushedCtaY = Math.min(subBottom + MIN_CTA_GAP, ctaTopFloor);
      if (pushedCtaY >= subBottom + MIN_CTA_GAP) {
        next.cta.y = pushedCtaY;
      } else {
        next.cta.y = ctaTopFloor;
        const newSubBottom = next.cta.y - MIN_CTA_GAP;
        next.subheadline.height = Math.max(
          SUB_BOX_FLOOR,
          newSubBottom - next.subheadline.y,
        );
      }
    } else if (ctaTop < subTop && ctaBottom + MIN_CTA_GAP > subTop) {
      // Case B — CTA above sub, but cta.bottom lands inside sub.
      const newSubY = ctaBottom + MIN_CTA_GAP;
      next.subheadline.y = newSubY;
      const newSubBottom = newSubY + next.subheadline.height;
      if (newSubBottom > subBottomCeiling) {
        next.subheadline.height = Math.max(
          SUB_BOX_FLOOR,
          subBottomCeiling - newSubY,
        );
      }
    }
  }

  // ── Always-on CTA-vs-stacked-visual non-overlap ─────────────────────────
  //
  // For stacked layouts (1080x1080 / 1080x1920 default text_leading where
  // visual is BELOW the text block), applyCtaPlacement may have moved CTA
  // to "below_subheadline" — putting it BETWEEN the subheadline and the
  // visual. computeLayout's visual.y was set to subBottom + 24 before that
  // move, so the CTA now lands inside the visual's y range. The CTA at
  // z=50 paints over the visual at z=20, producing the "button on top of
  // the tablet" rendering bug.
  //
  // Resolution: when stacked + CTA's y-range overlaps visual's y-range,
  // push the visual DOWN to start ≥16 px below the CTA bottom. The visual
  // shrinks if needed to fit above the disclaimer band (with a 200 px
  // floor — anything smaller and the mockup becomes a thumbnail).
  if (next.visual && visualIsStacked) {
    const ctaBottom = next.cta.y + next.cta.height;
    const VISUAL_BELOW_CTA_GAP = 16;
    const VISUAL_FLOOR = 200;
    if (next.cta.y < next.visual.y + next.visual.height && ctaBottom > next.visual.y) {
      const newVisualY = ctaBottom + VISUAL_BELOW_CTA_GAP;
      const visualBottomCeiling = next.riskWarning.y - 16;
      const newVisualHeight = Math.max(
        VISUAL_FLOOR,
        Math.min(next.visual.height, visualBottomCeiling - newVisualY),
      );
      next.visual = {
        ...next.visual,
        y: newVisualY,
        height: newVisualHeight,
      };
    }
  }

  // ── Step 8 — pull CTA up when subheadline is suppressed ─────────────────
  // When max_text_density="low", the subheadline element is skipped in
  // buildElements. Without this adjustment the CTA would float in an empty
  // band where the subheadline used to live. We pull it tight against the
  // headline ONLY when the placement is auto / below_subheadline — bottom-
  // anchored placements (bottom_left/center/right) keep their floor.
  if (
    hints.suppressSubheadline &&
    (hints.ctaPlacement === "auto" || hints.ctaPlacement === "below_subheadline")
  ) {
    const tightCtaY = next.headline.y + next.headline.height + 24;
    next.cta.y = Math.min(next.cta.y, tightCtaY);
  }

  // ── 6. safe_area_priority="high" — final ≥24 px gap clamp pass ──────────
  if (hints.safeAreaPriority === "high") {
    next = enforceMinGaps(next, hints);
  }

  // ── ALWAYS-ON logo-clearance clamp ──────────────────────────────────────
  // Headline can never start above logo.y + logo.height + 16. computeLayout's
  // hero_overlay branch builds the text stack bottom-up from the disclaimer,
  // so on tight formats with tall headlines (hero scale + bold emphasis on
  // 1200x628) the headline can come out above the logo's bottom edge. This
  // clamp pushes the stack down without restructuring the layout. CTA stays
  // clamped against the disclaimer ceiling so legal copy is never crowded.
  //
  // Note: now that the logo is in the top-RIGHT corner (Phase 2 brand rule),
  // headline horizontal positions on the LEFT side don't actually collide
  // with the logo. We keep this clamp for hero_overlay layouts where the
  // headline is centered or for portrait formats where the logo's full
  // width matters vertically.
  const LOGO_CLEAR = 16;
  const logoBottom = next.logo.y + next.logo.height;
  // Only enforce clamp if the headline's horizontal range intersects the
  // logo's horizontal range. On text-leading layouts where the headline
  // is on the left and the logo is in the top-right corner, the horizontal
  // ranges are disjoint and there's no need to push the headline down.
  const headlineRight = next.headline.x + next.headline.width;
  const logoRight = next.logo.x + next.logo.width;
  const horizontalOverlap =
    next.headline.x < logoRight && headlineRight > next.logo.x;
  if (horizontalOverlap && next.headline.y < logoBottom + LOGO_CLEAR) {
    const shift = logoBottom + LOGO_CLEAR - next.headline.y;
    next.headline.y += shift;
    next.subheadline.y += shift;
    next.cta.y += shift;
    next.cta.y = Math.min(next.cta.y, ctaCeiling - next.cta.height);
  }

  // ── ALWAYS-ON text-vs-visual non-overlap clamp ──────────────────────────
  //
  // Brand rule (operator-set): text NEVER overlaps a visual element unless
  // the visual is intentionally a foreground/full-canvas layer. For side-
  // panel layouts (text_leading / visual_leading), the text-block must
  // stay strictly to one side of the visual region with a small gap.
  //
  // We detect side-panel by the visual NOT covering the canvas (Step 7's
  // visualIsFullCanvas / visualIsStacked already track this). When the
  // text element's right edge enters the visual region (or the visual's
  // right edge enters the text), we shrink the text width so it stops
  // 24 px before the visual starts. fitFontToBox at render time will
  // reflow the text into the new narrower box.
  if (next.visual && !visualIsFullCanvas && !visualIsStacked) {
    const VISUAL_GAP = 24;
    const visualLeft = next.visual.x;
    const visualRight = next.visual.x + next.visual.width;
    // Text on the LEFT of the visual: clamp text.right to visual.left - gap
    // Text on the RIGHT of the visual: clamp text.left to visual.right + gap
    const textOnLeft = next.headline.x + next.headline.width <= visualLeft + 4;
    const textOnRight = next.headline.x >= visualRight - 4;
    if (textOnLeft || (!textOnRight && next.headline.x < visualLeft)) {
      // Text lives to the left — shrink width so it ends ≥ VISUAL_GAP px
      // before visual starts.
      const maxRight = visualLeft - VISUAL_GAP;
      const maxWidth = Math.max(120, maxRight - next.headline.x);
      if (next.headline.width > maxWidth) {
        next.headline.width = maxWidth;
        next.subheadline.width = maxWidth;
      }
    } else if (textOnRight) {
      // Text lives to the right — push left edge away from visual.
      const minLeft = visualRight + VISUAL_GAP;
      if (next.headline.x < minLeft) {
        const delta = minLeft - next.headline.x;
        next.headline.x += delta;
        next.subheadline.x += delta;
        next.headline.width = Math.max(120, next.headline.width - delta);
        next.subheadline.width = Math.max(120, next.subheadline.width - delta);
      }
    }
  }

  // ── FINAL pass: CTA-vs-stacked-visual non-overlap ──────────────────────
  // The earlier clamp at the top of this function ran when CTA was at its
  // post-applyCtaPlacement position. But subsequent passes (sub-vs-cta,
  // enforceMinGaps, suppressSubheadline pull-up) can MOVE the CTA after
  // we already checked. Reproducer: spec.cta_strategy.placement="below_
  // headline" on 1080x1920 — applyCtaPlacement put CTA at headlineY+H+16
  // (above visual, no overlap), then enforceMinGaps pushed CTA down past
  // sub.bottom into the visual region. By the time we get here, CTA is at
  // its final y. Re-running the clamp here closes that gap.
  if (next.visual && visualIsStacked) {
    const ctaBottomFinal = next.cta.y + next.cta.height;
    if (
      next.cta.y < next.visual.y + next.visual.height &&
      ctaBottomFinal > next.visual.y
    ) {
      const VISUAL_BELOW_CTA_GAP = 16;
      const VISUAL_FLOOR = 200;
      const newVisualY = ctaBottomFinal + VISUAL_BELOW_CTA_GAP;
      const visualBottomCeiling = next.riskWarning.y - 16;
      const newVisualHeight = Math.max(
        VISUAL_FLOOR,
        Math.min(next.visual.height, visualBottomCeiling - newVisualY),
      );
      next.visual = {
        ...next.visual,
        y: newVisualY,
        height: newVisualHeight,
      };
    }
  }

  // MEXEM spec — final snap (logo→headline). When the kit carries a
  // per-format logo_to_text gap, re-anchor the headline to
  // (logo.y + logo.height + gap) and slide the subheadline by the same
  // delta. The historic formula uses `innerTop + logoH + 48` which is
  // measured from the safe-area top — that drifts from the literal
  // logo bottom by (innerTop - logo.y) for formats where m.top differs
  // from LOGO_CORNER_INSET. The snap closes that drift so the rendered
  // gap matches the spec.
  if (next.logoToTextGap != null) {
    const logoBottom = next.logo.y + next.logo.height;
    const targetHeadlineY = logoBottom + next.logoToTextGap;
    const delta = targetHeadlineY - next.headline.y;
    if (delta !== 0) {
      next.headline = { ...next.headline, y: targetHeadlineY };
      next.subheadline = { ...next.subheadline, y: next.subheadline.y + delta };
    }
  }

  // MEXEM spec — final snap (text→CTA). When the kit carries a per-format
  // text_to_cta gap, override whatever prior passes decided and place
  // the CTA at (subheadline_bottom + gap), then re-clamp to ctaCeiling.
  // Defeats the otherwise-strong bottom-anchor / visual-clearance
  // writers that pin the CTA near the disclaimer band. Runs AFTER the
  // logo→headline snap so subheadline's shifted position is what we
  // anchor on.
  if (next.textToCtaGap != null) {
    const subBottom = next.subheadline.y + next.subheadline.height;
    next.cta.y = Math.min(
      subBottom + next.textToCtaGap,
      ctaCeiling - next.cta.height,
    );
  }

  return next;
}

interface CtaPlacementInput {
  placement: Exclude<RendererHints["ctaPlacement"], "auto">;
  layout: ComputedLayout;
  innerLeft: number;
  innerRight: number;
  ctaCeiling: number; // riskWarning.y - 24
  isRtl: boolean;
}

// Resolve a ctaPlacement enum to a concrete (x, y) inside the safe area.
// Each branch picks the natural placement, then the caller's clamp keeps
// the box on-canvas. Unsafe combos fall back to the closest safe path.
//
// Step 11 follow-up — "bottom_left/center/right" are now anchored to the
// TEXT REGION (headline.x .. headline.x + headline.width) rather than the
// canvas inner area. On a text_leading layout where the visual sits on
// the right side, centering the CTA at canvas-center landed it inside
// the mockup — visually a CTA on top of a chart screenshot. Anchoring on
// the text block keeps the CTA on the text side of the design. When the
// text block spans the canvas (hero_overlay / pure editorial), text-region
// and inner-region coincide, so existing layouts are unaffected.
function applyCtaPlacement(p: CtaPlacementInput): { x: number; y: number } {
  const { placement, layout, innerLeft, innerRight, ctaCeiling, isRtl } = p;
  const ctaW = layout.cta.width;
  const ctaH = layout.cta.height;
  const headlineY = layout.headline.y;
  const headlineH = layout.headline.height;
  const subY = layout.subheadline.y;
  const subH = layout.subheadline.height;
  // Text-region bounds. CTA placement is anchored on this when the text
  // block doesn't fill the canvas (i.e., side-panel layouts).
  const textLeft = layout.headline.x;
  const textRight = layout.headline.x + layout.headline.width;
  // Reading-start / reading-end x columns relative to the text region.
  // RTL inverts. Clamped within the inner safe area for robustness.
  const startColText = isRtl ? textRight - ctaW : textLeft;
  const endColText = isRtl ? textLeft : textRight - ctaW;
  const centerColText = Math.round(textLeft + (textRight - textLeft - ctaW) / 2);
  const startCol = Math.max(innerLeft, Math.min(innerRight - ctaW, startColText));
  const endCol = Math.max(innerLeft, Math.min(innerRight - ctaW, endColText));
  const centerCol = Math.max(innerLeft, Math.min(innerRight - ctaW, centerColText));
  const bottomY = ctaCeiling - ctaH;

  switch (placement) {
    case "below_headline": {
      // CTA tucked right under the headline (skipping the subheadline visually).
      // Subheadline can keep its position; if AI also wants subheadline
      // hidden it sets max_text_density="low" (not yet wired).
      return { x: layout.cta.x, y: Math.min(headlineY + headlineH + 16, ctaCeiling - ctaH) };
    }
    case "below_subheadline": {
      // Today's text_leading default. Use whichever x the upstream pass set.
      return { x: layout.cta.x, y: Math.min(subY + subH + (layout.textToCtaGap ?? 20), ctaCeiling - ctaH) };
    }
    case "bottom_left":
      return { x: startCol, y: bottomY };
    case "bottom_center":
      return { x: centerCol, y: bottomY };
    case "bottom_right":
      return { x: endCol, y: bottomY };
    case "top_right": {
      // Risk: the IBKR partner badge already lives at top-right on landscape
      // formats. For 1200x628 (where the badge is top-right) we collapse to
      // inline_with_headline so the badge keeps its slot. The badge moves to
      // bottom-right on square / portrait, so top_right is safe there.
      const ibkr = layout.ibkrLogo;
      const conflictsWithBadge = ibkr !== null && ibkr.y < layout.headline.y;
      if (conflictsWithBadge) {
        // Inline fallback — same overlap risk as the inline_with_headline
        // case. Only honour it when the headline already leaves a gap.
        const headlineRight = layout.headline.x + layout.headline.width;
        const headlineFitsBesideCta = isRtl
          ? layout.headline.x >= endCol + ctaW + 24
          : endCol >= headlineRight + 24;
        if (headlineFitsBesideCta) return { x: endCol, y: headlineY };
        return { x: layout.cta.x, y: Math.min(subY + subH + (layout.textToCtaGap ?? 20), ctaCeiling - ctaH) };
      }
      return { x: endCol, y: Math.max(layout.logo.y, layout.logo.y + 16) };
    }
    case "inline_with_headline": {
      // CTA on the same row as the headline, on the reading-end side. The
      // CALLER must have pre-narrowed the headline's width to leave a
      // horizontal gap for the button — otherwise the button and headline
      // text occupy the same rectangle and overlap (real bug seen on
      // 1200×628 "Carnival of Coins" where headline w=672 and CTA was
      // placed at endCol=612, sitting on top of the words).
      //
      // Bullet-proof guard: only honour inline placement when there's an
      // actual horizontal gap (≥24 px) between headline-right and the
      // CTA-left column. When no gap exists, fall through to the same
      // below-subheadline placement that bottom_left/center use.
      const headlineRight = layout.headline.x + layout.headline.width;
      const ctaLeftAtEndCol = endCol;
      const headlineFitsBesideCta = isRtl
        ? layout.headline.x >= endCol + ctaW + 24
        : ctaLeftAtEndCol >= headlineRight + 24;
      const reservedTextW = innerRight - innerLeft - ctaW - 24;
      if (!headlineFitsBesideCta || reservedTextW < 240) {
        return { x: layout.cta.x, y: Math.min(subY + subH + (layout.textToCtaGap ?? 20), ctaCeiling - ctaH) };
      }
      return { x: endCol, y: headlineY };
    }
    case "bottom_band": {
      // MEXEM reference rule: a full-canvas-width band hugging the bottom
      // edge of the canvas. The CTA element's width / x are stretched to
      // canvas extent in the caller (applyCompositionFromSpec) — here we
      // just anchor y to the bottom edge minus the band height. The CTA
      // builder elsewhere drops border-radius to 0 and overrides the fill
      // to brand-accent yellow when it sees this placement.
      return {
        x: 0,
        y: Math.max(0, layout.cta.y), // y is reset by the band-width override below
      };
    }
  }
}

// Step 7 — final clamp pass for safe_area_priority="high".
// Walks the vertical stack (logo → eyebrow → headline → subheadline → cta
// → riskWarning) and pushes any element down that's < 24 px below its
// predecessor. Clamps against the disclaimer band as the floor.
//
// Step 8 — when hints.suppressSubheadline is true the chain skips the
// subheadline rung entirely (since buildElements won't render it) and
// goes headline → CTA directly. Same MIN_GAP, same disclaimer floor.
function enforceMinGaps(
  layout: ComputedLayout,
  hints: RendererHints,
): ComputedLayout {
  const MIN_GAP = 24;
  const ceiling = layout.riskWarning.y - MIN_GAP;
  const next: ComputedLayout = {
    ...layout,
    headline: { ...layout.headline },
    subheadline: { ...layout.subheadline },
    cta: { ...layout.cta },
  };
  // Logo bottom must clear by MIN_GAP before headline starts.
  const logoBottom = layout.logo.y + layout.logo.height;
  if (next.headline.y < logoBottom + MIN_GAP) {
    next.headline.y = logoBottom + MIN_GAP;
  }
  const headlineBottom = next.headline.y + next.headline.height;
  if (hints.suppressSubheadline) {
    // Skip the subheadline rung — go headline → CTA directly.
    if (next.cta.y < headlineBottom + MIN_GAP) {
      next.cta.y = headlineBottom + MIN_GAP;
    }
  } else {
    // Headline bottom → subheadline.
    if (next.subheadline.y < headlineBottom + MIN_GAP) {
      next.subheadline.y = headlineBottom + MIN_GAP;
    }
    // Subheadline bottom → CTA.
    const subBottom = next.subheadline.y + next.subheadline.height;
    if (next.cta.y < subBottom + MIN_GAP) {
      next.cta.y = subBottom + MIN_GAP;
    }
  }
  // CTA bottom → disclaimer ceiling.
  next.cta.y = Math.min(next.cta.y, ceiling - next.cta.height);
  // If clamping the CTA pushed it back up over the subheadline, that
  // means the stack genuinely doesn't fit; we leave the rest alone (the
  // higher elements stay where the upstream layout put them) and let
  // shrink-to-fit downstream do what it can.
  return next;
}


function pickLogoHeight(
  size: { name: string; width: number; height: number },
  hints: RendererHints = DEFAULT_RENDERER_HINTS,
): number {
  let base: number;
  // Original-3 lookup is preserved verbatim. New formats route through the
  // bucket classifier so a 1500x500 ultra-wide doesn't end up with the
  // portrait 88px logo (which would crowd everything else into 412px of
  // height). Numbers below match the eyeball test against existing renders.
  if (size.name === "1200x628") base = 56;
  else if (size.name === "1080x1080") base = 80;
  else if (size.name === "1080x1920") base = 88;
  else {
    const fmt = classifyFormat(size);
    if (fmt.bucket === "ultra_wide") base = 48;
    else if (fmt.bucket === "wide" && fmt.height_class === "tight") base = 56;
    else if (fmt.bucket === "wide") base = 72; // 1920x1080
    else if (fmt.bucket === "square") base = 80; // 1200x1200
    else base = 88; // portrait / tall_portrait (1080x1350)
  }
  // Step 6 — brand_strategy.logo_prominence multiplier. Floor at 36px so
  // the logo always reads at any format; ceiling at +35% so "prominent"
  // doesn't crowd the headline.
  const LOGO_FLOOR_PX = 36;
  return Math.max(LOGO_FLOOR_PX, Math.round(base * hints.logoSizeMultiplier));
}

// ── Element builder ─────────────────────────────────────────────────────────

interface BuildElementsArgs {
  // Identity inputs needed by per-concept PRNG picks (e.g. CTA variant
  // selection). Both fields are forwarded verbatim from BuildAdSpecArgs.
  campaignId: string;
  conceptId: string;
  size: { name: string; width: number; height: number };
  layout: ComputedLayout;
  selection: DemoAssetSelection;
  visual: VisualForSpec;
  cloudinaryDelivery: CloudinaryDelivery;
  midjourneyById: Map<string, MidjourneyUpload>;
  midjourney: ResolvedMidjourneyForSpec;
  brandKit: BrandKitLite;
  copy: { headline: string; headline_emphasis?: string; subheadline: string; cta: string; disclaimer: string };
  composition: CompositionKind;
  template: TemplateKind;
  language: import("@/lib/i18n/language").Language;
  patternStyle?: PatternStyle;
  motif?: DesignMotif;
  designElements?: {
    eyebrow?: string;
    stat?: { number: string; label: string };
    kicker?: string;
  };
  rendererHints?: RendererHints;
  // Phase 3 — same shape as BuildAdSpecArgs.generatedAssetResolver. When set
  // the builder injects/overrides bg/cta/visual/fx/trading-ui elements with
  // matching generated assets. Null preserves today's behavior.
  generatedAssetResolver?: import("@/lib/generators/generatedAssetResolver").GeneratedAssetResolver | null;
  // Phase 4 — see BuildAdSpecArgs.qaWarnings.
  qaWarnings?: string[];
}

const MIDJOURNEY_PROVENANCE = {
  generated_by: "midjourney",
  uploaded_by_user: true,
  manual_workflow: true,
} as const;

// Build a generated design motif as an SVG manifest element. The motif
// IS the new content — algorithmic illustrations in brand colors that
// make each ad feel composed instead of assembled. All motifs use brand
// accent + brand background colors; opacity stays low (0.18-0.32) so
// foreground type and CTA dominate the visual hierarchy.
function buildDesignMotifElement(
  motif: DesignMotif,
  size: { name: string; width: number; height: number },
  brandKit: BrandKitLite,
): Element | null {
  if (motif === "none") return null;
  const w = size.width;
  const h = size.height;
  const accent = brandKit.colors.accent[0] ?? "#D81222";
  const bgMid =
    brandKit.colors.background[Math.floor(brandKit.colors.background.length / 2)] ??
    brandKit.colors.background[0] ??
    "#005786";
  const lightTint = brandKit.colors.text.find((c) => c.toUpperCase() === "#FFFFFF") ?? "#FFFFFF";

  const svg = (() => {
    if (motif === "chart_silhouette") {
      // Smooth ascending area chart spanning the bottom 60% of the canvas.
      // Two stops: a faint area fill, a sharper top stroke. Reads as
      // "growth" without literal data labels.
      const baseline = h * 0.78;
      const peak = h * 0.32;
      const points = [
        [0, baseline],
        [w * 0.15, h * 0.7],
        [w * 0.32, h * 0.62],
        [w * 0.5, h * 0.45],
        [w * 0.7, h * 0.5],
        [w * 0.85, peak],
        [w, h * 0.28],
      ];
      const lineD = points
        .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
        .join(" ");
      const fillD = `${lineD} L ${w} ${h} L 0 ${h} Z`;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.18"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>` +
        `<path d="${fillD}" fill="url(#g)"/>` +
        `<path d="${lineD}" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.32" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</svg>`
      );
    }
    if (motif === "abstract_bars") {
      // Vertical bars of varying heights along the bottom — stylised data
      // viz without numbers. Heights come from a fixed pseudo-random series
      // so the rhythm reads as intentional, not noise.
      const seq = [0.32, 0.5, 0.42, 0.68, 0.55, 0.78, 0.62, 0.85, 0.7, 0.95, 0.8, 0.6];
      const barW = w / (seq.length * 1.6);
      const gap = barW * 0.6;
      let x = (w - (seq.length * (barW + gap) - gap)) / 2;
      const bars = seq.map((s) => {
        const bh = h * 0.4 * s;
        const by = h - bh;
        const rect = `<rect x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${accent}" fill-opacity="0.32" rx="2"/>`;
        x += barW + gap;
        return rect;
      }).join("");
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bars}</svg>`;
    }
    if (motif === "axis_grid") {
      // Sparse graph-paper. Every 5th line slightly stronger so it reads
      // as a chart background.
      const step = Math.round(Math.min(w, h) / 14);
      let lines = "";
      for (let x = step; x < w; x += step) {
        const op = (x / step) % 5 === 0 ? 0.16 : 0.07;
        lines += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${lightTint}" stroke-width="1" stroke-opacity="${op}"/>`;
      }
      for (let y = step; y < h; y += step) {
        const op = (y / step) % 5 === 0 ? 0.16 : 0.07;
        lines += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${lightTint}" stroke-width="1" stroke-opacity="${op}"/>`;
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${lines}</svg>`;
    }
    if (motif === "wave_curve") {
      // Smooth sine wave sweeping across the lower half — modern, calm,
      // suggests momentum without literal data.
      const amp = h * 0.08;
      const mid = h * 0.62;
      const samples = 12;
      const pts: string[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const x = w * t;
        const y = mid + Math.sin(t * Math.PI * 2.4) * amp;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const polyline = pts.join(" ");
      const fillPts = `0,${h} ${polyline} ${w},${h}`;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<polygon points="${fillPts}" fill="${accent}" fill-opacity="0.08"/>` +
        `<polyline points="${polyline}" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity="0.26" stroke-linejoin="round"/>` +
        `</svg>`
      );
    }
    if (motif === "gradient_orb") {
      // Soft radial gradient orb anchored to a corner. Adds depth without
      // photographic content — pure CSS-style brand wash.
      const cx = w * 0.85;
      const cy = h * 0.18;
      const r = Math.max(w, h) * 0.55;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs><radialGradient id="orb" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0" stop-color="${bgMid}" stop-opacity="0.6"/>` +
        `<stop offset="0.5" stop-color="${bgMid}" stop-opacity="0.18"/>` +
        `<stop offset="1" stop-color="${bgMid}" stop-opacity="0"/>` +
        `</radialGradient></defs>` +
        `<rect width="${w}" height="${h}" fill="url(#orb)"/>` +
        `</svg>`
      );
    }
    if (motif === "node_network") {
      // 7 nodes connected by faint lines — abstract data network. Positions
      // are pseudo-random but symmetric across the canvas.
      const nodes = [
        [0.18, 0.32], [0.42, 0.18], [0.62, 0.4], [0.32, 0.58],
        [0.78, 0.25], [0.85, 0.65], [0.5, 0.72],
      ].map(([fx, fy]) => [w * fx, h * fy]);
      const links = [[0,1],[1,2],[2,4],[3,2],[2,5],[5,6],[6,3],[4,5]];
      let svgInner = "";
      for (const [a, b] of links) {
        svgInner += `<line x1="${nodes[a][0].toFixed(1)}" y1="${nodes[a][1].toFixed(1)}" x2="${nodes[b][0].toFixed(1)}" y2="${nodes[b][1].toFixed(1)}" stroke="${lightTint}" stroke-width="1.5" stroke-opacity="0.18"/>`;
      }
      for (const [x, y] of nodes) {
        svgInner += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${accent}" fill-opacity="0.36"/>`;
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svgInner}</svg>`;
    }
    if (motif === "arc_meter") {
      // Half-circle dial in the upper area — suggests a gauge / metric.
      const cx = w * 0.5;
      const cy = h * 0.42;
      const r = Math.min(w, h) * 0.32;
      const startA = Math.PI;
      const endA = 2 * Math.PI;
      const sx = cx + Math.cos(startA) * r;
      const sy = cy + Math.sin(startA) * r;
      const ex = cx + Math.cos(endA) * r;
      const ey = cy + Math.sin(endA) * r;
      const arcPath = `M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey}`;
      const tickInner = r - 12;
      const tickOuter = r;
      let ticks = "";
      for (let i = 0; i <= 12; i++) {
        const a = startA + ((endA - startA) * i) / 12;
        const x1 = cx + Math.cos(a) * tickInner;
        const y1 = cy + Math.sin(a) * tickInner;
        const x2 = cx + Math.cos(a) * tickOuter;
        const y2 = cy + Math.sin(a) * tickOuter;
        ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${lightTint}" stroke-width="2" stroke-opacity="0.22"/>`;
      }
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<path d="${arcPath}" fill="none" stroke="${accent}" stroke-width="6" stroke-opacity="0.28" stroke-linecap="round"/>` +
        ticks +
        `</svg>`
      );
    }
    // ticker_strip — horizontal bands of small accent rectangles on a
    // baseline, evoking a stock ticker without ANY readable text.
    const stripY = h * 0.86;
    const segCount = 22;
    const segW = w / (segCount * 1.4);
    const segGap = segW * 0.4;
    let strip = "";
    let x = (w - (segCount * (segW + segGap) - segGap)) / 2;
    for (let i = 0; i < segCount; i++) {
      const op = 0.15 + ((i * 7919) % 100) / 500;
      strip += `<rect x="${x.toFixed(1)}" y="${stripY.toFixed(1)}" width="${segW.toFixed(1)}" height="6" fill="${accent}" fill-opacity="${op.toFixed(2)}" rx="1"/>`;
      x += segW + segGap;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${strip}</svg>`;
  })();

  // Base64 over `;utf8,` so the URI is unambiguous (no percent-encoding
  // edge cases) for both Chromium-in-Playwright AND the Figma SVG export
  // (where the inliner decodes this back to native vectors).
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return {
    id: `el_motif_${motif}`,
    type: "image",
    role: "decorative",
    source: "ai-generated",
    x: 0,
    y: 0,
    width: w,
    height: h,
    z_index: 8,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    file_url: dataUri,
    object_fit: "fill",
    alt_text: `generated brand-color motif: ${motif}`,
    bannerbear: { layer_name: `motif_${motif}`, modification_type: "image_url" },
    figma: {
      node_type: "RECTANGLE",
      component_role: `motif-${motif}`,
      exportable: false,
      constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
      parent_frame_hint: `Ad / ${size.name}`,
    },
  };
}

// Geometric accent for editorial_type ads. Placed in the canvas's negative
// space opposite the text — a confident circle/disc that anchors the
// composition without competing with the headline. Sized as a fraction of
// the smaller canvas dimension so it scales gracefully across formats.
function computeEditorialAccent(
  composition: CompositionKind,
  size: { name: string; width: number; height: number },
): { x: number; y: number; width: number; height: number; border_radius: number; opacity: number } {
  const minDim = Math.min(size.width, size.height);
  const radius = Math.round(minDim * 0.42); // big disc — design language, not subtle
  const w = radius * 2;
  const h = radius * 2;
  // Park the disc off the visible canvas so we see only an arc — feels
  // intentional rather than decorative. Edge depends on composition so the
  // arc never sits on top of the headline.
  if (composition === "visual_leading") {
    // Text on the right → arc enters from the LEFT, vertically centered.
    return {
      x: -Math.round(w * 0.55),
      y: Math.round((size.height - h) / 2),
      width: w,
      height: h,
      border_radius: radius,
      opacity: 0.92,
    };
  }
  if (composition === "hero_overlay") {
    // Text overlays bottom → arc enters from the TOP-RIGHT corner.
    return {
      x: size.width - Math.round(w * 0.45),
      y: -Math.round(h * 0.45),
      width: w,
      height: h,
      border_radius: radius,
      opacity: 0.92,
    };
  }
  // text_leading (default) — text on the left → arc enters from the RIGHT.
  return {
    x: size.width - Math.round(w * 0.55),
    y: Math.round((size.height - h) / 2),
    width: w,
    height: h,
    border_radius: radius,
    opacity: 0.92,
  };
}

// Position a big-number stat block (e.g. "$0" + "PER ETF TRADE") as the
// editorial focal element. Sits in the UPPER part of the canvas, above
// the headline — the prior version filled the whole canvas with the
// number which read as "exaggerated" rather than confident. Now the stat
// is sized to ~22% of the canvas width (a strong type display, not a
// full-canvas takeover), with the headline + subheadline + CTA still
// rendering normally below.
function computeStatPlacement(
  composition: CompositionKind,
  size: { name: string; width: number; height: number },
  layout: ComputedLayout,
): {
  number: { x: number; y: number; width: number; height: number; fontSize: number; textAlign: "left" | "center" | "right" };
  label: { x: number; y: number; width: number; height: number; fontSize: number; textAlign: "left" | "center" | "right" };
} {
  const logoBottom = layout.logo.y + layout.logo.height;
  const top = logoBottom + 24;
  // Stat owns ONLY the strip between logo and headline — never crosses
  // into the headline area. The headline still renders below.
  const bottom = layout.headline.y - 16;
  const availableH = Math.max(80, bottom - top);

  // Number font is the smaller of "fits the available height" and
  // "~22% of the canvas width". The width cap is the design discipline:
  // even when there's plenty of vertical room, we don't let the number
  // dominate the canvas. Target presence: confident, not overwhelming.
  const widthCap = Math.round(size.width * 0.22);
  const heightCap = Math.round(availableH * 0.7);
  const numFontSize = Math.min(widthCap, heightCap);
  const numHeight = Math.round(numFontSize * 1.05);
  const labelFontSize = Math.max(13, Math.round(numFontSize * 0.1));
  const labelHeight = Math.round(labelFontSize * 1.4);
  const innerW = size.width - layout.margin.left - layout.margin.right;
  // Vertically center the (number + label) block within the available strip.
  const blockH = numHeight + 8 + labelHeight;
  const blockY = top + Math.round(Math.max(0, (availableH - blockH) / 2));
  const numY = blockY;
  const labelY = blockY + numHeight + 8;

  // Always center horizontally — pairs cleanly with the headline below
  // regardless of composition. Looks composed instead of asymmetric.
  return {
    number: {
      x: layout.margin.left,
      y: numY,
      width: innerW,
      height: numHeight,
      fontSize: numFontSize,
      textAlign: "center",
    },
    label: {
      x: layout.margin.left,
      y: labelY,
      width: innerW,
      height: labelHeight,
      fontSize: labelFontSize,
      textAlign: "center",
    },
  };
  // composition not used — kept in signature so callers can pass it
  // when future templates want side-aligned stats.
  void composition;
}

// Brand pattern element — a clean SVG geometric overlay used by the
// `pattern_immersive` template. Five styles available; the planner picks
// one per campaign so two campaigns side-by-side don't share rhythm.
function buildBrandPatternElement(
  size: { name: string; width: number; height: number },
  accentColor: string,
  style: PatternStyle,
): Element {
  const svg = (() => {
    const w = size.width;
    const h = size.height;
    // Tall portrait canvases (e.g. 1080x1920 stories) have more empty
    // space for the pattern to fill — bump opacity so the geometry reads
    // as designed surface rather than dead air.
    const opacity = h > w * 1.5 ? 0.30 : 0.18;
    if (style === "diagonal_lines" || style === "diagonal_lines_reverse") {
      const tile = 64;
      const angle = style === "diagonal_lines" ? 18 : -18;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs><pattern id="p" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">` +
        `<line x1="0" y1="0" x2="0" y2="${tile}" stroke="${accentColor}" stroke-width="2" stroke-opacity="${opacity}"/>` +
        `</pattern></defs><rect width="${w}" height="${h}" fill="url(#p)"/></svg>`
      );
    }
    if (style === "vertical_bars") {
      const tile = 96;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs><pattern id="p" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">` +
        `<rect x="0" y="0" width="3" height="${tile}" fill="${accentColor}" fill-opacity="${opacity}"/>` +
        `</pattern></defs><rect width="${w}" height="${h}" fill="url(#p)"/></svg>`
      );
    }
    if (style === "dot_grid") {
      const tile = 56;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<defs><pattern id="p" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">` +
        `<circle cx="${tile / 2}" cy="${tile / 2}" r="2" fill="${accentColor}" fill-opacity="${opacity + 0.08}"/>` +
        `</pattern></defs><rect width="${w}" height="${h}" fill="url(#p)"/></svg>`
      );
    }
    // concentric_arcs — three large rings off-canvas in the corner, evoking
    // radar / data sweep. Strong design language; works best on square +
    // portrait canvases.
    const cx = Math.round(w * 0.85);
    const cy = Math.round(h * 0.15);
    const rings = [w * 0.6, w * 0.45, w * 0.3].map((r) => Math.round(r));
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      rings
        .map(
          (r) =>
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accentColor}" stroke-width="2" stroke-opacity="${opacity}"/>`,
        )
        .join("") +
      `</svg>`
    );
  })();
  // Base64 over `;utf8,` so the URI is unambiguous (no percent-encoding
  // edge cases) for both Chromium-in-Playwright AND the Figma SVG export
  // (where the inliner decodes this back to native vectors).
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return {
    id: "el_brand_pattern",
    type: "image",
    role: "decorative",
    source: "ai-generated",
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    z_index: 5,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    file_url: dataUri,
    object_fit: "fill",
    alt_text: "brand-color geometric pattern",
    bannerbear: { layer_name: "brand_pattern", modification_type: "image_url" },
    figma: {
      node_type: "RECTANGLE",
      component_role: "brand-pattern",
      exportable: false,
      constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
      parent_frame_hint: `Ad / ${size.name}`,
    },
  };
}

// Build a "scrim" — a soft darkening gradient overlay used when the
// background is a photographic image. Direction varies by composition so
// the dark area sits behind the text:
//   text_leading   → darken the left, fade right
//   visual_leading → darken the right, fade left
//   hero_overlay   → darken the bottom, fade up
// Implemented as an `<image>` element pointing at a tiny SVG data URI. This
// way the renderer's existing image path handles it; no new element type
// needed and the manifest stays self-contained for export.
function buildScrimElement(
  composition: CompositionKind,
  size: { name: string; width: number; height: number },
  // Step 11 follow-up — accepts a z-index so the same scrim can sit at z=10
  // (under a mockup composite) for image backgrounds OR at z=30 (above the
  // mockup composite, below text) when a full-canvas mockup needs darkening
  // for readable text overlay. Defaults to z=10 to preserve old call sites.
  zIndex: number = 10,
): Element {
  let stops: string;
  if (composition === "hero_overlay") {
    stops =
      '<linearGradient id="s" x1="0" y1="1" x2="0" y2="0">' +
      '<stop offset="0" stop-color="#000" stop-opacity="0.72"/>' +
      '<stop offset="0.55" stop-color="#000" stop-opacity="0.0"/></linearGradient>';
  } else if (composition === "visual_leading") {
    stops =
      '<linearGradient id="s" x1="1" y1="0" x2="0" y2="0">' +
      '<stop offset="0" stop-color="#000" stop-opacity="0.55"/>' +
      '<stop offset="0.55" stop-color="#000" stop-opacity="0.0"/></linearGradient>';
  } else {
    stops =
      '<linearGradient id="s" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#000" stop-opacity="0.55"/>' +
      '<stop offset="0.55" stop-color="#000" stop-opacity="0.0"/></linearGradient>';
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><defs>${stops}</defs>` +
    `<rect width="${size.width}" height="${size.height}" fill="url(#s)"/></svg>`;
  // Base64 over `;utf8,` so the URI is unambiguous (no percent-encoding
  // edge cases) for both Chromium-in-Playwright AND the Figma SVG export
  // (where the inliner decodes this back to native vectors).
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return {
    id: "el_scrim",
    type: "image",
    role: "decorative",
    source: "ai-generated",
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    z_index: zIndex,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    file_url: dataUri,
    object_fit: "fill",
    alt_text: "scrim overlay for text legibility",
    bannerbear: { layer_name: "scrim", modification_type: "image_url" },
    figma: {
      node_type: "RECTANGLE",
      component_role: "scrim",
      exportable: false,
      constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
      parent_frame_hint: `Ad / ${size.name}`,
    },
  };
}

// Estimate the height the rendered text will actually take, based on
// expected line count. Then if the estimated height exceeds the element's
// allocated box, reduce the font size step-wise until it fits — that way
// long headlines never overflow into the subheadline below them, which
// is the most common source of "text on top of text" in renders.
//
// `charWidthRatio` is empirical for sans-serif fonts at the headline
// weight (-2 letter-spacing tightens it slightly). Per-format brand
// minimum prevents the algorithm from shrinking past readable.
function fitFontToBox(args: {
  text: string;
  boxWidth: number;
  boxHeight: number;
  baseFontSize: number;
  lineHeight: number;
  minFont: number;
  charWidthRatio?: number;
}): number {
  const ratio = args.charWidthRatio ?? 0.55;
  let fontSize = args.baseFontSize;
  while (fontSize > args.minFont) {
    const charsPerLine = Math.max(1, Math.floor(args.boxWidth / (fontSize * ratio)));
    // Word-aware line counting — Chrome's CSS word-wrap breaks at spaces,
    // so a long word that doesn't fit on the current line bumps to the
    // next one. The pre-Step-11 char-count divisor was wrong here: for
    // "Trade Without Commission Limits" with charsPerLine=12 it returned
    // ceil(31/12)=3 lines, but the actual browser wraps to 4 (because
    // "Commission" itself is 10 chars and bumps to its own line).
    const lines = countWrappedLines(args.text, charsPerLine);
    const rendered = lines * fontSize * args.lineHeight;
    if (rendered <= args.boxHeight) return fontSize;
    fontSize -= 2;
  }
  return args.minFont;
}

// Simulates CSS word-wrap line breaking: each whitespace-delimited word
// is placed on the current line if it fits, otherwise pushed to the next.
// Hyphens are not split. Matches Chrome's normal `word-wrap: normal`
// behaviour closely enough for layout fitting.
function countWrappedLines(text: string, charsPerLine: number): number {
  if (charsPerLine <= 0) return 1;
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return 1;
  let lines = 1;
  let lineLen = 0;
  for (const w of words) {
    const wordLen = w.length;
    if (lineLen === 0) {
      lineLen = wordLen;
    } else if (lineLen + 1 + wordLen <= charsPerLine) {
      lineLen += 1 + wordLen;
    } else {
      lines += 1;
      lineLen = wordLen;
    }
  }
  return lines;
}

// Pick the right MEXEM logo variant based on the ad's orientation and
// background. The brand assets ship four files named like:
//   logo blue P.png     → blue logo, portrait orientation
//   logo white P.png    → white logo, portrait orientation
//   logo blue V.png     → blue logo, landscape/square orientation
//   logo white V.png    → white logo, landscape/square orientation
// After preview-asset copy these become "/brand-input-preview/brand_logo/
// logo-{color}-{orientation}.png". We substitute the {color} and
// {orientation} segments based on (darkBg, portrait) and gracefully fall
// back to the input path when no matching variant exists.
function pickBrandLogoVariant(
  inputPath: string,
  opts: { portrait: boolean; darkBg: boolean },
): string {
  const color = opts.darkBg ? "white" : "blue";
  const orientation = opts.portrait ? "p" : "v";
  // Replace any "logo-(white|blue)-(p|v)" or "logo (white|blue) (P|V)" with the
  // wanted variant. Try the lowercased-dashed shape first (the public copy),
  // then the original spaced casing as a fallback.
  const dashed = inputPath.replace(
    /logo-(?:white|blue)-(?:p|v)\b/i,
    `logo-${color}-${orientation}`,
  );
  if (dashed !== inputPath) return dashed;
  return inputPath.replace(
    /logo (white|blue) ([PV])/i,
    () => `logo ${color} ${orientation.toUpperCase()}`,
  );
}

// IBKR partner logo: brand ships "ibkr-white-logo.png" and "ibkr-colour-logo.png".
// Dark background → white logo, light background → colour.
function pickIBKRVariant(
  inputPath: string,
  opts: { darkBg: boolean },
): string {
  const target = opts.darkBg ? "white" : "colour";
  return inputPath.replace(/ibkr-(?:white|colour|color)-logo/i, `ibkr-${target}-logo`);
}

// Approx WCAG relative luminance for a "#RRGGBB" color. Returns 0..1.
function relLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

// Pick the candidate color with the highest contrast against `bg`. The brand
// kit only stores a small palette of text colors (typically a dark and a
// light), so a dark headline never lands on a dark gradient and vice-versa.
function pickHighContrast(bg: string, candidates: string[], fallback: string): string {
  if (candidates.length === 0) return fallback;
  let best = candidates[0];
  let bestRatio = contrastRatio(bg, best);
  for (let i = 1; i < candidates.length; i++) {
    const r = contrastRatio(bg, candidates[i]);
    if (r > bestRatio) {
      best = candidates[i];
      bestRatio = r;
    }
  }
  return best;
}

// "Effective" background color for contrast: image backgrounds tend to be
// dark in this brand, gradients use their first stop. We pick a single hex
// to score candidates against — close enough for headline-on-bg legibility.
function effectiveBackgroundColor(selection: DemoAssetSelection): string {
  if (selection.background_fill.kind === "gradient") {
    return selection.background_fill.stops[0]?.color ?? "#00122C";
  }
  // Image background: assume dark — most brand backgrounds in this system
  // are dark photography. The contrast picker will choose a light text color.
  return "#00122C";
}

function buildElements(args: BuildElementsArgs): Element[] {
  const {
    size,
    layout,
    visual,
    cloudinaryDelivery,
    midjourneyById,
    midjourney: midjourneyResolved,
    brandKit,
    copy,
  } = args;
  // Phase 3 — generated-asset hooks. Reading these once at the top so the
  // existing branches further down stay structurally identical to today's
  // code; we just rebind `selection` for the bg branch and patch elements
  // after they're pushed.
  const genResolver = args.generatedAssetResolver ?? null;
  const genBg = genResolver?.getBackground() ?? null;
  const genCta = genResolver?.getCtaElement() ?? null;
  const genMockup = genResolver?.getMockup() ?? null;
  const genFx = genResolver?.getFxOverlay() ?? null;
  const genTrading = genResolver?.getTradingUi() ?? null;
  // Override selection.background_fill when an operator-supplied generated
  // background exists — flips the bg branch below into the "image" arm using
  // the asset's URL. Provenance + source are patched onto the pushed element
  // a few lines down. When no generated bg is supplied, this is a no-op.
  let selection = args.selection;
  if (genBg) {
    selection = {
      ...selection,
      background_fill: { kind: "image", public_path: genBg.url },
    };
  }
  // Language-aware typography. The CSS font-family is a stack:
  //   - the brand's preferred font sits first
  //   - then the script-specific Google Font (Heebo for Hebrew, Cairo for
  //     Arabic, Poppins/Inter for Latin)
  //   - sans-serif at the tail as a last resort
  // The /render/ad/[adId] page loads all needed Google Fonts at once.
  const langMeta = LANG_META[args.language];
  const isRtlLang = langMeta.rtl;
  const fontFamily = `"${brandKit.typography.families.headline}", ${langMeta.fontStack}`;
  const langCharWidthRatio = langMeta.charWidthRatio;

  // ── Reference-banner layout rules (audit 2026-05-08) ───────────────────────
  // The 8 MEXEM reference banners show two canonical layout families. The
  // RULE is which family wins per format:
  //
  //   • Landscape (width > height × 1.5)  →  text-left / visual-right
  //                                          (logo top-left, headline left,
  //                                          CTA left, phone overflowing
  //                                          the right edge)
  //   • Portrait  (height > width × 1.3)  →  centered-stacked
  //                                          (logo top-center, headline
  //                                          center, CTA center, phone
  //                                          bottom-center)
  //   • Square    (~1:1)                  →  picked per-concept (PRNG over
  //                                          campaignId × conceptId × format)
  //                                          so the campaign ships variety
  //                                          across its 3 specs.
  //
  // This is the LAYOUT rule. CTA color, emphasis style, arrow glyph etc.
  // remain per-concept design OPTIONS (see pickCtaPalette + ctaArrowStyle
  // + headlineEmphasisStyle above).
  const aspectRatio = size.width / size.height;
  const refIsLandscape = aspectRatio >= 1.5;
  const refIsPortrait = aspectRatio <= 1 / 1.3;
  const squarePicksCenter =
    !refIsLandscape &&
    !refIsPortrait &&
    ctaSeedToInt(`${args.campaignId}::${args.conceptId}::${size.name}::layoutFamily`) % 2 === 0;
  const referenceWantsCenter = refIsPortrait || squarePicksCenter;
  const textAlignDefault: "left" | "right" | "center" = referenceWantsCenter
    ? "center"
    : isRtlLang
      ? "right"
      : "left";
  // Step 7 — resolve paragraph text alignment. When the spec says "auto"
  // we use textAlignDefault (RTL-aware + reference-rule-aware). When the
  // spec gives an explicit value we honor it but RTL-flip left↔right
  // because the AI specifies in reading order, not visual order.
  const specAlignment = (args.rendererHints ?? DEFAULT_RENDERER_HINTS).textAlignment;
  // Brand rule (operator-set): text is ALWAYS at the reading-start side or
  // centered — NEVER at the reading-end side. In LTR (English / Latin):
  // left or center, never right. In RTL (Hebrew / Arabic): right or center,
  // never left. When the AI asks for "right" in LTR (or "left" in RTL) we
  // silently downgrade to the reading-start equivalent — same as how the
  // headline_position=top/bottom collapse works.
  const paragraphAlignRaw: "left" | "center" | "right" = (() => {
    if (specAlignment === "center") return "center";
    if (specAlignment === "auto") return textAlignDefault;
    if (specAlignment === "left") return isRtlLang ? "right" : "left";
    // specAlignment === "right"
    // Reading-end alignment is forbidden by brand rule. Downgrade to
    // reading-start (left in LTR, right in RTL).
    return isRtlLang ? "right" : "left";
  })();
  // Side-panel demotion (operator decision 2026-05): when the text block is
  // a narrow column (e.g. visual_leading wide layout where text occupies
  // ~40% of the canvas), centering text WITHIN the column produces awkward
  // mid-air-floating short lines like
  //
  //     Zero Fees,
  //       Endless
  //     Pirouettes
  //
  // The rule "text-align center" was intended for full-canvas centered
  // hero blocks, not for side panels. When the headline column spans less
  // than 70% of the canvas width, demote center → reading-start so short
  // lines stack tidily against the column's edge.
  const textBlockSpansCanvas =
    layout.headline.width >= size.width * 0.7;
  const paragraphAlign: "left" | "center" | "right" =
    paragraphAlignRaw === "center" && !textBlockSpansCanvas
      ? textAlignDefault
      : paragraphAlignRaw;
  const textAlignCenter: "center" = "center";
  void textAlignCenter; // reserved for future use
  // Pick text colors that contrast with the actual background, rather than
  // blindly using brandKit.colors.text[0] — which is dark blue and invisible
  // on dark navy gradients (see issue: "blue title on a blue background").
  const bgRef = effectiveBackgroundColor(selection);
  const textPalette = [...brandKit.colors.text, "#FFFFFF", "#0A0F1F"];
  const headlineColor = pickHighContrast(bgRef, textPalette, "#FFFFFF");
  const bodyColor = pickHighContrast(bgRef, textPalette, headlineColor);
  const disclaimerColor = pickHighContrast(
    bgRef,
    [...brandKit.colors.disclaimer, "#FFFFFF", "#E5E7EB"],
    "#FFFFFF",
  );
  const hints = args.rendererHints ?? DEFAULT_RENDERER_HINTS;

  // CTA visual treatment is a TWO-LAYER decision:
  //
  // Layer 1 — `hints.ctaStyle` (driven by cta_strategy.weight × accent_usage)
  //           expresses the AI's INTENT: standard / ghost / accent. This is
  //           the brand-discipline filter; the AI can only ask for "accent"
  //           when accent_usage permits it.
  //
  // Layer 2 — when the brand kit declares `cta.variants[]` (a list of
  //           pre-approved CTA looks), we honour the intent by SELECTING
  //           the variant that matches:
  //             ghost    → first variant whose id contains "ghost"
  //             accent   → first variant whose id contains "yellow" / "accent"
  //             standard → PRNG-pick from the remaining variants
  //                        (ids that aren't ghost/accent), keyed on
  //                        ${campaignId}::${conceptId}::${size.name} so
  //                        each spec in a campaign can land on a different
  //                        approved look (white pill on one, navy block on
  //                        another, etc.) while staying deterministic per
  //                        diversity_seed.
  //
  // When `cta.variants[]` is empty (legacy brand kits) the standard path
  // still falls back to the kit's single `button_*` defaults. So this
  // change is additive — no existing brand breaks.
  const accentColor = brandKit.colors.accent[0] ?? "#D81222";
  const ctaPalette = pickCtaPalette({
    ctaStyle: hints.ctaStyle,
    brandKit,
    headlineColor,
    accentColor,
    seedKey: `${args.campaignId}::${args.conceptId}::${size.name}::cta`,
    // Brand rule: CTA fill must never match (or fall below 3:1 against)
    // the canvas background. effectiveBackgroundColor folds gradient
    // first-stop / image-assume-dark into a single hex for the check.
    canvasBg: effectiveBackgroundColor(selection),
  });
  const ctaBg = ctaPalette.bg;
  const ctaFg = ctaPalette.fg;

  const elements: Element[] = [];

  // Background — image element OR a "shape" element backed by a CSS gradient.
  if (selection.background_fill.kind === "image") {
    // Per-spec resolved Midjourney binding wins over the global default.
    const mjBgUploadId = midjourneyResolved.background.upload_id;
    const mjBgAssignment = midjourneyResolved.background.assignment;
    const mjBgUpload = mjBgUploadId
      ? midjourneyById.get(mjBgUploadId)
      : undefined;
    // When Midjourney drove the background, prefer its Cloudinary URL (if
    // present) and stamp the element's source + provenance accordingly.
    const bgFileUrl = mjBgUpload?.cloudinary_secure_url ?? null;
    const bgDelivery = bgFileUrl
      ? {
          file_url: bgFileUrl,
          local_public_path: mjBgUpload?.public_path ?? null,
          cloudinary_public_id: mjBgUpload?.cloudinary_public_id ?? null,
          delivery_source: "cloudinary" as const,
        }
      : mjBgUpload
        ? {
            file_url: absolutePreviewUrl(mjBgUpload.public_path),
            local_public_path: mjBgUpload.public_path,
            cloudinary_public_id: null,
            delivery_source: "local_preview" as const,
          }
        : resolveDelivery(selection.background_fill.public_path, cloudinaryDelivery, false);
    elements.push({
      id: "el_background",
      type: "background",
      role: "background",
      // Honor the upload's own source so DALL-E / gpt-image-1 backgrounds are
      // tagged "openai_image", while manual Midjourney uploads stay tagged
      // "midjourney_manual_upload". Audit logs / exporters can tell them apart.
      source: mjBgUpload?.source ?? (mjBgUpload ? "midjourney_manual_upload" : "user-upload"),
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      z_index: 0,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: bgDelivery.file_url,
      ...(bgDelivery.local_public_path
        ? { local_public_path: bgDelivery.local_public_path }
        : {}),
      ...(bgDelivery.cloudinary_public_id
        ? { cloudinary_public_id: bgDelivery.cloudinary_public_id }
        : {}),
      delivery_source: bgDelivery.delivery_source,
      object_fit: "cover",
      alt_text: mjBgUpload ? "Midjourney background" : "Brand background asset",
      ...(mjBgUpload
        ? {
            midjourney: {
              prompt_id: mjBgUpload.prompt_id,
              upload_id: mjBgUpload.upload_id,
              intended_use: mjBgUpload.intended_use,
              context: mjBgUpload.context,
              approved: mjBgUpload.approved,
              ...(mjBgAssignment
                ? {
                    assignment_id: mjBgAssignment.assignment_id,
                    target_element_role: "background" as const,
                  }
                : {}),
              provenance: { ...MIDJOURNEY_PROVENANCE },
            },
          }
        : {}),
      bannerbear: { layer_name: "background_image", modification_type: "image_url" },
      figma: {
        node_type: "RECTANGLE",
        component_role: "background",
        exportable: false,
        constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
        parent_frame_hint: `Ad / ${size.name}`,
      },
    });
    // Phase 3 — when a generated background drove the bg branch, retag the
    // element we just pushed: source becomes "generated_asset" and we stamp
    // the generated_asset provenance block. The MJ provenance branch above
    // is mutually exclusive with this one because genBg flips selection
    // before the branch runs.
    if (genBg) {
      const last = elements[elements.length - 1];
      last.source = "generated_asset";
      last.alt_text = `Generated background (${genBg.variant})`;
      last.generated_asset = provenanceFromAsset(genBg);
    }
    // Brand tint — a flat, semi-transparent brand-color overlay covering the
    // entire canvas. AI-generated photos look generic in isolation; this
    // multiply-style wash unifies them with brand identity (FT/Bloomberg
    // monochrome treatment). Z-index 5: above raw bg, below scrim/mockup/text.
    const tintColor =
      brandKit.colors.background[0] ?? brandKit.colors.primary[0] ?? "#00122C";
    elements.push({
      id: "el_brand_tint",
      type: "shape",
      role: "decorative",
      source: "ai-generated",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      z_index: 5,
      // Step 6 — emphasis × density opacity multiplier (clamped 0-1).
      opacity: Math.min(1, 0.45 * hints.decorativeOpacityMultiplier),
      rotation: 0,
      visible: true,
      version: 1,
      background_color: tintColor,
      bannerbear: { layer_name: "brand_tint", modification_type: "background_color" },
      figma: {
        node_type: "RECTANGLE",
        component_role: "brand-tint",
        exportable: false,
        constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
        parent_frame_hint: `Ad / ${size.name}`,
      },
    });
    // Scrim — a soft darkening overlay sized to the canvas, gradient direction
    // chosen by composition so text always sits on a darker band of the
    // photographic background. Without this, text on busy AI imagery looks
    // unreadable and amateur. Z-index puts it under the mockup composite (20)
    // and text (40) but above the raw background (0).
    elements.push(buildScrimElement(args.composition, size));
  } else {
    elements.push({
      id: "el_background",
      type: "shape",
      role: "background",
      source: "inline-text",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      z_index: 0,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      background_color: selection.background_fill.stops[0].color,
      bannerbear: {
        layer_name: "background_color",
        modification_type: "background_color",
      },
      figma: {
        node_type: "RECTANGLE",
        component_role: "background-gradient",
        exportable: false,
        constraints: { horizontal: "STRETCH", vertical: "STRETCH" },
        parent_frame_hint: `Ad / ${size.name}`,
      },
      notes: `Preview-only CSS gradient: ${selection.background_fill.css}`,
    });
  }

  // Pattern overlay for `pattern_immersive` template — a clean SVG geometric
  // pattern in the brand accent color, sized to fill the canvas. The style
  // (diagonal lines, dots, arcs, etc.) varies per campaign so two
  // back-to-back campaigns don't both have the same rhythm.
  if (args.template === "pattern_immersive") {
    const accentColor =
      brandKit.colors.accent[0] ?? brandKit.colors.primary[0] ?? "#D81222";
    const style: PatternStyle = args.patternStyle ?? "diagonal_lines";
    const patternEl = buildBrandPatternElement(size, accentColor, style);
    // Step 6 — emphasis × density opacity scale, clamped to [0, 1].
    elements.push({
      ...patternEl,
      opacity: Math.max(0, Math.min(1, patternEl.opacity * hints.decorativeOpacityMultiplier)),
    });
  }

  // Generated brand motif — the "new content" layer. Sits at z-index 8,
  // between the brand pattern (5) and the scrim (10). When present, it
  // turns the ad from a layout into a designed piece: a chart silhouette
  // sweeps under the headline, an arc meter caps the upper half, etc.
  if (args.motif && args.motif !== "none") {
    const motifEl = buildDesignMotifElement(args.motif, size, brandKit);
    if (motifEl) {
      elements.push({
        ...motifEl,
        opacity: Math.max(0, Math.min(1, motifEl.opacity * hints.decorativeOpacityMultiplier)),
      });
    }
  }

  // Brand logo — picks the right variant per ad. Brand ships 4 MEXEM logos:
  //   logo white P / blue P  (portrait — used on 1080x1920 stories)
  //   logo white V / blue V  (landscape/square — used on 1200x628, 1080x1080)
  // Color picked by background luminance: dark bg → white logo,
  // light bg → blue logo. The substitution is filename-based and falls
  // back to the original asset if no variant exists for this combo.
  const bgIsDark = relLuminance(bgRef) < 0.5;
  const isPortrait = size.height > size.width;
  if (selection.brand_logo) {
    const variantPath = pickBrandLogoVariant(selection.brand_logo, {
      portrait: isPortrait,
      darkBg: bgIsDark,
    });
    const d = resolveDelivery(variantPath, cloudinaryDelivery, false);
    elements.push({
      id: "el_logo",
      type: "logo",
      role: "logo",
      source: "user-upload",
      x: layout.logo.x,
      y: layout.logo.y,
      width: layout.logo.width,
      height: layout.logo.height,
      z_index: 30,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: d.file_url,
      ...(d.local_public_path ? { local_public_path: d.local_public_path } : {}),
      ...(d.cloudinary_public_id ? { cloudinary_public_id: d.cloudinary_public_id } : {}),
      delivery_source: d.delivery_source,
      object_fit: "contain",
      alt_text: `${brandKit.brand_name} logo`,
      brand_token_refs: ["logo.primary"],
      uses_approved_color: true,
      source_approved: true,
      bannerbear: { layer_name: "brand_logo", modification_type: "image_url" },
      figma: {
        node_type: "INSTANCE",
        component_role: "logo",
        style_ref: "component/brand-logo",
        exportable: false,
        parent_frame_hint: `Ad / ${size.name} / Header`,
      },
    });
  }

  // "Powered by Interactive Brokers" is intentionally NOT rendered as a
  // separate element. The MEXEM brand logo already includes the partner
  // attribution under its wordmark — adding the IBKR mark again as a
  // standalone layer was duplicating the same information twice on every
  // ad. The selection.powered_by_ib path is still loaded so audit /
  // export consumers can introspect what was available, but no element
  // is pushed to the manifest.
  void selection.powered_by_ib;
  void layout.ibkrLogo;

  // ── Midjourney decorative accents (max 2). ────────────────────────────────
  // Position-preserving: index 0 → decorative_1, index 1 → decorative_2. A
  // null entry at either index means that slot has no binding (no assignment
  // and no global fallback), so we skip it without shifting the other slot.
  // Placed at corners with low opacity, between background and hero.
  for (let i = 0; i < 2; i += 1) {
    const binding = midjourneyResolved.decoratives[i];
    if (!binding || !binding.upload_id) continue;
    const u = midjourneyById.get(binding.upload_id);
    if (!u) continue;
    const decoSize = Math.min(220, Math.round(size.width * 0.18));
    const x = size.width - decoSize - 24;
    const y = i === 0 ? 24 : Math.max(24, size.height - decoSize - 24);
    const fileUrl =
      u.cloudinary_secure_url ?? absolutePreviewUrl(u.public_path);
    const targetRole: "decorative_1" | "decorative_2" =
      i === 0 ? "decorative_1" : "decorative_2";
    elements.push({
      id: `el_mj_decorative_${i + 1}`,
      type: "image",
      role: "decorative",
      source: u.source,
      x,
      y,
      width: decoSize,
      height: decoSize,
      z_index: 5,
      opacity: 0.4,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: fileUrl,
      local_public_path: u.public_path,
      ...(u.cloudinary_public_id ? { cloudinary_public_id: u.cloudinary_public_id } : {}),
      delivery_source: u.cloudinary_secure_url ? "cloudinary" : "local_preview",
      object_fit: "contain",
      alt_text: "Midjourney decorative accent",
      midjourney: {
        prompt_id: u.prompt_id,
        upload_id: u.upload_id,
        intended_use: u.intended_use,
        context: u.context,
        approved: u.approved,
        ...(binding.assignment
          ? {
              assignment_id: binding.assignment.assignment_id,
              target_element_role: targetRole,
            }
          : {}),
        provenance: { ...MIDJOURNEY_PROVENANCE },
      },
      bannerbear: { layer_name: targetRole, modification_type: "image_url" },
      figma: {
        node_type: "RECTANGLE",
        component_role: targetRole,
        exportable: false,
        parent_frame_hint: `Ad / ${size.name} / Decorative`,
      },
    });
  }

  // Product visual: composite > mockup-only > screenshot-only > nothing.
  // Full traceability lives in two places:
  //   - DemoAdSpec.composite_metadata (spec-level)
  //   - element.composite_refs (manifest-level — survives even if the spec
  //     wrapper is dropped)
  // Templates that don't include a device mockup skip this entirely:
  //   - photo_immersive uses the AI background as the only visual.
  //   - editorial_type is type-only with a geometric accent / stat block.
  // Additionally, in mockup_hero we drop the mockup whenever the background
  // is a photographic image — two photographic elements competing was the
  // single loudest "AI demo" signal in the renders. Letting the AI bg own
  // the visual gives the ad room to breathe.
  const hasImageBg = selection.background_fill.kind === "image";
  const wantsMockup = args.template === "mockup_hero" && !hasImageBg;
  if (wantsMockup && visual.visual_public_path && layout.visual) {
    const md = visual.metadata;
    const isComposite = md.fallback_kind === "composite";
    const elementSource: Element["source"] = isComposite
      ? "local_mockup_composite"
      : "user-upload";
    const componentRole = isComposite
      ? "hero-mockup-composite"
      : visual.manifest_role === "hero-image"
        ? "hero-mockup"
        : "platform-screenshot";

    const compositeRefs: NonNullable<Element["composite_refs"]> = {
      ...(md.composite_public_path
        ? { composite_public_path: md.composite_public_path }
        : {}),
      ...(md.composite_id ? { composite_id: md.composite_id } : {}),
      ...(md.mockup_source_path
        ? { original_mockup_asset_path: md.mockup_source_path }
        : {}),
      ...(md.mockup_filename
        ? { original_mockup_filename: md.mockup_filename }
        : {}),
      ...(md.screenshot_source_path
        ? { original_screenshot_asset_path: md.screenshot_source_path }
        : {}),
      ...(md.screenshot_filename
        ? { original_screenshot_filename: md.screenshot_filename }
        : {}),
      screenshot_context: md.selected_context,
      ...(md.screenshot_context_confidence
        ? { screenshot_context_confidence: md.screenshot_context_confidence }
        : {}),
      ...(md.mockup_slot_source ? { mockup_slot_source: md.mockup_slot_source } : {}),
    };

    const visualDelivery = resolveDelivery(
      visual.visual_public_path,
      cloudinaryDelivery,
      isComposite,
    );

    // Augment composite_refs with the cloudinary public_id for the composite
    // when we have one — keeps the manifest self-describing.
    if (visualDelivery.cloudinary_public_id && isComposite) {
      compositeRefs.composite_public_path =
        compositeRefs.composite_public_path ?? visual.visual_public_path;
    }

    elements.push({
      id: "el_visual",
      type: "image",
      role: "product_visual",
      source: elementSource,
      x: layout.visual.x,
      y: layout.visual.y,
      width: layout.visual.width,
      height: layout.visual.height,
      z_index: 20,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: visualDelivery.file_url,
      ...(visualDelivery.local_public_path
        ? { local_public_path: visualDelivery.local_public_path }
        : {}),
      ...(visualDelivery.cloudinary_public_id
        ? { cloudinary_public_id: visualDelivery.cloudinary_public_id }
        : {}),
      delivery_source: visualDelivery.delivery_source,
      object_fit: "contain",
      alt_text: visual.alt_text,
      bannerbear: { layer_name: "product_mockup", modification_type: "image_url" },
      figma: {
        node_type: "FRAME",
        component_role: componentRole,
        exportable: true,
        parent_frame_hint: `Ad / ${size.name} / Visual`,
      },
      composite_refs: compositeRefs,
      notes: `${md.fallback_kind} · ${md.selected_context}`,
      // Brand rule (operator-set): the visual element should "blend into"
      // the brand gradient — soft drop shadow grounds the device on the
      // canvas and prevents the hard rectangular silhouette of a PNG
      // mockup from looking pasted-on. Applied as a CSS drop-shadow at
      // render time so it follows the device's actual transparent shape,
      // not its bounding box.
      shadow: {
        x: 0,
        y: 24,
        blur: 60,
        spread: 0,
        color: "rgba(0, 0, 0, 0.45)",
      },
    });

    // Phase 3 — generated mockup override. Replaces el_visual's file_url with
    // the generated mockup composite while preserving the layout-driven
    // x/y/width/height + drop-shadow + composite_refs (we add the asset's
    // own provenance separately). The renderer treats this as a regular
    // image element.
    if (genMockup) {
      const last = elements[elements.length - 1];
      last.file_url = absolutePreviewUrl(genMockup.url);
      last.local_public_path = genMockup.url;
      last.cloudinary_public_id = undefined;
      last.delivery_source = "local_preview";
      last.source = "generated_asset";
      last.alt_text = `Generated mockup (${genMockup.variant})`;
      last.generated_asset = provenanceFromAsset(genMockup);
      // Phase 4 — aspect-ratio sanity. object_fit=contain letterboxes the
      // mockup if the slot AR is far from the asset AR, which can read as
      // "the mockup is floating in dead space". Warn so the operator either
      // re-generates the mockup at a closer AR or picks a different layout.
      const authoredAR = genMockup.size.width / genMockup.size.height;
      const slotAR = last.width / last.height;
      const ratio = Math.max(authoredAR, slotAR) / Math.min(authoredAR, slotAR);
      if (ratio > 1.5) {
        args.qaWarnings?.push(
          `${genMockup.id}: mockup aspect-ratio mismatch — asset ${genMockup.size.width}×${genMockup.size.height} (${authoredAR.toFixed(2)}) vs layout ${last.width}×${last.height} (${slotAR.toFixed(2)}). object_fit=contain will letterbox.`,
        );
      }
    }

    // Step 11 follow-up — when composition=hero_overlay turns the mockup
    // composite into a full-canvas background (mockup_hero with hero_overlay
    // composition is the AI's way of saying "mockup-as-bg"), the headline
    // and CTA float DIRECTLY on top of a busy chart screenshot. Without a
    // scrim, white headline lands on red/green candles and the CTA reads
    // against whatever's underneath. Push a scrim above the mockup (z=30)
    // and below text (z=40) so the overlay is always readable. We gate on
    // the mockup actually filling most of the canvas — when the mockup is
    // a side panel (text_leading / visual_leading), the text doesn't sit
    // over it and a scrim would just dim a clean half of the design.
    const visualCoversCanvas =
      layout.visual.width >= size.width * 0.85 &&
      layout.visual.height >= size.height * 0.85;
    if (args.composition === "hero_overlay" && visualCoversCanvas) {
      elements.push(buildScrimElement(args.composition, size, 30));
    }
  }

  // Editorial focal element: when the AI emitted a `stat` (e.g. "$0 / PER ETF
  // TRADE"), render that as the design's centerpiece — big tabular number
  // in the brand accent color, small uppercase label underneath. This is
  // the single most finance-specific signal the system can show. Falls back
  // to a geometric accent disc when no stat was provided OR when the
  // available vertical strip between logo and headline is too small to
  // fit the stat without overflowing into the headline.
  const editorialStripHeight =
    layout.headline.y - (layout.logo.y + layout.logo.height) - 48; // 24 padding each side
  const statFitsCleanly =
    !!args.designElements?.stat && editorialStripHeight >= 110;
  if (args.template === "editorial_type") {
    const accentColor =
      brandKit.colors.accent[0] ?? brandKit.colors.primary[0] ?? "#D81222";
    if (statFitsCleanly && args.designElements?.stat) {
      const stat = computeStatPlacement(args.composition, size, layout);
      elements.push({
        id: "el_stat_number",
        type: "text",
        role: "decorative",
        source: "inline-text",
        x: stat.number.x,
        y: stat.number.y,
        width: stat.number.width,
        height: stat.number.height,
        z_index: 15,
        opacity: 1,
        rotation: 0,
        visible: true,
        version: 1,
        text: args.designElements.stat.number,
        font_family: fontFamily,
        font_weight: 800,
        font_size: stat.number.fontSize,
        line_height: 0.95,
        letter_spacing: -2,
        text_align: stat.number.textAlign,
        color: accentColor,
        uses_approved_color: true,
        uses_approved_font: true,
        bannerbear: { layer_name: "stat_number", modification_type: "text" },
        figma: {
          node_type: "TEXT",
          component_role: "stat_number",
          style_ref: `text/stat-number-${size.name}`,
          exportable: false,
          parent_frame_hint: `Ad / ${size.name} / Stat`,
        },
      });
      elements.push({
        id: "el_stat_label",
        type: "text",
        role: "decorative",
        source: "inline-text",
        x: stat.label.x,
        y: stat.label.y,
        width: stat.label.width,
        height: stat.label.height,
        z_index: 15,
        opacity: 1,
        rotation: 0,
        visible: true,
        version: 1,
        text: args.designElements.stat.label.toUpperCase(),
        font_family: fontFamily,
        font_weight: 600,
        font_size: stat.label.fontSize,
        line_height: 1.2,
        letter_spacing: 2,
        text_align: stat.label.textAlign,
        color: headlineColor,
        uses_approved_color: true,
        uses_approved_font: true,
        bannerbear: { layer_name: "stat_label", modification_type: "text" },
        figma: {
          node_type: "TEXT",
          component_role: "stat_label",
          style_ref: `text/stat-label-${size.name}`,
          exportable: false,
          parent_frame_hint: `Ad / ${size.name} / Stat`,
        },
      });
    } else {
      const accent = computeEditorialAccent(args.composition, size);
      elements.push({
        id: "el_accent",
        type: "shape",
        role: "decorative",
        source: "ai-generated",
        x: accent.x,
        y: accent.y,
        width: accent.width,
        height: accent.height,
        z_index: 15,
        opacity: accent.opacity,
        rotation: 0,
        visible: true,
        version: 1,
        background_color: accentColor,
        border_radius: accent.border_radius,
        bannerbear: { layer_name: "accent_shape", modification_type: "background_color" },
        figma: {
          node_type: "ELLIPSE",
          component_role: "accent",
          exportable: false,
          parent_frame_hint: `Ad / ${size.name} / Decorative`,
        },
      });
    }
  }

  // The stat block is now a focal element ABOVE the headline — not a
  // full-canvas takeover. Headline + subheadline still render so the ad
  // has copy context ("200+ TOOLS AVAILABLE" alone read as exaggerated;
  // "200+ TOOLS AVAILABLE" + "Build a portfolio that breathes" reads as
  // an editorial finance ad). Only the eyebrow is dropped — its job is
  // taken by the stat label, which sits in the same visual register.
  // statTakesOver mirrors statFitsCleanly below — set inline so eyebrow
  // skipping decisions match what actually renders.
  const _statStripHeight =
    layout.headline.y - (layout.logo.y + layout.logo.height) - 48;
  const statTakesOver =
    args.template === "editorial_type" &&
    !!args.designElements?.stat &&
    _statStripHeight >= 110;

  // Eyebrow (optional) — small uppercase line above the headline. The AI
  // requests this to add finance-domain specificity ("ETF TRADING",
  // "0% COMMISSIONS", etc.). Forced uppercase + tighter tracking. Brand
  // accent color when distinct from text, otherwise the body color.
  //
  // Logo-clearance rule: eyebrow must start at least 24 px below the
  // logo's bottom edge so the brand mark always has breathing room. If
  // that clearance pushes the eyebrow within 12 px of the headline, the
  // strip between logo and headline is too narrow to host an eyebrow at
  // all — skip it rather than crowd the logo or overlap the headline.
  // Step 6 — spacing.density="minimal" suppresses the eyebrow even when the
  // AI emitted one. Honors the schema's "element count budget: minimal =
  // headline + CTA + logo + disclaimer" intent.
  if (args.designElements?.eyebrow && !statTakesOver && !hints.suppressEyebrow) {
    const eyebrowSize = Math.max(
      14,
      Math.round(layout.subheadline.fontSize * 0.55),
    );
    const eyebrowH = Math.round(eyebrowSize * 1.4);
    const logoBottom = layout.logo.y + layout.logo.height;
    // Logo-clearance: eyebrow starts at least 24 px below the logo so the
    // brand mark always has breathing room. The natural position is
    // `headline.y - eyebrowH - 8` (eyebrow tucked just above headline);
    // we honor that, but never let the eyebrow encroach on the logo
    // band. If clearance pushes the eyebrow into actual headline overlap,
    // skip it — the strip is too narrow to host both.
    const naturalY = layout.headline.y - eyebrowH - 8;
    const minY = logoBottom + 24;
    const safeY = Math.max(naturalY, minY);
    const overlapsHeadline = safeY + eyebrowH + 4 > layout.headline.y;
    if (!overlapsHeadline) {
    // Step 6 — accent_usage="strong" pulls the eyebrow color to the brand
    // accent so the accent appears somewhere even when the CTA stays on
    // the standard fill. Falls back to the contrast-picked color when
    // accent_usage is anything else (today's behavior).
    const eyebrowColor = hints.eyebrowUsesAccent
      ? brandKit.colors.accent[0] ?? headlineColor
      : pickHighContrast(
          bgRef,
          [brandKit.colors.accent[0] ?? "", ...brandKit.colors.text, "#FFFFFF"].filter(Boolean),
          "#FFFFFF",
        ) || headlineColor;
    elements.push({
      id: "el_eyebrow",
      type: "text",
      role: "decorative",
      source: "inline-text",
      x: layout.headline.x,
      y: safeY,
      width: layout.headline.width,
      height: eyebrowH,
      z_index: 40,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      text: args.designElements.eyebrow.toUpperCase(),
      font_family: fontFamily,
      font_weight: 600,
      font_size: eyebrowSize,
      line_height: 1.2,
      letter_spacing: 2,
      text_align: paragraphAlign,
      color: eyebrowColor,
      uses_approved_color: true,
      uses_approved_font: true,
      bannerbear: { layer_name: "eyebrow", modification_type: "text" },
      figma: {
        node_type: "TEXT",
        component_role: "eyebrow",
        style_ref: `text/eyebrow-${size.name}`,
        exportable: false,
        parent_frame_hint: `Ad / ${size.name} / Copy`,
      },
    });
    }
  }

  // Headline — always rendered. When a stat sits above it, the stat's
  // eyebrow-style label leads visually and the headline becomes the
  // supporting narrative line.
  void statTakesOver;
  // Shrink-to-fit: a long headline rendered at the brand-kit's max font
  // would overflow into the subheadline below. We estimate rendered
  // height and step font size down until the text fits the allocated
  // box. Floor at 36 px so the headline stays the visual leader.
  const headlineLineHeight = brandKit.typography.line_heights?.headline ?? 1.0;
  const headlineFontFitted = fitFontToBox({
    text: copy.headline,
    boxWidth: layout.headline.width,
    boxHeight: layout.headline.height,
    baseFontSize: layout.headline.fontSize,
    lineHeight: headlineLineHeight,
    minFont: 36,
    // ALL-CAPS bold headlines (the MEXEM reference style) actually render
    // WIDER per character than mixed-case body text — Poppins-bold
    // measures ~0.58 char-width-ratio in Chrome for uppercase letters.
    // Use a larger ratio than the default so countWrappedLines finds the
    // right line count. The fallback when language has unusually narrow
    // glyphs (Hebrew = 0.5) still bumps headlines up — the cap at 0.6
    // covers Latin / Arabic / Cyrillic without over-counting.
    charWidthRatio: Math.min(0.6, Math.max(0.55, langCharWidthRatio + 0.05)),
  });
  // Headline emphasis style is a per-concept OPTION (the reference banners
  // confirmed both looks are valid):
  //
  //   "color_split"   → legacy MEXEM look: prefix in brand-accent yellow,
  //                     remainder in headline color (white on dark navy).
  //   "single_color"  → reference banners (audit 2026-05-08): the whole
  //                     headline stays one color (white). Emphasis is
  //                     conveyed via natural line-break + the accent
  //                     word landing on its own line.
  //
  // Picked deterministically per (campaign, concept, format) so a single
  // campaign produces both treatments across its specs while staying
  // reproducible under diversity_seed.
  const accentYellow = brandKit.colors.accent[0] ?? "#F5C518";
  const headlineEmphasis =
    copy.headline_emphasis &&
    copy.headline.startsWith(copy.headline_emphasis) &&
    copy.headline_emphasis.length > 0 &&
    copy.headline_emphasis.length < copy.headline.length
      ? copy.headline_emphasis
      : undefined;
  const headlineEmphasisStyle: "color_split" | "single_color" =
    ctaSeedToInt(`${args.campaignId}::${args.conceptId}::${size.name}::headline`) % 2 === 0
      ? "color_split"
      : "single_color";
  {
    elements.push({
    id: "el_headline",
    type: "text",
    role: "headline",
    source: "inline-text",
    x: layout.headline.x,
    y: layout.headline.y,
    width: layout.headline.width,
    height: layout.headline.height,
    z_index: 40,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    text: copy.headline,
    // Honor the per-concept emphasis style. color_split adds the brand
    // accent color to the prefix; single_color omits the color so the
    // renderer keeps the whole headline one color (matches the reference
    // banners that don't use a yellow split).
    ...(headlineEmphasis
      ? headlineEmphasisStyle === "color_split"
        ? { emphasis_text: headlineEmphasis, emphasis_color: accentYellow }
        : { emphasis_text: headlineEmphasis }
      : {}),
    font_family: fontFamily,
    font_weight: 800,
    font_size: headlineFontFitted,
    line_height: headlineLineHeight,
    letter_spacing: -1.5,
    text_align: paragraphAlign,
    color: headlineColor,
    brand_token_refs: ["color.text", "font.headline"],
    uses_approved_color: true,
    uses_approved_font: true,
    bannerbear: { layer_name: "headline", modification_type: "text" },
    figma: {
      node_type: "TEXT",
      component_role: "headline",
      style_ref: `text/heading-${size.name}`,
      exportable: false,
      parent_frame_hint: `Ad / ${size.name} / Copy`,
    },
  });
  }

  // Subheadline — always rendered alongside the headline.
  // Shrink-to-fit just like the headline so a long subheadline never
  // bleeds into the CTA below.
  // Step 8 — text_strategy.max_text_density="low" skips the subheadline
  // entirely. The CTA is pulled up by applyCompositionFromSpec to close
  // the gap so the headline → CTA stack reads cleanly without an empty
  // band where the subheadline used to be.
  const subLineHeight = brandKit.typography.line_heights?.body ?? 1.4;
  const subFontFitted = fitFontToBox({
    text: copy.subheadline,
    boxWidth: layout.subheadline.width,
    boxHeight: layout.subheadline.height,
    baseFontSize: layout.subheadline.fontSize,
    lineHeight: subLineHeight,
    minFont: 14,
    charWidthRatio: langCharWidthRatio,
  });
  if (!hints.suppressSubheadline) {
    elements.push({
    id: "el_subheadline",
    type: "text",
    role: "subheadline",
    source: "inline-text",
    x: layout.subheadline.x,
    y: layout.subheadline.y,
    width: layout.subheadline.width,
    height: layout.subheadline.height,
    z_index: 40,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    text: copy.subheadline,
    font_family: fontFamily,
    font_weight: 400,
    font_size: subFontFitted,
    line_height: subLineHeight,
    letter_spacing: 0,
    text_align: paragraphAlign,
    color: bodyColor,
    brand_token_refs: ["color.text", "font.body"],
    uses_approved_color: true,
    uses_approved_font: true,
    bannerbear: { layer_name: "subheadline", modification_type: "text" },
    figma: {
      node_type: "TEXT",
      component_role: "body",
      style_ref: `text/body-${size.name}`,
      exportable: false,
      parent_frame_hint: `Ad / ${size.name} / Copy`,
    },
  });
  }

  // Step 10 — Kicker (optional pull-quote line below subheadline).
  // Renders only when text_strategy.max_text_density="high" AND the AI
  // emitted design_elements.kicker AND the renderer's fit-check finds
  // ≥30 px of vertical room between subheadline.bottom and cta.top.
  // Otherwise silently skipped — the spec asked, the layout said no,
  // we err on disclaimer / CTA readability.
  if (
    hints.allowKicker &&
    args.designElements?.kicker &&
    !hints.suppressSubheadline
  ) {
    const kickerSize = Math.max(
      14,
      Math.round(layout.subheadline.fontSize * 0.78),
    );
    const kickerH = Math.round(kickerSize * 1.4);
    const kickerY = layout.subheadline.y + layout.subheadline.height + 8;
    const kickerFits = kickerY + kickerH + 12 <= layout.cta.y;
    if (kickerFits) {
      elements.push({
        id: "el_kicker",
        type: "text",
        role: "body",
        source: "inline-text",
        x: layout.subheadline.x,
        y: kickerY,
        width: layout.subheadline.width,
        height: kickerH,
        z_index: 40,
        opacity: 1,
        rotation: 0,
        visible: true,
        version: 1,
        text: args.designElements.kicker,
        font_family: fontFamily,
        font_weight: 500,
        font_size: kickerSize,
        line_height: 1.3,
        letter_spacing: 0,
        text_align: paragraphAlign,
        color: bodyColor,
        uses_approved_color: true,
        uses_approved_font: true,
        bannerbear: { layer_name: "kicker", modification_type: "text" },
        figma: {
          node_type: "TEXT",
          component_role: "body",
          style_ref: `text/kicker-${size.name}`,
          exportable: false,
          parent_frame_hint: `Ad / ${size.name} / Copy`,
        },
      });
    }
  }

  // CTA — pill-shaped button with an arrow suffix. Pill border-radius =
  // half the button height (always fully-rounded ends), and the arrow "→"
  // signals action. Brand kit's `border_radius` is used as a floor; we
  // bump it up to half-height so the button reads as modern.
  // MEXEM reference rule — when the spec asked for a "bottom_band" CTA
  // (set in applyCompositionFromSpec by stretching cta.x=0 / cta.width=
  // canvas), the button is a full-width yellow band with sharp corners
  // and dark text. Detection is purely from the layout dimensions to keep
  // the element-builder decoupled from the hints. Brand-accent yellow
  // overrides the per-spec ctaPalette and the disclaimer-style sub-pixel
  // border; the band is its own creature.
  const isBottomBand =
    layout.cta.x === 0 && layout.cta.width >= size.width - 1;
  const pillRadius = Math.round(layout.cta.height / 2);
  const ctaBorderRadius = isBottomBand
    ? 0
    : Math.max(brandKit.cta.border_radius ?? 0, pillRadius);
  // CTA arrow suffix — now a per-concept OPTION instead of a hard rule.
  // Two valid treatments exist in the reference creative:
  //   "with_arrow"  → "Start investing →" (legacy default; CTA reads as a
  //                   directional verb)
  //   "no_arrow"    → "Start investing" (reference pill; the pill shape
  //                   itself implies the direction)
  // Picked deterministically per (campaign, concept, format).
  const ctaArrow = langMeta.arrow.forward;
  const ctaArrowStyle: "with_arrow" | "no_arrow" =
    ctaSeedToInt(`${args.campaignId}::${args.conceptId}::${size.name}::ctaArrow`) % 2 === 0
      ? "with_arrow"
      : "no_arrow";
  const ctaHasArrow = /[←-⇿➠-➿]/.test(copy.cta);
  const ctaText = ctaHasArrow
    ? copy.cta
    : ctaArrowStyle === "no_arrow"
      ? copy.cta
      : isRtlLang
        ? ctaArrow + " " + copy.cta
        : copy.cta + " " + ctaArrow;
  // CTA box must always fit the actual text. The renderer flex-centers
  // it, but if the box is narrower than the text width, `whiteSpace:
  // nowrap; overflow: hidden` clips on the right — which is exactly the
  // "text not positioned well" issue. Estimate width from font + char
  // count and grow the box. The bottom-band variant locks width to the
  // canvas (already set by applyCompositionFromSpec) and skips this path.
  const ctaCharBudgetPx = Math.ceil(layout.cta.fontSize * 0.58 * ctaText.length);
  const ctaSafeWidth = ctaCharBudgetPx + 96; // 48 px breathing room each side
  const ctaWidth = isBottomBand
    ? layout.cta.width
    : Math.max(layout.cta.width, ctaSafeWidth);
  // Reference rule: the bottom-band CTA fills with brand-accent yellow and
  // uses dark navy text. ctaPalette (which carries ghost / standard /
  // accent from cta.weight × accent_usage) is overridden here for the
  // band variant — this is the strongest brand-discipline signal in the
  // reference set. (Reuses the `accentYellow` declared earlier for the
  // headline 2-color split — same brand token, same source.)
  const bandFg = pickHighContrast(accentYellow, ["#0A0F1F", "#FFFFFF"], "#0A0F1F");
  const finalCtaBg = isBottomBand ? accentYellow : ctaBg;
  const finalCtaFg = isBottomBand ? bandFg : ctaFg;
  // CTA horizontal centering when the paragraph block is center-aligned.
  // applyCompositionFromSpec writes layout.cta.x off the text-region's
  // reading-start side (innerLeft for LTR), which lands the CTA on the LEFT
  // when the headline is centered — visually broken (see report from 2026-05).
  // When `paragraphAlign === "center"` we re-center the CTA inside the same
  // text column as the headline. bottom_band is exempt (it stretches to the
  // canvas edge by design).
  let ctaX = layout.cta.x;
  if (!isBottomBand && paragraphAlign === "center") {
    const headlineCol = layout.headline;
    ctaX = Math.round(headlineCol.x + (headlineCol.width - ctaWidth) / 2);
  }
  elements.push({
    id: "el_cta",
    type: "cta-button",
    role: "cta",
    source: "inline-text",
    x: ctaX,
    y: layout.cta.y,
    width: ctaWidth,
    height: layout.cta.height,
    z_index: 50,
    opacity: 1,
    rotation: 0,
    visible: true,
    version: 1,
    text: ctaText,
    font_family: fontFamily,
    // Step 6 — ghost CTAs read better with slightly heavier weight to
    // compensate for the missing fill. Filled variants stay at 600.
    font_weight: hints.ctaStyle === "ghost" ? 700 : isBottomBand ? 700 : 600,
    font_size: layout.cta.fontSize,
    line_height: brandKit.typography.line_heights?.cta ?? 1.1,
    text_align: "center",
    color: finalCtaFg,
    background_color: finalCtaBg,
    border_radius: ctaBorderRadius,
    // Step 6 — ghost variant adds a brand-color outline. Other variants
    // omit border_width so the renderer's existing "no border" path runs
    // unchanged.
    ...(ctaPalette.borderWidth
      ? {
          border_width: ctaPalette.borderWidth,
          border_color: ctaPalette.borderColor ?? headlineColor,
        }
      : {}),
    brand_token_refs: ["color.cta-bg", "color.cta-fg", "font.cta"],
    uses_approved_color: true,
    uses_approved_font: true,
    bannerbear: {
      layer_name: "cta",
      text_layer_name: "cta_text",
      button_layer_name: "cta_button",
      modification_type: "text",
    },
    figma: {
      node_type: "FRAME",
      component_role: "cta-button",
      style_ref: "component/cta-primary",
      exportable: true,
      auto_layout_hint: "horizontal",
      parent_frame_hint: `Ad / ${size.name} / CTA`,
    },
  });

  // Phase 3 — generated CTA override. When the brief picked a CTA asset with
  // render_mode=element + element_manifest_preview, copy its renderer-bound
  // fields onto the el_cta we just pushed. We deliberately KEEP the layout-
  // driven box geometry (x/y/width/height/z_index/id) and only adopt the
  // text-shape fields the asset was designed around — so the CTA still fits
  // the canvas's per-format placement rules.
  if (genCta) {
    const preview = genCta.element_manifest_preview;
    if (!preview) {
      // Asset was generated in svg-mode (no element shape). Skip — the
      // existing brand-kit-driven CTA stays as-is. Warn for the operator.
      const last = elements[elements.length - 1];
      const skipMsg = `generated CTA ${genCta.id} skipped — render_mode is "${genCta.render_mode}", needs "element"`;
      last.notes = (last.notes ? last.notes + " · " : "") + skipMsg;
      args.qaWarnings?.push(skipMsg);
    } else {
      const last = elements[elements.length - 1];
      // Renderer-bound fields. Geometry stays from layout.
      last.text = preview.text ?? last.text;
      last.font_family = preview.font_family ?? last.font_family;
      last.font_weight = preview.font_weight ?? last.font_weight;
      last.font_size = preview.font_size ?? last.font_size;
      last.line_height = preview.line_height ?? last.line_height;
      last.letter_spacing = preview.letter_spacing ?? last.letter_spacing;
      last.text_align = preview.text_align ?? last.text_align;
      last.color = preview.color ?? last.color;
      last.background_color = preview.background_color ?? last.background_color;
      last.border_radius = preview.border_radius ?? last.border_radius;
      last.padding = preview.padding ?? last.padding;
      if (preview.border_width !== undefined) last.border_width = preview.border_width;
      if (preview.border_color !== undefined) last.border_color = preview.border_color;
      if (preview.shadow !== undefined) last.shadow = preview.shadow;
      last.source = "generated_asset";
      last.generated_asset = provenanceFromAsset(genCta);

      // Phase 4 — CTA post-layout fit check. The generator validated text
      // fits at the asset's authored size, but we just re-stamped the box
      // geometry from the layout (which can be smaller, especially in
      // 1080x1920 portrait). Re-run the same `fontSize * 0.58 * len` budget
      // the renderer uses, and shrink the font 2px at a time until it fits.
      // Padding is preserved as long as the result stays above 18px;
      // otherwise we trim horizontal padding by 50% and re-fit.
      const ctaText = String(last.text ?? "");
      const refitNotes: string[] = [];
      let fontSize = Number(last.font_size ?? 32);
      let padL = last.padding?.left ?? 0;
      let padR = last.padding?.right ?? 0;
      const innerWidth = () => Math.max(0, last.width - padL - padR);
      const fits = () => Math.ceil(fontSize * 0.58 * ctaText.length) <= innerWidth();
      if (!fits()) {
        const before = fontSize;
        // Phase 1 — shrink font down to 18 with current padding.
        while (!fits() && fontSize > 18) fontSize -= 2;
        if (!fits()) {
          // Phase 2 — trim horizontal padding by 50% (preserve top/bottom).
          padL = Math.floor(padL * 0.5);
          padR = Math.floor(padR * 0.5);
          while (!fits() && fontSize > 12) fontSize -= 2;
        }
        last.font_size = fontSize;
        last.padding = {
          ...(last.padding ?? {}),
          left: padL,
          right: padR,
        };
        refitNotes.push(
          `CTA text "${ctaText}" refit: font ${before}→${fontSize}px, hPadding ${preview.padding?.left ?? 0}/${preview.padding?.right ?? 0}→${padL}/${padR} (box ${last.width}×${last.height})`,
        );
      }
      // Aspect-ratio sanity vs. the asset's authored size — surface a warning
      // when the layout slot is dramatically different so the operator can
      // either widen the layout or pick a CTA designed for the smaller box.
      if (preview.width && preview.height) {
        const authoredAR = preview.width / preview.height;
        const slotAR = last.width / last.height;
        const ratio = Math.max(authoredAR, slotAR) / Math.min(authoredAR, slotAR);
        if (ratio > 1.6) {
          refitNotes.push(
            `CTA aspect-ratio mismatch: asset ${preview.width}×${preview.height} (${authoredAR.toFixed(2)}) vs layout ${last.width}×${last.height} (${slotAR.toFixed(2)}).`,
          );
        }
      }
      for (const n of refitNotes) args.qaWarnings?.push(`${genCta.id}: ${n}`);
    }
  }

  // Risk warning / disclaimer
  if (copy.disclaimer) {
    // Shrink-to-fit the disclaimer too. Disclaimers are often the longest
    // string in the manifest (legal language like "Caution. Investing
    // involves risk of loss…") and the box is shallow — without this,
    // long disclaimers wrap to 2-3 lines and overflow into the bottom edge.
    const discLineHeight = brandKit.typography.line_heights?.disclaimer ?? 1.2;
    const disclaimerFontFitted = fitFontToBox({
      text: copy.disclaimer,
      boxWidth: layout.riskWarning.width,
      boxHeight: layout.riskWarning.height,
      baseFontSize: layout.riskWarning.fontSize,
      lineHeight: discLineHeight,
      minFont: 10,
      charWidthRatio: langCharWidthRatio,
    });
    elements.push({
      id: "el_disclaimer",
      type: "legal",
      role: "legal-disclaimer",
      source: "inline-text",
      x: layout.riskWarning.x,
      y: layout.riskWarning.y,
      width: layout.riskWarning.width,
      height: layout.riskWarning.height,
      z_index: 45,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      text: copy.disclaimer,
      font_family: fontFamily,
      font_weight: 400,
      font_size: disclaimerFontFitted,
      line_height: discLineHeight,
      text_align: "center",
      color: disclaimerColor,
      required: true,
      compliance_status: "approved",
      legal_review_required: true,
      bannerbear: { layer_name: "disclaimer", modification_type: "text" },
      figma: {
        node_type: "TEXT",
        component_role: "legal",
        style_ref: `text/legal-${size.name}`,
        exportable: false,
        parent_frame_hint: `Ad / ${size.name} / Legal`,
      },
    });
  }

  // Phase 3 — append optional generated FX overlay + trading UI.
  // Geometry rules:
  //   - FX overlay: full canvas, z_index from placement_rules
  //     (default 60 → above visuals, BELOW headline/CTA/disclaimer because
  //     those sit at z_index 70/50/45 in this builder).
  //   - Trading UI: anchored into the visual region (same bbox as el_visual)
  //     so it doesn't crash into headline/disclaimer. Capped by
  //     placement_rules.max_width_ratio (default 0.55 of canvas width).
  if (genFx) {
    const role = (genFx.placement_rules.compatible_roles?.[0] ?? "decorative") as
      | "decorative"
      | "background";
    // FX overlays must sit BELOW text/CTA/disclaimer. In this manifest the
    // CTA is at 50, disclaimer at 45. Anything ≥ 45 from the asset's
    // placement_rules gets clamped down so legal/CTA stay readable.
    const requested = genFx.placement_rules.recommended_z_index ?? 60;
    const z = Math.min(requested, 40);
    const opacity =
      typeof genFx.params?.intensity === "number"
        ? Math.min(0.7, Math.max(0, genFx.params.intensity as number))
        : 0.55;
    elements.push({
      id: "el_generated_fx",
      type: "image",
      role,
      source: "generated_asset",
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      z_index: z,
      opacity,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: absolutePreviewUrl(genFx.url),
      local_public_path: genFx.url,
      delivery_source: "local_preview",
      object_fit: "cover",
      alt_text: `Generated FX overlay (${genFx.variant})`,
      generated_asset: provenanceFromAsset(genFx),
    });
  }

  if (genTrading) {
    const compatibleRoles = genTrading.placement_rules.compatible_roles ?? [];
    const isProductVisual = compatibleRoles.includes("product_visual");
    const role = (isProductVisual ? "product_visual" : "supporting-image") as
      | "product_visual"
      | "supporting-image";
    const maxWidthRatio = genTrading.placement_rules.max_width_ratio ?? 0.55;
    const maxHeightRatio = genTrading.placement_rules.max_height_ratio ?? 0.6;
    // Anchor into the visual region when the layout reserved one. Otherwise
    // (text-only compositions like text_leading without a visual) fall back
    // to a centered slot within the bottom half of the canvas so the widget
    // doesn't crash into the headline.
    const region =
      layout.visual ?? {
        x: size.width * 0.05,
        y: size.height * 0.45,
        width: size.width * 0.9,
        height: size.height * 0.45,
      };
    const tw = Math.min(region.width, size.width * maxWidthRatio);
    const th = Math.min(region.height, size.height * maxHeightRatio);
    const tx = region.x + (region.width - tw) / 2;
    const ty = region.y + (region.height - th) / 2;
    const z = genTrading.placement_rules.recommended_z_index ?? 35;
    elements.push({
      id: "el_generated_trading_ui",
      type: "image",
      role,
      source: "generated_asset",
      x: tx,
      y: ty,
      width: tw,
      height: th,
      z_index: z,
      opacity: 1,
      rotation: 0,
      visible: true,
      version: 1,
      file_url: absolutePreviewUrl(genTrading.url),
      local_public_path: genTrading.url,
      delivery_source: "local_preview",
      object_fit: "contain",
      alt_text: `Generated trading widget (${genTrading.variant})`,
      generated_asset: provenanceFromAsset(genTrading),
    });
    // Phase 4 — same AR sanity as the mockup branch.
    const authoredAR = genTrading.size.width / genTrading.size.height;
    const slotAR = tw / th;
    const ratio = Math.max(authoredAR, slotAR) / Math.min(authoredAR, slotAR);
    if (ratio > 1.5) {
      args.qaWarnings?.push(
        `${genTrading.id}: trading-UI aspect-ratio mismatch — asset ${genTrading.size.width}×${genTrading.size.height} (${authoredAR.toFixed(2)}) vs slot ${Math.round(tw)}×${Math.round(th)} (${slotAR.toFixed(2)}). object_fit=contain will letterbox.`,
      );
    }
  }

  return elements;
}

// Convert "/brand-input-preview/...png" → "https://example.invalid/..." style?
// No — the manifest must be portable, so it stores the relative public path.
// The preview React layer prepends location.origin at render time. For
// schema validation (which requires a URL), we synthesize a stable absolute
// URL using example.invalid, replaced at render-time.
function absolutePreviewUrl(publicPath: string): string {
  // Element manifest schema validates file_url as a URL. Use a deterministic
  // "file:" URL so the manifest is parseable on its own; the React preview
  // resolves the original public_path from the same path.
  // The leading "/" is preserved as the path portion.
  return `file://localhost${publicPath}`;
}
