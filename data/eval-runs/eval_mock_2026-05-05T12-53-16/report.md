# Visual AI Planner — Eval Run `eval_mock_2026-05-05T12-53-16`

Generated: 2026-05-05T12:53:17.047Z
Provider: `mock`
Campaigns: 5 (5 with specs) · Concepts: 15 (15 with specs)

## Headline metrics

| Metric | Value |
|---|---|
| Total downgrades | **35** |
| Avg downgrades / concept | 2.33 |
| Total contradictions | **0** |
| Avg contradictions / concept | 0.00 |
| Mode-collapse mean score (0–1) | **0.00** |
| Severe mode-collapse campaigns (≥0.75) | 0 / 5 |
| Partial mode-collapse campaigns (0.5–0.74) | 0 / 5 |
| Brand-discipline violations (>1 strong accent) | 0 / 5 |
| Distinct concept signatures | 3 / 15 |
| Concepts with any format_adaptation | 15 / 15 |
| Avg format_adaptation fields / concept | 2 |

## Distributions

### layout_type

| Value | Count | % |
|---|---|---|
| `mockup_hero` | 5 | 33% |
| `pattern_immersive` | 5 | 33% |
| `editorial_type` | 5 | 33% |

### composition

| Value | Count | % |
|---|---|---|
| `text_leading` | 5 | 33% |
| `hero_overlay` | 5 | 33% |
| `centered` | 5 | 33% |

### primary_visual

| Value | Count | % |
|---|---|---|
| `mockup` | 5 | 33% |
| `pattern` | 5 | 33% |
| `motif` | 5 | 33% |

### background_style

| Value | Count | % |
|---|---|---|
| `split_color` | 5 | 33% |
| `deep_gradient` | 5 | 33% |
| `solid` | 5 | 33% |

### palette_intensity

| Value | Count | % |
|---|---|---|
| `standard` | 5 | 33% |
| `high_contrast` | 5 | 33% |
| `calm` | 5 | 33% |

### accent_usage

| Value | Count | % |
|---|---|---|
| `cta_only` | 5 | 33% |
| `strong` | 5 | 33% |
| `none` | 5 | 33% |

### logo_prominence

| Value | Count | % |
|---|---|---|
| `standard` | 10 | 67% |
| `small` | 5 | 33% |

### emphasis_level

| Value | Count | % |
|---|---|---|
| `balanced` | 5 | 33% |
| `bold` | 5 | 33% |
| `quiet` | 5 | 33% |

### headline_position

| Value | Count | % |
|---|---|---|
| `left` | 5 | 33% |
| `bottom` | 5 | 33% |
| `center` | 5 | 33% |

### text_alignment

| Value | Count | % |
|---|---|---|
| `left` | 10 | 67% |
| `center` | 5 | 33% |

### headline_scale

| Value | Count | % |
|---|---|---|
| `standard` | 10 | 67% |
| `hero` | 5 | 33% |

### visual_position

| Value | Count | % |
|---|---|---|
| `background` | 10 | 67% |
| `right` | 5 | 33% |

### visual_weight

| Value | Count | % |
|---|---|---|
| `balanced` | 5 | 33% |
| `dominant` | 5 | 33% |
| `subtle` | 5 | 33% |

### cta_weight

| Value | Count | % |
|---|---|---|
| `standard` | 5 | 33% |
| `loud` | 5 | 33% |
| `ghost` | 5 | 33% |

### cta_placement

| Value | Count | % |
|---|---|---|
| `below_subheadline` | 5 | 33% |
| `bottom_left` | 5 | 33% |
| `bottom_center` | 5 | 33% |

### cta_width

| Value | Count | % |
|---|---|---|
| `fit_text` | 15 | 100% |

### density

| Value | Count | % |
|---|---|---|
| `minimal` | 10 | 67% |
| `balanced` | 5 | 33% |

### padding

| Value | Count | % |
|---|---|---|
| `airy` | 10 | 67% |
| `standard` | 5 | 33% |

### max_text_density

| Value | Count | % |
|---|---|---|
| `low` | 10 | 67% |
| `high` | 5 | 33% |

### safe_area_priority

| Value | Count | % |
|---|---|---|
| `normal` | 10 | 67% |
| `high` | 5 | 33% |

## Downgrades

| Type | Count |
|---|---|
| `headline_position=bottom → auto` | 15 |
| `composition=centered → hero_overlay` | 15 |
| `composition=bottom_anchor → hero_overlay` | 5 |

## Contradictions

_No contradictory specs detected._

## Brand discipline

_All campaigns respected the "at most one concept may use accent_usage=strong" rule._

## Mode collapse across concepts

Score = fraction of (layout_type, composition, primary_visual, cta.weight) that share a value across all concepts in a campaign. 1.0 = total collapse, 0 = full divergence.

_No severe mode-collapse cases (≥ 0.75)._

## Cross-campaign repetition

Top concept signatures (`layout_type/composition/primary_visual/background_style`):

| Signature | Count | % of all concepts |
|---|---|---|
| `mockup_hero/text_leading/mockup/split_color` | 5 | 33% |
| `pattern_immersive/hero_overlay/pattern/deep_gradient` | 5 | 33% |
| `editorial_type/centered/motif/solid` | 5 | 33% |

## Format adaptation usage

| Format | Concepts with any override |
|---|---|
| leaderboard (1200×628) | 5 |
| square (1080×1080) | 0 |
| portrait (1080×1920) | 10 |

Fields most often overridden:

| Field | Count |
|---|---|
| `headline_position` | 5 |
| `text_alignment` | 5 |
| `cta_placement` | 5 |
| `composition` | 5 |
| `headline_scale` | 5 |
| `max_text_density` | 5 |

## Rationale length

Avg 177 chars · min 156 · max 189 · n=15
