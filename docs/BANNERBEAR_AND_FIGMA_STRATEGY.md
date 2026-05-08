# Bannerbear and Figma strategy

This document records the architectural decision that shapes the rest of the codebase. Every contributor must understand and respect it.

## TL;DR

- **Bannerbear is only the renderer.** It produces a flattened PNG/JPG.
- **The Element Manifest is the source of truth.** Every ad has one.
- **Bannerbear modifications are derived from the Element Manifest** — never the other way around.
- **The Bannerbear render response is stored for tracking and debugging only.** It is not used to reconstruct editable elements.
- **Figma is not used in this MVP.** But all schemas and manifests are Figma-ready from day one so the future Figma importer can read the manifest directly.

## Why this matters

A flattened PNG cannot be reversed back into editable layers without loss. If Bannerbear (or any rasterizer) becomes the source of truth, our ads stop being structured data and become images. That kills:

- Compliance review (we lose the per-element `compliance_status`, `risk_warning`, `legal_review_required`).
- Brand enforcement (we lose `brand_token_refs`, `uses_approved_color`, `uses_approved_font`).
- Localization (we cannot swap text without re-rendering from the original layered source).
- Design hand-off (Figma cannot import a PNG into editable nodes).

Keeping the Element Manifest as the source of truth keeps every one of those properties.

## Direction of truth

```
Element Manifest                 ── source of truth ──
       │
       ├──► convertManifestToModifications  ──►  Bannerbear  ──►  PNG/JPG
       │                                                          (rendered output,
       │                                                           tracking only)
       │
       └──► (future) Figma importer  ──►  editable Figma nodes
```

The arrows go **out of** the manifest. Nothing flows back in from Bannerbear's response or from a rasterized image.

## What Bannerbear is allowed to do

- Accept modifications produced by `lib/bannerbear/convertManifestToModifications.ts`.
- Render a flattened image.
- Return a render record (`BannerbearRenderRecord`) with `image_url`, `status`, the exact `modifications_sent`, and the raw `render_response`. We persist this for debugging and replay only.

## What Bannerbear is **not** allowed to do

- Drive the schema. If Bannerbear adds a new field, we decide whether to surface it through the manifest — we do not auto-adopt it.
- Be the editing surface. Operators edit the manifest (eventually via UI; today via tooling). The manifest re-renders. Editing the rendered image directly is forbidden.
- Round-trip. We never read `render_response` to rebuild element state.

## Template snapshots

`BannerbearTemplateSnapshot` (see `lib/schemas/bannerbear.schema.ts`) captures what a template *can* accept (`available_modifications`) so the manifest builder can wire `bannerbear.layer_name` correctly. Snapshots are informational — they constrain the manifest, they do not author it. Re-sync via `POST /api/sync-bannerbear-template` whenever a template changes shape.

## Figma-ready from day one

Even though we are not building Figma integration now, every Element Manifest entry carries an optional `figma` block:

- `node_type` — `FRAME`, `GROUP`, `TEXT`, `RECTANGLE`, `ELLIPSE`, `VECTOR`, `INSTANCE`, `COMPONENT`
- `component_role` — semantic role (matches our `role` field, restated in Figma vocabulary)
- `style_ref` — pointer to a Figma style or our brand token
- `constraints` — Figma layout constraints (`MIN`/`MAX`/`CENTER`/`STRETCH`/`SCALE`)
- `exportable` — whether Figma should mark the node as an export target
- `auto_layout_hint` — `horizontal` / `vertical` / `none`
- `parent_frame_hint` — name of the parent Figma frame

When we later build the Figma importer, it reads the manifest, walks the `elements` array, and creates one Figma node per element using these hints. **No rasterized image is involved.**

## Invariant

> **Every ad must have a complete, validated Element Manifest before it can be rendered, QA'd, or exported.**

If the manifest is missing or invalid, the pipeline halts. This is the load-bearing rule that keeps everything above true.
