import type {
  CampaignPlan,
  CampaignConcept,
} from "@/lib/schemas/aiCampaignPlan.schema";
import type { VisualLayoutSpec } from "@/lib/schemas/visualLayoutSpec.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Step 11 — eval analyzer.
//
// Pure function: takes an array of saved CampaignPlan objects and computes
// metrics that tell us whether the AI Visual Planner is actually expressing
// creative range or mode-collapsing onto a narrow set of patterns.
//
// Inputs: CampaignPlan[] read from disk (no I/O here).
// Output: RunReport (typed JSON) + a markdown rendering helper.
//
// Goals (from Step 11 brief):
//   1. Distribution of every key spec enum
//   2. Downgrade event totals + breakdown (parsed from plan.warnings)
//   3. Contradictory specs (layout_type vs primary_visual etc.)
//   4. Mode-collapse rate per campaign (same value across N concepts)
//   5. Cross-campaign repetition (top signatures)
//   6. Format-adaptation usage
// ─────────────────────────────────────────────────────────────────────────────

export interface RunReport {
  run_id: string;
  generated_at: string;
  provider: string;
  total_campaigns: number;
  campaigns_with_specs: number;
  total_concepts: number;
  concepts_with_specs: number;
  distributions: {
    layout_type: Record<string, number>;
    composition: Record<string, number>;
    primary_visual: Record<string, number>;
    background_style: Record<string, number>;
    palette_intensity: Record<string, number>;
    accent_usage: Record<string, number>;
    logo_prominence: Record<string, number>;
    emphasis_level: Record<string, number>;
    headline_position: Record<string, number>;
    text_alignment: Record<string, number>;
    headline_scale: Record<string, number>;
    visual_position: Record<string, number>;
    visual_weight: Record<string, number>;
    cta_weight: Record<string, number>;
    cta_placement: Record<string, number>;
    cta_width: Record<string, number>;
    density: Record<string, number>;
    padding: Record<string, number>;
    max_text_density: Record<string, number>;
    safe_area_priority: Record<string, number>;
  };
  downgrades: {
    total: number;
    by_type: Record<string, number>;
  };
  contradictions: {
    total: number;
    by_type: Record<string, number>;
    examples: Array<{
      campaign_id: string;
      concept_id: string;
      kind: string;
    }>;
  };
  brand_discipline: {
    // accent_usage="strong" should appear on at most ONE concept per campaign
    // (system prompt rule). Records actual occurrences per campaign.
    campaigns_with_excess_strong_accent: number;
    examples: Array<{ campaign_id: string; count: number }>;
  };
  mode_collapse: {
    // Across the concepts of one campaign, how many of (layout_type,
    // composition, primary_visual, cta_weight) are identical? Higher =
    // more collapsed.
    mean_collapse_score: number;
    severe_count: number; // ≥ 0.75 (3 of 4 dimensions identical)
    partial_count: number; // ≥ 0.5 (2 of 4 dimensions identical)
    examples: Array<{
      campaign_id: string;
      score: number;
      same_dims: string[];
    }>;
  };
  cross_campaign_repetition: {
    // concept-level signature: layout_type/composition/primary_visual/background_style
    top_signatures: Array<{ signature: string; count: number; percent: number }>;
    distinct_signatures: number;
  };
  format_adaptation: {
    campaigns_with_any_override: number;
    overrides_by_format: { leaderboard: number; square: number; portrait: number };
    overrides_by_field: Record<string, number>;
    avg_overridden_fields_per_concept: number;
  };
  rationale: {
    avg_chars: number;
    min_chars: number;
    max_chars: number;
    n_with_rationale: number;
  };
}

// ── Top-level analyze ───────────────────────────────────────────────────────

