-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 — Storage buckets used by AssetStorage
--
-- Buckets are PRIVATE. The app issues short-lived signed URLs via
-- createSignedUrl when a public consumer (a browser, an exporter) needs them.
-- This means a stolen storage path cannot be downloaded without going through
-- the signed-URL endpoint.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('campaign-uploads', 'campaign-uploads', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('campaign-generated', 'campaign-generated', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('campaign-exports', 'campaign-exports', false)
on conflict (id) do nothing;

-- Service role can read/write any bucket; the app uses the service role
-- exclusively for storage.
drop policy if exists "service role storage access" on storage.objects;
create policy "service role storage access" on storage.objects
  for all to service_role using (true) with check (true);
