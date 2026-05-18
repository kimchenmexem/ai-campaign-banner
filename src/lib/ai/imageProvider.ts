import crypto from "node:crypto";
import type { MidjourneyContext, MidjourneyIntendedUse, MidjourneyUpload } from "@/lib/schemas/midjourney.schema";

// ─────────────────────────────────────────────────────────────────────────────
// AI image provider — closes the planner loop.
//
// The campaign planner already emits per-concept Midjourney prompts. Midjourney
// itself has no public API, so historically the loop required a manual Discord
// roundtrip. This module sends the same prompts to OpenAI's image API
// (gpt-image-1 / dall-e-3) instead, saves the resulting PNGs to the existing
// /public/midjourney-uploads/ tree, and returns approved upload records that
// the planner's `applyConceptVisuals` already knows how to consume.
//
// The "Midjourney" upload schema is reused — only the `source` field changes
// to "openai_image" so audit / export consumers can distinguish auto-generated
// images from human-uploaded Midjourney outputs. Manual Midjourney uploads via
// `/midjourney` keep working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export type ImageProviderName = "openai" | "none";

export function readImageProviderName(): ImageProviderName {
  const v = process.env.AI_IMAGE_PROVIDER?.toLowerCase().trim();
  if (v === "openai") return "openai";
  // Default OFF — image generation is opt-in to avoid surprise API costs.
  return "none";
}

export interface ImageGenerateRequest {
  prompt_id: string;
  prompt_text: string;
  context: MidjourneyContext;
  intended_use: MidjourneyIntendedUse;
  // Aspect ratio hint. The provider maps this to its supported sizes.
  aspect_ratio: "16:9" | "1:1" | "9:16" | "4:5";
  // Optional hint used as the saved filename prefix.
  concept_id?: string;
}

export interface ImageGenerateResult {
  upload: MidjourneyUpload;
  // Cost surface for the operator. Best-effort: we use the model's published
  // per-image price when known; otherwise null.
  estimated_usd: number | null;
}

// ── OpenAI Images path ─────────────────────────────────────────────────────
const OPENAI_SIZES_BY_AR: Record<string, "1024x1024" | "1024x1536" | "1536x1024"> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "4:5": "1024x1536",
  "9:16": "1024x1536",
};

// OpenAI Images price table. Keyed by model + size. We default to the "high"
// quality tier of gpt-image-1 (the practical upgrade available 2026-Q1):
// noticeably sharper photographic detail than the default tier, at roughly
// 4× the cost. The free fallback to "medium" is via OPENAI_IMAGE_QUALITY env
// var; "low" is even cheaper if budget matters more than fidelity.
//
// gpt-image-1 high   ≈ $0.17 / 1024×1024  ($0.25 for 1024×1536 portrait)
// gpt-image-1 medium ≈ $0.04 / 1024×1024  ($0.06 for 1024×1536)
// gpt-image-1 low    ≈ $0.011 / 1024×1024 ($0.016 for 1024×1536)
//
// When the user has access to a newer model (e.g. gpt-image-2 once it
// ships), set OPENAI_IMAGE_MODEL in .env.local. The price lookup falls
// back to null when the model isn't in this table — campaigns still work,
// the cost line in the QA report just says "—" instead of a $ figure.
const OPENAI_PRICE_USD: Record<string, Record<string, Record<string, number>>> = {
  "gpt-image-1": {
    high: {
      "1024x1024": 0.17,
      "1024x1536": 0.25,
      "1536x1024": 0.25,
    },
    medium: {
      "1024x1024": 0.04,
      "1024x1536": 0.06,
      "1536x1024": 0.06,
    },
    low: {
      "1024x1024": 0.011,
      "1024x1536": 0.016,
      "1536x1024": 0.016,
    },
  },
  "dall-e-3": {
    standard: {
      "1024x1024": 0.04,
      "1024x1792": 0.08,
      "1792x1024": 0.08,
    },
    hd: {
      "1024x1024": 0.08,
      "1024x1792": 0.12,
      "1792x1024": 0.12,
    },
  },
};

