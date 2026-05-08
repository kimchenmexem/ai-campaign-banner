# System Overview

End-to-end picture of how this generator turns a marketing brief into rendered, on-brand banner ads. Read this first if you want a single document that explains the whole pipeline.

For deep dives on any single stage, see the existing per-stage docs (linked at the bottom).

---

## What this system does

You give it:
- A short marketing brief (`marketing_message`, audience, goal, tone, formats, contexts)
- A brand kit (logo files, color palette, typography, CTA style, legal disclaimer)
- A folder of brand assets (mockup devices, platform screenshots, optional Midjourney uploads)

It returns:
- A validated `CampaignPlan` with three concepts × N formats of fully-built ad specs (default: 3 concepts × 3 formats = 9 ads per campaign)
- Per-ad **Element Manifests** — typed JSON describing every layer (background, motif, mockup, text, CTA, disclaimer) with positions, fonts, colors, and provenance
- Final flat **PNGs** rendered by headless Chromium from those manifests, output to `public/rendered-ads/campaigns/{id}/`

The whole thing is reproducible: same `campaign_id` → identical render. Every new campaign generates a fresh design language because the design choices (template assignment, motif type, gradient pair, pattern style) are seeded by the campaign id.

---

## The pipeline

```
            ┌───────────────────────────────────────────────────────────────┐
            │  Operator submits brief at /campaign-planner                  │
            └────────────┬──────────────────────────────────────────────────┘
                         │
                         ▼
   ┌──────────────────────────────────────────────────┐
   │ 1. Plan generation (AI provider — OpenAI / Anthropic)
   │    System prompt enforces:                       │
   │      - Finance-domain vocabulary (ETFs, charts,  │
   │        margin, options — never "lifestyle")      │
   │      - Brand-only colors                         │
   │      - 3 distinct concepts (different metaphor   │
   │        per concept)                              │
   │      - Reference-calibre headlines + stats       │
   │    Output: AICampaignPlanRaw (JSON)              │
   │    Validation: AICampaignPlanRawSchema (Zod)     │
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 2. Critique-and-refine pass (same AI provider)   │
   │    A second call with CRITIQUE_SYSTEM_PROMPT     │
   │    + lower temperature (0.4). Plays creative     │
   │    director: kills consultant-ese, sharpens      │
   │    verbs, demands concept independence.          │
   │    Best-effort — falls back to the initial plan  │
   │    if refinement fails or returns invalid JSON.  │
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 3. (Optional) AI imagery generation              │
   │    When auto_generate_images is on, every prompt │
   │    in each concept's pack runs through OpenAI    │
   │    Images. Results saved to /midjourney-uploads/ │
   │    as approved uploads. Auto-generated *back-    │
   │    grounds* are NOT routed onto ads (text-glyph  │
   │    leak); manual MJ uploads still flow through.  │
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 4. Per-campaign design randomization             │
   │    Seeded PRNG keyed off campaign_id picks:      │
   │      - Template per concept (6 permutations of   │
   │        [mockup_hero, pattern_immersive,          │
   │         editorial_type])                         │
   │      - Composition per template (2 options for   │
   │        mockup_hero, fixed for the others)        │
   │      - Pattern style for pattern_immersive       │
   │        (5 SVG patterns)                          │
   │      - Generated motif per concept (8 algorithmic│
   │        SVG illustrations, context-aware)         │
   │      - Gradient angle (8 options)                │
   │      - Brand-color pair from the 8 brand-bg hexes│
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 5. Manifest construction                         │
   │    For each (concept × format):                  │
   │      a. Pick visual via existing demo machinery  │
   │         (mockup composite or screenshot, with    │
   │          aspect-ratio matching + fallback chain) │
   │      b. Build Element Manifest layer-by-layer:   │
   │         bg gradient → motif → pattern → scrim →  │
   │         logos → mockup → eyebrow → headline →    │
   │         subheadline → stat → CTA → disclaimer    │
   │      c. Stamp every text color via WCAG-aware    │
   │         contrast picker against the actual bg    │
   │      d. Validate against ElementManifestSchema   │
   │    Output: CampaignAdSpec[]                      │
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 6. Save + activate                               │
   │    data/campaigns/{id}/campaign-plan.json        │
   │    data/campaigns/index.generated.json (upsert)  │
   │    data/active-campaign.generated.json (if set)  │
   └────────────┬─────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────┐
   │ 7. Auto-render (when toggle is on)               │
   │    POST /api/render-campaign                     │
   │    For each ad: Playwright captures              │
   │    /render/ad/[adId] at native canvas size.      │
   │    Outputs PNGs + a render-map JSON.             │
   └──────────────────────────────────────────────────┘
```

