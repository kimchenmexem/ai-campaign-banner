# Contextual Mockup Preview

The visual preview now picks a platform screenshot whose **inferred context** matches the ad's intended concept (stocks / ETFs / charts / green-data / general-platform), composites that screenshot inside an appropriate device mockup, and uses the composite as the product visual on the rendered ad.

This is local preview realism only. Nothing in this layer is the source of truth.

## Architecture stays the same

- **Element Manifest is the source of truth.** Every demo manifest still validates against `ElementManifestSchema` and carries the per-element `bannerbear` and `figma` mapping blocks.
- **Bannerbear is only the future production renderer.** It is not called.
- **Cloudinary is not connected.** Composites are written to `public/generated-preview-composites/`.
- **Figma is not connected.** When it is, it reads the same Element Manifest the preview reads — never the rendered PNG/JPG.
- **The flattened image is not the source of truth.** Bannerbear later can either use the same composed visual *or* re-composite from the original mockup + screenshot assets — both options remain open because both inputs are recorded in the demo's `composite_metadata`.

## Pipeline

```
brand-input/                         (brand owner-supplied)
  ├─ brand-spec/brand-spec.json
  ├─ MEXEM logo/  IBKR logo/  background/  Elements/
  ├─ mockup devices/
  │   └─ mockup-manifest.json        ← optional, see "Fine-tuning" below
  └─ Platform screenshot/
      └─ screenshot-tags.json        ← optional, see "Tagging screenshots" below

  │  npm run brand:intake
  ▼
data/brand-kit-lite.generated.json
data/asset-import-plan.generated.json

  │  npm run preview:assets
  ▼
public/brand-input-preview/<canonical>/<sanitized>.<ext>
data/asset-preview-map.generated.json

  │  npm run preview:mockups            ← NEW
  ▼
public/generated-preview-composites/<device>-<context>.png
data/mockup-composite-map.generated.json

  │  npm run preview:demo
  ▼
data/demo-campaign.preview.json
  ├─ ad_specs[].composite_metadata     (intended_device + intended_context + trace)
  └─ ad_specs[].manifest                (Element Manifest — source of truth)

  │  npm run dev (or already running)
  ▼
http://localhost:3000/visual-preview
```

## How context is inferred

`src/lib/preview/inferScreenshotContext.ts` classifies each platform screenshot into one of:

```
stocks · etfs · charts · green_data · general_platform
```

Signals, in priority order:

1. **Tag sidecar file** at `brand-input/Platform screenshot/screenshot-tags.json`:
   ```json
   {
     "AAPL chart.png": ["stocks", "charts"],
     "ETF holdings dashboard.png": ["etfs"],
     "Performance overview.png": ["charts", "green_data"]
   }
   ```
   Matches by *original* filename. First valid tag wins (confidence 1.0).
2. **Filename keyword** (`stock`, `etf`, `chart`, `green`, `growth`, …) — confidence 0.7.
3. **Folder keyword** — confidence 0.5.
4. **Fallback** to `general_platform` — confidence 0.2.

Most production-shot filenames (e.g. `IMG_3260.PNG`, `Screenshot 2025-02-17 112522.png`) carry no signal, so they classify as `general_platform`. **The tag sidecar is the recommended way to make context inference reliable.**

## How mockups get a screen slot

The compositor needs to know where the screen rectangle sits inside each mockup image. Two sources, in priority order:

1. **Manifest entry** in `brand-input/mockup devices/mockup-manifest.json` — pixel-accurate.
2. **Heuristic** per device type — percentage-based, deliberately approximate.

Heuristic defaults (relative to image bounds):

| Device     | x   | y   | width | height | radius |
|------------|-----|-----|-------|--------|--------|
| phone      | 7%  | 4%  | 86%   | 92%    | 7%     |
| tablet     | 9%  | 5%  | 82%   | 90%    | 4%     |
| laptop     | 13% | 6%  | 74%   | 62%    | 1%     |
| desktop    | 8%  | 4%  | 84%   | 70%    | 0.5%   |
| smartwatch | 18% | 18% | 64%   | 64%    | 18%    |

