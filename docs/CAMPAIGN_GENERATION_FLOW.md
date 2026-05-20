# Campaign Generation Flow

End-to-end map of how a MEXEM ad-campaign set is produced, from operator
brief to exportable ZIP. Reflects `main` at `062c9ad`.

This document is descriptive, not prescriptive — when the code disagrees
with this doc, the code wins and the doc should be updated.

## 1. Executive summary

**`ai-campaign-banner`** is a Next.js campaign-generation studio. An
internal operator submits a brief; the system uses an LLM to invent three
distinct creative concepts, calls the sibling `marketing-translator`
service for locale-correct, compliance-validated copy, deterministically
expands each concept into an `ElementManifest` per required ad format,
optionally renders manifests to PNG, runs a manifest-level QA pass, and
gates ZIP / per-ad exports behind that QA.

**`marketing-translator`** is the single source of campaign / ad copy.
Its `/api/campaign-copy` endpoint calls OpenAI `gpt-4o` with
compliance-aware prompts and returns a localized copy package with
`complianceNotes`. `ai-campaign-banner` never invents headline /
subheadline / cta / disclaimer text locally.

**Connection.** One wire crosses the repo boundary: per concept, the
planner POSTs to the translator's `/api/campaign-copy` with the brief
and a concept hint, then overwrites the concept's `copy_package` with
the response and clears the AI-generated alternates / platform
variations.

**Operator inputs.** Marketing message, campaign goal, tone(s), required
formats, language, plus optional notes / creative_mode /
risk_warning_required / generated_asset_ids / diversity_seed /
max_diversity / ai_provider / auto-generate-images / auto-render.

**System output.** A validated `CampaignPlan` (3 concepts × N formats
= 3N `CampaignAdSpec`s, each with a full `ElementManifest`), persisted
to `data/campaigns/<id>/campaign-plan.json`, plus rendered PNGs
(optional), plus a deterministic QA report computed on demand, plus
Figma-ready SVG / element-bundle exports gated by QA.

**AI-driven vs deterministic.**

| Layer | Driven by |
|---|---|
| Concept count (always 3) | deterministic |
| Concept ideas / strategy / visual direction | LLM (provider-selected) |
| Copy (headline / subheadline / body / cta / disclaimer) | `marketing-translator` (gpt-4o, server-side) |
| Visual layout spec per concept | optional AI pass; PRNG fallback |
| Template / motif / palette picks | seeded PRNG from `campaign_id` (+ `diversity_seed` if set) |
| Format → canvas size | static table (15 formats on main) |
| Element positions / fonts / colors / per-format MEXEM boxes | brand-kit driven |
| Element-manifest construction | deterministic in `buildConceptsFromPlan` |
| Optional image generation | OpenAI Images (when opted in) |
| Deterministic QA | pure manifest math |
| Export gate | deterministic QA + on-disk Vision QA (read, not triggered) |

## 2. End-to-end flow

Step-by-step, on `main`:

1. **Operator opens `/campaign-planner`.** The page is a server
   component that renders `CampaignPlannerForm`
   ([src/app/campaign-planner/CampaignPlannerForm.tsx](../src/app/campaign-planner/CampaignPlannerForm.tsx)).
2. **Form is filled.** Required: `marketing_message`, `campaign_goal`,
   `tone[]`, `required_formats[]`, `language`. Optional: `notes`,
   `risk_warning_required` (default `true`), `creative_mode`
   ("standard" or "exploratory"), `generated_asset_ids[]`,
   `diversity_seed`, `max_diversity`, `ai_provider`,
   `autoGenerateImages`, `autoRender` (default `true`).
3. **Submit → `POST /api/generate-campaign`** with body
   `{ brief, ai_provider?, set_as_active?, auto_generate_images? }`.
4. **API validation + brief stamping.**
   ([src/app/api/generate-campaign/route.ts](../src/app/api/generate-campaign/route.ts))
   Validates against `CampaignBriefInputSchema`, stamps `brief_id` and
   `created_at`, re-validates against the full `CampaignBriefSchema`.
   Errors are redacted via `redact()` so Bearer tokens / `api_key=` /
   `sk-*` values never leak into the response.
