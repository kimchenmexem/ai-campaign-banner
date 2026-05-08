# Midjourney Manual Workflow

Midjourney is a **manual, human-in-the-loop** asset workflow. The system never calls Midjourney. It generates prompt packs, the human runs them in Midjourney, then uploads selected outputs back into the app where they become regular image assets that the demo and renderers can consume.

## Hard rules

- **No automation.** The system never sends a request to Midjourney.
- **No unofficial APIs.** Don't try to scrape, screen-grab, or wire any third-party Midjourney bridge. Use the official Midjourney UI.
- **Element Manifest stays the source of truth.** Approved uploads become regular image elements with `source: "midjourney_manual_upload"` plus a `midjourney` provenance block (prompt_id, upload_id, intended_use, context, approved). Nothing on the rendered PNG side rewrites the manifest.
- **Figma is not connected.** Midjourney provenance is preserved on each element so a future Figma importer can attribute the image without reading pixels.

### What Midjourney is allowed to generate

- Backgrounds (full-canvas brand-color gradients, abstract data motifs)
- Hero visuals (only when no contextual mockup composite exists)
- Decorative accents (corner motifs, low opacity)
- Moodboard / texture references (for human review, not for direct use)

### What Midjourney is forbidden to generate

- Brand logo (MEXEM)
- IBKR / Powered by IB logo
- CTA copy ("Start now" etc.)
- Disclaimer / risk-warning text
- Any required marketing copy
- Readable UI text or fake app screenshots

Every generated prompt embeds these forbidden items in its negative-instruction line and again in the closing modifiers.

## Pipeline

```
data/brand-kit-lite.generated.json
data/demo-campaign.preview.json (optional, used to align hero contexts)
        │
        │  npm run midjourney:prompts   (or POST /api/midjourney/prompts)
        ▼
data/midjourney-prompt-pack.generated.json
        │
        │  the human:
        │  1. opens /midjourney
        │  2. copies a prompt
        │  3. runs it in Midjourney
        │  4. downloads the chosen output
        │  5. uploads it through the form on /midjourney
        ▼
public/midjourney-uploads/<prompt_id>/<upload_id>-<filename>
data/midjourney-uploads.generated.json
        │
        │  approve in /midjourney
        │  then `npm run preview:demo`
        ▼
data/demo-campaign.preview.json
  └─ ad_specs[].manifest.elements[].source = "midjourney_manual_upload"
  └─ ad_specs[].manifest.elements[].midjourney = { prompt_id, upload_id, ... }
```

## Generate the prompt pack

```bash
npm run midjourney:prompts
```

Writes `data/midjourney-prompt-pack.generated.json` and prints every prompt to stdout in a copy-friendly form. Default pack ships 7 prompts:

1. Premium fintech background — 16:9
2. Premium fintech background — 1:1
3. Premium fintech background — 9:16
4. Hero visual — context-matched — 16:9 (uses the demo's 1200×628 ad concept when available)
5. Hero visual — context-matched — 1:1 (uses the demo's 1080×1080 ad concept)
6. Decorative abstract — 1:1
7. Brand moodboard — 16:9

Every prompt includes:
- The brand color palette (from the brand kit)
- "Leave clean negative space for marketing copy"
- The full forbidden list (no text, no logo, no watermark, no UI text, no fake screenshots, no brand logos, no IBKR logos, no people)
- An aspect-ratio param (`--ar 16:9`, `--ar 1:1`, `--ar 9:16`)
- `--style raw` for editorial fidelity
- Optional placeholders `[OPTIONAL_STYLE_REFERENCE_URL]` / `[OPTIONAL_IMAGE_REFERENCE_URL]` you can replace with a real Midjourney reference URL before pasting

## Run prompts manually

1. Open <http://localhost:3000/midjourney>.
2. Find the prompt you want; click **Copy prompt**.
3. Paste into Midjourney (Discord or web UI) and run it.
4. Pick the result you like, download as PNG / JPG / WEBP.
5. Back on `/midjourney`, scroll to the upload form:
   - **Prompt** — pick the prompt you ran. The intended_use, context, and aspect_ratio prefill from it.
   - **File** — choose your downloaded image.
   - **Approve immediately** — check this if the image is ready to use in the demo. (You can always approve later by toggling the checkbox on an existing upload card.)
6. Click **Upload**. The file lands in `public/midjourney-uploads/<prompt_id>/`, and a record is appended to `data/midjourney-uploads.generated.json`.
7. Run `npm run preview:demo`. Approved uploads now appear on the manifest:
   - The first approved **background** upload replaces the brand-input background and stamps the background element with `source: "midjourney_manual_upload"`.
   - Up to two approved **decorative** uploads emit corner-accent elements (low opacity, between background and hero in z-order).
   - An approved **hero_visual** upload is used only when no contextual mockup composite exists.

## API surface

```
GET  /api/midjourney/prompts
POST /api/midjourney/prompts          → regenerate the pack
GET  /api/midjourney/uploads
POST /api/midjourney/uploads          (multipart)  → save file + metadata
POST /api/midjourney/uploads          (application/json: { upload_id, approved?, notes? }) → patch
DELETE /api/midjourney/uploads?upload_id=...        → remove file + record
```

These are local-development tools. Don't expose them in production.

## Assigning uploads to specific slots

By default an approved upload is treated as a "first-by-intended-use" fallback: the demo picks the first approved background, the first two approved decoratives, and (if no composite exists) the first approved hero visual. **Assignments** override that default by binding a specific upload to a specific (format, slot) target.

A slot is `(format, target_element_role)`:

- `format`: `"1200x628" | "1080x1080" | "1080x1920" | null` (null = applies to all formats)
- `target_element_role`: `"background" | "hero_visual" | "decorative_1" | "decorative_2"`

How to assign:

1. Approve the upload (toggle the **Approved** checkbox on the upload card on `/midjourney`).
2. In the same card's **Assignments** section, pick a slot from the dropdown (e.g. *"Background — 1080×1080"* or *"Decorative_1 — all formats"*).
3. Click **Assign**. A new active assignment is created. Any other active assignment for the same `(format, target)` slot is auto-deactivated so the latest assignment wins.
4. Run `npm run preview:demo` to apply.

Resolution rules (per ad spec):

1. **Format-specific assignment** (`format == specFormat`) wins over a global assignment (`format === null`).
2. Within the same precedence tier, higher `priority` wins; ties broken by most-recent `created_at`.
3. If no assignment exists, fall back to the global "first-by-intended-use" default.

API:

```
POST /api/midjourney/assignments  { upload_id, format, target_element_role, active?, priority? }
POST /api/midjourney/assignments  { assignment_id, active?, priority? }   # patch existing
DELETE /api/midjourney/assignments?assignment_id=...
```

Diagnostic:

```bash
npm run midjourney:list-uploads
```

Prints total uploads, approved count, assigned count, per-intended_use + per-context tallies, and active assignments grouped by slot.

## Provenance on the Element Manifest

Every Midjourney-source element on the demo manifest now carries a structured provenance block in its `midjourney` sub-object:

```jsonc
{
  "id": "el_background",
  "source": "midjourney_manual_upload",
  "midjourney": {
    "prompt_id": "bg-premium-1x1",
    "upload_id": "mj_xxxxxxxxxxxx",
    "intended_use": "background",
    "context": "premium_fintech",
    "approved": true,
    "assignment_id": "mja_yyyyyyyyyyyy",     // present when an assignment drove the slot
    "target_element_role": "background",      // ditto
    "provenance": {
      "generated_by": "midjourney",
      "uploaded_by_user": true,
      "manual_workflow": true
    }
  }
}
```

The `provenance` block is stamped on every Midjourney element regardless of whether an explicit assignment was used — it makes the manual-workflow status undeniable in any audit log, ZIP exporter, or future Figma importer.

## How approved uploads land in the manifest

Per ad spec, `pickAssets` runs first:

```ts
const mjBackgrounds = approved.filter(u => u.intended_use === "background");
const mjBackground = mjBackgrounds[0] ?? null;            // first wins
const mjDecoratives = approved.filter(u => u.intended_use === "decorative").slice(0, 2);
const mjHero = approved.find(u => u.intended_use === "hero_visual") ?? null;
```

Then `buildElements` emits:

- `el_background` with `source: "midjourney_manual_upload"` + a `midjourney` block when `mjBackground` exists.
- `el_mj_decorative_1` / `el_mj_decorative_2` for decoratives, at corners, opacity 0.4, z-index 5.
- The mockup composite stays the primary product visual — Midjourney hero only kicks in when no composite is available.

The Cloudinary URL on each upload (when present) becomes `file_url`, the local public path goes into `local_public_path`, and `delivery_source` reflects which is being served.

## Verify the manifest

```bash
jq '[.ad_specs[] | .manifest.elements[] | select(.source == "midjourney_manual_upload")
     | {role, source, midjourney, file_url}]' \
  data/demo-campaign.preview.json
```

Each entry shows the role (`background` / `decorative`), the `midjourney` block with prompt_id + upload_id, and the resolved file_url.

## Files involved

| Path | Role |
|---|---|
| [src/lib/schemas/midjourney.schema.ts](../src/lib/schemas/midjourney.schema.ts) | Prompt + Pack + Upload Zod schemas. |
| [src/lib/midjourney/createPromptPack.ts](../src/lib/midjourney/createPromptPack.ts) | Prompt pack generator (reads brand kit + demo, emits 7+ prompts). |
| [src/lib/midjourney/loadUploads.ts](../src/lib/midjourney/loadUploads.ts) | Read/write helpers for the uploads index + an `filterApproved()` convenience. |
| [scripts/midjourney-generate-prompts.ts](../scripts/midjourney-generate-prompts.ts) | `npm run midjourney:prompts` |
| [src/app/midjourney/page.tsx](../src/app/midjourney/page.tsx) | `/midjourney` UI (prompt cards + upload form + upload list). |
| [src/components/midjourney/PromptCard.tsx](../src/components/midjourney/PromptCard.tsx) | Prompt display + copy button. |
| [src/components/midjourney/UploadManager.tsx](../src/components/midjourney/UploadManager.tsx) | File upload form + approval toggle + delete. |
| [src/app/api/midjourney/prompts/route.ts](../src/app/api/midjourney/prompts/route.ts) | GET/POST prompts. |
| [src/app/api/midjourney/uploads/route.ts](../src/app/api/midjourney/uploads/route.ts) | GET/POST/DELETE uploads (multipart + JSON patch). |
| [src/lib/preview/createDemoCampaign.ts](../src/lib/preview/createDemoCampaign.ts) | Reads approved uploads, threads them through `pickAssets` + `buildElements`. |
