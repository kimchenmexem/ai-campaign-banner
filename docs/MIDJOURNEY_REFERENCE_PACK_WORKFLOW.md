# Midjourney Reference Pack Workflow

Make Midjourney use the project's existing brand assets as **reference inputs** for the manual workflow. Midjourney does not read the repo directly — the system classifies every brand asset for safety, picks the relevant ones per prompt, and copies them into a public folder you can drag into Midjourney.

## Hard rules

- **Midjourney does not read the repository.** No automation, no unofficial API. Period.
- **Element Manifest stays the source of truth.** Reference packs feed Midjourney; the manifest still owns final layout + provenance.
- **Some asset types must NEVER be used as Midjourney input** — see the classifier below.
- **References are style references.** Drop them as `--sref` (or drag them into the prompt as a style reference) — never as image prompts that should be copied.

## What's safe vs. unsafe as a Midjourney input

The classifier in [src/lib/midjourney/selectReferenceAssets.ts](../src/lib/midjourney/selectReferenceAssets.ts) walks the asset preview map (and optional `brand-input/examples/`) and labels every asset:

| Folder type             | Role                       | Why                                                                                                |
|-------------------------|----------------------------|----------------------------------------------------------------------------------------------------|
| `brand_logo`            | **avoid_for_midjourney**   | Midjourney would produce a counterfeit logo. The real logo is composited as a separate layer.      |
| `powered_by_ib`         | **avoid_for_midjourney**   | IBKR / Powered-by-IB logo must never be MJ-generated (trademark + provenance).                     |
| `platform_screenshots`  | **avoid_for_midjourney**   | Real platform UI; using as reference would produce fake-text fake-UI imagery.                      |
| `mockups`               | **avoid_for_midjourney**   | Device frames + UI inside. Midjourney would produce realistic-but-fake devices.                    |
| `backgrounds`           | **style_reference**        | Brand-approved abstract atmosphere. Safe — MJ can match colors/atmosphere without copying text.    |
| `elements` (clean)      | **style_reference**        | Decorative element. Safe as moodboard / style ref.                                                 |
| `elements` (device-like)| **avoid_for_midjourney**   | Filename suggests a mockup; same warning the asset import plan emits — move it to `mockup devices/`. |
| `examples/` (optional)  | **style_reference**        | Brand-approved visual benchmarks. Safe as style refs.                                              |
| anything else           | **avoid_for_midjourney**   | Default-deny.                                                                                      |

Device-keyword filter on `elements/`: `iphone`, `ipad`, `macbook`, `laptop`, `desktop`, `phone`, `tablet`, `smartwatch`, `watch`, `mockup` — same list the screenshot-tagger / asset import plan uses.

## What lives where

```
data/midjourney-prompt-pack.generated.json
  └─ prompts[].recommended_references[]   ← inline per-prompt, drives the UI
  └─ prompts[].forbidden_outputs[]        ← restated per prompt for the UI banner

data/midjourney-reference-pack.generated.json
  ├─ classifications.style_reference[]    ← every safe asset, with `reason`
  ├─ classifications.avoid_for_midjourney[]
  └─ prompts[]
       ├─ selected_reference_assets[]     ← picked per prompt
       ├─ style_reference_assets[]        ← full safe pool
       ├─ avoid_assets[]                  ← full deny pool
       ├─ usage_notes
       └─ manual_steps[]

public/midjourney-reference-pack/<prompt_id>/
  └─ <copies of the selected reference files>   ← drag these into Midjourney
```

## Selection policy per prompt

| Intended use | Folder priority                          | Max refs |
|--------------|------------------------------------------|----------|
| `background` | backgrounds → elements → examples        | 4        |
| `hero_visual`| backgrounds → examples                   | 2        |
| `decorative` | elements → examples                      | 4        |
| `moodboard`  | backgrounds → elements → examples        | 4        |
| `texture`    | elements → backgrounds → examples        | 3        |

Hero prompts deliberately **don't** include screenshots/mockups even at low priority — those would push Midjourney toward fake UI.

## Generate the packs

```bash
# Generate prompts (fast, no network):
npm run midjourney:prompts

# Generate the reference pack + copy reference files to public/:
npm run midjourney:reference-pack
```

The reference-pack script:
1. Generates the prompt pack if missing.
2. Runs the classifier.
3. Picks per-prompt references using the policy above.
4. Copies each selected reference into `public/midjourney-reference-pack/<prompt_id>/<sanitized-filename>`.
5. Re-stamps `data/midjourney-prompt-pack.generated.json` so each prompt's `recommended_references` and `forbidden_outputs` are inline (the `/midjourney` UI reads them from there).

## Use the references manually

1. Open <http://localhost:3000/midjourney>.
2. Each prompt card now shows:
   - The prompt text (with copy button).
   - A **"Do not generate"** amber box restating the per-prompt forbidden list.
   - A **"Recommended references"** grid: thumbnails + asset type + role + why it was picked.
3. To run a prompt:
   - Click **Copy prompt**.
   - In Midjourney, drag the corresponding files from `public/midjourney-reference-pack/<prompt_id>/` into the prompt as **style references** (drag-and-drop, or use `--sref` after re-uploading).
   - Run.
   - Pick a result, download as PNG/JPG/WEBP.
4. Back on `/midjourney`, scroll to the upload form, choose the file + the matching prompt, click **Approve immediately**, **Upload**.
5. Run `npm run preview:demo` to use the upload in the demo manifest.

## Verifying the pack

```bash
# Counts:
jq '{
  style_count: (.classifications.style_reference | length),
  avoid_count: (.classifications.avoid_for_midjourney | length),
  per_prompt: [.prompts[] | {prompt_id, picked: (.selected_reference_assets | length)}]
}' data/midjourney-reference-pack.generated.json

# Confirm hero prompts pick at most 2 refs and never include screenshots/mockups:
jq '.prompts[] | select(.intended_use == "hero_visual") | .selected_reference_assets[].canonical_folder_type' \
  data/midjourney-reference-pack.generated.json
# → "backgrounds" only (or "examples")
```

## Why this matters

Midjourney is good at matching **atmosphere**: color, depth, composition, mood. It's bad at copying **specific content** like UI text, brand logos, or readable charts. Feeding it the right reference type gets the atmosphere we want; feeding it the wrong type produces fake-text, fake-logo, fake-UI imagery that we'd have to throw away.

The classifier encodes that intuition once. The per-prompt picker keeps the right material in front of the right prompt. The export script puts the files within drag-and-drop reach.

## Files

| Path | Role |
|---|---|
| [src/lib/midjourney/selectReferenceAssets.ts](../src/lib/midjourney/selectReferenceAssets.ts) | Classifier. |
| [src/lib/midjourney/createReferencePack.ts](../src/lib/midjourney/createReferencePack.ts) | Per-prompt picker + reference pack writer + the canonical `FORBIDDEN_OUTPUTS_LIST`. |
| [src/lib/midjourney/createPromptPack.ts](../src/lib/midjourney/createPromptPack.ts) | Prompt pack generator; calls the reference pass to embed inline recommendations. |
| [scripts/midjourney-export-reference-pack.ts](../scripts/midjourney-export-reference-pack.ts) | `npm run midjourney:reference-pack` |
| [src/components/midjourney/PromptCard.tsx](../src/components/midjourney/PromptCard.tsx) | Renders the per-prompt forbidden box + reference thumbnails. |
| [src/lib/schemas/midjourney.schema.ts](../src/lib/schemas/midjourney.schema.ts) | `MidjourneyPromptReference`, `MidjourneyReferencePack`, `MidjourneyReferenceClassified`. |
