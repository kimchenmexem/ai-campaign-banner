import { promises as fs } from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Vision QA — feed a rendered banner PNG + brand-rule list into Gemini and get
// back a structured list of brand-rule violations. No numeric score (per
// operator decision) — just yes/no per rule, plus a one-line description and
// (when possible) a coarse rectangle pointing at the offender.
//
// Brand rules come from docs/BANNER_REFERENCE_RULES.md, supplemented with the
// derived rules we've added since (text never on reading-end side, CTA refit,
// Elements/-only mockups, AR sanity, etc.). We pass the markdown verbatim so
// edits to the rules document immediately tighten / loosen QA — the prompt is
// the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gemini-2.5-flash";
const RULES_PATH = path.join("docs", "BANNER_REFERENCE_RULES.md");

// ── Output schema ──────────────────────────────────────────────────────────
// Gemini returns JSON; we validate shape so a malformed response never lands
// on the campaign plan.
export const ViolationSchema = z.object({
  rule_id: z.string().min(1),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
  description: z.string().min(1),
  // Optional bounding box on the rendered canvas (0-1 normalised; we
  // multiply at render-time when surfacing). Lets the UI eventually draw a
  // pointer at the offender. May be absent when the violation is global
  // (e.g. "headline + sub same color tone").
  bbox_norm: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1),
    })
    .optional(),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const BannerQaSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  png_path: z.string(),
  violations: z.array(ViolationSchema),
  qa_at: z.string(),
  model: z.string(),
});
export type BannerQa = z.infer<typeof BannerQaSchema>;

// ── Single-banner QA ───────────────────────────────────────────────────────
export interface RunVisionQaArgs {
  pngAbsPath: string;
  manifest: ElementManifest;
  format: string;
  adId: string;
  cwd?: string;
  rulesText?: string;
  model?: string;
}

