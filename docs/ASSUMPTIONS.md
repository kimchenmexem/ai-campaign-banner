# Assumptions

These are explicit assumptions the MVP is built on. Surface and revisit them as the product evolves.

## Scope

- Single-tenant MVP. Multi-brand support is implied via `brandId` but not enforced with row-level security yet.
- One human operator per session; no auth flow in this stage (Settings page is local config only).
- Midjourney is **manual** — the app generates prompt packs and waits for humans to upload finished assets.
- Banner assembly happens exclusively through Bannerbear templates; no programmatic Figma or canvas rendering.

## Schemas

- `BrandKitLite` is a deliberately small surface (colors, fonts, voice, logo). A fuller brand kit can be added later without breaking existing campaigns.
- Hex color regex accepts both `#RGB` and `#RRGGBB`. Other formats (rgba, hsl, named colors) are out of scope.
- `ElementManifest.elements` requires at least one element. Empty manifests are not legal.
- `CampaignStatus` is a closed enum; transitions are validated by application code, not DB triggers (yet).

## External services

- Bannerbear is reached via plain `fetch`, not an SDK. Polling for async renders will be implemented in Stage N.
- Cloudinary credentials are read from env on first use. The client is configured exactly once per process.
- Supabase is reached with the v2 JS client. Service-role usage is gated behind `"server-only"` imports.
- AI provider is selected at runtime from `AI_PROVIDER`. If unset, OpenAI is the default.

## Security

- Service-role Supabase key is server-only and must never reach the browser bundle.
- All API routes validate request bodies with Zod before doing anything.
- No keys are committed; `.env.example` documents every variable.

## Deferred

- Row-level security policies on Supabase tables.
- Rate limiting on API routes.
- Background job runner / queue for long-running renders.
- E2E auth, multi-user permissions.
- Internationalisation.
