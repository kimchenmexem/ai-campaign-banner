# Production hardening

This pass replaced the previous "local dev with Supabase configured but
stubbed" state with a production-safe baseline. The four big pieces:

1. Auth + role guards on every mutating / expensive route.
2. CampaignRepository + AssetStorage abstractions with fail-closed production
   refusal of local-filesystem state.
3. Job model + enqueue routes + worker process for long-running work.
4. Real upload validation, race fix in `renderCampaign`, GET export
   download-only semantics, locale + image-generation logic fixes.

## Auth

Auth is required by default in every environment. The session resolver lives
in [`src/lib/auth/session.ts`](../src/lib/auth/session.ts) and accepts the
Supabase access token either as `Authorization: Bearer <jwt>` or via the
Supabase JS client cookie. The JWT is validated server-side via Supabase
Auth's `getUser()` so a forged JWT is rejected.

### Role model

Three roles, hierarchical:

| Role   | Can do |
| ------ | ------ |
| viewer | Read campaigns, list jobs, download already-built artifacts |
| editor | Create / update / render / export / upload + everything viewer can |
| admin  | Cancel jobs, force-delete in-use assets + everything editor can |

Roles are read server-side in this order (first match wins):
1. `app_metadata.roles[0]` (or `app_metadata.role`) — service-role writes only.
2. `user_roles` table (migration `0001_campaigns.sql`).
3. Env-var allowlist (`AUTH_ADMIN_EMAILS`, `AUTH_EDITOR_EMAILS`, `AUTH_VIEWER_EMAILS`).

`user_metadata` is never trusted — it's user-editable on the client.

### Local-dev escape hatch

Set `AUTH_DISABLED=true` to bypass auth entirely. The setting is **only**
honored when `NODE_ENV !== "production"`. Production builds ignore it.

### Dev-only routes

Routes that mutate the repo's `data/` or `public/` directories
(`/api/screenshot-tags` POST, `/api/mockup-manifest` POST,
`/api/upload-asset`, the JSON-file paths of midjourney + brand-kit) refuse
with **404** in production unless `ALLOW_LOCAL_FS_WRITES=true` is set. The
flag is an explicit escape hatch for emergencies and is documented as such.

### Rate limiting

Per-route rate limits via `enforceRateLimit()`
([`src/lib/auth/rateLimit.ts`](../src/lib/auth/rateLimit.ts)):

- `RATE_LIMITS.expensive` — 10 / minute (render, generate, qa, export)
- `RATE_LIMITS.upload`    — 30 / minute
- `RATE_LIMITS.write`     — 60 / minute (general mutations)

The limiter is in-process and suitable for single-instance deployments. For
multi-instance prod, swap the bucket store for Redis; the call sites don't
change.

## Repository / Storage abstractions

### CampaignRepository

[`src/lib/repositories/CampaignRepository.ts`](../src/lib/repositories/CampaignRepository.ts).
Selects a driver via `CAMPAIGN_REPO_DRIVER` or `NODE_ENV`:

- `local` — reads / writes `data/campaigns/{id}/campaign-plan.json` (legacy)
- `supabase` — reads / writes the `campaigns` table (migration 0001)

Production **fails closed**: if `NODE_ENV=production` and the driver would
fall back to local without `ALLOW_LOCAL_FS_WRITES=true`, the factory throws
on the first call.

### AssetStorage

[`src/lib/storage/AssetStorage.ts`](../src/lib/storage/AssetStorage.ts).
Three buckets: `uploads`, `generated`, `exports`.

- `local` — writes under `public/<subdir>/`. Bytes are publicly readable.
- `supabase` — writes to Supabase Storage. Buckets are private; the app
  hands back signed URLs (`signedUrl(key, ttlSec=3600)`).

Production fails closed the same way as the campaign repository.

### Storage buckets

Migration `0004_storage_buckets.sql` creates three private buckets. Override
names with `STORAGE_BUCKET_UPLOADS` / `STORAGE_BUCKET_GENERATED` /
`STORAGE_BUCKET_EXPORTS`.

## Jobs

[`src/lib/jobs/types.ts`](../src/lib/jobs/types.ts) defines the model:

```
Job {
  id, type ("render" | "variants" | "export"),
  campaign_id, created_by, status, progress,
  input, result, error, idempotency_key,
  created_at, updated_at, started_at, finished_at
}
```

### Enqueue routes

| Route                                            | Method | Role   | Purpose                              |
| ------------------------------------------------ | ------ | ------ | ------------------------------------ |
| `/api/campaigns/[id]/render-jobs`                | POST   | editor | Enqueue a Playwright render run      |
| `/api/campaigns/[id]/variant-jobs`               | POST   | editor | Enqueue N AI plan variants           |
| `/api/campaigns/[id]/export-jobs`                | POST   | editor | Build the campaign ZIP               |
| `/api/jobs`                                      | GET    | viewer | List jobs (filterable)               |
| `/api/jobs/[jobId]`                              | GET    | viewer | Status + result                      |
| `/api/jobs/[jobId]`                              | DELETE | admin  | Cancel a queued / running job        |

Each enqueue route returns `202 Accepted` with `Location: /api/jobs/{id}`.
The client polls until status is `succeeded` or `failed`.

### Worker

Run the worker in production:

```sh
npm run worker            # poll forever
npm run worker -- --once  # claim one job, run it, exit
```

