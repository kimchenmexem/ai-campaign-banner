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

  // ── 3. CTA placement — smart anchor with gap fallback ────────────────
  // When cta_anchor is set we prefer it (Z-pattern endpoint / bottom band).
  // But if anchoring would leave the subhead floating with a huge dead gap
  // (anchored CTA y is far below subhead bottom), or if the stack is so
  // tall that anchoring would force overlap, fall back to cta_gap_above_em.
  // Both fields can be set on the same rule; anchor is the preference,
  // gap is the safety net.
  let usedAnchor = false;
  if (stack.cta_anchor && stack.cta_anchor !== "default") {
    let anchorX = cta.x;
    let anchorY = cta.y;
    if (stack.cta_anchor === "bottom-left") {
      anchorY = ctaMaxY;
    } else if (stack.cta_anchor === "bottom-right") {
      anchorX = canvas.width - rightReserved - cta.width;
      anchorY = ctaMaxY;
    } else if (stack.cta_anchor === "right-center") {
      anchorX = canvas.width - rightReserved - cta.width;
      anchorY = Math.round((canvas.height - cta.height) / 2);
    }
    // Sanity checks before committing to the anchor:
    // (a) anchored CTA must not overlap a present subheadline
    const subBottom = subheadline ? subheadline.y + subheadline.height : -Infinity;
    const overlaps = anchorY < subBottom + 16;
    // (b) anchored CTA must leave a reasonable visual gap (≤ 250px) to subhead;
    // huge gaps look like the stack and the CTA are unrelated.
    const visualGap = anchorY - subBottom;
    const tooFar = subheadline && visualGap > 250;
    if (!overlaps && !tooFar) {
      const oldX = cta.x, oldY = cta.y;
      cta.x = anchorX;
      cta.y = anchorY;
      usedAnchor = true;
      if (oldX !== cta.x || oldY !== cta.y) {
        notes.push(
          `text_stack.cta_anchor=${stack.cta_anchor}: cta.x ${oldX} → ${cta.x}, cta.y ${oldY} → ${cta.y}`,
        );
      }
    } else {
      notes.push(
        `text_stack.cta_anchor=${stack.cta_anchor} skipped (${overlaps ? "would overlap subhead" : `gap ${visualGap}px > 250px`}); falling back to gap_above`,
      );
    }
  }
  if (!usedAnchor && subheadline && stack.cta_gap_above_em != null) {
    // CTA gap-above (used when no anchor, OR when anchor fell back)
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

  // ── 4. Stack-overflow check ──────────────────────────────────────────
  // If the assembled stack reaches past the canvas bottom, the headline is
  // typically wrapped to too many lines. We can't fix this here (it requires
  // smaller fonts or a different composition); surface it as a warning so
  // the operator knows to re-run, change creative_mode, or shorten copy.
  if (cta.y + cta.height > canvas.height) {
    notes.push(
      `STACK OVERFLOW: cta.bottom ${cta.y + cta.height} > canvas height ${canvas.height}. Headline likely wrapped too many lines for this format.`,
    );
  }

  // ── 5. Platform safe-zone clamp ──────────────────────────────────────
  // Delegate to the standalone clamp so the same logic is reusable from
  // call sites that have no matching composition rule (story formats must
  // respect the platform UI band regardless of which composition fired).
  const clampNotes = clampToSafeZones(manifest, canvas, safeAreaExtra);
  for (const n of clampNotes) notes.push(n);

  return { applied: notes.length > 0, notes };
}