export function analyzeCampaigns(
  plans: CampaignPlan[],
  meta: { run_id: string; provider: string },
): RunReport {
  const allConcepts: CampaignConcept[] = plans.flatMap((p) => p.concepts);
  const conceptsWithSpec = allConcepts.filter((c) => c.visual_layout_spec);

  const distributions = emptyDistributions();
  for (const c of conceptsWithSpec) {
    const s = c.visual_layout_spec!;
    bump(distributions.layout_type, s.layout_type);
    bump(distributions.composition, s.composition);
    bump(distributions.primary_visual, s.visual_strategy.primary_visual);
    bump(distributions.background_style, s.brand_strategy.background_style);
    bump(distributions.palette_intensity, s.brand_strategy.palette_intensity);
    bump(distributions.accent_usage, s.brand_strategy.accent_usage);
    bump(distributions.logo_prominence, s.brand_strategy.logo_prominence);
    bump(distributions.emphasis_level, s.hierarchy.emphasis_level);
    bump(distributions.headline_position, s.text_strategy.headline_position);
    bump(distributions.text_alignment, s.text_strategy.text_alignment);
    bump(distributions.headline_scale, s.text_strategy.headline_scale);
    bump(distributions.visual_position, s.visual_strategy.visual_position);
    bump(distributions.visual_weight, s.visual_strategy.visual_weight);
    bump(distributions.cta_weight, s.cta_strategy.weight);
    bump(distributions.cta_placement, s.cta_strategy.placement);
    bump(distributions.cta_width, s.cta_strategy.width);
    bump(distributions.density, s.spacing.density);
    bump(distributions.padding, s.spacing.padding);
    bump(distributions.max_text_density, s.text_strategy.max_text_density);
    bump(distributions.safe_area_priority, s.spacing.safe_area_priority);
  }

  const downgrades = aggregateDowngrades(plans);
  const contradictions = aggregateContradictions(plans);
  const brand_discipline = aggregateBrandDiscipline(plans);
  const mode_collapse = aggregateModeCollapse(plans);
  const cross_campaign_repetition = aggregateRepetition(conceptsWithSpec);
  const format_adaptation = aggregateFormatAdaptation(conceptsWithSpec);
  const rationale = aggregateRationale(conceptsWithSpec);

  return {
    run_id: meta.run_id,
    generated_at: new Date().toISOString(),
    provider: meta.provider,
    total_campaigns: plans.length,
    campaigns_with_specs: plans.filter((p) =>
      p.concepts.some((c) => c.visual_layout_spec),
    ).length,
    total_concepts: allConcepts.length,
    concepts_with_specs: conceptsWithSpec.length,
    distributions,
    downgrades,
    contradictions,
    brand_discipline,
    mode_collapse,
    cross_campaign_repetition,
    format_adaptation,
    rationale,
  };
}

// ── Aggregators ─────────────────────────────────────────────────────────────

function aggregateDowngrades(plans: CampaignPlan[]): RunReport["downgrades"] {
  const by_type: Record<string, number> = {};
  let total = 0;
  for (const p of plans) {
    for (const w of p.warnings) {
      if (!w.startsWith("downgrade: ")) continue;
      total += 1;
      // Strip the "downgrade: <concept>/<format>: " prefix to get the
      // canonical downgrade type. Preserves "<field>=<requested> → <applied>".
      const rest = w.replace(/^downgrade:\s*[^:]+:\s*/, "");
      // Drop the trailing parenthesis context so types aggregate cleanly.
      const key = rest.replace(/\s*\([^)]*\)\s*$/, "").trim();
      bump(by_type, key);
    }
  }
  return { total, by_type };
}

function aggregateContradictions(
  plans: CampaignPlan[],
): RunReport["contradictions"] {
  const by_type: Record<string, number> = {};
  const examples: RunReport["contradictions"]["examples"] = [];
  let total = 0;
  for (const p of plans) {
    for (const c of p.concepts) {
      const s = c.visual_layout_spec;
      if (!s) continue;
      const found = detectContradictions(s);
      for (const kind of found) {
        bump(by_type, kind);
        total += 1;
        if (examples.length < 12) {
          examples.push({
            campaign_id: p.campaign_id,
            concept_id: c.concept_id,
            kind,
          });
        }
      }
    }
  }
  return { total, by_type, examples };
}

function detectContradictions(s: VisualLayoutSpec): string[] {
  const found: string[] = [];
  const lt = s.layout_type;
  const pv = s.visual_strategy.primary_visual;
  const v = s.visual_strategy;

  // layout_type vs primary_visual coherence
  if (lt === "mockup_hero" && pv === "pattern") {
    found.push("layout_type=mockup_hero ⨯ primary_visual=pattern");
  }
  if (lt === "pattern_immersive" && pv === "mockup") {
    found.push("layout_type=pattern_immersive ⨯ primary_visual=mockup");
  }
  if (lt === "editorial_type" && (pv === "mockup" || pv === "screenshot")) {
    found.push(`layout_type=editorial_type ⨯ primary_visual=${pv}`);
  }
  if (lt === "photo_immersive" && pv !== "screenshot" && pv !== "mockup") {
    found.push(`layout_type=photo_immersive ⨯ primary_visual=${pv}`);
  }

  // primary_visual vs use_* booleans
  if (pv === "mockup" && v.use_mockup === false) {
    found.push("primary_visual=mockup ⨯ use_mockup=false");
  }
  if (pv === "pattern" && v.use_pattern === false) {
    found.push("primary_visual=pattern ⨯ use_pattern=false");
  }
  if (pv === "motif" && v.use_motif === false) {
    found.push("primary_visual=motif ⨯ use_motif=false");
  }
  if (pv === "screenshot" && v.use_screenshot === false) {
    found.push("primary_visual=screenshot ⨯ use_screenshot=false");
  }

  // density vs max_text_density coherence
  if (s.spacing.density === "rich" && s.text_strategy.max_text_density === "low") {
    found.push("density=rich ⨯ max_text_density=low");
  }
  if (s.spacing.density === "minimal" && s.text_strategy.max_text_density === "high") {
    found.push("density=minimal ⨯ max_text_density=high");
  }

  // accent_usage vs cta.weight (auto-downgraded but worth flagging)
  if (
    s.cta_strategy.weight === "loud" &&
    (s.brand_strategy.accent_usage === "none" ||
      s.brand_strategy.accent_usage === "subtle")
  ) {
    found.push(
      `cta.weight=loud ⨯ accent_usage=${s.brand_strategy.accent_usage}`,
    );
  }

  return found;
}

