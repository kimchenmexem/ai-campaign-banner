import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { MockupParamsSchema } from "@/lib/schemas/generatedAsset.schema";
import type { SourceAssetRef } from "@/lib/schemas/generatedAsset.schema";
import type { GenerateContext, GenerateResult } from "@/lib/generators/types";
import { composeMockupPreview } from "@/lib/preview/composeMockupPreview";
import {
  loadMockupManifest,
  resolveMockup,
  type DeviceType,
} from "@/lib/preview/mockupManifest";
import { defaultPlacementRules } from "@/lib/generators/placement";
import { resolveBrandInputPath } from "@/lib/generators/brandInput";

const GENERATOR_ID = "mockup@2.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Mockup generator — composites a screenshot inside a calibrated mockup PNG
// using the existing `composeMockupPreview` (which handles 4-corner perspective
// warping when the manifest defines corners).
//
// We do NOT regenerate mockup PNGs from scratch; we reuse the artwork in
// `brand-input/mockup devices/` plus the manifest. This way the asset
// generator stays consistent with what the banner pipeline already produces.
// ─────────────────────────────────────────────────────────────────────────────

const MOCKUP_DIR = path.posix.join("brand-input", "mockup devices");

export async function generateMockup(
  rawParams: unknown,
  ctx: GenerateContext,
): Promise<GenerateResult> {
  const params = MockupParamsSchema.parse(rawParams);

  const mockupAbsPath = params.mockup_path
    ? resolveBrandInputPath(ctx.cwd, params.mockup_path)
    : await pickMockupForDevice(ctx.cwd, params.device);
  if (!mockupAbsPath) {
    throw new Error(
      `No mockup found in ${MOCKUP_DIR} for device "${params.device}". Add one and run \`npm run preview:mockups\`, or pass mockup_path explicitly.`,
    );
  }
  await assertReadable(mockupAbsPath, "mockup_path");

  const screenshotAbsPath = resolveBrandInputPath(ctx.cwd, params.screenshot_path);
  await assertReadable(screenshotAbsPath, "screenshot_path");

  // Load the mockup manifest so we get the calibrated screen slot (corners,
  // border_radius). Falls back to a heuristic when no entry exists.
  const manifest = await loadMockupManifest(
    path.join(ctx.cwd, "brand-input", "mockup devices", "mockup-manifest.json"),
  );
  const meta = await sharp(mockupAbsPath).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`Could not read mockup dimensions for ${mockupAbsPath}.`);
  }
  const resolved = resolveMockup(path.basename(mockupAbsPath), manifest, {
    width: meta.width,
    height: meta.height,
  });
  if (!resolved) {
    throw new Error(
      `No screen slot for mockup ${path.basename(mockupAbsPath)}. Calibrate it via /mockup-calibrator.`,
    );
  }

  // Render to a temp file (composeMockupPreview writes to disk by design),
  // then read the bytes back. The storage layer will rewrite under
  // public/generated-assets/mockups/.
  const tmpFile = path.join(
    os.tmpdir(),
    `mockup-${crypto.randomBytes(6).toString("hex")}.png`,
  );
  try {
    await composeMockupPreview({
      mockupAbsPath,
      screenshotAbsPath,
      outputAbsPath: tmpFile,
      slot: resolved.screen_slot,
      fit: "cover",
    });
    const bytes = await fs.readFile(tmpFile);
    const sourceAssets: SourceAssetRef[] = [
      {
        source_type: "brand_input",
        path: path.relative(ctx.cwd, mockupAbsPath),
        role: "mockup_device",
      },
      {
        source_type: "brand_input",
        id: params.screenshot_path,
        path: params.screenshot_path.startsWith("/")
          ? undefined
          : params.screenshot_path,
        public_path: params.screenshot_path.startsWith("/")
          ? params.screenshot_path
          : undefined,
        role: "screenshot",
      },
    ];
    return {
      type: "mockup",
      variant: params.device,
      format: "png",
      size: { width: meta.width, height: meta.height },
      bytes,
      params: rawParams as Record<string, unknown>,
      brand_token_refs: [],
      generator: GENERATOR_ID,
      seed: hashStringToSeed(params.screenshot_path + params.device),
      tags: ["mockup", params.device, resolved.slot_source],
      notes: params.notes,
      render_mode: "composite",
      placement_rules: defaultPlacementRules("mockup", params.device),
      source_assets: sourceAssets,
    };
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function pickMockupForDevice(
  cwd: string,
  device: DeviceType,
): Promise<string | null> {
  // First, prefer a calibrated mockup whose manifest entry matches `device`.
  const manifest = await loadMockupManifest(
    path.join(cwd, "brand-input", "mockup devices", "mockup-manifest.json"),
  );
  for (const entry of manifest.values()) {
    if (entry.device_type === device) {
      const abs = path.join(cwd, MOCKUP_DIR, entry.filename);
      if (await pathExists(abs)) return abs;
    }
  }
  // Fallback: scan the directory and pick the first filename that hints at
  // the requested device family.
  const dirAbs = path.join(cwd, MOCKUP_DIR);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dirAbs);
  } catch {
    return null;
  }
  const hint = deviceFilenameHints(device);
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!/\.(png|jpg|jpeg|webp)$/.test(lower)) continue;
    if (hint.test(lower)) return path.join(dirAbs, name);
  }
  return null;
}

function deviceFilenameHints(device: DeviceType): RegExp {
  switch (device) {
    case "phone":
      return /(iphone|phone|mobile)/;
    case "tablet":
      return /(ipad|tablet)/;
    case "laptop":
      return /(macbook|laptop|notebook)/;
    case "desktop":
      return /(imac|desktop|monitor)/;
    case "smartwatch":
      return /(watch)/;
    default:
      return /.*/;
  }
}

async function assertReadable(p: string, label: string): Promise<void> {
  try {
    await fs.access(p, fs.constants.R_OK);
  } catch {
    throw new Error(`${label} not readable at ${p}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function hashStringToSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
