# Architecture

## Stack

- Next.js 16 (App Router) + React 19, TypeScript strict
- Tailwind CSS 4
- Zod 4 for all input/output validation
- Supabase (Postgres) for campaign manifests, assets, versions, QA reports
- Cloudinary for binary asset storage (uploaded inputs and rendered finals)
- Bannerbear for banner rendering (template-driven)
- Midjourney as a manual visual workflow only — the system generates prompt packs but never calls a Midjourney API
- AI provider abstraction (OpenAI or Anthropic) selected at runtime via `AI_PROVIDER`
- JSZip for ZIP export

## High-level flow

```
brief
  → AI: campaign plan (concepts)
  → AI: ad specs (sizes/channels/copy slots)
  → AI: element manifest (every layer, fully described)
  → AI: midjourney prompt pack            (manual asset step happens outside the app)
  → Cloudinary: upload approved assets     (manual)
  → Bannerbear: render finals from templates + manifest
  → Cloudinary: store rendered finals
  → Supabase: persist campaign + concepts + specs + manifests + assets + qa reports
  → QA: deterministic checks
  → Export: ZIP package (finals/, elements/, copy/, specs/, qa/)
```

## Modules

| Path | Responsibility |
|---|---|
| `src/lib/schemas/*` | Single source of truth for shapes; types inferred via `z.infer` |
| `src/lib/ai/*` | Provider abstraction + planner + Midjourney prompt-pack builder |
| `src/lib/bannerbear/*` | Template map, render request/response shapes, fetch client |
| `src/lib/cloudinary/*` | SDK wrapper, folder helpers, upload helper |
| `src/lib/supabase/*` | Browser client, server client (service role), typed queries |
| `src/lib/export/*` | Manifest file builder + ZIP packager |
| `src/lib/qa/*` | Deterministic, AI-free QA checks |
| `src/app/api/*` | Route handlers — every input validated with Zod |
| `src/app/*` | UI: home, campaigns list/detail, assets, settings |

## Key invariants

- **Every rendered ad has a complete `ElementManifest`.** Without it the ad does not progress to QA or export.
- **All AI outputs are validated against Zod before use.** Raw model output never reaches storage or downstream code.
- **No Midjourney API calls.** The system only emits prompt packs; humans run them and upload the results.
- **No hard-coded keys.** All credentials come from environment variables, read lazily inside client factories.
- **Server-only modules guard service-role keys.** Anything that touches the Supabase service role imports `"server-only"`.

## Brand Kit Lite

Brand Kit Lite is the brand's source of truth in the MVP. It is a single Zod-validated JSON document covering identity, logo, colors, typography, CTA, layout, visual language, legal rules, and approved asset types. Schema lives at `src/lib/schemas/brandKit.schema.ts`; the example fixture lives at `data/brand-kit-lite.example.json`.

### How it works

- The kit is loaded once per request (or cached) via `loadBrandKit()` in `src/lib/brandKit/loadBrandKit.ts`.
- Three downstream consumers read it:
  1. **AI planner** — receives the kit as part of the prompt context so concepts and copy stay on-brand.
  2. **Element manifest builder** — populates each element's `brand_token_refs`, `uses_approved_color`, `uses_approved_font`, and `source_approved` flags by checking element values against the kit.
  3. **Deterministic QA** — re-validates the manifest against the kit (colors, fonts, disclaimer presence and size, allowed templates, allowed CTA texts, asset-type approval).
- Helper accessors (`getAllowedColors`, `getAllowedFonts`, `getDefaultDisclaimer`, `getAllowedTemplates`, `getCtaStyle`, `getDisclaimerRules`, `getAssetTypeRule`) wrap the kit so QA and planner code never reach into the raw shape.

### Why this replaces Figma in the MVP

Without Figma we still need a single, machine-readable definition of "what counts as on-brand." Brand Kit Lite plays exactly the role Figma styles + variables would play:

| Figma concept                | Brand Kit Lite equivalent                                                |
|------------------------------|--------------------------------------------------------------------------|
| Color styles                 | `colors.primary` / `secondary` / `accent` / `background` / `text` arrays |
| Color variables (modes)      | `colors.allowed_gradients` + `colors.forbidden`                          |
| Text styles                  | `typography.families` + `typography.sizes_per_format`                    |
| Layout grid / spacing tokens | `layout.spacing` + `layout.outer_margins` + `layout.safe_areas`          |
| Component variants           | `cta`, `layout.allowed_compositions`, `layout.allowed_templates`         |
| Library publishing rules     | `approved_asset_types` + `legal.legal_claim_rules`                       |

Treating the JSON as the canonical store means the AI planner, the renderer's manifest builder, and QA all consume the same definitions. There is no drift between "what design says" and "what the system enforces."

### Mapping to Figma later

When we later wire Figma in, the kit ports across with no rewrite:

- `colors.*` arrays → Figma **color variables**, one variable per token. Modes (light/dark) become Figma variable modes.
- `typography.families` + `weights` + `sizes_per_format` → Figma **text styles**, one per role per format (e.g. `heading/1080x1080`, `body/1080x1920`).
- `layout.spacing.scale` → Figma **number variables** for the 4-pt scale.
- `cta` → a Figma **component** with the same padding, radius, colors, and minimum size; `cta.allowed_texts` becomes the variant's allowed string values.
- `layout.allowed_compositions` and `layout.allowed_templates` → Figma component variants (one per composition) and Figma library frames per template.
- `approved_asset_types` + `legal.legal_claim_rules` → Figma **library publishing rules** + branch protection notes.
- `visual_language.allowed_styles` / `forbidden_styles` → documentation in the Figma library description; not enforceable in Figma natively but read by the (future) Figma importer when it generates AI-art prompts.

Because the manifest already carries an optional `figma` block per element (`node_type`, `style_ref`, `constraints`, `auto_layout_hint`, `parent_frame_hint`), the future Figma importer can resolve `style_ref` directly against the variables/styles created from this kit.
