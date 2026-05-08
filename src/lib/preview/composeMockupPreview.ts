import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  resolveMockup,
  loadMockupManifest,
  type DeviceType,
  type MockupManifestEntry,
  type ScreenSlot,
} from "@/lib/preview/mockupManifest";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
  type AssetPreviewRecord,
} from "@/lib/preview/copyPreviewAssets";
import {
  inferScreenshotContext,
  loadScreenshotTagSidecar,
  type ScreenshotContext,
  type ScreenshotContextConfidence,
  type ScreenshotTag,
} from "@/lib/preview/inferScreenshotContext";

// ─────────────────────────────────────────────────────────────────────────────
// Compose a screenshot inside a device mockup.
//
// Output shape (data/mockup-composite-map.generated.json):
//   {
//     generated_at: string,
//     output_dir: "/generated-preview-composites/",
//     composites: AssetCompositeRecord[],
//     warnings: string[],
//   }
//
// Each composite is keyed by (device_type, screenshot_context) so the demo
// generator can pick the right one for each ad concept.
//
// We do not change the BrandKitLite / Element manifest schemas — composite
// metadata lives in this side-file only. The Element manifest will reference
// the composite's public_path via `file_url` like any other image asset.
// ─────────────────────────────────────────────────────────────────────────────

export const COMPOSITE_PUBLIC_DIR = "generated-preview-composites";

export const AssetCompositeRecordSchema = z.object({
  composite_id: z.string().min(1),
  mockup_source_path: z.string(),
  mockup_original_filename: z.string(),
  screenshot_source_path: z.string(),
  screenshot_original_filename: z.string(),
  public_path: z.string(),
  device_type: z.string(),
  screenshot_context: z.string(),
  // Categorical confidence of the screenshot's context inference.
  screenshot_context_confidence: z.enum([
    "explicit_tag",
    "folder_match",
    "filename_match",
    "fallback_general",
  ]),
  slot: z.object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    border_radius: z.number().nonnegative().optional(),
    // Optional 4-corner quadrilateral for oblique mockups (TL, TR, BR, BL).
    corners: z
      .array(z.object({ x: z.number(), y: z.number() }))
      .length(4)
      .optional(),
  }),
  // Where the screen rectangle came from. "explicit_manifest" means an entry
  // in mockup-manifest.json; "heuristic" means the percentage-based fallback.
  slot_source: z.enum(["explicit_manifest", "heuristic"]),
  fit: z.enum(["cover", "contain"]),
  output_dimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  created_at: z.string(),
});
export type AssetCompositeRecord = z.infer<typeof AssetCompositeRecordSchema>;

export const MockupCompositeMapSchema = z.object({
  generated_at: z.string(),
  output_dir: z.string(),
  composites: z.array(AssetCompositeRecordSchema),
  warnings: z.array(z.string()),
});
export type MockupCompositeMap = z.infer<typeof MockupCompositeMapSchema>;

// ── One-shot compositor ──────────────────────────────────────────────────────
export interface ComposeArgs {
  mockupAbsPath: string;
  screenshotAbsPath: string;
  outputAbsPath: string;
  slot: ScreenSlot;
  fit?: "cover" | "contain";
  // Optional shared Playwright browser. When the bulk pipeline runs many
  // composes, passing one browser keeps Chromium startup cost amortised.
  browser?: import("playwright").Browser;
}

export interface ComposeResult {
  width: number;
  height: number;
}