export async function generateImageOpenAI(
  req: ImageGenerateRequest,
  opts: { cwd?: string } = {},
): Promise<ImageGenerateResult> {
  const cwd = opts.cwd ?? process.cwd();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing — set it in .env.local before running image generation.");
  }
  const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
  // Default to "high" quality (the v2-equivalent rendering pass for
  // gpt-image-1). Override via OPENAI_IMAGE_QUALITY when budget matters
  // more than fidelity. dall-e-3 uses different quality keys (standard/hd);
  // gpt-image-1 uses high/medium/low.
  const quality =
    process.env.OPENAI_IMAGE_QUALITY ??
    (model.startsWith("dall-e") ? "hd" : "high");
  const size = OPENAI_SIZES_BY_AR[req.aspect_ratio] ?? "1024x1024";
  let OpenAI: typeof import("openai").default;
  try {
    OpenAI = (await import("openai")).default;
  } catch (err) {
    throw new Error(`OpenAI SDK not installed. ${(err as Error).message}`);
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // gpt-image-1 returns base64 by default; dall-e-3 returns either url or b64.
  // Prefer b64 so we don't depend on a temporary URL.
  const response = await client.images.generate({
    model,
    prompt: wrapPromptForCleanImagery(req.prompt_text),
    size,
    n: 1,
    // The OpenAI SDK accepts `quality` for both gpt-image-1 (high/medium/low)
    // and dall-e-3 (standard/hd). Cast to satisfy the union type without
    // pinning to a single model's enum.
    quality: quality as "high" | "medium" | "low" | "standard" | "hd" | "auto",
  });
  const item = response.data?.[0];
  if (!item) throw new Error("OpenAI returned no image data");

  const pngBuffer = await fetchPngBuffer(item);
  const upload = await saveAsUpload({
    cwd,
    pngBuffer,
    promptId: req.prompt_id,
    intendedUse: req.intended_use,
    context: req.context,
    conceptHint: req.concept_id,
    note: `Auto-generated by ${model} (${quality}) from prompt ${req.prompt_id}.`,
  });

  const estimated_usd =
    OPENAI_PRICE_USD[model]?.[quality]?.[size] ?? null;
  return { upload, estimated_usd };
}

// Wrap a concept prompt with aggressive anti-text directives. OpenAI Images
// has gotten better at typography, which means it leaks letters and numbers
// into backgrounds we want to be purely abstract. Putting the negative
// directive both BEFORE the subject (sets the system tone) and AFTER it
// (last-token weighting) is the most reliable way to suppress text.
//
// We also strip a small set of phrases that consistently produce glyphs in
// renders ("ticker tape", "stock symbols on screen", etc.) — these subjects
// almost guarantee illegible text artifacts no matter the negatives.
function wrapPromptForCleanImagery(prompt: string): string {
  const stripped = prompt
    .replace(/\bticker\s*tape\b/gi, "abstract horizontal lines")
    .replace(/\bstock\s*tickers?\b/gi, "abstract financial motifs")
    .replace(/\bcandlestick\s*chart\b/gi, "abstract data composition")
    .replace(/\bprice\s*labels?\b/gi, "")
    .replace(/\baxis\s*labels?\b/gi, "");
  const opening =
    "Pure abstract photography. Absolutely no text, letters, numbers, words, symbols, glyphs, captions, labels, watermarks, logos, or UI. ";
  const closing =
    " — strict: no readable characters of any kind, no signage, no typography in the image, all text-like marks blurred or absent.";
  return opening + stripped + closing;
}

async function fetchPngBuffer(item: {
  b64_json?: string | null;
  url?: string | null;
}): Promise<Buffer> {
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("OpenAI image response had neither b64_json nor url");
}

// ── Upload writer (shared) ──────────────────────────────────────────────────
async function saveAsUpload(args: {
  cwd: string;
  pngBuffer: Buffer;
  promptId: string;
  intendedUse: MidjourneyIntendedUse;
  context: MidjourneyContext;
  conceptHint?: string;
  note: string;
}): Promise<MidjourneyUpload> {
  const upload_id = `mu_${crypto.randomBytes(6).toString("hex")}`;
  const slug =
    (args.conceptHint ?? args.promptId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32) ||
    "image";
  const filename = `${slug}_${upload_id}.png`;

  // Route through AssetStorage so production lands the bytes in Supabase
  // Storage instead of the repo's public/ dir.
  const { getAssetStorage } = await import("@/lib/storage/AssetStorage");
  const storage = getAssetStorage("uploads");
  const storageKey = `${upload_id}/${filename}`;
  const put = await storage.put(storageKey, args.pngBuffer, "image/png");

  return {
    upload_id,
    prompt_id: args.promptId,
    intended_use: args.intendedUse,
    context: args.context,
    local_path: put.key,
    public_path: put.public_url,
    cloudinary_public_id: null,
    cloudinary_secure_url: put.signed_url,
    filename,
    bytes: put.bytes,
    approved: true, // auto-approve so the planner picks it up immediately
    notes: args.note,
    source: "openai_image",
    created_at: new Date().toISOString(),
  };
}