The Element Manifest is the source of truth at every step. The AI chooses copy and strategy; the system chooses layout, colors, and design discipline. Hallucination cannot break layout — only copy.

---

## Templates and design families

Every concept gets one of three templates. The seeded PRNG shuffles assignment per campaign so concept 1 might be `mockup_hero` one campaign and `editorial_type` the next.

### `mockup_hero`

Classic product-evidence ad. Brand-color gradient background, calibrated device mockup with a platform screenshot composited inside. Text + CTA on the opposite side of the mockup.

- Composition: `text_leading` (text left, mockup right) OR `visual_leading` (mockup left, text right)
- Visible elements: bg → mockup → logos → headline → sub → CTA → disclaimer
- Used when the message benefits from showing the actual product

### `pattern_immersive`

Brand-color gradient + a clean geometric SVG pattern in the brand accent color filling the canvas. No mockup. Text anchored to the bottom.

- Composition: `hero_overlay`
- 5 pattern variants picked per campaign: `diagonal_lines`, `diagonal_lines_reverse`, `vertical_bars`, `dot_grid`, `concentric_arcs`
- Visible elements: bg → motif → pattern → logos → eyebrow → headline → sub → CTA → disclaimer
- Used when the message is conceptual and doesn't need product evidence

### `editorial_type`

Brand-color gradient + a focal element (either a generated stat block or a geometric accent disc in the brand accent). Pure typographic ad. The headline is supporting; the stat or accent is the focal piece.

- Composition: `hero_overlay`
- Stat takeover: when the AI emits `design_elements.stat` (e.g. `$0` / `PER ETF TRADE`), it renders as the focal element above the headline. Otherwise an accent disc fills the negative space.
- Visible elements: bg → motif → logos → stat number + label (or accent disc) → headline → sub → CTA → disclaimer
- Used for "hero claim" ads — single specific number that says everything

---

## Generated design motifs

Every concept also gets an **algorithmically generated SVG illustration** layered behind the foreground (z-index 8, between bg and scrim). This is the "new content" axis: the system generates a fresh design surface for each ad, not just rearranges fixed elements.

8 motif types, all rendered in brand colors, opacity 0.18-0.32 so they never dominate:

| Motif | What it draws |
|---|---|
| `chart_silhouette` | Smooth ascending area chart curve |
| `abstract_bars` | Vertical bars of varying heights (data-viz) |
| `axis_grid` | Sparse graph-paper grid |
| `wave_curve` | Sinuous polyline + faint area below |
| `gradient_orb` | Radial-gradient soft orb in a corner |
| `node_network` | 7 nodes connected by faint lines |
| `arc_meter` | Half-circle gauge with ticks |
| `ticker_strip` | Bar of mixed-opacity rectangles (ticker without text) |
| `none` | Explicit "no motif" — sometimes the cleanest design |

Motif is **context-aware**: a `charts` concept gets `chart_silhouette` / `wave_curve` / `axis_grid`, an `etfs` concept gets `abstract_bars` / `node_network` / `gradient_orb`, etc. Within the context's pool the PRNG picks one — so the same brief generated twice produces different motifs.

---

## Brand discipline

The brand kit is the only authority for visual decisions. The AI's `primary_palette` field is treated as a *mood hint* and otherwise ignored — every actual color rendered comes from `brandKit.colors.{primary, accent, background, text}`.

What this guarantees:
- Backgrounds always use one of the 8 brand-bg hexes (paired in any combination)
- CTA color comes from `brandKit.cta.button_background_color`
- Headline color comes from a WCAG-contrast pick against the actual rendered bg, drawn from `brandKit.colors.text`
- Disclaimer floor: 12 px. Per-format cap: 14 / 18 / 22 px depending on canvas size
- Brand fonts only (`brandKit.typography.families.headline`)

