# AI Campaign Planner Workflow

Replaces the hardcoded demo with an AI-driven planner. The operator submits a brief; the AI proposes concepts (strategy + copy + visual direction); the system builds the layouts. The Element Manifest stays the source of truth.

## What the planner does — and what it does not

| The AI decides | The system decides |
|---|---|
| Concept names, target emotions, tone | Element layout (positions, sizes, z-index) |
| Strategic ideas, copy (headline / subheadline / CTA / disclaimer) | Which screenshot / mockup / composite to pick |
| Visual direction (mood, palette suggestion, composition language) | Which fallback to use when no asset matches the desired context |
| Per-concept Midjourney prompt pack (intent, aspect ratio, prompt text) | Per-format ad spec construction (1200×628, 1080×1080, 1080×1920) |

The AI never authors an Element Manifest. It returns concept stubs (`AICampaignPlanRaw`); the system runs the existing demo machinery (`pickAssets`, `pickVisualForSpec`, `buildAdSpec`) to construct the per-format manifests deterministically, then validates the final `CampaignPlan`. Hallucination can only ever break copy / strategy — not layouts.

## End-to-end flow

```
CampaignBriefInput  ──► /api/generate-campaign  ──► planCampaign()
   (form / API)             (Zod-validated)         │
                                                    ├─ generateStructuredCampaignPlan()
                                                    │      └─ AICampaignPlanRawSchema.parse(...)   ← reject hallucination
                                                    │
                                                    ├─ buildConceptsFromPlan()
                                                    │      └─ for each concept × format:
                                                    │           pickAssets → pickVisualForSpec → buildAdSpec
                                                    │
                                                    └─ CampaignPlanSchema.parse(...)               ← final guard
                                                          │
                                                          ▼
                              data/campaigns/{campaign_id}/campaign-plan.json
                              data/campaigns/index.generated.json                (upserted)
                              data/active-campaign.generated.json                (if set_as_active)
```

## Schemas (source of truth, in order of strictness)

- [`src/lib/schemas/campaignBrief.schema.ts`](../src/lib/schemas/campaignBrief.schema.ts) — operator input. The form posts `CampaignBriefInput`; the API stamps `brief_id` + `created_at` and re-validates as `CampaignBrief`.
- [`src/lib/schemas/aiCampaignPlan.schema.ts`](../src/lib/schemas/aiCampaignPlan.schema.ts) — two layers:
  - `AICampaignPlanRawSchema` — what the AI returns (concept stubs only, no `ad_specs`). Validated immediately after the LLM call.
  - `CampaignPlanSchema` — the saved artifact, with `ad_specs` whose Element Manifests were built by code, plus `source_brief` so a campaign can be regenerated reproducibly.

## AI provider abstraction

Three providers, selected by the `AI_PROVIDER` env var (or `ai_provider` field in the API request):

| Name | When to use | Network? | Determinism |
|---|---|---|---|
| `mock` | Default for dev, CI, demos | None | SHA1-seeded — same brief always returns the same concepts |
| `openai` | Production with `OPENAI_API_KEY` | Yes (OpenAI) | Non-deterministic |
| `anthropic` | Production with `ANTHROPIC_API_KEY` | Yes (Anthropic) | Non-deterministic |

All three return JSON that's parsed against `AICampaignPlanRawSchema`. The system prompt includes hard rules (no logos in the prompt pack, palette only from the brand kit, etc.). API errors are redacted (`Bearer …`, `api_key=…`, `sk-…`) before they leave the server.

## Operator workflow

### Plan a new campaign (UI)

1. `npm run dev`, then visit [`/campaign-planner`](http://localhost:3000/campaign-planner).
2. Fill in marketing message, target audience, goal, tone, formats, preferred contexts.
3. Pick provider (default `mock`), tick "Set as active campaign", click **Generate campaign**.
4. The form Zod-validates client-side, POSTs to `/api/generate-campaign`, then redirects to `/campaigns/{id}`.

### Plan a new campaign (CLI, deterministic)

```bash
npm run campaign:generate-mock   # writes a sample brief, sets it active
npm run campaign:list            # prints index with ★ active marker
```

### Render the active campaign as PNGs

```bash
npm run dev                                          # in one terminal
RENDER_BASE_URL=http://localhost:3000 \
  npm run render:code-campaign                       # in another
```

Outputs:
- `public/rendered-ads/campaigns/{campaign_id}/{concept_id}_{format}.png`
- `data/campaigns/{campaign_id}/code-render-map.generated.json`
- `data/campaigns/{campaign_id}/campaign.code-rendered.json`

The renderer reuses `/render/ad/[adId]`. For campaign mode it backs up `data/demo-campaign.preview.json`, swaps in a `planToDemoView()`-projected version of the campaign so the route can resolve every `ad_id`, captures all ads, then restores the backup.

If no campaign is active and no `--campaign-id=...` flag is passed, the script falls back to `scripts/render-code-demo.ts` so the demo path keeps working.

### View results

- [`/campaigns`](http://localhost:3000/campaigns) — every saved plan, with ★ active and ✓ rendered markers.
- [`/campaigns/{id}`](http://localhost:3000/campaigns) — concepts, ad specs, manifests, prompt packs, rendered PNGs (when present).
- [`/visual-preview`](http://localhost:3000/visual-preview) — the active campaign rendered as positioned HTML/CSS (falls back to demo).
- [`/code-render-preview`](http://localhost:3000/code-render-preview) — local preview vs. rendered PNG side-by-side, for the active campaign or the demo.

## How to verify the campaign uses the Element Manifest

```bash
jq '.concepts[0].ad_specs[0].manifest.elements
       | map({type, role, x: .x, y: .y, has_text: (.text != null)})' \
   data/campaigns/{campaign_id}/campaign-plan.json
```

Every ad spec carries a full `manifest.elements` array with absolute positions and z-index — built by the same code that builds the demo, not by the AI.

## How to verify the AI never decides layout

The `AICampaignPlanRawSchema` has no fields named `manifest`, `elements`, `x`, `y`, `width`, or `height`. If you ever see a planner that surfaces those to the AI, that's the bug. The whole layer separation is so we can swap LLMs without retraining on layout JSON.

## Element Manifest provenance, end-to-end

```
brand kit  ───┐
              ├─► AdBuildContext  ──► buildAdSpec()  ──► Element Manifest  ──► PNG render
asset map  ───┤                          │                   │                  │
composite ────┤                          │                   │                  │
midjourney ───┘                          │                   │                  │
                                         │                   │                  │
                              concept_id, copy,         positions, sizes,    flat snapshot
                              visual context           image refs            (for distribution)
                              (FROM AI)                (FROM CODE)
```

Bannerbear, Figma, and any future renderer read the Element Manifest. The flat PNG is never the source of truth.