5. **`planCampaign(brief, opts)` runs.**
   ([src/lib/ai/campaignPlanner.ts](../src/lib/ai/campaignPlanner.ts))
   Sequential phases:
   1. **Load build context.** Brand kit, asset previews, Cloudinary
      maps, Midjourney uploads, generated-asset resolver. Warnings
      collected but non-fatal.
   2. **AI generation.** `provider.generateStructuredCampaignPlan()`
      returns 3 concept stubs (`AICampaignPlanRaw`). Required —
      failure halts the pipeline.
   3. **Schema re-validation** of the raw plan.
   4. **Refinement pass (best-effort).** Standard mode →
      critique-and-refine (kills consultant-ese). Exploratory mode →
      creative-stretch (pushes divergence). On failure, retains the
      original plan.
   5. **Marketing-translator loop.** Per concept, **sequential**, calls
      `fetchCampaignCopy()` with an `AbortController` timeout. Overwrites
      `copy_package.{headline, subheadline, body?, cta, disclaimer}`
      with the localized output. Clears `headline_emphasis`,
      `alternative_headlines`, `alternative_ctas`,
      `platform_copy_variations`. Appends topic-disclaimer text when
      relevant. Carries the translator's `complianceNotes[]` through to
      the saved plan.
   6. **Image generation (optional).** When `imageProvider="openai"`,
      generates background / hero / decorative images for each concept's
      `midjourney_prompt_pack`. Best-effort; failures are warnings, not
      hard errors.
   7. **Visual layout planning (best-effort, AI optional).** If the
      provider supports it, produces a `VisualLayoutSpec` per concept.
      Missing specs fall back to a seeded PRNG.
   8. **Ad spec build (deterministic).** `buildConceptsFromPlan()`
      ([src/lib/ai/buildAdSpecsFromPlan.ts](../src/lib/ai/buildAdSpecsFromPlan.ts))
      iterates **per concept × per `brief.required_formats[]`** to
      produce one `CampaignAdSpec` per (concept, format). Layout is
      driven by the brand kit's per-format MEXEM data (see section 7).
   9. **Persistence.** Writes `data/campaigns/<id>/campaign-plan.json`,
      upserts `data/campaigns/index.generated.json`, optionally writes
      `data/active-campaign.generated.json`. `campaign_id` is
      `cam_<sha1(brief_id || ISO timestamp)[0..8]>` — same brief re-run
      → new campaign_id.
6. **API returns** `{ ok, campaign_id, plan, saved_path, active, images }`.
7. **Auto-render (optional, default on).** The form calls
   `POST /api/render-campaign`, which loads the plan, spawns headless
   Chromium, navigates to `/render/campaign/<id>/ad/<adId>` per ad,
   screenshots `#render-canvas` at exact canvas size, writes PNGs to
   `public/rendered-ads/campaigns/<id>/<concept_id>_<format>.png`, and
   stores `data/campaigns/<id>/code-render-map.generated.json` +
   `campaign.code-rendered.json`.
8. **Browser redirects to `/campaigns/<id>`.** Operator reviews
   thumbnails, can manually trigger Vision QA via
   `POST /api/qa-campaign` (writes
   `data/campaigns/<id>/vision-qa.generated.json`).
9. **Operator triggers export.** Available routes on `main`:
   - `GET /api/export-campaign-zip?campaign_id=…[&override_blocking_qa=1]`
   - `GET /api/export-ad-svg?campaign_id=…&ad_id=…[&embed=0][&override_blocking_qa=1]`
   - `GET /api/export-ad-elements?campaign_id=…&ad_id=…[&override_blocking_qa=1]`
   - `POST /api/export-campaign` — `501 Not Implemented` stub.
   The gate (section 8) runs first; on block-level violations the
   response is `409 blocked_by_qa` with a structured `reasons[]`,
   unless `override_blocking_qa=1`.

## 3. Mermaid flowchart

