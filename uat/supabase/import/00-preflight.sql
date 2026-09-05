-- ==========================================================================
-- WayMaker Ink — pre-flight. READ ONLY. Deletes nothing, writes nothing.
--
-- Run this FIRST and read every answer before opening 01-clear-request-data.sql.
--
-- It exists because the SQL Editor commits a whole file as one batch: the
-- counts printed inside the clear script scroll past *after* the truncate has
-- already happened, and there is no prompt in between to stop at. Splitting the
-- looking from the doing is the only way the looking is worth anything.
-- ==========================================================================

-- 1 · WHICH DATABASE AM I IN?
--    Compare the project ref against supabase/.temp/project-ref. If they do not
--    match, close this tab — you have the wrong project open.
select
  current_database()                        as database,
  current_user                              as running_as,
  inet_server_addr()                        as server,
  now()                                     as server_time,
  current_setting('server_version')         as pg_version;

-- 2 · WHAT IS ABOUT TO BE DESTROYED
select 'requests'       as table_name, count(*) as rows_to_delete from public.requests
union all
select 'request_images', count(*) from public.request_images
union all
select 'request_events', count(*) from public.request_events
order by table_name;

-- 3 · WHAT IS ABOUT TO BE KEPT
--    All four must be non-zero after the clear. artists especially: the import
--    has a foreign key onto it, and an empty artists table fails every row.
select 'artists'         as table_name, count(*) as rows_kept from public.artists
union all
select 'service_tiers',   count(*) from public.service_tiers
union all
select 'piercing_prices', count(*) from public.piercing_prices
union all
select 'profiles',        count(*) from public.profiles
order by table_name;

-- 4 · THE IMPORT'S FOREIGN KEY TARGETS
--    The export references exactly these two artist keys. Both rows must exist
--    or the import fails wholesale — it is one statement, so it is all or
--    nothing rather than a partial load.
select
  k.key,
  (a.key is not null) as exists_in_artists,
  a.name,
  a.enabled
from (values ('nic'), ('laynie')) as k(key)
left join public.artists a on a.key = k.key
order by k.key;

-- 5 · IS THERE ANYTHING HERE WORTH KEEPING?
--    Real client requests that arrived while UAT was live would be destroyed by
--    step 1 and are NOT in the Sheet export. Look at this before assuming
--    everything present is test data.
select
  rid, status, artist_key, first_name, last_name, submitted_at
from public.requests
order by submitted_at desc
limit 25;

-- 6 · WOULD THE IMPORT COLLIDE WITH ANYTHING ALREADY PRESENT?
--    Should be 0. Non-zero means those rids already exist, and the import's
--    `on conflict (rid) do nothing` would skip them — which after a clear can
--    only happen if the clear was not run.
select count(*) as rids_already_present
from public.requests
where rid in (
  'WMI-MSUDCJNW-G4RMT3','WMI-MSXCC5I2-W4EB4H','WMI-MTHNJJ4K-CNENMQ'
);

-- 7 · STORAGE
--    Files in the reference bucket. Truncating requests orphans these — the
--    rows pointing at them go, the files stay. See the commented block at the
--    bottom of 01-clear-request-data.sql.
select
  count(*)                                                as objects,
  pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as total_size
from storage.objects
where bucket_id = 'request-refs';
