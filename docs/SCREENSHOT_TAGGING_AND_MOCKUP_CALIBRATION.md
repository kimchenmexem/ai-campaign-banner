# Screenshot Tagging & Mockup Calibration

Two browser-based local-development tools that turn opaque filenames into accurate contextual mockup composites:

- **`/screenshot-tagger`** — assign each platform screenshot a context (stocks / etfs / charts / green_data / general_platform).
- **`/mockup-calibrator`** — define the precise screen rectangle inside each device mockup, drawing a draggable overlay on the actual image.

Both write small JSON sidecar files in `brand-input/` that the existing preview pipeline already consumes.

## Architecture stays the same

- **Element Manifest is the source of truth.** Schema unchanged.
- **Local preview only.** Cloudinary, Bannerbear, and Figma are still not wired.
- **No final flattened image is the source of truth.** Bannerbear can later re-composite from the mockup + screenshot inputs that this layer records.

## Why this matters

Filenames in `brand-input/Platform screenshot/` look like `IMG_3260.PNG` or `Screenshot 2025-02-17 112522.png`. The keyword inferer can't do anything with those, so they all classify as `general_platform`, and every contextual ad falls back to a single generic composite. Tagging fixes that. Calibration fixes the parallel problem on the mockup side: heuristic screen rectangles are wrong for most real device mockups.

## Confidence labels

The screenshot context inferer now returns a categorical confidence:

| Label              | Meaning                                                                  |
|--------------------|--------------------------------------------------------------------------|
| `explicit_tag`     | A manual tag in `screenshot-tags.json` matched the file. Trustable.      |
| `filename_match`   | A keyword in the filename matched (e.g. `aapl-stocks.png` → stocks).     |
| `folder_match`     | A keyword in the folder name matched. Less specific than filename.       |
| `fallback_general` | No signal — defaulted to `general_platform`. Tag the file to fix.        |

The Visual Preview info panel and the Screenshot Tagger UI both surface this label so reviewers can spot which screenshots still need explicit tags.

## Slot source labels

The mockup compositor now records where the screen rectangle came from:

| Label               | Meaning                                                       |
|---------------------|---------------------------------------------------------------|
| `explicit_manifest` | An entry in `mockup-manifest.json` matched the mockup file.    |
| `heuristic`         | The percentage-based fallback was used. Calibrate the mockup.  |

Every heuristic-driven composite now emits a warning telling you where to fix it.

## How to tag screenshots

1. Run the preview pipeline once so the inventory exists:
   ```bash
   npm run brand:intake
   npm run preview:assets
   ```
2. Open `/screenshot-tagger` in the browser.
3. For each screenshot:
   - Pick a context from the dropdown (or leave blank to keep using inference).
   - Add an optional note (e.g. "Stocks watchlist screen").
4. Click **Save all tags**. The page writes `brand-input/Platform screenshot/screenshot-tags.json`:
   ```json
   [
     {
       "filename": "Screenshot 2025-02-17 112522.png",
       "context": "stocks",
       "notes": "Stocks watchlist screen"
     }
   ]
   ```
5. Re-run the contextual half of the pipeline:
   ```bash
   npm run preview:mockups
   npm run preview:demo
   ```
6. Refresh `/visual-preview` — composites now use the tagged screenshots, and the info panel shows `confidence: explicit_tag`.

The tag file is matched **case-insensitively** against `original_filename` (the file as it appears in `brand-input/Platform screenshot/`, not the sanitized public copy).

## How to calibrate a mockup

1. Same prerequisite — `npm run preview:assets` must have run.
2. Open `/mockup-calibrator`.
3. The first mockup loads with a blue rectangle representing the current screen slot. The rectangle is seeded from `mockup-manifest.json` if present, otherwise from the per-device-type heuristic.
4. Adjust:
   - **Drag the rectangle** to move it.
   - **Use the x / y / width / height / border_radius fields** for precise pixel values (input units are mockup-image native pixels, not display pixels).
   - **Set `device_type`** if the inferred type is wrong.
5. Use the **Prev / Next** buttons to walk through mockups; edits persist client-side.
6. Click **Save all** — the page writes `brand-input/mockup devices/mockup-manifest.json`:
   ```json
   [
     {
       "filename": "ipad-3.png",
       "device_type": "tablet",
       "screen_slot": {
         "x": 180, "y": 120, "width": 820, "height": 620, "border_radius": 24
       }
     }
   ]
   ```
7. Recomposite:
   ```bash
   npm run preview:mockups
   npm run preview:demo
   ```
8. Refresh `/visual-preview` — composites now use the explicit slot, and the info panel shows `slot source: explicit_manifest`.

## What "fallback_used" means in the visual-preview info panel

`fallback_used: true` ⇄ `selected_context !== desired_context`. It happens when the desired (device, context) composite isn't available and the demo had to use a different context (typically `general_platform`). Tag screenshots to drive this to `false`.