```mermaid
flowchart TD
    A[Operator: /campaign-planner form] --> B[POST /api/generate-campaign]
    B --> C[Stamp brief_id + created_at, re-validate]
    C --> D[planCampaign]

    D --> D1[Load build context]
    D1 --> D2[AI generation: provider.generateStructuredCampaignPlan<br/>→ 3 concept stubs]
    D2 --> D3[Refinement pass best-effort<br/>standard: critique-refine · exploratory: creative-stretch]
    D3 --> D4[Per concept sequential: fetchCampaignCopy<br/>→ marketing-translator]
    D4 -.URL unset · NODE_ENV=production · ALLOW_MOCK != 1.-> X1[throw MarketingTranslatorConfigError]
    D4 -.URL unset · dev OR ALLOW_MOCK=1.-> M[local mockCampaignCopy]
    D4 -.timeout / HTTP error.-> X2[throw MarketingTranslatorError]
    M --> D5[Overwrite copy_package · clear AI alternates]
    D4 --> D5
    D5 --> D6{auto_generate_images?}
    D6 -- yes --> D7[OpenAI Images per prompt<br/>persist as Midjourney uploads]
    D6 -- no --> D8
    D7 --> D8[Optional planVisualLayoutsForCampaign<br/>fallback: seeded PRNG]
    D8 --> D9[buildConceptsFromPlan<br/>concept × required_format → AdSpec + ElementManifest]
    D9 --> D10[Validate CampaignPlanSchema, persist via repository<br/>upsert index, optionally setActiveCampaign]
    D10 --> R[Return campaign_id + plan]

    R --> RND{autoRender?}
    RND -- yes --> RND1[POST /api/render-campaign · Playwright Chromium]
    RND1 --> RND2[Write PNG + render-map + campaign.code-rendered.json]
    RND2 --> UI[/campaigns/id page]
    RND -- no --> UI

    UI -.optional, operator-triggered.-> QA[POST /api/qa-campaign · Gemini Vision<br/>→ vision-qa.generated.json]
    UI --> EXP{Export}
    EXP --> E0[QA gate: deterministic QA + read on-disk Vision QA]
    E0 -- blocks present, no override --> X3[409 blocked_by_qa · reasons]
    E0 -- override OR no blocks --> E1[export-campaign-zip · PNGs + manifests + ZIP]
    E0 --> E2[export-ad-svg · single SVG per ad]
    E0 --> E3[export-ad-elements · per-element ZIP per ad]

    subgraph MT [marketing-translator service]
      MT1[POST /api/campaign-copy] --> MT2[validate request · gpt-4o · temperature 0.7 · JSON mode]
      MT2 --> MT3[validateCompliance on every text field]
      MT3 --> MT4[Return LocalizedCopyPackage<br/>locale · direction · headline · subheadline · body? · cta · disclaimer · complianceNotes]
    end
    D4 -.HTTP POST · Bearer CAMPAIGN_COPY_API_KEY.-> MT1
```

## 4. AI vs deterministic

| Layer | AI-driven | Deterministic |
|---|---|---|
| Concept strategy / target_emotion / visual_direction | yes (provider) | — |
| Copy: headline / subheadline / body / cta / disclaimer | yes (translator, gpt-4o, server-side) | — |
| Visual layout ideas per concept | yes (optional pass, best-effort) | fallback: seeded PRNG |
| Format → canvas size | — | `FORMAT_TO_SIZE` static table (15 formats) |
| Format → device family | — | `FORMAT_TO_DEVICE` static table |
| Format → channel label | — | `FORMAT_TO_CHANNEL` static table |
| Per-format MEXEM box sizes (logo / text / cta / risk / product_visual) | — | brand-kit `element_sizes_per_format` + `logo.size_per_format` |
| Per-format section gaps | — | brand-kit `section_gaps_per_format` |
| Per-format logo position + visual anchor | — | brand-kit `logo_position_per_format` + `visual_anchor_per_format` |
| Per-format top inset | — | brand-kit `outer_margins[F].top` |
| Element manifest coordinates / fonts / colors | — | computed from brand kit by `buildAdSpec()` |
| Image generation (optional) | yes (OpenAI Images) | — |
| Deterministic QA | — | pure manifest math, info / warn / block |
| Vision QA (when present) | yes (Gemini, manual trigger) | — |
| Render | — | Playwright + Chromium screenshot of the manifest page |
| Export gate | — | union of deterministic + on-disk Vision QA blocks |

## 5. Key files by stage