export async function composeMockupPreview(args: ComposeArgs): Promise<ComposeResult> {
  const fit = args.fit ?? "cover";
  const slot = args.slot;

  // Step 1: load mockup metadata (we keep the mockup as the canvas).
  const mockup = sharp(args.mockupAbsPath);
  const mockupMeta = await mockup.metadata();
  if (!mockupMeta.width || !mockupMeta.height) {
    throw new Error(`Could not read mockup dimensions for ${args.mockupAbsPath}`);
  }

  // Step 2a: when the slot has 4 explicit corners, perspective-warp the
  // screenshot into that quadrilateral via a real homography rendered by
  // headless Chromium (CSS matrix3d). Pixel-perfect on every tilt — the
  // 4th corner is no longer "implied" the way SVG affine left it.
  if (slot.corners && slot.corners.length === 4) {
    await composeWithCorners({
      mockupAbsPath: args.mockupAbsPath,
      screenshotAbsPath: args.screenshotAbsPath,
      outputAbsPath: args.outputAbsPath,
      mockupWidth: mockupMeta.width,
      mockupHeight: mockupMeta.height,
      corners: slot.corners,
      borderRadius: slot.border_radius ?? 0,
      browser: args.browser,
    });
    return { width: mockupMeta.width, height: mockupMeta.height };
  }

  // Step 2b: axis-aligned path — resize the screenshot into the slot bounds.
  const resized = await sharp(args.screenshotAbsPath)
    .resize({
      width: slot.width,
      height: slot.height,
      fit: fit === "contain" ? "contain" : "cover",
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Step 3: optionally apply a rounded-corner mask via SVG.
  let screenshotBuffer = resized;
  if (slot.border_radius && slot.border_radius > 0) {
    const r = Math.min(slot.border_radius, Math.floor(Math.min(slot.width, slot.height) / 2));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${slot.width}" height="${slot.height}"><rect x="0" y="0" width="${slot.width}" height="${slot.height}" rx="${r}" ry="${r}" fill="#ffffff"/></svg>`;
    screenshotBuffer = await sharp(resized)
      .composite([{ input: Buffer.from(svg), blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  // Step 4: composite onto the mockup canvas at the slot origin.
  await sharp(args.mockupAbsPath)
    .composite([
      {
        input: screenshotBuffer,
        left: Math.round(slot.x),
        top: Math.round(slot.y),
      },
    ])
    .png()
    .toFile(args.outputAbsPath);

  return { width: mockupMeta.width, height: mockupMeta.height };
}

// ── Perspective (4-corner) compositor ────────────────────────────────────────
// Real perspective warp via headless Chromium + CSS matrix3d.
//
// We compute the 3x3 homography that maps the screenshot's source rect
// to the four hand-traced corners of the device screen, convert it to a
// CSS matrix3d (4x4 column-major), and let Chromium render the warped
// screenshot. All four corners are pinned exactly — unlike the prior
// SVG affine path, which only respected three. Text stays sharp because
// Chromium's GPU sampler does the resampling.
async function composeWithCorners(args: {
  mockupAbsPath: string;
  screenshotAbsPath: string;
  outputAbsPath: string;
  mockupWidth: number;
  mockupHeight: number;
  corners: Array<{ x: number; y: number }>;
  borderRadius: number;
  browser?: import("playwright").Browser;
}): Promise<void> {
  const screenshotMeta = await sharp(args.screenshotAbsPath).metadata();
  if (!screenshotMeta.width || !screenshotMeta.height) {
    throw new Error(`Could not read screenshot dimensions for ${args.screenshotAbsPath}`);
  }

  // Pre-resize to the visible quad's bounding box × 2 for sharpness when
  // Chromium downsamples the warped output. The browser is rendering at
  // device-pixel ratio 2, so the source rect should be ~2x quad size.
  const xs = args.corners.map((c) => c.x);
  const ys = args.corners.map((c) => c.y);
  const quadW = Math.max(64, Math.max(...xs) - Math.min(...xs));
  const quadH = Math.max(64, Math.max(...ys) - Math.min(...ys));
  const srcW = Math.round(quadW * 2);
  const srcH = Math.round(quadH * 2);

  const screenshotPng = await sharp(args.screenshotAbsPath)
    .resize(srcW, srcH, {
      fit: "cover",
      kernel: "lanczos3",
      position: "centre",
    })
    .png()
    .toBuffer();
  const dataUri = `data:image/png;base64,${screenshotPng.toString("base64")}`;

  // Compute the homography that maps source rect (0,0)-(srcW,srcH) →
  // destination quad (corners[0..3]). Returns 8 unknowns of the 3x3
  // matrix (h33 is fixed at 1).
  const homography = computeHomography(srcW, srcH, args.corners);
  const matrix3d = formatMatrix3d(homography);

  // Border-radius is applied in source-image space via CSS — rides the warp.
  const r = args.borderRadius > 0
    ? Math.min(args.borderRadius, Math.floor(Math.min(srcW, srcH) / 2))
    : 0;

  const html = buildPerspectiveHtml({
    mockupWidth: args.mockupWidth,
    mockupHeight: args.mockupHeight,
    screenshotDataUri: dataUri,
    srcW,
    srcH,
    matrix3d,
    borderRadius: r,
  });

  const warpedScreenshot = await renderHtmlToPng({
    html,
    width: args.mockupWidth,
    height: args.mockupHeight,
    browser: args.browser,
  });

  await sharp(args.mockupAbsPath)
    .composite([{ input: warpedScreenshot, top: 0, left: 0 }])
    .png()
    .toFile(args.outputAbsPath);
}

// ── Homography solver ────────────────────────────────────────────────────────
// Solve 8 linear equations for the 8 unknowns of a 3x3 perspective matrix
// (h33 is fixed at 1). Source corners are the rect (0,0)-(W,0)-(W,H)-(0,H);
// destination corners are the four points the operator dragged. Standard
// Gaussian elimination — 8x9 augmented matrix.
function computeHomography(
  srcW: number,
  srcH: number,
  dst: Array<{ x: number; y: number }>,
): number[] {
  const src = [
    { x: 0, y: 0 },
    { x: srcW, y: 0 },
    { x: srcW, y: srcH },
    { x: 0, y: srcH },
  ];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, dx]);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, dy]);
  }
  const n = 8;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    }
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    for (let k = i + 1; k < n; k++) {
      const factor = A[k][i] / A[i][i];
      for (let j = i; j <= n; j++) {
        A[k][j] -= factor * A[i][j];
      }
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = A[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= A[i][j] * x[j];
    }
    x[i] /= A[i][i];
  }
  return x; // [h11, h12, h13, h21, h22, h23, h31, h32]
}