## Auto-seed for instant results

Walking the tagger and the calibrator end-to-end takes time. Two seed scripts get the pipeline producing realistic composites with one command, while still letting humans refine afterwards:

```bash
npm run preview:seed-screenshot-tags    # writes screenshot-tags.json (skips if non-empty)
npm run preview:seed-mockup-manifest    # writes mockup-manifest.json (skips if non-empty)
```

Both scripts:

- **Refuse to overwrite an existing file** unless invoked with `-- --force`.
- **Stamp every entry with a "auto-seeded; requires human review" note** so a reviewer can find them in the UIs.

Logic:

- Screenshot seed: assigns the 1st screenshot to `stocks`, 2nd to `etfs`, 3rd to `charts`, 4th to `green_data`, the rest to `general_platform`. Sorted alphabetically for determinism.
- Mockup manifest seed: infers device type from filename (iphone/ipad/macbook/iwatch), reads each mockup's native dimensions via Sharp, and generates a percentage-based screen slot per device. Mockups whose device type infers to `unknown` are skipped — calibrate them in `/mockup-calibrator`.

`npm run preview:all` already runs both seed steps before `preview:mockups`, so a fresh checkout produces contextual composites on the very first run.

## Pipeline order — no breaking changes

```bash
# Existing scripts keep working; new seed scripts are additive:
npm run brand:intake
npm run preview:assets
npm run preview:seed-screenshot-tags    # NEW (no-op if file exists)
npm run preview:seed-mockup-manifest    # NEW (no-op if file exists)
npm run preview:mockups
npm run preview:demo
npm run preview:all                      # all six in order
```

Run `preview:all` after **either** tagging screenshots **or** calibrating mockups for the changes to land in `data/demo-campaign.preview.json` and the visual preview.

## Manifest-level traceability

Every product visual element on the demo manifest now carries a structured `composite_refs` block (in addition to the spec-level `composite_metadata`):

```jsonc
{
  "id": "el_visual",
  "role": "product_visual",
  "source": "local_mockup_composite",
  "file_url": "file://localhost/generated-preview-composites/laptop-stocks.png",
  "composite_refs": {
    "composite_public_path": "/generated-preview-composites/laptop-stocks.png",
    "composite_id": "laptop-stocks",
    "original_mockup_asset_path": "brand-input/mockup devices/mockup-macbook.png",
    "original_mockup_filename": "mockup-macbook.png",
    "original_screenshot_asset_path": "brand-input/Platform screenshot/apple_stock_mobileApp.png",
    "original_screenshot_filename": "apple_stock_mobileApp.png",
    "screenshot_context": "stocks",
    "screenshot_context_confidence": "explicit_tag",
    "mockup_slot_source": "explicit_manifest"
  }
}
```

Bannerbear (later) can ignore the flat composite and re-render from `original_mockup_*` + `original_screenshot_*`. Figma (later) can resolve the same refs to its own assets. The Element Manifest is portable on its own — you can hand it to either renderer without the spec wrapper.

## Cascading fallback

The 1080×1920 ad now has a documented fallback chain in `AD_CONCEPT_BY_SIZE` (in [createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts)): `charts → green_data → device general_platform → any-device same-context → raw mockup → raw screenshot → none`. Edit that constant to change which contexts a format prefers.

## Files involved

| Path | Role |
|---|---|
| [src/lib/preview/inferScreenshotContext.ts](../src/lib/preview/inferScreenshotContext.ts) | Inferer with categorical confidence + tag sidecar loader/writer. |
| [src/lib/preview/mockupManifest.ts](../src/lib/preview/mockupManifest.ts) | Manifest loader/writer + `slot_source` resolution. |
| [src/lib/preview/composeMockupPreview.ts](../src/lib/preview/composeMockupPreview.ts) | Records `slot_source` + `screenshot_context_confidence` per composite; warns on heuristic slots. |
| [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) | Per-spec `desired_context` / `selected_context` / `fallback_used` / etc. |
| [src/app/api/screenshot-tags/route.ts](../src/app/api/screenshot-tags/route.ts) | GET + POST tag sidecar. |
| [src/app/api/mockup-manifest/route.ts](../src/app/api/mockup-manifest/route.ts) | GET + POST mockup manifest. |
| [src/app/screenshot-tagger/page.tsx](../src/app/screenshot-tagger/page.tsx) | Tagger UI shell. |
| [src/components/preview/ScreenshotTagEditor.tsx](../src/components/preview/ScreenshotTagEditor.tsx) | Tagger client editor. |
| [src/app/mockup-calibrator/page.tsx](../src/app/mockup-calibrator/page.tsx) | Calibrator UI shell. |
| [src/components/preview/MockupCalibrator.tsx](../src/components/preview/MockupCalibrator.tsx) | Calibrator client editor with drag + manual inputs. |