// Universal guard: ensures the CTA never overlaps a visual element
// (product_visual / hero-image / supporting-image). When the renderer puts
// a mockup or hero image in the centre of the canvas and the CTA lands on
// top of it, the CTA reads as floating noise. Resolution: push the CTA
// BELOW the visual (conventional — CTA sits under the mockup), or above
// the visual when there's no room below. Runs after composition rules
// (so the CTA's intended y is set) and before the disclaimer guard
// (so the disclaimer follows the CTA's final position).
export function preventCtaVisualOverlap(
  manifest: ElementManifest,
  canvas: Canvas,
): string[] {
  const cta = manifest.elements.find((e) => e.role === "cta");
  if (!cta) return [];
  const VISUAL_ROLES = new Set([
    "product_visual",
    "hero-image",
    "supporting-image",
  ]);
  const visuals = manifest.elements.filter(
    (e) => e.role && VISUAL_ROLES.has(e.role) && e.x != null && e.y != null,
  );
  if (visuals.length === 0) return [];

  const overlapping = visuals.find((v) => {
    const yOver =
      Math.min(cta.y + cta.height, v.y + v.height) > Math.max(cta.y, v.y);
    const xOver =
      Math.min(cta.x + cta.width, v.x + v.width) > Math.max(cta.x, v.x);
    return yOver && xOver;
  });
  if (!overlapping) return [];

  const notes: string[] = [];
  const buffer = 16;

  // Try below the visual first — conventional placement (mockup over CTA
  // is visually noisy; CTA under mockup reads cleanly as "act after seeing").
  const belowY = overlapping.y + overlapping.height + buffer;
  if (belowY + cta.height <= canvas.height) {
    notes.push(
      `cta-visual-guard: cta.y ${cta.y} → ${belowY} (below ${overlapping.role})`,
    );
    cta.y = belowY;
    return notes;
  }

  // Fall back to above the visual — only if there's room after the subhead.
  const subhead = manifest.elements.find((e) => e.role === "subheadline");
  const aboveY = overlapping.y - buffer - cta.height;
  const subBottom = subhead ? subhead.y + subhead.height : 0;
  if (aboveY >= subBottom + 8 && aboveY >= 0) {
    notes.push(
      `cta-visual-guard: cta.y ${cta.y} → ${aboveY} (above ${overlapping.role})`,
    );
    cta.y = aboveY;
    return notes;
  }

  notes.push(
    `cta-visual-guard: cannot resolve overlap with ${overlapping.role} on ${canvas.width}x${canvas.height} canvas`,
  );
  return notes;
}

// Universal guard: ensures the legal-disclaimer never overlaps any text
// element (CTA, subheadline, headline, body). Runs always, regardless of
// whether a composition rule applied. The renderer occasionally places
// the disclaimer inside a tall bottom-band CTA (the MEXEM reference
// style) or inside a button-style CTA — both produce illegible legal
// text. Resolution: try a series of candidate y positions and pick the
// first one that doesn't overlap any text obstacle. Idempotent.
export function preventDisclaimerOverlap(
  manifest: ElementManifest,
  canvas: Canvas,
): string[] {
  const disclaimer = manifest.elements.find((e) => e.role === "legal-disclaimer");
  if (!disclaimer) return [];

  // Obstacles the disclaimer must not overlap: text-stack elements AND
  // visual elements (mockups, hero images). The disclaimer drifting onto
  // a phone mockup is just as bad as drifting onto the CTA.
  const OBSTACLE_ROLES = new Set([
    "headline",
    "subheadline",
    "body",
    "cta",
    "product_visual",
    "hero-image",
    "supporting-image",
  ]);
  const obstacles = manifest.elements.filter(
    (e) =>
      e.role &&
      OBSTACLE_ROLES.has(e.role) &&
      e.x != null &&
      e.y != null,
  );
  if (obstacles.length === 0) return [];

  const buffer = 8;
  const overlapsAny = (y: number): { role: string; y: number; height: number } | null => {
    for (const o of obstacles) {
      const yOver = Math.min(y + disclaimer.height, o.y + o.height) > Math.max(y, o.y);
      const xOver =
        Math.min(disclaimer.x + disclaimer.width, o.x + o.width) >
        Math.max(disclaimer.x, o.x);
      if (yOver && xOver) return { role: o.role!, y: o.y, height: o.height };
    }
    return null;
  };

  // Already clean — nothing to do.
  if (!overlapsAny(disclaimer.y)) return [];

  const notes: string[] = [];
  const cta = manifest.elements.find((e) => e.role === "cta");
  // Generate candidate slots in order of preference:
  //   1. Just above the CTA (conventional for bottom-band CTAs).
  //   2. Just below the CTA (button-style CTAs).
  //   3. Bottom of canvas (last-resort fallback near the disclaimer's
  //      original intended position).
  // We intentionally DO NOT include "above the entire text-stack" — that
  // floats the disclaimer in an arbitrary empty area near the top of the
  // canvas, which is worse UX than leaving it in its renderer-assigned
  // position with a warning.
  const candidates: Array<{ y: number; label: string }> = [];
  if (cta) {
    candidates.push({ y: cta.y - buffer - disclaimer.height, label: "above CTA" });
    candidates.push({ y: cta.y + cta.height + buffer, label: "below CTA" });
  }
  candidates.push({ y: canvas.height - buffer - disclaimer.height, label: "bottom of canvas" });

  for (const c of candidates) {
    if (c.y < 0 || c.y + disclaimer.height > canvas.height) continue;
    if (overlapsAny(c.y)) continue;
    notes.push(`disclaimer-guard: disclaimer.y ${disclaimer.y} → ${c.y} (${c.label})`);
    disclaimer.y = c.y;
    return notes;
  }
  notes.push(
    `disclaimer-guard: could not find a non-overlapping slot in ${canvas.width}x${canvas.height} (canvas too tight) — left at y=${disclaimer.y}`,
  );
  return notes;
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