These are wrong for many real-world mockups. Tune via the manifest.

## Fine-tuning mockup screen slots

Edit (or create) `brand-input/mockup devices/mockup-manifest.json`:

```json
[
  {
    "filename": "ipad-3.png",
    "device_type": "tablet",
    "screen_slot": {
      "x": 180,
      "y": 120,
      "width": 820,
      "height": 620,
      "border_radius": 24
    }
  },
  {
    "filename": "iphone-5.png",
    "device_type": "phone",
    "screen_slot": { "x": 56, "y": 92, "width": 480, "height": 1020, "border_radius": 64 }
  }
]
```

The matching is case-insensitive on the *original* filename (the file as it sits in `brand-input/mockup devices/`, not the sanitized public copy). `device_type` ∈ {`phone`, `tablet`, `laptop`, `desktop`, `smartwatch`}. After editing, re-run `npm run preview:mockups`.

## Tagging screenshots

Drop `brand-input/Platform screenshot/screenshot-tags.json`. Format:

```json
{
  "Order dialog (Light).png": ["general_platform"],
  "Screenshot 2025-02-17 112522.png": ["stocks"],
  "IMG_3905.PNG": ["charts", "green_data"]
}
```

After editing, re-run `npm run preview:mockups` and `npm run preview:demo`.

## What a composite is, and what it isn't

- Each composite is **one** PNG written under `public/generated-preview-composites/<device>-<context>.png`.
- The composite is referenced from the Element Manifest via the same `file_url` mechanism every other image element uses — there is **no** new schema field.
- Per-spec traceability lives at the demo level in `DemoAdSpec.composite_metadata`. It records:
  - `intended_device_type`, `intended_context` (the ad's concept)
  - `composite_id`, `composite_public_path` (when generated)
  - `mockup_source_path`, `mockup_filename`
  - `screenshot_source_path`, `screenshot_filename`
  - `screenshot_context_inferred`
  - `fallback_kind`: `composite` | `mockup_only` | `screenshot_only` | `none`
- The Element Manifest's product visual element also embeds the trace in its `notes` field so a manifest read in isolation still carries the lineage.

When Bannerbear renders the same ad later, it can choose to use the composite PNG as a single layer **or** ignore it and recomposite from the original mockup + screenshot assets — the inputs are preserved either way.

## Demo concept assignment

Today's hard-coded mapping:

| Format    | Device  | Context |
|-----------|---------|---------|
| 1200×628  | laptop  | stocks  |
| 1080×1080 | tablet  | etfs    |
| 1080×1920 | phone   | charts  |

Edit `AD_CONCEPT_BY_SIZE` in [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) to change the assignment.

## Commands

```bash
npm run preview:mockups   # composite screenshots into mockups, write data/mockup-composite-map.generated.json
npm run preview:all       # full pipeline: brand:intake → preview:assets → preview:mockups → preview:demo
```

## Files involved

| Path | Role |
|---|---|
| [src/lib/preview/inferScreenshotContext.ts](../src/lib/preview/inferScreenshotContext.ts) | Classifies screenshots into stocks / etfs / charts / green_data / general_platform. Loads optional tag sidecar. |
| [src/lib/preview/mockupManifest.ts](../src/lib/preview/mockupManifest.ts) | Loads `mockup-manifest.json`; falls back to per-device heuristic screen slots. |
| [src/lib/preview/composeMockupPreview.ts](../src/lib/preview/composeMockupPreview.ts) | Sharp-based compositor. Writes the (device × context) matrix and `data/mockup-composite-map.generated.json`. |
| [scripts/preview-mockups.ts](../scripts/preview-mockups.ts) | Orchestrator behind `npm run preview:mockups`. |
| [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) | Picks per-spec composite by (device, context) with documented fallbacks. Adds `composite_metadata`. |
| [src/components/preview/VisualPreviewTabs.tsx](../src/components/preview/VisualPreviewTabs.tsx) | Renders the per-spec "Visual selection" info panel. |
