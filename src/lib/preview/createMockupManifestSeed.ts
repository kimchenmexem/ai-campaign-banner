import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  AssetPreviewMapSchema,
  type AssetPreviewMap,
} from "@/lib/preview/copyPreviewAssets";
import {
  DEFAULT_MOCKUP_MANIFEST_PATH,
  heuristicScreenSlot,
  inferDeviceTypeFromFilename,
  loadMockupManifestArray,
  writeMockupManifest,
  type DeviceType,
  type MockupManifestEntry,
} from "@/lib/preview/mockupManifest";

// ─────────────────────────────────────────────────────────────────────────────
// Auto-seed brand-input/mockup devices/mockup-manifest.json with reasonable
// per-device-type screen slots so composites improve immediately. Each
// entry's screen_slot is computed from the same heuristic the compositor
// uses, but materialized as concrete pixel values so a human can fine-tune
// them in /mockup-calibrator.
//
// Rules:
//   - Skip mockups whose device type infers as "unknown" (no heuristic).
//   - Preserve an existing mockup-manifest.json unless `force: true`.
//   - Stamp every seeded entry with notes: "auto-seeded; requires human
//     calibration".
// ─────────────────────────────────────────────────────────────────────────────

const SEED_NOTE = "auto-seeded; requires human calibration";

export interface SeedMockupManifestOptions {
  cwd?: string;
  assetMapPath?: string;
  outputPath?: string;
  force?: boolean;
}

export interface SeedMockupManifestResult {
  status: "wrote" | "kept_existing" | "no_mockups";
  entries: MockupManifestEntry[];
  skipped: Array<{ filename: string; reason: string }>;
  outputPath: string;
}

export async function createMockupManifestSeed(
  opts: SeedMockupManifestOptions = {},
): Promise<SeedMockupManifestResult> {
  const cwd = opts.cwd ?? process.cwd();
  const assetMapPath =
    opts.assetMapPath ?? path.join(cwd, "data", "asset-preview-map.generated.json");
  const outputPath = opts.outputPath ?? DEFAULT_MOCKUP_MANIFEST_PATH;

  const map: AssetPreviewMap = AssetPreviewMapSchema.parse(
    JSON.parse(await fs.readFile(assetMapPath, "utf8")),
  );

  if (!opts.force) {
    const existing = await loadMockupManifestArray(outputPath);
    if (existing.length > 0) {
      return {
        status: "kept_existing",
        entries: existing,
        skipped: [],
        outputPath,
      };
    }
  }

  const mockups = map.items
    .filter((i) => i.canonical_folder_type === "mockups")
    .sort((a, b) => a.original_filename.localeCompare(b.original_filename));

  if (mockups.length === 0) {
    return { status: "no_mockups", entries: [], skipped: [], outputPath };
  }

  const entries: MockupManifestEntry[] = [];
  const skipped: Array<{ filename: string; reason: string }> = [];

  for (const m of mockups) {
    const device: DeviceType = inferDeviceTypeFromFilename(m.original_filename);
    if (device === "unknown") {
      skipped.push({
        filename: m.original_filename,
        reason: "device_type=unknown — heuristic does not apply; tag manually in /mockup-calibrator",
      });
      continue;
    }
    const abs = path.resolve(cwd, m.original_local_path);
    let meta: { width?: number; height?: number };
    try {
      meta = await sharp(abs).metadata();
    } catch (err) {
      skipped.push({
        filename: m.original_filename,
        reason: `sharp metadata failed: ${(err as Error).message}`,
      });
      continue;
    }
    if (!meta.width || !meta.height) {
      skipped.push({
        filename: m.original_filename,
        reason: "image has no width/height metadata",
      });
      continue;
    }
    const slot = heuristicScreenSlot(device, meta.width, meta.height);
    if (!slot) {
      skipped.push({
        filename: m.original_filename,
        reason: `no heuristic slot for device_type=${device}`,
      });
      continue;
    }
    entries.push({
      filename: m.original_filename,
      device_type: device,
      screen_slot: slot,
      notes: SEED_NOTE,
    });
  }

  await writeMockupManifest(entries, outputPath);
  return { status: "wrote", entries, skipped, outputPath };
}