function aggregateBrandDiscipline(
  plans: CampaignPlan[],
): RunReport["brand_discipline"] {
  // System-prompt rule: at most ONE concept per campaign may use
  // accent_usage=strong. Count violations.
  const examples: RunReport["brand_discipline"]["examples"] = [];
  let count = 0;
  for (const p of plans) {
    const strong = p.concepts.filter(
      (c) => c.visual_layout_spec?.brand_strategy.accent_usage === "strong",
    ).length;
    if (strong > 1) {
      count += 1;
      examples.push({ campaign_id: p.campaign_id, count: strong });
    }
  }
  return { campaigns_with_excess_strong_accent: count, examples };
}

function aggregateModeCollapse(
  plans: CampaignPlan[],
): RunReport["mode_collapse"] {
  let totalScore = 0;
  let severe = 0;
  let partial = 0;
  const examples: RunReport["mode_collapse"]["examples"] = [];
  for (const p of plans) {
    const score = computeModeCollapse(p);
    totalScore += score.score;
    if (score.score >= 0.75) {
      severe += 1;
      if (examples.length < 12) {
        examples.push({
          campaign_id: p.campaign_id,
          score: score.score,
          same_dims: score.sameDims,
        });
      }
    } else if (score.score >= 0.5) {
      partial += 1;
    }
  }
  return {
    mean_collapse_score: plans.length > 0 ? totalScore / plans.length : 0,
    severe_count: severe,
    partial_count: partial,
    examples,
  };
}

function computeModeCollapse(p: CampaignPlan): {
  score: number;
  sameDims: string[];
} {
  const concepts = p.concepts.filter((c) => c.visual_layout_spec);
  if (concepts.length < 2) return { score: 0, sameDims: [] };
  const dims: Array<{ name: string; values: Set<string> }> = [
    { name: "layout_type", values: new Set(concepts.map((c) => c.visual_layout_spec!.layout_type)) },
    { name: "composition", values: new Set(concepts.map((c) => c.visual_layout_spec!.composition)) },
    { name: "primary_visual", values: new Set(concepts.map((c) => c.visual_layout_spec!.visual_strategy.primary_visual)) },
    { name: "cta.weight", values: new Set(concepts.map((c) => c.visual_layout_spec!.cta_strategy.weight)) },
  ];
  const sameDims = dims.filter((d) => d.values.size <= 1).map((d) => d.name);
  return { score: sameDims.length / dims.length, sameDims };
}

function aggregateRepetition(
  conceptsWithSpec: CampaignConcept[],
): RunReport["cross_campaign_repetition"] {
  const counts: Record<string, number> = {};
  for (const c of conceptsWithSpec) {
    const s = c.visual_layout_spec!;
    const sig = [
      s.layout_type,
      s.composition,
      s.visual_strategy.primary_visual,
      s.brand_strategy.background_style,
    ].join("/");
    bump(counts, sig);
  }
  const total = conceptsWithSpec.length;
  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return {
    distinct_signatures: sorted.length,
    top_signatures: sorted.slice(0, 8).map(([signature, count]) => ({
      signature,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    })),
  };
}

