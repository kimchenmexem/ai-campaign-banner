# Local Visual Preview

A throwaway, browser-based preview of demo campaign banners assembled from Brand Kit Lite + the brand-input asset folder. **It is not the production renderer.**

## Why this exists

Before wiring Cloudinary uploads or Bannerbear renders, we want to *see* the layout, copy, asset selection, and per-format scaling working. The preview reads the same Element Manifest that the production pipeline will read, and renders it as positioned HTML/CSS in the browser.

## What it is and is not

| | Local preview | Bannerbear (later) | Figma (later) |
|---|---|---|---|
| Reads from | Element Manifest | Element Manifest | Element Manifest |
| Output | HTML/CSS in dev server | Flat PNG / JPG | Editable Figma nodes |
| Source of truth? | No | No | No |
| Can be deleted | Yes — delete `data/*.preview.json` and `public/brand-input-preview/` | n/a | n/a |

The Element Manifest stays the source of truth in every column.

## Hard rules

- **No Cloudinary upload.** Files are copied locally to `public/brand-input-preview/`.
- **No Bannerbear API call.** The preview never leaves the dev server.
- **No Figma connection.** When Figma is wired later, it reads the same manifest the preview reads — not the rendered HTML, not a flattened PNG.
- **The final PNG/JPG is not the source of truth.** Bannerbear will render *from* the manifest; the rendered PNG is downstream output only.

## Pipeline

```
brand-input/                          ← brand owner drops files here
  ├─ brand-spec/brand-spec.json       ← rules, colors, sizes, etc.
  └─ {MEXEM logo,IBKR logo,...}/      ← raw assets

   │  npm run brand:intake
   ▼
data/brand-kit-lite.generated.json    ← validated BrandKitLite + provenance
data/asset-import-plan.generated.json ← per-file Cloudinary plan (no upload)

   │  npm run preview:assets
   ▼
public/brand-input-preview/<canonical>/<sanitized>.<ext>
data/asset-preview-map.generated.json ← maps original_local_path → public_path

   │  npm run preview:demo
   ▼
data/demo-campaign.preview.json       ← campaign + 3 ad specs + 3 manifests

   │  npm run dev   (or already-running dev server)
   ▼
http://localhost:3000/visual-preview  ← rendered HTML preview, with manifest viewer
```

## How to run

```bash
# Run the full pipeline:
npm run preview:all

# Or step-by-step:
npm run brand:intake     # rebuild brand kit + asset import plan
npm run preview:assets   # copy brand-input/ → public/brand-input-preview/
npm run preview:demo     # write data/demo-campaign.preview.json

# Then open the preview:
npm run dev              # if not already running
open http://localhost:3000/visual-preview
```

## What you see

Three tabs — **1200×628**, **1080×1080**, **1080×1920** — each rendering:

- a real text headline, subheadline, CTA, and disclaimer (every text element is HTML, not pixels);
- the brand logo (real `<img>`, swappable from `brand-input/MEXEM logo/`);
- the Powered by IB / IBKR logo (real `<img>`, when present);
- a hero visual (mockup if available, otherwise platform screenshot);
- a background image OR a CSS gradient sourced from the kit's gradient palette.

Below each preview a collapsible viewer shows the Element Manifest JSON for that ad. That JSON is what Bannerbear and Figma will later consume.

## What is preview-only

- The CSS gradient fallback for backgrounds is only applied at render time. The manifest still records the element as a `shape` with a `background_color` (Bannerbear's analogue) plus a `notes` field with the gradient CSS.
- `file_url` on image elements stores `file://localhost/<public_path>`. The schema requires a URL; the renderer strips the `file://localhost` prefix back to the relative public path. When Cloudinary is wired, the converter will write real Cloudinary URLs into the same field.
- Layout coordinates are computed locally per format. They will be replaced by the AI manifest builder when that lands.

## Files involved

| Path | Role |
|---|---|
| [src/lib/preview/copyPreviewAssets.ts](../src/lib/preview/copyPreviewAssets.ts) | Reads import plan, copies images into `public/brand-input-preview/`, writes the preview map. |
| [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) | Builds three Figma-ready Element Manifests from kit + preview map. |
| [scripts/preview-assets.ts](../scripts/preview-assets.ts) | Orchestrator behind `npm run preview:assets`. |
| [scripts/preview-demo.ts](../scripts/preview-demo.ts) | Orchestrator behind `npm run preview:demo`. |
| [src/components/preview/AdPreviewCanvas.tsx](../src/components/preview/AdPreviewCanvas.tsx) | Scaled, absolutely-positioned canvas. |
| [src/components/preview/ElementLayer.tsx](../src/components/preview/ElementLayer.tsx) | Renders one Element by type/role. |
| [src/components/preview/ManifestViewer.tsx](../src/components/preview/ManifestViewer.tsx) | Collapsible JSON view of the manifest. |
| [src/components/preview/VisualPreviewTabs.tsx](../src/components/preview/VisualPreviewTabs.tsx) | Tabbed UI for the three formats. |
| [src/app/visual-preview/page.tsx](../src/app/visual-preview/page.tsx) | The page itself. |
