import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ScreenshotContextSchema,
  SCREENSHOT_CONTEXTS,
  type ScreenshotContext,
} from "@/lib/schemas/screenshotContext.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot context inference.
//
// Maps a platform-screenshot file to one of a fixed set of campaign contexts.
// Signal sources, in priority order:
//   1. Tag file:  brand-input/Platform screenshot/screenshot-tags.json
//        [
//          { "filename": "example.png", "context": "stocks", "notes": "..." }
//        ]
//      Returns confidence "explicit_tag".
//   2. Filename keywords (case-insensitive substring match).
//        Returns confidence "filename_match".
//   3. Folder name keywords (e.g. an `etfs/` subfolder).
//        Returns confidence "folder_match".
//   4. Fallback: "general_platform" with confidence "fallback_general".
//
// Confidence is a categorical label, not a numeric probability. The Screenshot
// Tagger UI shows the label directly so reviewers know which signal won.
//
// The enum itself lives in @/lib/schemas/screenshotContext.schema (a leaf
// module with no node deps), so client components and other schemas can
// import the type without pulling node:fs / node:path into their bundles.
// ─────────────────────────────────────────────────────────────────────────────

export {
  ScreenshotContextSchema,
  SCREENSHOT_CONTEXTS,
  type ScreenshotContext,
};

export const ScreenshotContextConfidenceSchema = z.enum([
  "explicit_tag",
  "folder_match",
  "filename_match",
  "fallback_general",
]);
export type ScreenshotContextConfidence = z.infer<
  typeof ScreenshotContextConfidenceSchema
>;

// Keyword library — substring match on lowercased filename + folder.
type KeywordContext = Exclude<ScreenshotContext, "general_platform">;
const KEYWORDS: Record<KeywordContext, string[]> = {
  stocks: [
    "stock",
    "stocks",
    "equity",
    "equities",
    "ticker",
    "aapl",
    "tsla",
    "buy-stock",
    "sell-stock",
  ],
  etfs: ["etf", "etfs", "fund", "funds", "index-fund", "sp500", "spy", "qqq"],
  charts: ["chart", "charts", "candlestick", "candle", "graph", "performance", "tradingview"],
  green_data: [
    "green",
    "growth",
    "upward",
    "upwarding",
    "gains",
    "profit",
    "rising",
    "investing",
  ],
};

const CONTEXT_PRIORITY: KeywordContext[] = ["stocks", "etfs", "charts", "green_data"];

export interface ContextSignal {
  source: "tag_file" | "filename" | "folder" | "fallback";
  matched_keyword?: string;
  raw_tag?: string;
}

export interface ScreenshotContextInference {
  context: ScreenshotContext;
  confidence: ScreenshotContextConfidence;
  signals: ContextSignal[];
}

export interface InferenceInput {
  filename: string;
  folder?: string;
  // Map of *original* filename → tag entry. The loader produces keys
  // lowercased so callers can pass the map straight through.
  tagsByFilename?: Map<string, ScreenshotTag>;
}

/**
 * Run inference for one file. Always returns a result; falls back to
 * "general_platform" when no signal matches.
 */
export function inferScreenshotContext(
  input: InferenceInput,
): ScreenshotContextInference {
  const filename = input.filename;
  const folder = input.folder ?? "";
  const lowerFilename = filename.toLowerCase();
  const lowerFolder = folder.toLowerCase();
  const signals: ContextSignal[] = [];

  // 1. Explicit tag.
  const tag = input.tagsByFilename?.get(lowerFilename);
  if (tag) {
    signals.push({ source: "tag_file", raw_tag: tag.context });
    return { context: tag.context, confidence: "explicit_tag", signals };
  }

  // 2. Filename keywords.
  for (const ctx of CONTEXT_PRIORITY) {
    for (const kw of KEYWORDS[ctx]) {
      if (lowerFilename.includes(kw)) {
        signals.push({ source: "filename", matched_keyword: kw });
        return { context: ctx, confidence: "filename_match", signals };
      }
    }
  }

  // 3. Folder keywords.
  for (const ctx of CONTEXT_PRIORITY) {
    for (const kw of KEYWORDS[ctx]) {
      if (lowerFolder.includes(kw)) {
        signals.push({ source: "folder", matched_keyword: kw });
        return { context: ctx, confidence: "folder_match", signals };
      }
    }
  }

  // 4. Fallback.
  signals.push({ source: "fallback" });
  return { context: "general_platform", confidence: "fallback_general", signals };
}

// ── Tag sidecar loader ───────────────────────────────────────────────────────

export const ScreenshotTagSchema = z.object({
  filename: z.string().min(1),
  context: ScreenshotContextSchema,
  notes: z.string().optional(),
});
export type ScreenshotTag = z.infer<typeof ScreenshotTagSchema>;

export const ScreenshotTagFileSchema = z.array(ScreenshotTagSchema);
export type ScreenshotTagFile = z.infer<typeof ScreenshotTagFileSchema>;

export const TAG_SIDECAR_FILE_PATH = path.join(
  process.cwd(),
  "brand-input",
  "Platform screenshot",
  "screenshot-tags.json",
);

/**
 * Load the optional tag sidecar. Returns a Map keyed by lowercased filename
 * for case-insensitive lookup. Empty Map when the file does not exist.
 */
export async function loadScreenshotTagSidecar(
  filePath: string = TAG_SIDECAR_FILE_PATH,
): Promise<Map<string, ScreenshotTag>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = ScreenshotTagFileSchema.parse(JSON.parse(raw));
  const map = new Map<string, ScreenshotTag>();
  for (const tag of parsed) map.set(tag.filename.toLowerCase(), tag);
  return map;
}

/**
 * Read the raw tag file (preserving original casing + order). Used by the
 * Screenshot Tagger UI which round-trips the array back to disk.
 */
export async function loadScreenshotTagFile(
  filePath: string = TAG_SIDECAR_FILE_PATH,
): Promise<ScreenshotTagFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return ScreenshotTagFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeScreenshotTagFile(
  tags: ScreenshotTagFile,
  filePath: string = TAG_SIDECAR_FILE_PATH,
): Promise<void> {
  const validated = ScreenshotTagFileSchema.parse(tags);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2) + "\n", "utf8");
}