function aggregateFormatAdaptation(
  conceptsWithSpec: CampaignConcept[],
): RunReport["format_adaptation"] {
  const overrides_by_format = { leaderboard: 0, square: 0, portrait: 0 };
  const overrides_by_field: Record<string, number> = {};
  let totalOverridden = 0;
  let campaignsWithAny = 0;

  for (const c of conceptsWithSpec) {
    const fa = c.visual_layout_spec!.format_adaptation;
    let conceptHadAny = false;
    for (const fmt of ["leaderboard", "square", "portrait"] as const) {
      const o = fa?.[fmt];
      if (!o) continue;
      const fields = Object.keys(o).filter((k) => k !== "notes");
      if (fields.length === 0) continue;
      conceptHadAny = true;
      overrides_by_format[fmt] += 1;
      totalOverridden += fields.length;
      for (const f of fields) bump(overrides_by_field, f);
    }
    if (conceptHadAny) campaignsWithAny += 1;
  }
  return {
    campaigns_with_any_override: campaignsWithAny,
    overrides_by_format,
    overrides_by_field,
    avg_overridden_fields_per_concept:
      conceptsWithSpec.length > 0
        ? Math.round((totalOverridden / conceptsWithSpec.length) * 100) / 100
        : 0,
  };
}

function aggregateRationale(
  conceptsWithSpec: CampaignConcept[],
): RunReport["rationale"] {
  const lengths = conceptsWithSpec
    .map((c) => c.visual_layout_spec!.rationale?.length ?? 0)
    .filter((n) => n > 0);
  if (lengths.length === 0) {
    return { avg_chars: 0, min_chars: 0, max_chars: 0, n_with_rationale: 0 };
  }
  return {
    avg_chars: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
    min_chars: Math.min(...lengths),
    max_chars: Math.max(...lengths),
    n_with_rationale: lengths.length,
  };
}

// ── Markdown renderer ───────────────────────────────────────────────────────

