-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 — campaign-side asset/manifest/qa tables
--
-- These are the sibling tables that `src/lib/supabase/queries.ts` writes to
-- (insertAsset / insertElementManifest / insertQaReport). The shapes mirror
-- the Zod schemas so the JSON is structured but query-friendly.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists campaign_assets (
  asset_id text primary key,
  campaign_id text not null,
  asset jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists campaign_assets_campaign_idx on campaign_assets (campaign_id);

create table if not exists element_manifests (
  manifest_id text primary key,
  asset_id text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists element_manifests_asset_idx on element_manifests (asset_id);

create table if not exists qa_reports (
  report_id text primary key,
  asset_id text not null,
  report jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists qa_reports_asset_idx on qa_reports (asset_id);

alter table campaign_assets enable row level security;
alter table element_manifests enable row level security;
alter table qa_reports enable row level security;

drop policy if exists "service role access" on campaign_assets;
create policy "service role access" on campaign_assets
  for all to service_role using (true) with check (true);
drop policy if exists "service role access" on element_manifests;
create policy "service role access" on element_manifests
  for all to service_role using (true) with check (true);
drop policy if exists "service role access" on qa_reports;
create policy "service role access" on qa_reports
  for all to service_role using (true) with check (true);