export async function runVisionQa(args: RunVisionQaArgs): Promise<BannerQa> {
  const cwd = args.cwd ?? process.cwd();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY missing — set it in .env.local before running vision QA.",
    );
  }
  const rulesText = args.rulesText ?? (await loadRules(cwd));
  const pngBytes = await fs.readFile(args.pngAbsPath);
  const pngB64 = pngBytes.toString("base64");

  // Compact manifest — only the fields a vision check needs. Cuts prompt
  // size + helps Gemini correlate visible elements to manifest claims.
  const compactManifest = compactForPrompt(args.manifest);

  const prompt = buildPrompt({
    rulesText,
    manifest: compactManifest,
    format: args.format,
  });

  const client = new GoogleGenAI({ apiKey });
  const model = args.model ?? DEFAULT_MODEL;

  // Retry on 429 (rate-limit) and 503 (transient overload). Free-tier
  // quota for gemini-2.5-flash is 5 RPM, and the API also occasionally
  // returns 503 UNAVAILABLE during high demand. Both are recoverable —
  // we honour Retry-After / retryDelay from 429 errors when present, and
  // back off exponentially on 503 (max 4 attempts).
  const resp = await callWithRetry(() =>
    client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/png",
                data: pngB64,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    }),
  );

  const raw = (resp.text ?? "").trim();
  if (!raw) {
    return {
      ad_id: args.adId,
      format: args.format,
      png_path: relativeToCwd(args.pngAbsPath, cwd),
      violations: [],
      qa_at: new Date().toISOString(),
      model,
    };
  }

  // Gemini returns `{ violations: [...] }` per our responseSchema.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`vision QA: Gemini returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const wrapper = z
    .object({ violations: z.array(z.unknown()) })
    .safeParse(parsed);
  if (!wrapper.success) {
    throw new Error(
      `vision QA: malformed wrapper — ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  // Validate each violation; drop malformed entries instead of failing the
  // whole campaign.
  const violations: Violation[] = [];
  for (const v of wrapper.data.violations) {
    const parsed = ViolationSchema.safeParse(v);
    if (parsed.success) violations.push(parsed.data);
  }

  return {
    ad_id: args.adId,
    format: args.format,
    png_path: relativeToCwd(args.pngAbsPath, cwd),
    violations,
    qa_at: new Date().toISOString(),
    model,
  };
}

// ── Retry helper ───────────────────────────────────────────────────────────
// Wraps a single Gemini call so the campaign-level orchestrator can keep its
// simple "iterate banners → call generateContent" loop without dealing with
// transient failures.
//
// Codes treated as transient:
//   429 RESOURCE_EXHAUSTED — rate limit. The error body carries a
//                            `retryDelay: "Ns"` field; honour it when
//                            present, else fall back to exp backoff.
//   503 UNAVAILABLE        — high demand. Pure exp backoff.
//
// Max 4 attempts total (≈ 1s → 4s → 16s → 64s with the default).
async function callWithRetry<T>(
  fn: () => Promise<T>,
  attempt = 0,
): Promise<T> {
  const MAX_ATTEMPTS = 4;
  try {
    return await fn();
  } catch (err) {
    const info = parseRetriableError(err);
    if (!info || attempt >= MAX_ATTEMPTS - 1) throw err;
    const baseBackoff = Math.min(64_000, 1000 * Math.pow(4, attempt));
    const delayMs = info.retryAfterMs ?? baseBackoff;
    await sleep(delayMs);
    return callWithRetry(fn, attempt + 1);
  }
}

function parseRetriableError(err: unknown): { code: number; retryAfterMs: number | null } | null {
  if (!(err instanceof Error)) return null;
  // The Google SDK throws errors whose .message is the JSON envelope.
  const msg = err.message ?? "";
  let code: number | null = null;
  if (msg.includes('"code":429')) code = 429;
  else if (msg.includes('"code":503')) code = 503;
  if (!code) return null;
  // Try to extract `retryDelay: "50s"` from 429 bodies.
  const match = msg.match(/"retryDelay":"(\d+)(?:\.\d+)?s"/);
  const retryAfterMs = match ? Math.max(1000, parseInt(match[1], 10) * 1000 + 1000) : null;
  return { code, retryAfterMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function loadRules(cwd: string): Promise<string> {
  try {
    return await fs.readFile(path.join(cwd, RULES_PATH), "utf8");
  } catch {
    // Reasonable fallback if the doc is missing — operators can always
    // expand it later. The hard rules below are derived from the
    // operator's repeated feedback in 2026-04 / 2026-05.
    return [
      "# MEXEM banner rules (fallback)",
      "- Logo must sit top-left with equal inset from top and left edges.",
      "- Disclaimer must always sit at the bottom of the canvas.",
      "- CTA must always sit ABOVE the disclaimer.",
      "- Text block must sit on the reading-start side (left for LTR, right for RTL) or be centered. Never on the reading-end side.",
      "- Yellow brand-accent text must never overlap with yellow brand-accent shapes.",
      "- No text element overlaps another text element.",
      "- No text overlaps a CTA, mockup, or decorative shape that hurts legibility.",
      "- Mockups must blend visually (drop shadow). They should not look pasted on.",
      "- Brand colors only (kit primary + accent); no rogue hex.",
      "- Headline can have a 2-color split (yellow emphasis prefix + white rest).",
      "- Disclaimer is the smallest text on the canvas. No other text should be that small.",
    ].join("\n");
  }
}

function relativeToCwd(p: string, cwd: string): string {
  if (p.startsWith(cwd)) return p.slice(cwd.length).replace(/^\/+/, "");
  return p;
}

function compactForPrompt(m: ElementManifest): unknown {
  return {
    size: m.size,
    elements: m.elements
      .filter((e) => e.visible !== false)
      .map((e) => ({
        id: e.id,
        type: e.type,
        role: e.role,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        z_index: e.z_index,
        text: e.text,
        color: e.color,
        background_color: e.background_color,
        emphasis_text: e.emphasis_text,
        emphasis_color: e.emphasis_color,
        font_size: e.font_size,
        text_align: e.text_align,
      })),
  };
}

// Gemini's responseSchema constrains the output JSON shape so we don't have
// to parse free-form prose. Keys map to ViolationSchema above.
const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  required: ["violations"],
  properties: {
    violations: {
      type: "array",
      items: {
        type: "object",
        required: ["rule_id", "description"],
        properties: {
          rule_id: {
            type: "string",
            description:
              "A short kebab-case key for the broken rule. Examples: text-on-reading-end, text-overlaps-cta, yellow-on-yellow, disclaimer-not-bottom, logo-not-top-left, cta-overlaps-mockup, font-size-too-close-to-disclaimer.",
          },
          severity: {
            type: "string",
            enum: ["info", "warn", "block"],
            description:
              "info = cosmetic, warn = should be fixed before approval, block = must fix.",
          },
          description: {
            type: "string",
            description:
              "One-sentence explanation of what is wrong, naming the affected element when possible (e.g. 'Headline emphasis word \"Gold\" overlaps the yellow corner motif').",
          },
          bbox_norm: {
            type: "object",
            description:
              "Optional bounding box of the offender, normalized 0-1 against the canvas. Omit when the violation is global.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
        },
      },
    },
  },
};

function buildPrompt(args: {
  rulesText: string;
  manifest: unknown;
  format: string;
}): string {
  return [
    "You are a brand-discipline QA reviewer for the MEXEM (Powered by Interactive Brokers) ad-banner system.",
    "",
    "Task: review the attached banner PNG against the brand rules below and return a JSON list of any rules the banner violates. The rules are absolute — no creative latitude. Return an EMPTY violations array when the banner respects every rule.",
    "",
    "Output rules:",
    " - Do not return per-rule scores. No numeric ratings. Only a list of violations.",
    " - One violation per discrete problem. If the same headline overlaps two elements, that's two violations.",
    " - Use kebab-case for rule_id. Pick a value that names the failure mode (text-on-reading-end, yellow-on-yellow, cta-overlaps-mockup, …).",
    " - Severity: 'block' for compliance / legibility breakers (overlap, disclaimer missing, brand-color violation), 'warn' for layout/readability issues, 'info' for cosmetic only.",
    " - Reference the affected element by id when possible — the manifest is provided so you can correlate visible regions with element ids.",
    " - Every claim must be visible in the PNG. Don't speculate from the manifest if the PNG looks fine.",
    "",
    `Banner format: ${args.format}`,
    "",
    "Element manifest (compacted for QA):",
    "```json",
    JSON.stringify(args.manifest),
    "```",
    "",
    "Brand rules:",
    "",
    args.rulesText,
  ].join("\n");
}
