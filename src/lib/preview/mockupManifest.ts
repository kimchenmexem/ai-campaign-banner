import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Mockup manifest — optional human-curated placement metadata for files in
// `brand-input/mockup devices/`.
//
// File location:  brand-input/mockup devices/mockup-manifest.json
// Format (each entry, by *original* filename):
//   {
//     "filename": "ipad-3.png",
//     "device_type": "tablet",
//     "screen_slot": { "x": 180, "y": 120, "width": 820, "height": 620,
//                       "border_radius": 24 }
//   }
//
// If the manifest is missing or a mockup isn't listed, fall back to a
// percentage-based heuristic per device type. Heuristics are estimates —
// add an entry to the manifest to override.
// ─────────────────────────────────────────────────────────────────────────────

export const DeviceTypeSchema = z.enum([
  "phone",
  "tablet",
  "laptop",
  "desktop",
  "smartwatch",
  "unknown",
]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

export const ScreenSlotSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  border_radius: z.number().nonnegative().optional(),
  // Optional 4-corner quadrilateral for screens at oblique / perspective
  // angles (laptops in 3/4 view, tilted phones, etc.). When present:
  //   - corner order is [top-left, top-right, bottom-right, bottom-left]
  //   - x/y/width/height become the *bounding box* of the corners (the
  //     compositor still uses them for output dimensions)
  //   - the compositor warps the screenshot via SVG affine using TL, TR, BL
  //     (the 4th corner is implied — affine cannot do full perspective, but
  //     for slight obliques the result is visually correct)
  corners: z.array(PointSchema).length(4).optional(),
});
export type ScreenSlot = z.infer<typeof ScreenSlotSchema>;

export const MockupManifestEntrySchema = z.object({
  filename: z.string().min(1),
  device_type: DeviceTypeSchema,
  screen_slot: ScreenSlotSchema,
  notes: z.string().optional(),
});
export type MockupManifestEntry = z.infer<typeof MockupManifestEntrySchema>;

export const MockupManifestFileSchema = z.array(MockupManifestEntrySchema);
export type MockupManifestFile = z.infer<typeof MockupManifestFileSchema>;

// ── Default file location ────────────────────────────────────────────────────
export const DEFAULT_MOCKUP_MANIFEST_PATH = path.join(
  process.cwd(),
  "brand-input",
  "mockup devices",
  "mockup-manifest.json",
);

/**
 * Load the optional mockup manifest. Returns a Map keyed by lowercased
 * original filename for case-insensitive lookup. Empty Map when the file
 * does not exist.
 */
export async function loadMockupManifest(
  filePath: string = DEFAULT_MOCKUP_MANIFEST_PATH,
): Promise<Map<string, MockupManifestEntry>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = MockupManifestFileSchema.parse(JSON.parse(raw));
  const map = new Map<string, MockupManifestEntry>();
  for (const entry of parsed) {
    map.set(entry.filename.toLowerCase(), entry);
  }
  return map;
}

// ── Device-type inference from filename ──────────────────────────────────────
const DEVICE_PATTERNS: Array<{ device: DeviceType; patterns: RegExp[] }> = [
  { device: "phone", patterns: [/iphone/i, /\bphone\b/i, /\bmobile\b/i] },
  { device: "tablet", patterns: [/ipad/i, /\btablet\b/i] },
  { device: "laptop", patterns: [/macbook/i, /\blaptop\b/i, /notebook/i] },
  { device: "desktop", patterns: [/desktop/i, /imac/i, /\bmonitor\b/i] },
  { device: "smartwatch", patterns: [/iwatch/i, /\bwatch\b/i, /\bsmartwatch\b/i] },
];

export function inferDeviceTypeFromFilename(filename: string): DeviceType {
  for (const { device, patterns } of DEVICE_PATTERNS) {
    for (const re of patterns) {
      if (re.test(filename)) return device;
    }
  }
  return "unknown";
}