The worker uses the `claim_next_queued_job` stored procedure (migration
0002) which uses `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers
can scale horizontally.

### Inline fallback (dev only)

In dev, `WORKER_INLINE=true` (the default when `NODE_ENV !== "production"`)
runs the work in-process when the enqueue route is hit, so a developer
doesn't need a separate worker terminal. Production must leave
`WORKER_INLINE` unset or `false`.

### Legacy `/api/render-campaign`, `/api/generate-campaign-variants`

These remain as auth-guarded wrappers that still run synchronously today.
New callers should switch to the job-based endpoints; the legacy ones can
be retired once every UI client is migrated.

## Render race fix

`renderCampaign` previously wrote a temp file at
`data/demo-campaign.preview.json` and read it back via the global
`/render/ad/[adId]` route. Two concurrent renders would overwrite each
other's swap — and if no backup existed beforehand, the temp file
survived.

Replaced with `/render/campaign/[campaignId]/ad/[adId]`
([page](../src/app/render/campaign/[campaignId]/ad/[adId]/page.tsx)) which
loads the plan via the repository. No global mutable state remains.

## GET export semantics

`GET /api/export-campaign-zip` is now download-only. It refuses with **409
`not_ready`** when the render-map artifact is missing, with a hint to POST
the render-job endpoint. It never invokes `renderCampaign`.

## Upload hardening

[`validateImageUpload()`](../src/lib/uploads/validateImageUpload.ts):

1. Size limit (`UPLOAD_MAX_BYTES`, default 8 MB).
2. Declared MIME must be in the allowlist (PNG / JPEG / WebP).
3. Magic-byte sniff must match the declared MIME.
4. `sharp` decode + re-encode (rejects malformed bytes, strips EXIF).
5. Pixel-dimension cap (default 6000x6000).
6. Optional scanner via `UPLOAD_SCANNER_MODULE` (path to a Node module
   exporting `scan(buffer) => Promise<{ clean, signature? }>`). When
   `UPLOAD_REQUIRE_SCANNER=true` and no scanner is configured, every
   upload is rejected.
7. SHA-256 content hash → collision-safe filename.

Uploads route through `AssetStorage` (Supabase Storage in prod, private
bucket, signed URL access).

## Logic fixes

| What | Where | Before | After |
| --- | --- | --- | --- |
| `mapLanguageToLocale` | `src/lib/ai/campaignPlanner.ts` | Threw for `he`/`ar` | `he → he-IL`, `ar → ar-AE` |
| `imageGenerationMode` | `src/lib/ai/imageGenerationMode.ts` + `campaignPlanner.ts` | Generated every prompt in `midjourney_prompt_pack` (3-9 images/campaign) regardless of route docs | Defaults to `background-only` (1 image / concept). `all-prompts` explicit opt-in. |
| Placeholder ZIP | `src/lib/export/createCampaignZip.ts` + `createManifestFiles.ts` | Returned README-only empty folders | **Deleted.** `exportCampaignPlanZip` is the only export path. |

## Migrations

Run in order:

1. `supabase/migrations/0001_campaigns.sql` — campaigns + user_roles + active_campaign
2. `supabase/migrations/0002_jobs.sql` — jobs table + `claim_next_queued_job` SP
3. `supabase/migrations/0003_campaign_assets.sql` — sibling tables for asset / manifest / qa
4. `supabase/migrations/0004_storage_buckets.sql` — private buckets

```sh
supabase db push   # or apply manually via psql
```

## Migrating from local filesystem to Supabase

The dev path that wrote into `data/campaigns/{id}/campaign-plan.json` and
`public/midjourney-uploads/...` will keep working in local dev with
`CAMPAIGN_REPO_DRIVER=local` and `STORAGE_DRIVER=local`. To migrate
existing campaigns into Supabase:

1. Apply migrations 0001-0004.
2. Set `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
3. Walk `data/campaigns/` and call
   `getCampaignRepository().insertCampaign(plan)` for each
   `campaign-plan.json`. A small migration script can be wired up via
   `tsx`; not included here because the operator chooses which campaigns
   are worth migrating.

## Testing

The repo doesn't ship a test framework. We added a tiny `tsx`-runnable
harness in [`scripts/test/`](../scripts/test) that covers the highest-risk
fixes:

| Test | Covers |
| --- | --- |
| `auth.test.ts` | Role hierarchy, dev-only blocker, rate limiter |
| `locale.test.ts` | `mapLanguageToLocale` for every supported language |
| `uploadValidator.test.ts` | Size, MIME, magic bytes, decode, empty file |
| `render-race.test.mts` | Per-campaign URL, no global demo write |
| `export-side-effects.test.mts` | GET export never imports `renderCampaign` |
| `api-auth.test.mts` | Anonymous mutation rejected on every protected route; dev-only routes 404 in prod |
| `image-gen-mode.test.mts` | Default background-only, opt-in all-prompts |
| `campaign-repo.test.mts` | Local driver works, prod refuses local without flag |

Run:

```sh
AUTH_DISABLED=true CAMPAIGN_REPO_DRIVER=local npm run test
```

## What is NOT done in this pass (follow-ups)

- The legacy `/api/render-campaign` and `/api/generate-campaign-variants`
  still run synchronously instead of just enqueuing a job. They're
  auth-guarded and rate-limited, but the UI should be migrated to the new
  enqueue endpoints before the legacy routes are retired.
- CSRF protection. Auth is bearer-token based today (not cookies driving
  sessions for mutations), so CSRF isn't strictly required. If a future
  iteration moves to cookie-driven sessions, add SameSite=Strict + a CSRF
  token check.
- Migration of `data/asset-preview-map.generated.json` and similar JSON
  files into Supabase. They're still local-dev source-of-truth.
- Multi-instance rate limiter. The in-process token bucket only protects
  against single-instance loops.
