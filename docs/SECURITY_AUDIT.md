# API route security audit

Snapshot of every API route under `src/app/api/**/route.ts` with current state
and the role/protection that the hardening pass enforces.

Legend
- **mutates**: writes filesystem / DB / external API state
- **expensive**: AI calls, Playwright render, ZIP creation, or anything > ~1s
- **dev-only**: writes into the repo tree (`data/`, `public/brand-input-preview/…`,
  `public/midjourney-uploads/…`) — must be disabled in production
- **role**: minimum role required after hardening (`admin` > `editor` > `viewer`)

| Route | Method | mutates | expensive | dev-only | role |
| --- | --- | --- | --- | --- | --- |
| `/api/asset` | DELETE | yes | no | yes (writes `data/` + repo `public/`) | editor |
| `/api/brand-kit` | GET | no | no | reads from `data/` | viewer |
| `/api/brand-kit` | PATCH | yes | no | yes (writes `data/`) | editor |
| `/api/export-ad-elements` | GET | no | no | reads campaign plan | viewer |
| `/api/export-ad-svg` | GET | no | no | reads campaign plan | viewer |
| `/api/export-campaign` | POST | no (501) | no | placeholder | editor |
| `/api/export-campaign-zip` | GET | **YES — auto-renders** | **YES** | reads + writes | editor (after fix: viewer for download, editor for build) |
| `/api/generate-campaign` | POST | yes | **YES (AI)** | writes `data/` | editor |
| `/api/generate-campaign-variants` | POST | yes | **YES (AI x N)** | writes `data/` | editor |
| `/api/generators/asset/[id]` | DELETE | yes (force=1 bypass) | no | writes `data/` | editor (force=1 → admin) |
| `/api/generators/asset/[id]` | PATCH | yes | no | writes `data/` | editor |
| `/api/generators/background` | POST | yes | yes (AI) | writes `data/` | editor |
| `/api/generators/brand-input-assets` | * | yes | varies | writes `data/` | editor |
| `/api/generators/cta` | POST | yes | yes (AI) | writes `data/` | editor |
| `/api/generators/fx-overlay` | POST | yes | yes (AI) | writes `data/` | editor |
| `/api/generators/mockup` | POST | yes | yes (AI) | writes `data/` | editor |
| `/api/generators/registry` | GET | no | no | reads | viewer |
| `/api/generators/trading-ui` | POST | yes | yes (AI) | writes `data/` | editor |
| `/api/midjourney/assignments` | GET | no | no | reads | viewer |
| `/api/midjourney/assignments` | POST | yes | no | writes `data/` | editor |
| `/api/midjourney/assignments` | DELETE | yes | no | writes `data/` | editor |
| `/api/midjourney/prompts` | GET | no | no | reads | viewer |
| `/api/midjourney/prompts` | POST | yes | no | writes `data/` | editor |
| `/api/midjourney/uploads` | GET | no | no | reads | viewer |
| `/api/midjourney/uploads` | POST (multipart) | yes | no | writes repo `public/` | editor |
| `/api/midjourney/uploads` | POST (json patch) | yes | no | writes `data/` | editor |
| `/api/midjourney/uploads` | DELETE | yes | no | writes `data/` + repo `public/` | editor |
| `/api/mockup-manifest` | GET | no | no | reads | viewer |
| `/api/mockup-manifest` | POST | yes | no | yes | editor (dev-only blocked in prod) |
| `/api/qa` | POST | no (501) | no | placeholder | editor |
| `/api/qa-campaign` | POST | yes | **YES (Gemini Vision)** | writes `data/` | editor |
| `/api/render-ad` | POST | external (Bannerbear) | yes | reads `data/` | editor |
| `/api/render-campaign` | POST | yes | **YES (Playwright + AI)** | writes `data/` + repo `public/` | editor |
| `/api/screenshot-tags` | GET | no | no | reads | viewer |
| `/api/screenshot-tags` | POST | yes | no | yes | editor (dev-only blocked in prod) |
| `/api/sync-bannerbear-template` | POST | no (501) | no | placeholder | editor |
| `/api/upload-asset` | POST | yes | no | yes (writes repo `public/`) | editor (dev-only blocked in prod) |

## New routes added in this pass

| Route | Method | role | Notes |
| --- | --- | --- | --- |
| `/api/render/campaign/[campaignId]/ad/[adId]` page | GET | viewer | Per-campaign render page, replaces global demo file path in `renderCampaign`. |
| `/api/jobs` | GET | viewer | List jobs (paginated, optional `?campaign_id=`). |
| `/api/jobs/[jobId]` | GET | viewer | Job status. |
| `/api/jobs/[jobId]` | DELETE | admin | Cancel a job. |
| `/api/campaigns/[id]/render-jobs` | POST | editor | Enqueue render job. |
| `/api/campaigns/[id]/variant-jobs` | POST | editor | Enqueue variant generation. |
| `/api/campaigns/[id]/export-jobs` | POST | editor | Build the ZIP artifact. |

## What changes vs. the audit baseline

1. Every mutating or expensive route now requires a Supabase Auth session and a
   role check via `requireRole(...)` (`src/lib/auth/guard.ts`).
2. Dev-only routes (`/api/screenshot-tags` POST, `/api/mockup-manifest` POST,
   `/api/upload-asset` POST, the JSON-file-backed parts of midjourney + assets)
   refuse with **404** when `NODE_ENV === "production"` unless the explicit
   `ALLOW_LOCAL_FS_WRITES=true` flag is set. The flag is rejected on the
   default production build path.
3. `/api/export-campaign-zip` GET is now download-only. It no longer auto-renders.
4. `renderCampaign` no longer writes to `data/demo-campaign.preview.json`. It
   reads the plan via the repository and renders through
   `/render/campaign/[campaignId]/ad/[adId]`.
5. Uploads go through `validateImageUpload(...)` which checks size, declared
   MIME, magic-byte sniff, and a `sharp` decode pass.
6. `mapLanguageToLocale` accepts `he` (`he-IL`) and `ar` (`ar-AE` — finance
   default) without throwing. `LANG_META` already had glyph/RTL metadata for
   both.
7. `generateImagesForConcepts` defaults to **one image per concept** (the
   `background` prompt) unless the caller passes
   `imageGenerationMode: "all-prompts"`.
8. `src/lib/export/createCampaignZip.ts` deleted (was a placeholder, unused).
   `exportCampaignPlanZip` is the only export path.
