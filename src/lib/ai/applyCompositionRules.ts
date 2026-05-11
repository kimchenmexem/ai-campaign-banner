import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CompositionRulesFileSchema,
  type CompositionRulesFile,
  type CompositionRule,
  type FormatRules,
  type SafeAreaExtra,
} from "@/lib/schemas/compositionRules.schema";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Post-processing pass that aligns clusters in the Element Manifest after
// the main builder has produced it. Only mutates elements when a rule is
// defined for (format, composition); otherwise the manifest is untouched.
//
// The pass implements industry banner-design conventions in a data-driven
// way — alignment, vertical rhythm, Z-pattern anchors, and platform safe
// zones — without touching the existing layout pipeline that controls
// fonts, colors, brand tokens, and all other elements.
// ─────────────────────────────────────────────────────────────────────────────

// Brand-kit margins are honoured by the main renderer. The applier adds an
// extra default safety pad for anchored elements so bottom-anchored CTAs
// don't kiss the canvas edge.
const DEFAULT_EDGE_PAD = 48;

let cachedRules: CompositionRulesFile | null = null;

export async function loadCompositionRules(
  cwd: string = process.cwd(),
): Promise<CompositionRulesFile | null> {
  if (cachedRules) return cachedRules;
  const filePath = path.join(cwd, "data", "composition-rules.generated.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = CompositionRulesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    cachedRules = parsed.data;
    return cachedRules;
  } catch {
    return null;
  }
}

export function findFormat(
  rules: CompositionRulesFile | null,
  format: string,
): FormatRules | null {
  if (!rules) return null;
  return rules.formats?.[format] ?? null;
}

export function findRule(
  rules: CompositionRulesFile | null,
  format: string,
  composition: string | undefined,
): CompositionRule | null {
  if (!rules) return null;
  const fmt = rules.formats?.[format];
  if (!fmt) return null;
  // Explicit composition rule wins; otherwise fall back to the per-format
  // default. This guarantees basic cluster cohesion for any composition the
  // AI might return — including ones we haven't enumerated yet.
  if (composition && fmt.compositions?.[composition]) {
    return fmt.compositions[composition];
  }
  return fmt.default ?? null;
}

export interface Canvas {
  width: number;
  height: number;
}

export interface ApplyResult {
  applied: boolean;
  notes: string[];
}

