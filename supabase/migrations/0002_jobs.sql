-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 — jobs queue
--
-- One row per enqueued render / variants / export job. The worker process
-- (scripts/worker.ts) polls this table via claim_next_queued_job() which
-- uses FOR UPDATE SKIP LOCKED so multiple workers can be scaled horizontally
-- without claiming the same row twice.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists jobs (
  id text primary key,
  type text not null check (type in ('render','variants','export')),
  campaign_id text,
  created_by text,
  status text not null check (status in ('queued','running','succeeded','failed','canceled')) default 'queued',
  progress double precision not null default 0 check (progress >= 0 and progress <= 1),
  input jsonb not null,
  result jsonb,
  error text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists jobs_status_created_at_idx on jobs (status, created_at);
create index if not exists jobs_campaign_id_idx on jobs (campaign_id);
create unique index if not exists jobs_idempotency_active_idx
  on jobs (idempotency_key, type, campaign_id)
  where idempotency_key is not null and status not in ('canceled','failed');

-- Concurrency-safe claim: SELECT FOR UPDATE SKIP LOCKED so two workers
-- never claim the same row. Returns the claimed row or NULL.
create or replace function claim_next_queued_job(p_types text[])
returns setof jobs
language plpgsql
as $$
declare
  v_id text;
begin
  select id into v_id
  from jobs
  where status = 'queued' and type = any(p_types)
  order by created_at asc
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update jobs
       set status = 'running', started_at = now(), updated_at = now()
     where id = v_id
   returning *;
end;
$$;

alter table jobs enable row level security;

drop policy if exists "service role access" on jobs;
create policy "service role access" on jobs
  for all to service_role using (true) with check (true);
