-- ─────────────────────────────────────────────────────────────────────────────
-- 0001 — campaigns + active_campaign + user_roles
--
-- The repository code in `src/lib/repositories/CampaignRepository.ts` reads
-- and writes these tables. All access is through the service role from the
-- server; RLS is enabled and the only policy is "service_role can do anything"
-- — application authorization happens in route guards, not in RLS, because
-- the worker uses the same service-role connection.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists campaigns (
  campaign_id text primary key,
  brand_id    text not null,
  plan        jsonb not null,
  ai_provider text not null check (ai_provider in ('openai','anthropic','mock')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1
);

create index if not exists campaigns_brand_id_idx on campaigns (brand_id);
create index if not exists campaigns_created_at_idx on campaigns (created_at desc);

create table if not exists active_campaign (
  id          integer primary key default 1 check (id = 1),
  campaign_id text references campaigns(campaign_id) on delete set null
);

insert into active_campaign (id) values (1) on conflict do nothing;

-- Role assignment — separate table so app_metadata stays optional. The
-- session resolver (src/lib/auth/session.ts) reads from here when
-- app_metadata.roles isn't set.
create table if not exists user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role    text not null check (role in ('admin','editor','viewer')),
  created_at timestamptz not null default now()
);

alter table campaigns enable row level security;
alter table active_campaign enable row level security;
alter table user_roles enable row level security;

-- Server-side service-role access only. App-side reads/writes are mediated
-- by the route guards (requireRole).
drop policy if exists "service role access" on campaigns;
create policy "service role access" on campaigns
  for all to service_role using (true) with check (true);

drop policy if exists "service role access" on active_campaign;
create policy "service role access" on active_campaign
  for all to service_role using (true) with check (true);

drop policy if exists "service role access" on user_roles;
create policy "service role access" on user_roles
  for all to service_role using (true) with check (true);