// ── Heuristic screen slot (percentage-based) ────────────────────────────────
// Tuned to be reasonable defaults for typical product mockups. Brand owners
// must override via mockup-manifest.json for pixel-accurate placement.
export interface PercentageSlot {
  x_pct: number; // 0..1
  y_pct: number;
  width_pct: number;
  height_pct: number;
  border_radius_pct: number; // relative to min(slot.width, slot.height)
}

const HEURISTIC_SLOT_PCT: Record<DeviceType, PercentageSlot | null> = {
  phone: { x_pct: 0.07, y_pct: 0.04, width_pct: 0.86, height_pct: 0.92, border_radius_pct: 0.07 },
  tablet: { x_pct: 0.09, y_pct: 0.05, width_pct: 0.82, height_pct: 0.9, border_radius_pct: 0.04 },
  laptop: { x_pct: 0.13, y_pct: 0.06, width_pct: 0.74, height_pct: 0.62, border_radius_pct: 0.01 },
  desktop: { x_pct: 0.08, y_pct: 0.04, width_pct: 0.84, height_pct: 0.7, border_radius_pct: 0.005 },
  smartwatch: {
    x_pct: 0.18,
    y_pct: 0.18,
    width_pct: 0.64,
    height_pct: 0.64,
    border_radius_pct: 0.18,
  },
  // No safe default for unknown — caller decides whether to skip.
  unknown: null,
};

export function heuristicScreenSlot(
  deviceType: DeviceType,
  imageWidth: number,
  imageHeight: number,
): ScreenSlot | null {
  const pct = HEURISTIC_SLOT_PCT[deviceType];
  if (!pct) return null;
  const x = Math.round(imageWidth * pct.x_pct);
  const y = Math.round(imageHeight * pct.y_pct);
  const width = Math.round(imageWidth * pct.width_pct);
  const height = Math.round(imageHeight * pct.height_pct);
  const radius = Math.round(Math.min(width, height) * pct.border_radius_pct);
  return { x, y, width, height, border_radius: radius };
}

// ── Resolve one mockup ───────────────────────────────────────────────────────
export const SlotSourceSchema = z.enum(["explicit_manifest", "heuristic"]);
export type SlotSource = z.infer<typeof SlotSourceSchema>;

export interface ResolvedMockup {
  filename: string;
  device_type: DeviceType;
  screen_slot: ScreenSlot;
  slot_source: SlotSource;
}

/**
 * Resolve the screen slot for a mockup by filename + image dimensions.
 * `mockup-manifest.json` wins over heuristic. Returns null when the device
 * type is `unknown` and there is no manifest entry — caller should skip.
 */
export function resolveMockup(
  originalFilename: string,
  manifest: Map<string, MockupManifestEntry>,
  imageDimensions: { width: number; height: number },
): ResolvedMockup | null {
  const fromManifest = manifest.get(originalFilename.toLowerCase());
  if (fromManifest) {
    return {
      filename: originalFilename,
      device_type: fromManifest.device_type,
      screen_slot: fromManifest.screen_slot,
      slot_source: "explicit_manifest",
    };
  }
  const device = inferDeviceTypeFromFilename(originalFilename);
  const slot = heuristicScreenSlot(device, imageDimensions.width, imageDimensions.height);
  if (!slot) return null;
  return {
    filename: originalFilename,
    device_type: device,
    screen_slot: slot,
    slot_source: "heuristic",
  };
}

// ── Write-back support (used by the Mockup Calibrator UI) ────────────────────
export async function loadMockupManifestArray(
  filePath: string = DEFAULT_MOCKUP_MANIFEST_PATH,
): Promise<MockupManifestFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return MockupManifestFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeMockupManifest(
  entries: MockupManifestFile,
  filePath: string = DEFAULT_MOCKUP_MANIFEST_PATH,
): Promise<void> {
  const validated = MockupManifestFileSchema.parse(entries);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2) + "\n", "utf8");
}
