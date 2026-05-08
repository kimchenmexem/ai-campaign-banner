import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GeneratedAssetIndexSchema,
  type GeneratedAsset,
  type GeneratedAssetType,
} from "@/lib/schemas/generatedAsset.schema";

// ─────────────────────────────────────────────────────────────────────────────
// GeneratedAssetResolver
//
// Phase 3 — bridge between the Asset Generator output
// (data/generated-assets.generated.json) and the campaign pipeline.
//
// Construction:
//   const resolver = await loadGeneratedAssetResolver({
//     ids: ["asset_cta_4f1c8e", "asset_background_…"],
//     warnings,
//   });
//
// Behaviour:
//   - Loads the index file, ENOENT-tolerant.
//   - Validates each id against the index. Missing ids push a warning and are
//     dropped silently — no throw.
//   - Groups picked assets by type. When multiple ids share a type, the first
//     id wins per type (stable: same input order → same output).
//   - Exposes typed getters for each role.
//
// "approved" preference (per spec): the GeneratedAsset schema doesn't carry
// an `approved` flag yet. When the schema gains one, this resolver should
// re-rank picks by that flag before falling back to first-by-input-order.
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_PATH = path.join("data", "generated-assets.generated.json");

const NOTES_USE_RE = /use_generated_asset:([\w.-]+)/g;

export interface GeneratedAssetResolver {
  // Map keyed by asset.type — at most one row per type.
  picksByType: Map<GeneratedAssetType, GeneratedAsset>;
  // Every asset that successfully resolved (in input order). Useful for
  // logging + manifest provenance.
  picked: GeneratedAsset[];
  // Ids the operator passed that we couldn't resolve. Surface as warnings.
  missingIds: string[];

  getBackground(): GeneratedAsset | null;
  getCtaElement(): GeneratedAsset | null;
  getMockup(): GeneratedAsset | null;
  getTradingUi(): GeneratedAsset | null;
  getFxOverlay(): GeneratedAsset | null;
}

export interface LoadResolverOptions {
  ids?: string[];
  notes?: string;
  cwd?: string;
  warnings?: string[];
}

/**
 * Build a resolver for one campaign brief. Pulls ids from both the explicit
 * `ids` array and `use_generated_asset:<id>` tokens parsed out of `notes`.
 */
export async function loadGeneratedAssetResolver(
  opts: LoadResolverOptions = {},
): Promise<GeneratedAssetResolver> {
  const cwd = opts.cwd ?? process.cwd();
  const warnings = opts.warnings ?? [];
  const explicitIds = opts.ids ?? [];
  const notesIds = parseNotesIds(opts.notes);
  const allIds = dedupe([...explicitIds, ...notesIds]);

  if (allIds.length === 0) return emptyResolver([]);

  const index = await readIndex(cwd);
  const byId = new Map<string, GeneratedAsset>();
  for (const a of index.assets) byId.set(a.id, a);

  const picked: GeneratedAsset[] = [];
  const missingIds: string[] = [];
  // Phase 4 — group by type FIRST, then pick a winner per type with approved
  // assets preferred over unapproved. Within the same approval tier, the
  // earliest id in input order wins (stable). This means an operator can pin
  // an unapproved CTA explicitly (it'll still adopt) but if they list both an
  // approved + unapproved CTA, the approved one always wins.
  const candidatesByType = new Map<GeneratedAssetType, GeneratedAsset[]>();
  for (const id of allIds) {
    const asset = byId.get(id);
    if (!asset) {
      missingIds.push(id);
      warnings.push(`generated_asset_id "${id}" not found in ${INDEX_PATH} — skipped.`);
      continue;
    }
    picked.push(asset);
    const list = candidatesByType.get(asset.type) ?? [];
    list.push(asset);
    candidatesByType.set(asset.type, list);
  }

  const picksByType = new Map<GeneratedAssetType, GeneratedAsset>();
  for (const [type, candidates] of candidatesByType) {
    const approved = candidates.filter((a) => a.approved !== false);
    const winner = (approved.length > 0 ? approved : candidates)[0];
    picksByType.set(type, winner);

    // Surface every dropped candidate (different from the winner) as info.
    for (const c of candidates) {
      if (c.id !== winner.id) {
        warnings.push(
          `generated_asset_id "${c.id}" type=${type} ignored — winner "${winner.id}" already adopted that role.`,
        );
      }
    }
    // Phase 4 — explicit unapproved-asset adoption warning so the QA report
    // surfaces it.
    if (winner.approved === false) {
      warnings.push(
        `generated_asset_id "${winner.id}" (type=${type}) is UNAPPROVED — adopted anyway because no approved candidate was provided. Approve it via PATCH /api/generators/asset/${winner.id} or remove it from the brief.`,
      );
    }
  }

  return makeResolver(picksByType, picked, missingIds);
}

function makeResolver(
  picksByType: Map<GeneratedAssetType, GeneratedAsset>,
  picked: GeneratedAsset[],
  missingIds: string[],
): GeneratedAssetResolver {
  const get = (t: GeneratedAssetType): GeneratedAsset | null =>
    picksByType.get(t) ?? null;
  return {
    picksByType,
    picked,
    missingIds,
    getBackground: () => get("background"),
    getCtaElement: () => get("cta"),
    getMockup: () => get("mockup"),
    getTradingUi: () => get("trading_ui"),
    getFxOverlay: () => get("fx_overlay"),
  };
}

function emptyResolver(missingIds: string[]): GeneratedAssetResolver {
  return makeResolver(new Map(), [], missingIds);
}

function parseNotesIds(notes?: string): string[] {
  if (!notes) return [];
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex defensively — in case the same regex is reused.
  NOTES_USE_RE.lastIndex = 0;
  while ((match = NOTES_USE_RE.exec(notes)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

async function readIndex(cwd: string): Promise<{ assets: GeneratedAsset[] }> {
  const p = path.join(cwd, INDEX_PATH);
  try {
    const raw = await fs.readFile(p, "utf8");
    return GeneratedAssetIndexSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { assets: [] };
    }
    throw err;
  }
}

// Pretty-print one provenance block ready for `Element.generated_asset`.
export function provenanceFromAsset(
  asset: GeneratedAsset,
): import("@/lib/schemas/elementManifest.schema").ElementGeneratedAsset {
  return {
    id: asset.id,
    type: asset.type,
    generator: asset.generator,
    variant: asset.variant,
    tags: asset.tags,
    source_assets: asset.source_assets,
  };
}
