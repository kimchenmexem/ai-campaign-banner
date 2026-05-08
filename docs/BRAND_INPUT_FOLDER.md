# Brand Input Folder

`brand-input/` is the MVP intake surface. The brand owner drops their materials into the folders below; the intake script reads them, validates the spec, and produces the generated files the rest of the pipeline reads from.

## Actual current folder structure

```
brand-input/
  background/             ← approved or candidate background images
  brand-spec/             ← brand-spec.json + risk-warning.txt (the rules)
  Elements/               ← decorative / supporting visuals (mockups, hero shots, materials)
  IBKR logo/              ← "Powered by IB" / IBKR logo assets
  MEXEM logo/             ← primary brand logo files (color + monochrome variants)
  mockup devices/         ← product/device mockups (iPhone, iPad, MacBook, watch)
  Platform screenshot/    ← screenshots of the product/platform
```

These names are not normalized. Folders contain spaces, mixed case, and inconsistent plural forms. **We do not rename them.** Instead, every name is resolved through an alias table in [`src/lib/brandInput/folderAliases.ts`](../src/lib/brandInput/folderAliases.ts).

## What each folder is for

| Folder                  | Canonical type         | Asset type           | Purpose                                                        |
|-------------------------|------------------------|----------------------|----------------------------------------------------------------|
| `background/`           | `backgrounds`          | `background`         | Background images. Approved or candidate, used behind hero copy. |
| `brand-spec/`           | `brand_spec`           | `brand_spec_file`    | The source-of-truth brand rules: `brand-spec.json` and helper docs like `risk-warning.txt`. |
| `Elements/`             | `elements`             | `decorative_element` | Decorative or supporting visuals. Often raw mockups and material shots. |
| `IBKR logo/`            | `powered_by_ib`        | `powered_by_ib`      | "Powered by Interactive Brokers" / IBKR logo assets. **Never AI-generated.** |
| `MEXEM logo/`           | `brand_logo`           | `brand_logo`         | Primary brand logo variants. **Never AI-generated.**           |
| `mockup devices/`       | `mockups`              | `mockup`             | Product mockups in real device frames.                         |
| `Platform screenshot/`  | `platform_screenshots` | `platform_screenshot`| UI screenshots from the production product.                    |

The alias resolver is tolerant of:

- spaces (`MEXEM logo`)
- mixed case (`Elements`, `IBKR logo`)
- pluralization (`mockup devices` vs `mockups`)
- `_` and `-` interchangeability (`brand_spec` vs `brand-spec`)

You can rename any folder to any reasonable variant of the canonical name and the intake script keeps working — but the names listed above are guaranteed to resolve.

## What the intake produces

Run [`npm run brand:intake`](../package.json) to produce:

- `data/brand-kit-lite.generated.json` — a fully-validated `BrandKitLite` derived from `brand-spec.json` + the inventory.
- `data/asset-import-plan.generated.json` — for each local file, the suggested Cloudinary folder and tag set. **No upload happens.**

The script also prints a summary of file counts per canonical folder so you can sanity-check the inventory at a glance.

## What is and isn't part of the MVP

- **`brand-input/` is local-only.** Production assets will live in Cloudinary (binaries) and Supabase (records), keyed by the same canonical taxonomy.
- **`brand-spec.json` is authored by hand.** It is the source the AI planner trusts for brand colors, fonts, sizes, spacing, disclaimers, and rules.
- **Images are inventoried, not uploaded.** The asset import plan describes *where each file would go* in Cloudinary; running the actual upload is a later step.
- **Figma is not connected yet.** When it is, the importer will read the Element Manifest (which is built from the brand kit + per-ad layout decisions). It will not read flattened PNGs from Bannerbear.
- **Bannerbear remains the renderer only.** See [BANNERBEAR_AND_FIGMA_STRATEGY.md](./BANNERBEAR_AND_FIGMA_STRATEGY.md). The arrows always go *out of* the Element Manifest.

## How to run

```bash
npm run brand:intake
```

Output:

```
Brand intake — reading brand-input/ ...
✓ Loaded brand spec for Company Brand (brand_001)
✓ Scanned brand-input/: N files indexed
✓ Wrote data/brand-kit-lite.generated.json
✓ Wrote data/asset-import-plan.generated.json (X items, Y skipped)

Summary
────────────────────────────────────────────────
  brand-spec.json found:        yes
  Brand Kit Lite generation:    passed
  MEXEM logo files:             …
  IBKR logo files:              …
  background files:             …
  Platform screenshot files:    …
  mockup device files:          …
  Elements files:               …
  brand-spec files:             …
```

## What runs where

| Concern                              | Code                                                                  |
|--------------------------------------|-----------------------------------------------------------------------|
| Validate `brand-spec.json`           | [`src/lib/schemas/brandInput.schema.ts`](../src/lib/schemas/brandInput.schema.ts) |
| Resolve folder names                 | [`src/lib/brandInput/folderAliases.ts`](../src/lib/brandInput/folderAliases.ts)   |
| Scan folders + build inventory       | [`src/lib/brandInput/loadBrandInput.ts`](../src/lib/brandInput/loadBrandInput.ts) |
| Convert spec + inventory → BrandKit  | [`src/lib/brandInput/convertBrandInputToBrandKit.ts`](../src/lib/brandInput/convertBrandInputToBrandKit.ts) |
| Build asset import plan              | [`src/lib/brandInput/createAssetImportPlan.ts`](../src/lib/brandInput/createAssetImportPlan.ts) |
| Orchestrator                         | [`scripts/brand-intake.ts`](../scripts/brand-intake.ts)               |