export function renderMarkdownReport(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Visual AI Planner — Eval Run \`${r.run_id}\``);
  lines.push("");
  lines.push(`Generated: ${r.generated_at}`);
  lines.push(`Provider: \`${r.provider}\``);
  lines.push(
    `Campaigns: ${r.total_campaigns} (${r.campaigns_with_specs} with specs) · Concepts: ${r.total_concepts} (${r.concepts_with_specs} with specs)`,
  );
  lines.push("");

  lines.push(`## Headline metrics`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total downgrades | **${r.downgrades.total}** |`);
  lines.push(`| Avg downgrades / concept | ${ratio(r.downgrades.total, r.concepts_with_specs)} |`);
  lines.push(`| Total contradictions | **${r.contradictions.total}** |`);
  lines.push(`| Avg contradictions / concept | ${ratio(r.contradictions.total, r.concepts_with_specs)} |`);
  lines.push(`| Mode-collapse mean score (0–1) | **${r.mode_collapse.mean_collapse_score.toFixed(2)}** |`);
  lines.push(`| Severe mode-collapse campaigns (≥0.75) | ${r.mode_collapse.severe_count} / ${r.total_campaigns} |`);
  lines.push(`| Partial mode-collapse campaigns (0.5–0.74) | ${r.mode_collapse.partial_count} / ${r.total_campaigns} |`);
  lines.push(`| Brand-discipline violations (>1 strong accent) | ${r.brand_discipline.campaigns_with_excess_strong_accent} / ${r.total_campaigns} |`);
  lines.push(`| Distinct concept signatures | ${r.cross_campaign_repetition.distinct_signatures} / ${r.concepts_with_specs} |`);
  lines.push(`| Concepts with any format_adaptation | ${r.format_adaptation.campaigns_with_any_override} / ${r.concepts_with_specs} |`);
  lines.push(`| Avg format_adaptation fields / concept | ${r.format_adaptation.avg_overridden_fields_per_concept} |`);
  lines.push("");

  lines.push(`## Distributions`);
  lines.push("");
  for (const [key, dist] of Object.entries(r.distributions)) {
    lines.push(`### ${key}`);
    lines.push("");
    lines.push(`| Value | Count | % |`);
    lines.push(`|---|---|---|`);
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    const sorted = Object.entries(dist).sort(([, a], [, b]) => b - a);
    for (const [v, n] of sorted) {
      lines.push(`| \`${v}\` | ${n} | ${total > 0 ? Math.round((n / total) * 100) : 0}% |`);
    }
    lines.push("");
  }

  lines.push(`## Downgrades`);
  lines.push("");
  if (r.downgrades.total === 0) {
    lines.push(`_No downgrades observed. The AI is staying inside the supported enum vocabulary._`);
  } else {
    lines.push(`| Type | Count |`);
    lines.push(`|---|---|`);
    const sorted = Object.entries(r.downgrades.by_type).sort(
      ([, a], [, b]) => b - a,
    );
    for (const [k, n] of sorted) lines.push(`| \`${k}\` | ${n} |`);
  }
  lines.push("");

  lines.push(`## Contradictions`);
  lines.push("");
  if (r.contradictions.total === 0) {
    lines.push(`_No contradictory specs detected._`);
  } else {
    lines.push(`| Type | Count |`);
    lines.push(`|---|---|`);
    const sorted = Object.entries(r.contradictions.by_type).sort(
      ([, a], [, b]) => b - a,
    );
    for (const [k, n] of sorted) lines.push(`| ${k} | ${n} |`);
    lines.push("");
    lines.push(`### Examples`);
    lines.push("");
    for (const ex of r.contradictions.examples.slice(0, 8)) {
      lines.push(`- \`${ex.campaign_id}\` / \`${ex.concept_id}\` — ${ex.kind}`);
    }
  }
  lines.push("");

  lines.push(`## Brand discipline`);
  lines.push("");
  if (r.brand_discipline.campaigns_with_excess_strong_accent === 0) {
    lines.push(`_All campaigns respected the "at most one concept may use accent_usage=strong" rule._`);
  } else {
    lines.push(`Campaigns with multiple \`accent_usage=strong\` concepts:`);
    lines.push("");
    for (const ex of r.brand_discipline.examples.slice(0, 8)) {
      lines.push(`- \`${ex.campaign_id}\` — ${ex.count} concepts marked strong`);
    }
  }
  lines.push("");

  lines.push(`## Mode collapse across concepts`);
  lines.push("");
  lines.push(
    `Score = fraction of (layout_type, composition, primary_visual, cta.weight) that share a value across all concepts in a campaign. 1.0 = total collapse, 0 = full divergence.`,
  );
  lines.push("");
  if (r.mode_collapse.examples.length === 0) {
    lines.push(`_No severe mode-collapse cases (≥ 0.75)._`);
  } else {
    lines.push(`### Severe examples`);
    lines.push("");
    for (const ex of r.mode_collapse.examples) {
      lines.push(
        `- \`${ex.campaign_id}\` — score ${ex.score.toFixed(2)} — same: ${ex.same_dims.join(", ") || "(none)"}`,
      );
    }
  }
  lines.push("");

  lines.push(`## Cross-campaign repetition`);
  lines.push("");
  lines.push(`Top concept signatures (\`layout_type/composition/primary_visual/background_style\`):`);
  lines.push("");
  lines.push(`| Signature | Count | % of all concepts |`);
  lines.push(`|---|---|---|`);
  for (const s of r.cross_campaign_repetition.top_signatures) {
    lines.push(`| \`${s.signature}\` | ${s.count} | ${s.percent}% |`);
  }
  lines.push("");

  lines.push(`## Format adaptation usage`);
  lines.push("");
  lines.push(`| Format | Concepts with any override |`);
  lines.push(`|---|---|`);
  lines.push(`| leaderboard (1200×628) | ${r.format_adaptation.overrides_by_format.leaderboard} |`);
  lines.push(`| square (1080×1080) | ${r.format_adaptation.overrides_by_format.square} |`);
  lines.push(`| portrait (1080×1920) | ${r.format_adaptation.overrides_by_format.portrait} |`);
  lines.push("");
  if (Object.keys(r.format_adaptation.overrides_by_field).length > 0) {
    lines.push(`Fields most often overridden:`);
    lines.push("");
    lines.push(`| Field | Count |`);
    lines.push(`|---|---|`);
    const sorted = Object.entries(r.format_adaptation.overrides_by_field).sort(
      ([, a], [, b]) => b - a,
    );
    for (const [k, n] of sorted) lines.push(`| \`${k}\` | ${n} |`);
  }
  lines.push("");

  lines.push(`## Rationale length`);
  lines.push("");
  lines.push(
    `Avg ${r.rationale.avg_chars} chars · min ${r.rationale.min_chars} · max ${r.rationale.max_chars} · n=${r.rationale.n_with_rationale}`,
  );
  lines.push("");

  return lines.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function emptyDistributions(): RunReport["distributions"] {
  return {
    layout_type: {},
    composition: {},
    primary_visual: {},
    background_style: {},
    palette_intensity: {},
    accent_usage: {},
    logo_prominence: {},
    emphasis_level: {},
    headline_position: {},
    text_alignment: {},
    headline_scale: {},
    visual_position: {},
    visual_weight: {},
    cta_weight: {},
    cta_placement: {},
    cta_width: {},
    density: {},
    padding: {},
    max_text_density: {},
    safe_area_priority: {},
  };
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function ratio(num: number, denom: number): string {
  if (denom === 0) return "—";
  return (num / denom).toFixed(2);
}
