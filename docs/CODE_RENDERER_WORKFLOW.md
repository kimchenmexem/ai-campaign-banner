# Code-Based Renderer Workflow

The MVP's production renderer. Reads the Element Manifest, renders it as positioned HTML/CSS at exact canvas size, and captures a flat PNG via headless Chromium. Bannerbear remains optional.

## Why a code renderer

Bannerbear works fine but requires a designer to author every layer in their dashboard. For an MVP that needs to ship visuals from a Claude-Code-only loop, that handoff is the bottleneck. The code renderer takes the Element Manifest the rest of the pipeline already produces and renders directly — no manual template setup, no per-layer mapping, no `400 "This template has no layers yet"`.

**Architecture stays the same:**

- **Element Manifest is the source of truth.** The code renderer reads, never writes back.
- **Bannerbear remains optional.** [docs/BANNERBEAR_RENDER_WORKFLOW.md](./BANNERBEAR_RENDER_WORKFLOW.md) and `/bannerbear-preview` still work; nothing was deleted.
- **The flat PNG is not the source of truth.** A renderer that's willing to re-render (Bannerbear later, Figma later) gets all inputs back from the manifest plus `composite_refs` plus the Cloudinary asset map.
- **Figma is not connected.** When it is, it'll read the same manifest the code renderer reads — never a flat PNG.

## How it works

```
data/demo-campaign.preview.json
        │
        │  npm run render:code-demo
        │  (Playwright + headless Chromium)
        ▼
http://localhost:3000/render/ad/<adId>      ← chrome-free Element Manifest render
                                              (exact canvas size, position:fixed)
        │
        │  page.locator("#render-canvas").screenshot({ path })
        ▼
public/rendered-ads/demo/<format>.png       ← flat PNG (real text + real images)
data/code-render-map.generated.json         ← per-ad record + manifest hash + warnings
data/demo-campaign.code-rendered.json       ← demo + renders bundle for the preview page
```

The render route at `/render/ad/[adId]` uses `ProductionAdCanvas` + `ProductionElementLayer` (both in `src/components/render/`). They render every element absolutely-positioned per the manifest's `x/y/width/height/z_index`, with real text fonts/colors/sizes and real `<img>` tags for image elements. Cloudinary URLs and `file://localhost/...` URLs both work — the layer strips the `file://localhost` prefix back to a relative public path.

## Hard rules (in code)

- The render page resolves the adSpec from `data/demo-campaign.preview.json` and renders the manifest as-is. It never invents positions, never re-flows.
- `ProductionAdCanvas` is `position: fixed; top: 0; left: 0` so it escapes the parent layout's max-width and padding. The headless screenshot targets `#render-canvas` directly.
- The script waits for `networkidle` *and* explicitly awaits every `<img>` to decode before capturing — so remote Cloudinary images don't get sampled half-loaded.
- One failed render does not abort the run; failed records carry `status: "failed"` + an `error` string. Page-level errors and failed image requests are recorded under `warnings`.

## Commands

```bash
# Capture all 3 demo ads (requires dev server running):
npm run dev                     # in another shell, if not already running
npm run render:code-demo        # produces public/rendered-ads/demo/*.png

# Full chain from brand intake to PNGs:
npm run render:code-all         # = preview:all + render:code-demo

# Optional: push the final PNGs to Cloudinary (Cloudinary creds must be set):
npm run cloudinary:upload-code-renders
```

The render script honors `RENDER_BASE_URL` (env var) and `--base-url=<url>` (CLI flag), defaulting to `http://localhost:3000`. Use the flag/env when the dev server is on another port.

## Generated files

| Path | Purpose |
|---|---|
| `public/rendered-ads/demo/<format>.png` | The flat PNG. One file per AdSpec format. |
| `data/code-render-map.generated.json` | Per-ad records: ad_id, format, canvas size, output path, status, rendered_at, source = `"code_renderer"`, element_manifest_hash, bytes, warnings, error. |
| `data/demo-campaign.code-rendered.json` | `{ demo, renders }` bundle the preview page reads. |
| `data/cloudinary-code-render-map.generated.json` | Created only by `npm run cloudinary:upload-code-renders`. Maps each render's local path to its Cloudinary `secure_url` + `public_id`. |

## How the preview page consumes them

`/code-render-preview` shows three columns per ad:

- **Local preview (HTML/CSS).** The same `AdPreviewCanvas` the visual-preview page uses, scaled to fit.
- **Code-rendered final (PNG).** Sourced first from the Cloudinary URL when the upload step has run, otherwise from `public/rendered-ads/demo/*.png`. The "Delivery source" badge says `cloudinary` (green) or `local_preview` (amber).
- **Render details panel.** Output path, canvas size, bytes, rendered_at, source, warnings, the `element_manifest_hash` so a reviewer can spot when a re-render came from a different manifest version.

## How `getPreferredRenderedAds()` resolves

`src/lib/export/renderedAdsSource.ts` gives the future ZIP exporter a single resolver:

1. Code-rendered PNG (Cloudinary URL preferred when uploaded; falls back to local public path).
2. Bannerbear render (when one completed).
3. Last-resort `local_preview` placeholder so the exporter can still report something rather than silently dropping an ad.

`also_available` lists the other renderers that produced output for the same ad, for diagnostics.

## Why the PNG still isn't the source of truth

Because:

- A future Figma importer will rebuild editable nodes from the manifest, not from pixels.
- The composite mockup-with-screenshot has its inputs preserved in `composite_refs`, so any renderer can re-composite at higher quality without parsing the flat image.
- Layer text (headline, CTA, disclaimer) is real text in the PNG; readers can copy-paste, but the *authoritative* copy lives in the manifest's text fields.
- Cloudinary `secure_url`s on every image element mean the inputs are addressable independently of the final PNG.

The code renderer is convenient. The manifest is canonical.

## Files

| Path | Role |
|---|---|
| [src/components/render/ProductionAdCanvas.tsx](../src/components/render/ProductionAdCanvas.tsx) | Native-size canvas that escapes parent layout via `position: fixed`. |
| [src/components/render/ProductionElementLayer.tsx](../src/components/render/ProductionElementLayer.tsx) | One Element → one rendered HTML node. |
| [src/app/render/ad/[adId]/page.tsx](../src/app/render/ad/%5BadId%5D/page.tsx) | Chrome-free render route consumed by Playwright. |
| [scripts/render-code-demo.ts](../scripts/render-code-demo.ts) | `npm run render:code-demo` |
| [scripts/upload-code-renders.ts](../scripts/upload-code-renders.ts) | `npm run cloudinary:upload-code-renders` |
| [src/app/code-render-preview/page.tsx](../src/app/code-render-preview/page.tsx) | `/code-render-preview` UI |
| [src/lib/export/renderedAdsSource.ts](../src/lib/export/renderedAdsSource.ts) | `getPreferredRenderedAds()` for the future ZIP exporter. |