| Stage | Files | Role |
|---|---|---|
| Operator UI | [src/app/campaign-planner/page.tsx](../src/app/campaign-planner/page.tsx) · [src/app/campaign-planner/CampaignPlannerForm.tsx](../src/app/campaign-planner/CampaignPlannerForm.tsx) | Brief form, client-side validation, submit + auto-render trigger |
| Brief schema | [src/lib/schemas/campaignBrief.schema.ts](../src/lib/schemas/campaignBrief.schema.ts) | `CampaignBriefSchema`, `CampaignFormatSchema` (15 formats) |
| API entry | [src/app/api/generate-campaign/route.ts](../src/app/api/generate-campaign/route.ts) | POST handler · brief stamping · error redaction · invokes planCampaign |
| Orchestrator | [src/lib/ai/campaignPlanner.ts](../src/lib/ai/campaignPlanner.ts) | `planCampaign()` phases · locale map · per-concept translator loop · persistence |
| Providers | [src/lib/ai/provider.ts](../src/lib/ai/provider.ts) | OpenAI / Anthropic / Mock factory, prompts, refinement passes |
| Plan schema | [src/lib/schemas/aiCampaignPlan.schema.ts](../src/lib/schemas/aiCampaignPlan.schema.ts) | `AICampaignPlanRaw`, `CampaignPlan`, `CampaignAdSpec`, `CampaignConcept` |
| Translator client | [src/lib/marketing-translator/client.ts](../src/lib/marketing-translator/client.ts) | `fetchCampaignCopy()` · prod mock guard · `MarketingTranslatorError` / `MarketingTranslatorConfigError` |
| Translator schemas (local) | [src/lib/marketing-translator/schema.ts](../src/lib/marketing-translator/schema.ts) | Request / response Zod schemas (parallel to translator's shared package) |
| Translator service | `../marketing-translator/backend/src/routes/campaign-copy.ts` · `../marketing-translator/backend/src/services/campaignCopy.ts` · `../marketing-translator/packages/shared/src/campaign-copy.ts` | HTTP endpoint · gpt-4o call · validateCompliance · response schema |
| Spec builder | [src/lib/ai/buildAdSpecsFromPlan.ts](../src/lib/ai/buildAdSpecsFromPlan.ts) | Concept × required_format → AdSpec + ElementManifest · `FORMAT_TO_SIZE`/`DEVICE`/`CHANNEL` |
| Spec mapping | [src/lib/ai/mapVisualSpecToInternals.ts](../src/lib/ai/mapVisualSpecToInternals.ts) | AI `VisualLayoutSpec` → renderer hints; safety clamps |
| Brand-kit schema | [src/lib/schemas/brandKit.schema.ts](../src/lib/schemas/brandKit.schema.ts) | `FormatKeySchema` (15) · per-format layout & logo blocks · topic disclaimers |
| Brand-kit converter | [src/lib/brandInput/convertBrandInputToBrandKit.ts](../src/lib/brandInput/convertBrandInputToBrandKit.ts) | `MEXEM_FORMAT_SPECS` · `MEXEM_1200X1200_VARIANT_B` · `applyMexemTopMargins()` |
| Brand-kit data | [data/brand-kit-lite.generated.json](../data/brand-kit-lite.generated.json) | Generated SoT — per-format element sizes, section gaps, logo position, visual anchor, outer margin top overrides |
| Visual-layout buckets | [src/lib/schemas/visualLayoutSpec.schema.ts](../src/lib/schemas/visualLayoutSpec.schema.ts) | `FORMAT_KEY_TO_NAME` — AR-bucketed leaderboard / square / portrait for all 15 formats |
| Manifest schema | [src/lib/schemas/elementManifest.schema.ts](../src/lib/schemas/elementManifest.schema.ts) | `ElementType`, `ElementRole`, `ElementSource`, geometry (px), text / image / legal / composite_refs |
| Renderer | [src/lib/render/renderCampaign.ts](../src/lib/render/renderCampaign.ts) · [src/app/api/render-campaign/route.ts](../src/app/api/render-campaign/route.ts) | Playwright + Chromium screenshot path |
| Deterministic QA | [src/lib/qa/deterministicQa.ts](../src/lib/qa/deterministicQa.ts) | Manifest-only checks · info / warn / block · zero-area / off-canvas / overlap |
| Vision QA (manual trigger) | [src/lib/qa/runQaForCampaign.ts](../src/lib/qa/runQaForCampaign.ts) · [src/lib/qa/visionQa.ts](../src/lib/qa/visionQa.ts) · [src/app/api/qa-campaign/route.ts](../src/app/api/qa-campaign/route.ts) | Gemini 2.5-flash · writes `vision-qa.generated.json` |
| Export gate | [src/lib/qa/exportGate.ts](../src/lib/qa/exportGate.ts) | `evaluateExportGate` (campaign-level) and `evaluateAdExportGate` (per-ad) · combines deterministic + on-disk Vision blocks |
| Export routes (active) | [src/app/api/export-campaign-zip/route.ts](../src/app/api/export-campaign-zip/route.ts) · [src/app/api/export-ad-svg/route.ts](../src/app/api/export-ad-svg/route.ts) · [src/app/api/export-ad-elements/route.ts](../src/app/api/export-ad-elements/route.ts) | Gated export endpoints |
| Export route (stub) | [src/app/api/export-campaign/route.ts](../src/app/api/export-campaign/route.ts) | `501 Not Implemented` |

## 6. Sources of truth

| Artifact | SoT location | Writer | Consumers |
|---|---|---|---|
| `CampaignBrief` | request body → embedded in `CampaignPlan.source_brief` | operator via `/api/generate-campaign` | planner, manifest builder, exporter |
| `CampaignPlan` | `data/campaigns/<id>/campaign-plan.json` (local) or Supabase row | `CampaignRepository.save()` | renderer, exporter, QA |
| `LocalizedCopyPackage` | response from `marketing-translator/api/campaign-copy` | `marketing-translator` service (gpt-4o + `validateCompliance`) | planner overwrites each `concept.copy_package` from it |
| `ElementManifest` | per-ad object inside `CampaignPlan` (schema-validated) | `buildConceptsFromPlan()` (deterministic) | render page, SVG exporter, deterministic QA, Vision QA |
| Brand kit | [data/brand-kit-lite.generated.json](../data/brand-kit-lite.generated.json) | `npm run brand:intake` → `convertBrandInputToBrandKitWithProvenance()` | spec builder, layout helpers, gradient/typography hints |
| MEXEM per-format specs | `MEXEM_FORMAT_SPECS` constant in [convertBrandInputToBrandKit.ts](../src/lib/brandInput/convertBrandInputToBrandKit.ts) — emitted into the brand kit | converter (re-run via `brand:intake`) | renderer, deterministic QA (via the brand kit) |
| Deterministic QA report | in-memory / computed on demand by `runDeterministicQa(plan)` | `src/lib/qa/deterministicQa.ts` | export gate (consumer); not persisted in this PR |
| Vision QA report | `data/campaigns/<id>/vision-qa.generated.json` | `runQaForCampaign` (operator-triggered) | UI overlay, export gate (read-only) |
| Rendered PNG | `public/rendered-ads/campaigns/<id>/<concept_id>_<format>.png` | `renderCampaign.ts` via Playwright | UI gallery, ZIP export, Vision QA input |
| Export ZIP / per-ad SVG / per-ad elements ZIP | streamed response — built fresh per request | the three export routes | designer / downstream tools |
| Campaign index | `data/campaigns/index.generated.json` | `upsertCampaignIndex()` | `/campaigns` list page |
| Active campaign pointer | `data/active-campaign.generated.json` | `setActiveCampaign()` | preview routes, dashboards |

## 7. MEXEM banner rules

### Supported formats on `main`

15 formats total, every one represented in `CampaignFormatSchema`,
`FormatKeySchema`, `FORMAT_KEY_TO_NAME`, `FORMAT_TO_DEVICE`,
`FORMAT_TO_CHANNEL`, and `FORMAT_TO_SIZE`.

**Set 1** (7 formats — measurements from
`MEXEM_Banner_Specifications.pdf`):

- `300x250` — IAB Medium Rectangle
- `336x280` — IAB Large Rectangle
- `1080x1080` — square
- `1080x1920` — vertical story
- `1200x628` — horizontal trial
- `1200x1200` — Variant A active (phone-right). Variant B
  (phone-lower) is captured **data-only** under
  `layout.composition_variants_per_format["1200x1200"].b`. No
  `1200x1200_a` / `1200x1200_b` enum values exist; the renderer
  picks Variant A unconditionally.
- `960x1200` — vertical

**Set 2** (8 IAB display formats — measurements from
`MEXEM_Banner_Specifications_Set_2.pdf`):

- `320x100` — wide micro banner
- `320x50` — ultra-wide micro banner
- `300x1050` — portrait skyscraper
- `300x600` — half page
- `160x600` — narrow skyscraper
- `970x250` — IAB billboard
- `728x90` — IAB leaderboard
- `250x250` — square compact

### How the spec is stored

The converter holds a hardcoded `MEXEM_FORMAT_SPECS` partial record (one
entry per active format) and a separate `MEXEM_1200X1200_VARIANT_B`
constant. Running `npm run brand:intake` regenerates
`data/brand-kit-lite.generated.json` from those constants and feeds:

- `logo.size_per_format[F]` — logo box `{ width, height }`
- `layout.element_sizes_per_format[F].{text, cta, risk_message, product_visual}` — element box sizes
- `layout.section_gaps_per_format[F].{logo_to_text, text_to_cta}` — vertical inter-section gaps
- `layout.logo_position_per_format[F]` — `"top-left"` (default) or `"top-center"` (when symmetric side margins)
- `layout.visual_anchor_per_format[F]` — `"right"` (default) or `"bottom-band"` (full-canvas-width band)
- `layout.outer_margins[F].top` — overridden when the spec gives a top inset; right/bottom/left remain on the brand-spec frame inset
- `layout.composition_variants_per_format["1200x1200"].b` — data-only Variant B block

### Ambiguity policy

Every field in `MexemFormatSpec` is optional. Where the source PDFs
either don't label a value or label it inconsistently with the visible
design role, the field is **omitted** in `MEXEM_FORMAT_SPECS` — the
brand-kit converter's per-field conditional spread keeps the omission
through to `brand-kit-lite.generated.json`, and the renderer falls back
to its computed default for that element. Values are never fabricated
to fill gaps.

Concrete omissions on Set 2:

| Format | Omitted | Reason |
|---|---|---|
| `320x100` | `risk_message` | source caution strip is visible but has no labelled dimension |
| `320x50` | `cta`, `product_visual` | both visible but unlabelled |
| `970x250` | `cta` | visible but unlabelled |
| `728x90` | `product_visual` | banner has no visual element |
| `250x250` | `top_margin` | no top callout in the spec — `outer_margins.top` keeps the brand-spec frame default |

Annotation corrections applied while transcribing Set 2 (per the PDF's
own "Source Notes / Annotation Exceptions" table): the `320x50` text
block, `300x1050` CTA + visual, `970x250` right-side element, and
`728x90` text are all categorized by visible design role rather than
the source's labels.

### Bannerbear / Midjourney

The format enum and `FORMAT_KEY_TO_NAME` mapping are extended in
lockstep, so the AI visual planner can persona-bucket every supported
format. The Bannerbear template map and Midjourney prompt-pack schema
are **not** auto-extended for new formats — they're only updated when
a template UID or Midjourney prompt actually exists. New formats render
via the Playwright code-render path.

### Variant B status

`1200x1200` Variant B is data-only. The renderer does **not** pick it
today; the active `1200x1200` layout is always Variant A. A future
variant-selector PR can read `composition_variants_per_format` at
render time and swap layouts based on operator input or seeded PRNG.

## 8. Production guardrails (invariants)

1. **`marketing-translator` owns all campaign copy.** `ai-campaign-banner`
   must overwrite the AI-generated `copy_package` fields with the
   translator response, and must clear `headline_emphasis`,
   `alternative_headlines`, `alternative_ctas`, and
   `platform_copy_variations` once the translator has run. They no
   longer match the final copy and are not compliance-checked.
2. **No silent mock copy in production.** When
   `MARKETING_TRANSLATOR_API_URL` is unset, the client throws
   `MarketingTranslatorConfigError` if `NODE_ENV === "production"`
   unless `MARKETING_TRANSLATOR_ALLOW_MOCK === "1"` is set explicitly.
   In non-production the missing URL still falls through to the local
   `mockCampaignCopy` so dev work doesn't depend on the translator
   running.
3. **Translator configured but down must fail clearly.** With the URL
   set, any HTTP error or timeout throws `MarketingTranslatorError`;
   the planner does not fall back to the mock.
4. **Manifest is the rendering source of truth.** Both the
   Playwright code-render page and the SVG exporter read from the
   per-ad `ElementManifest` only; the renderer never invents text,
   fonts, colors, or positions that aren't in the manifest.
5. **Disclaimer / risk message must not overlap text or CTA.** Vision
   QA enforces this on rendered pixels; deterministic QA enforces it
   on manifest geometry via `disclaimer-overlaps-cta` and
   `disclaimer-overlaps-headline` checks.
6. **`legal.topic_disclaimers` must be populated.** The brand kit's
   topic appendices (`etf_free`, `complex_products`, `tax_advice`) are
   read by the planner and appended to the disclaimer when copy
   mentions a matching topic. Regressions here are silent — guard with
   the smoke-test pattern in `convertBrandInputToBrandKit.ts`.
7. **`exportGate` refuses block-level violations.** `/api/export-campaign-zip`,
   `/api/export-ad-svg`, and `/api/export-ad-elements` all check the
   gate before producing output. Bypass requires
   `?override_blocking_qa=1` on the query string.
8. **Vision QA is read, not triggered, by the gate.** The gate calls
   `loadCampaignVisionQa()` (which only reads the on-disk
   `vision-qa.generated.json`); it never runs a fresh Vision QA pass,
   because Vision QA is paid + rate-limited + operator-initiated.
9. **Per-ad gate filters by `ad_id`.** A clean sibling banner remains
   exportable via `/api/export-ad-svg` while another banner in the
   same campaign is blocked.
10. **`campaign_id` must not be user-controllable.** It's a SHA-1 hash
    of `brief_id || ISO timestamp`, ensuring an external caller can't
    target a specific `data/campaigns/<id>/` directory.
11. **Generated campaign artifacts are not committed.** `data/campaigns/cam_*`,
    `public/uploads/`, `public/rendered-ads/`, `public/generated-preview-composites/`,
    `tmp/`, `.next/`, and `.next.nosync/` are working-tree only.
12. **SVG WIP is separate.** The campaign-level `/api/export-campaign-svg`,
    `/api/export-campaign-svgs`, and `/api/export-campaign-pdf` routes
    live on the SVG WIP feature branch only; they are **not on `main`**.
    When that work merges, each of those handlers must pick up an
    `evaluateExportGate` call mirroring `/api/export-campaign-zip` —
    same `override_blocking_qa=1` query param, same 409 `blocked_by_qa`
    response shape.

## 9. Environment variables

Variable names only. **Never commit secret values.**

| Variable | Purpose |
|---|---|
| `MARKETING_TRANSLATOR_API_URL` | Translator base URL. Unset in non-production → mock fallback. Unset in production → `MarketingTranslatorConfigError` (unless opt-in). |
| `MARKETING_TRANSLATOR_API_KEY` | Bearer token sent on every translator request. Must match the translator's `CAMPAIGN_COPY_API_KEY`. |
| `MARKETING_TRANSLATOR_TIMEOUT_MS` | Per-concept request timeout. Default `15_000` ms. |
| `MARKETING_TRANSLATOR_ALLOW_MOCK` | When `"1"`, re-enables the local mock in production for an intentional staging dry-run. Leave unset everywhere else. |
| `CAMPAIGN_COPY_API_KEY` | (`marketing-translator` side) static service-to-service token. Must match `MARKETING_TRANSLATOR_API_KEY`. |
| `DATABASE_URL` | Supabase / Postgres connection string for the production `CampaignRepository`. |
| `OPENAI_API_KEY` | Used by the OpenAI provider on `ai-campaign-banner` side (image generation, AI planner) and by `marketing-translator` (`gpt-4o`). |
| `AI_PROVIDER` | Default provider selection on `ai-campaign-banner`. Overridable per request via the form's `ai_provider` field. Values: `mock` (default), `openai`, `anthropic`. |

The `redact()` helper in `/api/generate-campaign/route.ts` strips
`Bearer …`, `api_key=…`, and `sk-*` substrings from error responses;
preserve this when adding new error paths.

## 10. Limitations and follow-ups

### Implemented (on `main`)

- Campaign-copy integration with `marketing-translator` per concept.
- Production mock guard (`MARKETING_TRANSLATOR_ALLOW_MOCK` opt-in).
- Deterministic QA (required-element / zero-area / off-canvas / overlap).
- Export gate on `/api/export-campaign-zip` (campaign-level) and
  `/api/export-ad-svg` + `/api/export-ad-elements` (per-ad).
- MEXEM Set 1 + Set 2 per-format spec data in the brand kit.
- Topic-aware disclaimers (etf_free / complex_products / tax_advice).

### Partial

- **`1200x1200` Variant B is data-only.** Stored under
  `composition_variants_per_format["1200x1200"].b`; the renderer does
  not pick it. Follow-up: variant-selector PR that consumes this block
  at render time.
- **Set 2 ambiguous fields are intentionally omitted, not derived.**
  For `320x100` (risk), `320x50` (cta / visual), `970x250` (cta), and
  `728x90` (visual), the renderer falls back to its computed defaults.
  A follow-up could either get explicit dimensions from the brand owner
  or formalise derivation rules.
- **`/api/export-campaign-svg`, `-svgs`, `-pdf` are not on `main`.**
  They exist only on the SVG WIP feature branch. When that branch
  ships, each handler needs the same `evaluateExportGate` call — a
  one-liner per route mirroring `export-campaign-zip`.
- **Deterministic QA is structural, not visual.** It catches missing
  required elements, zero-area boxes, off-canvas elements, and obvious
  manifest-level overlaps. Color contrast, typography legibility, and
  brand-color enforcement are Vision QA's territory and are not
  duplicated here.
- **Schema duplication between `ai-campaign-banner` and
  `marketing-translator`.** The translator publishes a shared package
  at `marketing-translator/packages/shared/src/campaign-copy.ts`;
  `ai-campaign-banner` redefines a parallel `LocalizedCopyPackageSchema`
  in `src/lib/marketing-translator/schema.ts`. Move to the published
  package, or generate one from the other, to prevent drift.
- **Per-concept translator calls are sequential.** Three concepts × a
  15 s timeout = up to ~45 s latency on a slow day. A `Promise.allSettled`
  with a shared `AbortController` would parallelise.
- **Vision QA stays operator-triggered.** The export gate reads
  on-disk Vision QA but does not run it. A campaign exported before
  Vision QA was run is gated only by deterministic checks. Documenting
  this is fine; if you want vision-aware gating by default, add an
  auto-run hook on render completion.

### Future / planned

- **Unsupported languages.** `ai-campaign-banner`'s locale map
  currently supports `en` → `en-GB`, `fr` → `fr-FR`, `it` → `it-IT`,
  `nl` → `nl-NL`. Other languages — including `he`, `ar`, `nl-BE`,
  `fr-BE`, `es-ES`, `en-GB` — throw immediately at the planner. The
  `marketing-translator` backend accepts a wider set of locales (e.g.
  `nl-BE`, `fr-BE`, `es-ES`); the next step is to widen the planner's
  language → locale table and the form's language selector in
  lockstep.
- **Local file storage for campaigns.** The local `CampaignRepository`
  driver writes campaigns + indexes + active pointers to
  `data/campaigns/`. Confirm production uses Supabase exclusively; if
  not, move artifacts to S3 / Supabase Storage so containers can be
  recycled safely.
- **No per-campaign audit trail.** `CampaignPlan` does not carry
  `created_by`. Two editors could overwrite each other's active-campaign
  pointer with no record. Add `created_by` from the auth context.
- **Variant-selector plumbing for `1200x1200`.** When Variant B is ready
  to ship, decide selection signal (per concept? per campaign? AI-chosen
  based on copy length?) and wire it into `buildConceptsFromPlan`.
- **Bannerbear extension for new formats.** The Bannerbear template map
  isn't auto-extended for Set 1 / Set 2 formats. If Bannerbear becomes
  a target renderer for those formats, add template UIDs and modification
  mappings.
- **Cross-banner overlap checks.** Deterministic QA today checks only
  intra-banner geometry. Cross-banner consistency (same headline length
  across formats? same CTA across the set?) would benefit from a
  campaign-level pass.