If the AI suggests an off-brand hex, the planner logs a warning and uses the brand-locked gradient anyway.

---

## Element Manifest — the source of truth

Every ad is described by an `ElementManifest`: a typed JSON document listing every layer with `id`, `type`, `role`, `source`, geometry (`x`, `y`, `width`, `height`, `z_index`), styling (color, font, etc.), and provenance (where the asset came from).

Why it matters:
- **The renderer is dumb.** `/render/ad/[adId]` (Next.js page) reads the manifest and renders each element exactly as described — no inference, no interpretation. Headless Chromium screenshots the result.
- **Reproducibility.** Same manifest in, same PNG out, every time.
- **Provenance.** Each element carries `source: "user-upload" | "local_mockup_composite" | "openai_image" | "midjourney_manual_upload" | "ai-generated" | "inline-text"`. Audits and exports can trace any pixel back to its origin.
- **Future renderers.** Bannerbear, Figma, or any new renderer reads the same manifest. The flat PNG is never the source of truth.

Element types: `background`, `image`, `logo`, `text`, `shape`, `cta-button`, `legal`, `other`.

Element roles: `headline`, `subheadline`, `body`, `cta`, `logo`, `background`, `hero-image`, `decorative`, `legal-disclaimer`, `product_visual`, `other`.

---

## Per-campaign randomization

Same brief generated twice produces two structurally different campaigns. The variety axes:

| Axis | Pool size | What changes |
|---|---|---|
| Template-to-concept assignment | 6 permutations | Concept positions shuffle |
| Composition for `mockup_hero` | 2 (text-left / visual-left) | Mockup placement swaps |
| Pattern style for `pattern_immersive` | 5 variants | Geometric language varies |
| Generated motif | 8 types (context-aware) | New illustration layer per concept |
| Gradient angle | 8 angles | 25°, 45°, 90°, 110°, 135°, 160°, 200°, 305° |
| Brand bg pair | 8 starting indices × 2 | Each campaign uses a different navy/teal pair |

All seeded by `campaign_id`. Same URL → identical render (reproducibility). New campaign → fresh language (variety).

---

## Mockup calibration