export function applyCompositionRules(
  manifest: ElementManifest,
  rule: CompositionRule,
  canvas: Canvas,
  safeAreaExtra?: SafeAreaExtra,
): ApplyResult {
  const notes: string[] = [];
  const stack = rule.text_stack_cluster;
  if (!stack) return { applied: false, notes };

  const headline = manifest.elements.find((e) => e.role === "headline");
  const subheadline = manifest.elements.find((e) => e.role === "subheadline");
  const cta = manifest.elements.find((e) => e.role === "cta");
  if (!headline || !cta) {
    return { applied: false, notes: ["text_stack: missing headline or cta"] };
  }

  // Compute the bottom y the CTA must respect (canvas bottom edge minus
  // any platform safe zone the format declares — e.g. 220px for stories).
  // Top/left clamps live in clampToSafeZones and are not needed here.
  const bottomReserved = (safeAreaExtra?.bottom ?? 0) + DEFAULT_EDGE_PAD;
  const rightReserved = (safeAreaExtra?.right ?? 0) + DEFAULT_EDGE_PAD;
  const ctaMaxY = canvas.height - bottomReserved - cta.height;

  // ── 1. Head → subhead vertical gap ────────────────────────────────────
  if (subheadline && stack.head_subhead_gap_em != null) {
    const emPx = headline.font_size ?? 56;
    const gap = Math.round(stack.head_subhead_gap_em * emPx);
    const targetY = headline.y + headline.height + gap;
    if (subheadline.y !== targetY) {
      notes.push(
        `text_stack.head_subhead_gap_em=${stack.head_subhead_gap_em}: subhead.y ${subheadline.y} → ${targetY}`,
      );
      subheadline.y = targetY;
    }
  }

  // ── 2. Cluster x-alignment ────────────────────────────────────────────
  if (stack.alignment === "left-of-headline") {
    const oldCtaX = cta.x;
    cta.x = headline.x;
    if (subheadline) subheadline.x = headline.x;
    if (oldCtaX !== headline.x) {
      notes.push(
        `text_stack.alignment=left-of-headline: cta.x ${oldCtaX} → ${headline.x}`,
      );
    }
  } else if (stack.alignment === "centered-on-headline") {
    const headlineCenter = headline.x + headline.width / 2;
    const oldCtaX = cta.x;
    cta.x = Math.round(headlineCenter - cta.width / 2);
    if (subheadline) {
      subheadline.x = Math.round(headlineCenter - subheadline.width / 2);
    }
    if (oldCtaX !== cta.x) {
      notes.push(
        `text_stack.alignment=centered-on-headline: cta.x ${oldCtaX} → ${cta.x}`,
      );
    }
  }

  // ── 3. CTA anchor (Z-pattern / bottom-anchor / right-center) ─────────
  // When cta_anchor is set we override the y-position entirely; cta_gap_above_em
  // is ignored in that case (the gap rule and the anchor rule are mutually
  // exclusive — anchor wins, see "the action is separated" pattern).
  if (stack.cta_anchor && stack.cta_anchor !== "default") {
    const oldCtaY = cta.y;
    const oldCtaX = cta.x;
    if (stack.cta_anchor === "bottom-left") {
      cta.y = ctaMaxY;
      // alignment may have already set cta.x; preserve it.
    } else if (stack.cta_anchor === "bottom-right") {
      cta.x = canvas.width - rightReserved - cta.width;
      cta.y = ctaMaxY;
    } else if (stack.cta_anchor === "right-center") {
      cta.x = canvas.width - rightReserved - cta.width;
      cta.y = Math.round((canvas.height - cta.height) / 2);
    }
    if (oldCtaY !== cta.y || oldCtaX !== cta.x) {
      notes.push(
        `text_stack.cta_anchor=${stack.cta_anchor}: cta.x ${oldCtaX} → ${cta.x}, cta.y ${oldCtaY} → ${cta.y}`,
      );
    }
  } else if (subheadline && stack.cta_gap_above_em != null) {
    // ── 4. CTA gap-above (only when no anchor override) ────────────────
    const emPx = subheadline.font_size ?? 22;
    const gap = Math.round(stack.cta_gap_above_em * emPx);
    const targetY = subheadline.y + subheadline.height + gap;
    if (cta.y !== targetY) {
      notes.push(
        `text_stack.cta_gap_above_em=${stack.cta_gap_above_em}: cta.y ${cta.y} → ${targetY}`,
      );
      cta.y = targetY;
    }
  }

  // ── 5. Platform safe-zone clamp ──────────────────────────────────────
  // Delegate to the standalone clamp so the same logic is reusable from
  // call sites that have no matching composition rule (story formats must
  // respect the platform UI band regardless of which composition fired).
  const clampNotes = clampToSafeZones(manifest, canvas, safeAreaExtra);
  for (const n of clampNotes) notes.push(n);

  return { applied: notes.length > 0, notes };
}

// Stand-alone clamp that pushes the text-stack into the safe area
// declared by the format. Idempotent — running it twice is a no-op.
// Used both inside applyCompositionRules and as a standalone guard from
// the build pipeline (so story platforms get their 220px reserved bands
// honoured even when no composition rule matched).
export function clampToSafeZones(
  manifest: ElementManifest,
  canvas: Canvas,
  safeAreaExtra: SafeAreaExtra | undefined,
): string[] {
  if (!safeAreaExtra) return [];
  const headline = manifest.elements.find((e) => e.role === "headline");
  const subheadline = manifest.elements.find((e) => e.role === "subheadline");
  const cta = manifest.elements.find((e) => e.role === "cta");
  if (!headline || !cta) return [];

  const topReserved = (safeAreaExtra.top ?? 0) + DEFAULT_EDGE_PAD;
  const bottomReserved = (safeAreaExtra.bottom ?? 0) + DEFAULT_EDGE_PAD;
  const leftReserved = (safeAreaExtra.left ?? 0) + DEFAULT_EDGE_PAD;
  const notes: string[] = [];

  // Top band: push headline down + slide the rest of the stack with it.
  if (headline.y < topReserved) {
    const delta = topReserved - headline.y;
    notes.push(`safe_area: headline.y ${headline.y} → ${topReserved} (top platform UI)`);
    headline.y = topReserved;
    if (subheadline) subheadline.y += delta;
    cta.y += delta;
  }
  // Bottom band: snap CTA up so its bottom edge sits on the safe-area floor.
  if (cta.y + cta.height > canvas.height - bottomReserved) {
    const newCtaY = canvas.height - bottomReserved - cta.height;
    notes.push(`safe_area: cta.y ${cta.y} → ${newCtaY} (bottom platform UI)`);
    cta.y = newCtaY;
  }
  // Left edge: don't let alignment drag the CTA outside the safe column.
  if (safeAreaExtra.left != null && cta.x < leftReserved) {
    const oldX = cta.x;
    cta.x = leftReserved;
    if (subheadline && subheadline.x < leftReserved) subheadline.x = leftReserved;
    notes.push(`safe_area: cta.x ${oldX} → ${leftReserved} (left edge clamp)`);
  }
  return notes;
}