// Convert the 8 homography unknowns to a CSS matrix3d() string.
// CSS matrix3d arguments are column-major; the 2D homography is embedded
// in the 4D matrix via the w-component (perspective divide).
//   final_x = (h11*x + h12*y + h13) / (h31*x + h32*y + 1)
//   final_y = (h21*x + h22*y + h23) / (h31*x + h32*y + 1)
function formatMatrix3d(h: number[]): string {
  const [h11, h12, h13, h21, h22, h23, h31, h32] = h;
  // Columns: (h11, h21, 0, h31), (h12, h22, 0, h32), (0,0,1,0), (h13, h23, 0, 1)
  return `matrix3d(${h11},${h21},0,${h31},${h12},${h22},0,${h32},0,0,1,0,${h13},${h23},0,1)`;
}

function buildPerspectiveHtml(args: {
  mockupWidth: number;
  mockupHeight: number;
  screenshotDataUri: string;
  srcW: number;
  srcH: number;
  matrix3d: string;
  borderRadius: number;
}): string {
  const radiusStyle =
    args.borderRadius > 0 ? `border-radius:${args.borderRadius}px;` : "";
  return `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;width:${args.mockupWidth}px;height:${args.mockupHeight}px;overflow:hidden;}
    .stage{position:relative;width:${args.mockupWidth}px;height:${args.mockupHeight}px;}
    .warp{position:absolute;left:0;top:0;width:${args.srcW}px;height:${args.srcH}px;transform-origin:0 0;transform:${args.matrix3d};image-rendering:auto;${radiusStyle}overflow:hidden;}
    .warp img{width:100%;height:100%;display:block;${radiusStyle}}
  </style></head><body><div class="stage"><div class="warp"><img src="${args.screenshotDataUri}" alt=""/></div></div></body></html>`;
}