Photographic device mockups (iPhone, iPad, MacBook) often photograph at oblique angles. The calibrator at [/mockup-calibrator](http://localhost:3000/mockup-calibrator) lets an operator hand-trace the four corners of each device's screen.

When `corners` are present in the mockup manifest, the compositor uses a **real homography warp** rendered by headless Chromium with CSS `matrix3d`. All four corners pinned exactly — no affine approximation. Text inside warped mockups stays sharp because Chromium's GPU sampler does the resampling at 2× device-pixel ratio, then Sharp's lanczos3 downsamples for crispness.

Aspect-ratio matching: when picking a screenshot for a (device × context) pair, the compositor scores candidates by `|slot_AR - screenshot_AR|` and picks the closest. Cross-context fallback when no in-context candidate fits — keeps portrait phone screenshots out of landscape laptop slots.

---

## How to use

### Plan a new campaign (UI)

1. `npm run dev`, open [/campaign-planner](http://localhost:3000/campaign-planner)
2. Fill in `marketing_message`, `target_audience`, goal, tone, formats, preferred contexts
3. Pick AI provider (default `openai`, can also be `anthropic` or `mock`)
4. Toggle "Auto-generate AI imagery" if you want OpenAI Images called (~$0.40/campaign — saved to `/midjourney` for review, not auto-routed onto ads)
5. Toggle "Auto-render PNGs" (default on) so renders happen as part of the same operation
6. Click **Generate campaign**

The form Zod-validates client-side, posts to `/api/generate-campaign`, runs the full pipeline including the critique pass and (optional) auto-render, then redirects to `/campaigns/{id}` with the result.

### Plan a new campaign (CLI)

```bash
npm run campaign:generate-mock   # deterministic mock provider, no API call
npm run campaign:list            # list all campaigns with active marker
```

### Render an existing campaign

```bash
RENDER_BASE_URL=http://localhost:3000 npm run render:code-campaign
```

Or click "Render PNGs now" / "Re-render PNGs" on the campaign detail page.

### Update mockup calibration

After hand-tracing corners in `/mockup-calibrator`:

```bash
npm run mockups:republish
```

This rebuilds all 16 composites with the new corners, force-uploads them to Cloudinary (overwriting at the same URLs), and re-renders the active campaign.

### View the result

- [/campaigns](http://localhost:3000/campaigns) — list of every campaign
- [/campaigns/{id}](http://localhost:3000/campaigns) — detail page with concepts, ad specs, manifests, prompt packs, and rendered PNGs inline
- [/visual-preview](http://localhost:3000/visual-preview) — active campaign as live HTML/CSS (no PNG capture needed)
- [/code-render-preview](http://localhost:3000/code-render-preview) — local HTML preview vs final PNG, side-by-side

---

## Configuration

Environment variables (in `.env.local`, never committed):

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `openai` / `anthropic` / `mock` (default mock) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI text + image generation. Default model `gpt-4o`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Claude text generation. Default `claude-sonnet-4-6`. |
| `AI_IMAGE_PROVIDER` | `openai` / `none` (default none — opt-in only) |
| `OPENAI_IMAGE_MODEL` | Default `gpt-image-1` |
| `CLOUDINARY_*` | Asset hosting credentials |
| `RENDER_BASE_URL` | Base URL for the renderer to hit. Defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_APP_URL` | Public app URL used for callbacks |

`.env.example` is the public template — kept free of real secrets and committed. `.env.local` is gitignored (`.env*` with a `!.env.example` exception).

---

## Provenance and auditability

Every rendered pixel can be traced to its source:

- **Brand assets** (logos, mockups): `source: "user-upload"` with `local_public_path`
- **Generated composites** (mockup + screenshot): `source: "local_mockup_composite"` with `composite_refs.{composite_id, composite_public_path}`
- **AI-generated imagery** (OpenAI Images): `source: "openai_image"` with `midjourney.{prompt_id, upload_id, intended_use, context, approved}` and a `provenance` block
- **Manual Midjourney uploads**: `source: "midjourney_manual_upload"` with the same MJ provenance shape
- **Generated motifs / scrims / patterns**: `source: "ai-generated"` with the SVG embedded as a data URI
- **Text** (headline, sub, CTA, disclaimer): `source: "inline-text"` — emits no external file, just rendered glyphs

Every Midjourney/OpenAI element also carries `provenance.{generated_by, uploaded_by_user, manual_workflow}` so audits can distinguish auto-routed from hand-curated.

---

## Hard architectural rules

1. **Element Manifest is the source of truth.** The renderer never invents positions, never re-flows. Every coordinate is authored by `computeLayout` + `buildElements`.
2. **AI never decides layout.** The AI's output (`AICampaignPlanRaw`) has no fields for `x`, `y`, `width`, `height`, `font_size`, or `manifest`. Hallucination can only break copy/strategy.
3. **Brand kit is the only color authority.** All rendered colors come from `brandKit.colors.*`. AI palette suggestions are mood hints only.
4. **Auto-generated AI photographic backgrounds are NEVER auto-routed onto ads.** They leaked text glyphs and fought brand colors. Stays in `/midjourney` for hand-curation. Manual Midjourney uploads still flow through normally.
5. **Schemas are validated on every input/output.** Brief, AI raw plan, refined plan, final plan — Zod-checked before save.
6. **Same `campaign_id` → identical render.** Always. Reproducibility is non-negotiable.

---

## Where the code lives

```
src/
  app/
    campaign-planner/        — operator form
    campaigns/               — list + detail pages
    api/
      generate-campaign/     — POST: brief → CampaignPlan
      render-campaign/       — POST: campaign_id → PNGs via Playwright
      mockup-manifest/       — GET/POST mockup calibration
    render/ad/[adId]/        — chrome-free renderer page Playwright captures
  lib/
    ai/
      provider.ts            — OpenAI / Anthropic / Mock providers, system prompts
      campaignPlanner.ts     — orchestrator (validate → generate → critique → build → save)
      buildAdSpecsFromPlan.ts — per-concept ad-spec builder + per-campaign randomization
      imageProvider.ts       — OpenAI Images integration (auto-image generation)
    preview/
      createDemoCampaign.ts  — manifest builder + computeLayout + computeStatPlacement +
                                 motif renderers + scrim + pattern + accent disc
      composeMockupPreview.ts — Sharp + Playwright homography compositor
      planToDemoView.ts      — adapter so /visual-preview can show campaigns
      mockupManifest.ts      — calibration schema (rect or 4-corner quad)
      inferScreenshotContext.ts — screenshot tagging
    render/
      renderCampaign.ts      — shared renderer (Playwright capture per ad)
    schemas/
      aiCampaignPlan.schema.ts — AI raw + final CampaignPlan Zod schemas
      campaignBrief.schema.ts — operator brief schema
      brandKit.schema.ts     — brand kit schema (colors, fonts, CTA, legal)
      elementManifest.schema.ts — Element / Manifest schemas
      midjourney.schema.ts   — upload, prompt pack, assignment schemas
      screenshotContext.schema.ts — leaf enum for context tags
data/
  brand-kit-lite.generated.json    — converted brand kit
  asset-preview-map.generated.json — asset inventory
  mockup-composite-map.generated.json — built composites
  cloudinary-asset-map.generated.json
  cloudinary-composite-map.generated.json
  midjourney-uploads.generated.json
  midjourney-assignments.generated.json
  campaigns/
    index.generated.json
    {campaign_id}/
      campaign-plan.json              — saved CampaignPlan
      code-render-map.generated.json  — render summary
      campaign.code-rendered.json     — bundle for the preview page
  active-campaign.generated.json
brand-input/
  brand-spec/                  — operator-authored brand spec
  Logo/                        — brand logo files
  Powered by IB/               — partner logo
  Background/                  — background imagery
  mockup devices/              — device mockups (with mockup-manifest.json for calibration)
  Platform screenshot/         — platform screenshots (with screenshot-tags.json)
  Elements/                    — additional brand elements
public/
  brand-input-preview/         — copies of brand-input for the dev server
  generated-preview-composites/ — built mockup composites
  midjourney-uploads/          — manual + auto-generated AI imagery
  rendered-ads/campaigns/{id}/ — final PNGs
```

---

## Per-stage docs

For deep dives, see the per-stage docs:

- [AI_CAMPAIGN_PLANNER_WORKFLOW.md](./AI_CAMPAIGN_PLANNER_WORKFLOW.md) — the planner pipeline in detail
- [ARCHITECTURE.md](./ARCHITECTURE.md) — earlier architecture document
- [LOCAL_VISUAL_PREVIEW.md](./LOCAL_VISUAL_PREVIEW.md) — preview pages
- [CODE_RENDERER_WORKFLOW.md](./CODE_RENDERER_WORKFLOW.md) — Playwright renderer
- [CONTEXTUAL_MOCKUP_PREVIEW.md](./CONTEXTUAL_MOCKUP_PREVIEW.md) — composite generation
- [SCREENSHOT_TAGGING_AND_MOCKUP_CALIBRATION.md](./SCREENSHOT_TAGGING_AND_MOCKUP_CALIBRATION.md) — calibrator workflow
- [CLOUDINARY_UPLOAD_WORKFLOW.md](./CLOUDINARY_UPLOAD_WORKFLOW.md) — Cloudinary publishing
- [MIDJOURNEY_MANUAL_WORKFLOW.md](./MIDJOURNEY_MANUAL_WORKFLOW.md) — manual MJ workflow
- [BANNERBEAR_RENDER_WORKFLOW.md](./BANNERBEAR_RENDER_WORKFLOW.md) — optional Bannerbear path
- [BANNERBEAR_AND_FIGMA_STRATEGY.md](./BANNERBEAR_AND_FIGMA_STRATEGY.md) — why the manifest is portable
- [BRAND_INPUT_FOLDER.md](./BRAND_INPUT_FOLDER.md) — brand-input folder layout
- [ASSUMPTIONS.md](./ASSUMPTIONS.md) — design and ops assumptions
