# Cloudinary Upload Workflow

Cloudinary is the storage tier for brand assets and locally-generated mockup composites. It is **not** the source of truth — the Element Manifest is. Cloudinary holds the bytes; the manifest holds the structure.

## Hard rules

- **Element Manifest is the source of truth.** Every image element keeps both `cloudinary_public_id` (when uploaded) and `local_public_path` (always), plus `delivery_source: "cloudinary" | "local_preview"` so a renderer can choose either.
- **Bannerbear remains disconnected.** This stage prepares the URLs Bannerbear will later consume — nothing here calls Bannerbear.
- **Figma remains disconnected.**
- **No secrets in logs.** Error messages are scrubbed for `api_key=`, `api_secret=`, `signature=` query params before printing. The diagnostics command prints presence-only flags.

## Configure `.env.local`

Add (or fill in) these three values:

```bash
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-key
CLOUDINARY_API_SECRET=your-secret
```

Find them in the Cloudinary console → **Programmable Media → Dashboard → Account Details**. The `cloud_name` is public-safe; the API key + secret are not — keep them in `.env.local` (gitignored).

## Verify connectivity

```bash
npm run cloudinary:check
```

Output (success path):

```
Cloudinary diagnostics — no uploads will be performed.

✓ Loaded .env.local
  Cloud name present:   yes (your-cloud-name)
  API key present:      yes
  API secret present:   yes

✓ Cloudinary connection: ok
```

This pings the API; it does **not** upload anything. Failure exits non-zero with a redacted error.

## Run the uploads

```bash
npm run cloudinary:upload-assets       # uploads brand-input/* to brands/{brand_id}/{logos,powered-by-ib,backgrounds,screenshots,mockups,elements}/
npm run cloudinary:upload-composites   # uploads public/generated-preview-composites/ to brands/{brand_id}/generated-composites/
npm run cloudinary:upload-all          # both, in order
```

Both scripts:

- **Read** their input map (asset import plan or mockup composite map) from `data/`.
- **Skip** files already uploaded successfully (matched by local path / composite_id).
- **Pass `--force`** to re-upload everything: `npm run cloudinary:upload-assets -- --force`.
- **Set `overwrite: false`** by default at the Cloudinary API; only `--force` flips it to `overwrite: true`.
- **Use deterministic public_ids** so a second run (or another developer) generates the same Cloudinary paths.
- **Are concurrent** with a 4-way semaphore — handles 60+ files in well under a minute.

## What gets uploaded

| Source                                 | Cloudinary destination                                                | Notes                                       |
|----------------------------------------|-----------------------------------------------------------------------|---------------------------------------------|
| `brand-input/MEXEM logo/*.png`         | `brands/{brand_id}/logos/{filename}`                                  | Image only; non-images skipped.             |
| `brand-input/IBKR logo/*.png`          | `brands/{brand_id}/powered-by-ib/{filename}`                          |                                             |
| `brand-input/background/*.png`         | `brands/{brand_id}/backgrounds/{filename}`                            |                                             |
| `brand-input/Platform screenshot/*`    | `brands/{brand_id}/screenshots/{filename}`                            | png, jpg, jpeg, webp, svg only.             |
| `brand-input/mockup devices/*`         | `brands/{brand_id}/mockups/{filename}`                                |                                             |
| `brand-input/Elements/*`               | `brands/{brand_id}/elements/{filename}`                               |                                             |
| `public/generated-preview-composites/` | `brands/{brand_id}/generated-composites/{composite_id}`               | Uploaded by `cloudinary:upload-composites`. |

Every upload is tagged with: `brand:{brand_id}`, `asset_type:*`, `source:*`, `local_intake`, `preview_ready`, plus the asset import plan's `suggested_tags`.

## Generated files

| Path | Purpose |
|---|---|
| `data/cloudinary-asset-map.generated.json` | One record per import-plan item with `cloudinary_public_id`, `cloudinary_secure_url`, dimensions, format, bytes, `upload_status` (`success` / `skipped` / `failed` / `unsupported`), and a redacted error message on failure. |
| `data/cloudinary-composite-map.generated.json` | One record per composite with the Cloudinary URL plus full traceability (`mockup_source_path`, `screenshot_source_path`, `screenshot_context`, `screenshot_context_confidence`, `slot_source`). |

## How `/visual-preview` switches to Cloudinary

`createDemoCampaign` reads both maps when present and joins them to the local preview map:

- **Asset map → local public_path.** The `AssetPreviewMap.public_path` is the bridge between `data/cloudinary-asset-map.generated.json` and the demo's image elements.
- **Composite map → composite path.** Composites are looked up by their `original_public_path`.

When a Cloudinary URL is found, the demo emits:

```json
{
  "id": "el_visual",
  "role": "product_visual",
  "source": "local_mockup_composite",
  "file_url": "https://res.cloudinary.com/your-cloud/.../laptop-stocks.png",
  "local_public_path": "/generated-preview-composites/laptop-stocks.png",
  "cloudinary_public_id": "brands/brand_001/generated-composites/laptop-stocks",
  "delivery_source": "cloudinary",
  "composite_refs": { … }
}
```

Without Cloudinary, the same element falls back to:

```json
{
  "file_url": "file://localhost/generated-preview-composites/laptop-stocks.png",
  "local_public_path": "/generated-preview-composites/laptop-stocks.png",
  "delivery_source": "local_preview"
}
```

The preview canvas treats both paths the same way — strip `file://localhost`, otherwise use the URL as-is. Cloudinary URLs render directly because `<img>` accepts arbitrary `https://` sources.

## Re-upload semantics

- **No-force re-run:** `npm run cloudinary:upload-assets` skips any file with `upload_status === "success"` in the existing map. The output map is rebuilt with `upload_status: "skipped"` for those rows so you can see the no-op.
- **Force re-upload:** `npm run cloudinary:upload-assets -- --force` re-uploads every file with `overwrite: true` and `invalidate: true` (CDN cache busting).
- **Recovering after a public_id change:** delete `data/cloudinary-asset-map.generated.json` and re-run. The script will create new uploads at the new public_ids; old ones become orphans in your Cloudinary library (clean up via the dashboard).

## Files

| Path | Role |
|---|---|
| [src/lib/cloudinary/client.ts](../src/lib/cloudinary/client.ts) | Lazy SDK config; `cloudinaryEnvStatus()` for diagnostics. |
| [src/lib/cloudinary/upload.ts](../src/lib/cloudinary/upload.ts) | `uploadLocalFileToCloudinary`, `uploadAssetImportPlan`, `uploadMockupComposites`, `createCloudinaryPublicId`, `inferCloudinaryResourceType`, plus the two output schemas. |
| [scripts/check-cloudinary.ts](../scripts/check-cloudinary.ts) | `npm run cloudinary:check` |
| [scripts/upload-cloudinary-assets.ts](../scripts/upload-cloudinary-assets.ts) | `npm run cloudinary:upload-assets` |
| [scripts/upload-cloudinary-composites.ts](../scripts/upload-cloudinary-composites.ts) | `npm run cloudinary:upload-composites` |
| [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) | Reads the two cloudinary maps, swaps `file_url` from `file://localhost/...` to `https://res.cloudinary.com/...` per element. |
