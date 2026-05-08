# Bannerbear Render Workflow

Bannerbear is the renderer only. The Element Manifest stays the source of truth — Bannerbear receives modifications computed from the manifest, returns a flat PNG, and we record the round-trip for debugging. Nothing is reconstructed from the rendered image.

## Hard rules

- **Element Manifest is the source of truth.** Bannerbear's response is never read back into manifest fields.
- **Cloudinary URLs are required for image assets.** Local paths and `file://` URLs throw a clear error before the API call.
- **Never log secrets.** Auth headers and Bearer tokens are stripped from any error message before printing.
- **Figma is not connected.** When it is later, it will read the same manifest, not the Bannerbear PNG.

## One-time Bannerbear setup

Each ad size requires its own Bannerbear template with these layers (case-sensitive layer names):

**Required (the renderer will return 400 if any of these are missing):**

| Layer name        | Type      | Purpose                                  |
|-------------------|-----------|------------------------------------------|
| `background_image`| image     | Brand background fill or photo.          |
| `brand_logo`      | image     | The MEXEM-style brand logo.              |
| `product_mockup`  | image     | Composited mockup-with-screenshot visual.|
| `headline`        | text      | Primary message.                         |
| `cta_text`        | text      | CTA copy (e.g. "Start now").             |
| `disclaimer`      | text      | Risk warning text — must be a real layer.|

**Optional (improve the result when present, ignored when absent):**

| Layer name      | Type   | Purpose                                  |
|-----------------|--------|------------------------------------------|
| `subheadline`   | text   | Supporting copy below the headline.      |
| `cta_button`    | shape  | Receives `background_color` for the CTA. |
| `powered_by_ib` | image  | "Powered by Interactive Brokers" logo.   |
| `decorative_1`  | image/shape | First decorative slot.              |
| `decorative_2`  | image/shape | Second decorative slot.             |

Layer naming is contractual — the converter in [src/lib/bannerbear/convertManifestToModifications.ts](../src/lib/bannerbear/convertManifestToModifications.ts) emits modifications targeting these exact names. If your template uses different names, the renders will succeed but with no modifications applied (Bannerbear silently ignores unrecognized layer names).

## Configure `.env.local`

```bash
BANNERBEAR_API_KEY=bb_pr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BANNERBEAR_TEMPLATE_1200x628=<uid>
BANNERBEAR_TEMPLATE_1080x1080=<uid>
BANNERBEAR_TEMPLATE_1080x1920=<uid>
```

Find the template UIDs in the Bannerbear dashboard URL when you open a template (`https://app.bannerbear.com/projects/<project>/templates/<uid>`).

## Verify connectivity + layer contract

```bash
npm run bannerbear:check
```

Output:

```
✓ BANNERBEAR_API_KEY:   yes
✓ All 3 template UIDs configured

Template — 1200x628
  uid:    qY4mReZpzyrLD97lP8 (source: env)
  name:   Banner / Leaderboard
  size:   1200×628
  layers: 11 (background_image, brand_logo, product_mockup, headline, …)
  ✓ all required layers present
  · missing optional: decorative_2

…
✓ Bannerbear diagnostics passed.
```

Exits non-zero (codes 2 / 3 / 4) if env vars or required layers are missing. **No renders are performed.**

## Snapshot template metadata

```bash
npm run bannerbear:sync-templates
```

Writes `data/bannerbear-template-snapshots.generated.json`. Each snapshot includes:

- `format` (e.g. `1080x1080`)
- `template_uid`, `template_name`, `width`, `height`
- `available_modifications` — the full layer-name + accepted-modification-kind list
- `extended_defaults` — any other fields Bannerbear includes when `?extended=true`
- `fetched_at`
- `missing_required_layers`, `missing_optional_layers`

## Render the demo campaign

```bash
npm run bannerbear:render-demo
```

For each AdSpec in `data/demo-campaign.preview.json`:

1. Resolve the template UID (env → template map → AdSpec's `bannerbearTemplateUid`).
2. Run `convertElementManifestToBannerbearModifications(spec.manifest)`.
3. Refuse to call Bannerbear if any image element still has a local URL — the converter returns `local_url_errors` and the script records the failure without burning a render credit.
4. `POST /v2/images` and poll `GET /v2/images/:uid` every 1.5s up to 30 attempts (~45s timeout per render).
5. Record:
   - `final_render_url` (the rendered PNG)
   - `bannerbear_image_uid`
   - `bannerbear_render_response` (verbatim)
   - `modifications_sent` (verbatim)
   - `conversion_diagnostics` (mapped layers, missing layers, unsupported properties, warnings)
   - `status` and an `error` string on failure

The script **continues on per-ad failures**. One failed ad doesn't stop the others — every result lands in the render map either way.

Outputs:

- `data/bannerbear-render-map.generated.json` — flat per-render array.
- `data/demo-campaign.bannerbear-rendered.json` — `{ demo, renders }` for the side-by-side preview page.

## View the comparison

```bash
npm run dev   # if not already running
open http://localhost:3000/bannerbear-preview
```

Each ad shows:

- **Left:** the local HTML/CSS preview driven by the Element Manifest.
- **Right:** the Bannerbear-rendered PNG (or a clear failure box).
- A status badge: `not rendered` / `completed` / `failed`.
- Expandable diagnostics: template UID + source, mapped layers, missing layers, local URL errors, unsupported properties, the full modifications payload, and the raw Bannerbear response.

When a render fails, the diagnostics tell you exactly what to fix — the layer name that didn't exist, the local URL that wasn't uploaded, the empty text field the converter dropped.

## API route

`POST /api/render-ad`

Two request shapes:

```json
{ "ad_id": "spec_demo_1080x1080" }       // looks up the spec from data/demo-campaign.preview.json
{ "adSpec": { "specId": "...", "size": {...}, "manifest": {...} } }
```

Responses match the script's `RenderAdResult` shape. Status 200 + `{ ok: true, result }` on success, 502 + `{ ok: false, result }` on Bannerbear failure (the `result` still carries diagnostics so the caller can react), 400 on input validation, 500 on unhandled error.

## Why Figma still wins later

When Figma integration lands, the importer will read the **manifest** (per-element x/y/w/h, role, font, color, composite_refs, etc.) — not the Bannerbear PNG. The PNG is a flat snapshot for distribution; the manifest is editable structure.

This is why every preview-stage element keeps `local_public_path` + `cloudinary_public_id` + `composite_refs`: a renderer that is willing to re-composite (Bannerbear today, Figma tomorrow) gets all the inputs it needs without parsing pixels.

## Files

| Path | Role |
|---|---|
| [src/lib/bannerbear/client.ts](../src/lib/bannerbear/client.ts) | `bannerbearRequest`, `getBannerbearTemplate`, `createBannerbearImage`, `getBannerbearImage`, `pollBannerbearImage`, `bannerbearEnvStatus`. |
| [src/lib/bannerbear/templateMapping.ts](../src/lib/bannerbear/templateMapping.ts) | `getBannerbearTemplateUidForFormat`, `getTemplateMap`, `getRequiredBannerbearLayers`, plus the legacy `BannerbearTemplateMap` schema. |
| [src/lib/bannerbear/syncTemplate.ts](../src/lib/bannerbear/syncTemplate.ts) | `syncAllBannerbearTemplates`, `syncBannerbearTemplate`, `loadTemplateSnapshotsIfPresent`. |
| [src/lib/bannerbear/convertManifestToModifications.ts](../src/lib/bannerbear/convertManifestToModifications.ts) | `convertElementManifestToBannerbearModifications` + diagnostics. |
| [src/lib/bannerbear/renderAd.ts](../src/lib/bannerbear/renderAd.ts) | `renderAdWithBannerbear`, `RenderableAdSpecSchema`, `RenderAdResultSchema`. |
| [scripts/check-bannerbear.ts](../scripts/check-bannerbear.ts) | `npm run bannerbear:check` |
| [scripts/sync-bannerbear-templates.ts](../scripts/sync-bannerbear-templates.ts) | `npm run bannerbear:sync-templates` |
| [scripts/render-bannerbear-demo.ts](../scripts/render-bannerbear-demo.ts) | `npm run bannerbear:render-demo` |
| [src/app/api/render-ad/route.ts](../src/app/api/render-ad/route.ts) | `POST /api/render-ad` |
| [src/app/bannerbear-preview/page.tsx](../src/app/bannerbear-preview/page.tsx) | `/bannerbear-preview` UI |