// Render an HTML string with Playwright and return the PNG buffer. Uses a
// shared browser when one is passed in (amortises Chromium startup), else
// launches its own. Background is transparent so the warped screenshot
// can be composited cleanly onto the mockup.
async function renderHtmlToPng(args: {
  html: string;
  width: number;
  height: number;
  browser?: import("playwright").Browser;
}): Promise<Buffer> {
  const { chromium } = await import("playwright");
  const browser = args.browser ?? (await chromium.launch({ headless: true }));
  const ownsBrowser = !args.browser;
  try {
    const context = await browser.newContext({
      viewport: { width: args.width, height: args.height },
      // 2x device-pixel ratio gives Chromium more pixels through the warp;
      // we downsample with Sharp's lanczos3 right after for crisp text.
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.setContent(args.html, { waitUntil: "load" });
    // Wait for the embedded image to decode before screenshotting.
    await page.evaluate(async () => {
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
        ),
      );
    });
    const buf2x = await page.screenshot({ type: "png", omitBackground: true });
    await context.close();
    // Downscale 2x → 1x with lanczos3 for sharp text.
    return await sharp(buf2x)
      .resize(args.width, args.height, { kernel: "lanczos3" })
      .png()
      .toBuffer();
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

// ── Bulk pipeline used by `npm run preview:mockups` ──────────────────────────
export interface BuildCompositeMatrixOptions {
  cwd?: string;
  assetMapPath?: string;
  outputJsonPath?: string;
  outputPublicDir?: string;
  fit?: "cover" | "contain";
}

export interface BuildCompositeMatrixResult {
  map: MockupCompositeMap;
  warnings: string[];
}

/**
 * Build one composite per (device_type, screenshot_context) pair using the
 * first matching mockup and the first matching screenshot. Manifest entries
 * for mockups override heuristics. Skips device_type "unknown" without a
 * manifest entry.
 */
export async function buildMockupCompositeMatrix(
  opts: BuildCompositeMatrixOptions = {},
): Promise<BuildCompositeMatrixResult> {
  const cwd = opts.cwd ?? process.cwd();
  const assetMapPath =
    opts.assetMapPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const outputJsonPath =
    opts.outputJsonPath ??
    path.join(cwd, "data", "mockup-composite-map.generated.json");
  const outputPublicDir =
    opts.outputPublicDir ?? path.join(cwd, "public", COMPOSITE_PUBLIC_DIR);
  const fit = opts.fit ?? "cover";

  const assets: AssetPreviewMap = AssetPreviewMapSchema.parse(
    JSON.parse(await fs.readFile(assetMapPath, "utf8")),
  );

  const mockupManifest = await loadMockupManifest();
  const tagSidecar: Map<string, ScreenshotTag> = await loadScreenshotTagSidecar();

  await fs.mkdir(outputPublicDir, { recursive: true });

  // Lazy-launched, shared Chromium for the perspective compositor. Only
  // the perspective-warp path uses it; the axis-aligned path stays Sharp-only.
  // Sharing one browser across all composites avoids the 1-2s per-launch cost.
  let sharedBrowser: import("playwright").Browser | null = null;
  const getBrowser = async (): Promise<import("playwright").Browser> => {
    if (sharedBrowser) return sharedBrowser;
    const { chromium } = await import("playwright");
    sharedBrowser = await chromium.launch({ headless: true });
    return sharedBrowser;
  };

  const warnings: string[] = [];

  // Group mockups by device type. The user can calibrate multiple mockups per
  // device type (e.g. 5 different iPad shots, all marked `tablet`); we keep
  // only one per device for the composite matrix. Selection priority — the
  // most-calibrated mockup wins, so a hand-traced perspective quad is never
  // overruled by an alphabetically-earlier uncalibrated entry:
  //   1. manifest entry WITH corners[] (full perspective calibration)
  //   2. manifest entry without corners (axis-aligned rectangle calibration)
  //   3. heuristic-only mockup (no manifest entry — percentage fallback)
  const mockupCandidates = new Map<DeviceType, Array<AssetPreviewRecord & { _entry?: MockupManifestEntry }>>();
  for (const item of assets.items.filter((i) => i.canonical_folder_type === "mockups")) {
    const manifestEntry = mockupManifest.get(item.original_filename.toLowerCase());
    const device = manifestEntry
      ? manifestEntry.device_type
      : inferDeviceTypeFromAsset(item);
    if (device === "unknown") continue;
    const list = mockupCandidates.get(device) ?? [];
    list.push({ ...item, _entry: manifestEntry });
    mockupCandidates.set(device, list);
  }
  function calibrationRank(c: { _entry?: MockupManifestEntry }): number {
    if (c._entry?.screen_slot.corners) return 0; // best
    if (c._entry) return 1;
    return 2; // heuristic
  }
  const mockupsByDevice = new Map<DeviceType, AssetPreviewRecord & { _entry?: MockupManifestEntry }>();
  for (const [device, candidates] of mockupCandidates) {
    const sorted = [...candidates].sort((a, b) => calibrationRank(a) - calibrationRank(b));
    mockupsByDevice.set(device, sorted[0]);
  }

  if (mockupsByDevice.size === 0) {
    warnings.push("No usable mockups found in inventory (all device_types unknown).");
  }

  // Group screenshots by context. Retain the inference (confidence label)
  // alongside the asset record so the composite map can surface it.
  type ScreenshotPick = {
    record: AssetPreviewRecord;
    confidence: ScreenshotContextConfidence;
  };
  // Collect ALL screenshots per context (not just one) so we can later pick
  // the one whose aspect ratio matches the device's slot. The previous
  // "first match" approach put portrait phone screenshots into landscape
  // laptop slots, which after `fit: cover` cropped to mostly-white space.
  const screenshotsByContextAll = new Map<ScreenshotContext, ScreenshotPick[]>();
  for (const item of assets.items.filter(
    (i) => i.canonical_folder_type === "platform_screenshots",
  )) {
    const inferred = inferScreenshotContext({
      filename: item.original_filename,
      folder: item.original_folder_name,
      tagsByFilename: tagSidecar,
    });
    const list = screenshotsByContextAll.get(inferred.context) ?? [];
    list.push({ record: item, confidence: inferred.confidence });
    screenshotsByContextAll.set(inferred.context, list);
  }
  // Within each context list, sort by confidence so explicit_tag > heuristic.
  for (const list of screenshotsByContextAll.values()) {
    const order: ScreenshotContextConfidence[] = [
      "explicit_tag",
      "filename_match",
      "folder_match",
      "fallback_general",
    ];
    list.sort((a, b) => order.indexOf(a.confidence) - order.indexOf(b.confidence));
  }
  if (!screenshotsByContextAll.has("general_platform") && screenshotsByContextAll.size > 0) {
    // Use all available screenshots as the general fallback.
    const all = assets.items
      .filter((i) => i.canonical_folder_type === "platform_screenshots")
      .map((record) => ({ record, confidence: "fallback_general" as const }));
    if (all.length > 0) screenshotsByContextAll.set("general_platform", all);
  }

  if (screenshotsByContextAll.size === 0) {
    warnings.push("No platform screenshots in inventory — composites cannot be built.");
  }

  // Cache screenshot dimensions so we can rank by aspect-ratio fit per slot.
  // We read each unique screenshot once.
  const screenshotDims = new Map<string, { width: number; height: number }>();
  async function dimsFor(record: AssetPreviewRecord): Promise<{ width: number; height: number } | null> {
    const key = record.original_local_path;
    const cached = screenshotDims.get(key);
    if (cached) return cached;
    try {
      const meta = await sharp(path.resolve(cwd, record.original_local_path)).metadata();
      if (meta.width && meta.height) {
        const v = { width: meta.width, height: meta.height };
        screenshotDims.set(key, v);
        return v;
      }
    } catch {
      // ignore — caller falls back
    }
    return null;
  }
  for (const ctx of ["stocks", "etfs", "charts", "green_data"] as const) {
    if (!screenshotsByContextAll.has(ctx)) {
      warnings.push(
        `No screenshot tagged or named for context "${ctx}" — composite skipped or fallback used.`,
      );
    }
  }

  // Build the matrix.
  const composites: AssetCompositeRecord[] = [];
  for (const [device, mockupRecord] of mockupsByDevice) {
    const mockupAbs = path.resolve(cwd, mockupRecord.original_local_path);
    let mockupMeta: { width?: number; height?: number };
    try {
      mockupMeta = await sharp(mockupAbs).metadata();
    } catch (err) {
      warnings.push(`Could not read mockup ${mockupAbs}: ${(err as Error).message}`);
      continue;
    }
    if (!mockupMeta.width || !mockupMeta.height) {
      warnings.push(`Mockup ${mockupRecord.original_filename} has no dimensions — skipped.`);
      continue;
    }

    const resolved = resolveMockup(
      mockupRecord.original_filename,
      mockupManifest,
      { width: mockupMeta.width, height: mockupMeta.height },
    );
    if (!resolved) {
      warnings.push(
        `No screen slot for mockup ${mockupRecord.original_filename} (device ${device}). Add an entry to brand-input/mockup devices/mockup-manifest.json.`,
      );
      continue;
    }

    if (resolved.slot_source === "heuristic") {
      warnings.push(
        `Mockup ${mockupRecord.original_filename} (${device}) used HEURISTIC screen slot. Add an entry in brand-input/mockup devices/mockup-manifest.json (or use the Mockup Calibrator at /mockup-calibrator) for accurate placement.`,
      );
    }

    // Slot aspect ratio drives screenshot selection: pick the candidate
    // whose width/height ratio is closest to the slot's. This keeps
    // landscape laptop shots out of portrait phone slots and vice versa,
    // which was producing mostly-white composites when `fit: cover`
    // cropped a tall image into a wide slot.
    const slotAR = resolved.screen_slot.width / resolved.screen_slot.height;

    for (const [ctx, candidates] of screenshotsByContextAll) {
      // Score each candidate by |slot_AR - candidate_AR|. Resolve dimensions
      // lazily; if a candidate's dims can't be read, we score it last.
      const scored: Array<{ pick: ScreenshotPick; arDiff: number }> = [];
      for (const c of candidates) {
        const dims = await dimsFor(c.record);
        const ar = dims ? dims.width / dims.height : NaN;
        const diff = Number.isFinite(ar) ? Math.abs(slotAR - ar) : 999;
        scored.push({ pick: c, arDiff: diff });
      }
      scored.sort((a, b) => a.arDiff - b.arDiff);

      // If the best in-context match is still a poor aspect-ratio fit (e.g.
      // landscape laptop slot but only portrait phone screenshots tagged for
      // this context), search across ALL contexts for a closer fit. This
      // avoids the failure mode where a tall screenshot gets `fit: cover`-
      // cropped into a wide slot and produces a mostly-white composite.
      let pick = scored[0].pick;
      if (scored[0].arDiff > 0.5) {
        const crossContext: Array<{ pick: ScreenshotPick; arDiff: number }> = [];
        for (const list of screenshotsByContextAll.values()) {
          for (const c of list) {
            const dims = await dimsFor(c.record);
            const ar = dims ? dims.width / dims.height : NaN;
            const diff = Number.isFinite(ar) ? Math.abs(slotAR - ar) : 999;
            crossContext.push({ pick: c, arDiff: diff });
          }
        }
        crossContext.sort((a, b) => a.arDiff - b.arDiff);
        if (crossContext[0].arDiff < scored[0].arDiff) {
          pick = crossContext[0].pick;
          warnings.push(
            `Composite ${device}-${ctx} used cross-context screenshot ${pick.record.original_filename} (slot AR ${slotAR.toFixed(2)} vs context's best ${scored[0].arDiff.toFixed(2)} mismatch).`,
          );
        }
      }
      const screenshotRecord = pick.record;
      const compositeId = `${device}-${ctx}`;
      const outputFilename = `${compositeId}.png`;
      const outputAbs = path.join(outputPublicDir, outputFilename);
      const screenshotAbs = path.resolve(cwd, screenshotRecord.original_local_path);

      try {
        const browser = resolved.screen_slot.corners
          ? await getBrowser()
          : undefined;
        const result = await composeMockupPreview({
          mockupAbsPath: mockupAbs,
          screenshotAbsPath: screenshotAbs,
          outputAbsPath: outputAbs,
          slot: resolved.screen_slot,
          fit,
          browser,
        });
        composites.push({
          composite_id: compositeId,
          mockup_source_path: mockupRecord.original_local_path,
          mockup_original_filename: mockupRecord.original_filename,
          screenshot_source_path: screenshotRecord.original_local_path,
          screenshot_original_filename: screenshotRecord.original_filename,
          public_path: `/${COMPOSITE_PUBLIC_DIR}/${outputFilename}`,
          device_type: device,
          screenshot_context: ctx,
          screenshot_context_confidence: pick.confidence,
          slot: resolved.screen_slot,
          slot_source: resolved.slot_source,
          fit,
          output_dimensions: { width: result.width, height: result.height },
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        warnings.push(
          `Compose failed for ${compositeId}: ${(err as Error).message}`,
        );
      }
    }
  }

  const map: MockupCompositeMap = MockupCompositeMapSchema.parse({
    generated_at: new Date().toISOString(),
    output_dir: `/${COMPOSITE_PUBLIC_DIR}/`,
    composites,
    warnings,
  });

  await fs.writeFile(outputJsonPath, JSON.stringify(map, null, 2) + "\n", "utf8");

  // Close the shared browser if it was launched. No-op when only axis-aligned
  // composites ran.
  if (sharedBrowser) await sharedBrowser.close();

  return { map, warnings };
}

function inferDeviceTypeFromAsset(asset: AssetPreviewRecord): DeviceType {
  // Prefer the original_filename, then the sanitized filename.
  const candidates = [asset.original_filename, asset.filename];
  for (const c of candidates) {
    const t = inferDeviceFromString(c);
    if (t !== "unknown") return t;
  }
  return "unknown";
}

function inferDeviceFromString(s: string): DeviceType {
  const v = s.toLowerCase();
  if (/iphone|phone|mobile/.test(v)) return "phone";
  if (/ipad|tablet/.test(v)) return "tablet";
  if (/macbook|laptop|notebook/.test(v)) return "laptop";
  if (/desktop|imac|monitor/.test(v)) return "desktop";
  if (/iwatch|watch/.test(v)) return "smartwatch";
  return "unknown";
}
