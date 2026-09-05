-- ==========================================================================
-- WayMaker Ink — clear the request data before importing the Sheet history
--
-- 🔴 DESTRUCTIVE AND NOT REVERSIBLE. Read the whole header before running it.
--
-- Run as `postgres` (SQL Editor or psql). There is no delete policy on
-- public.requests by design — "a client request is a business record" — so an
-- ordinary authenticated session cannot do this and is not meant to.
--
-- ---------------------------------------------------------------- what goes ---
--   public.requests          every row
--   public.request_images    every row, via `on delete cascade`
--   public.request_events    every row, via `on delete cascade`
--   storage.objects          the request-refs bucket — see the block at the
--                            bottom, which is commented out on purpose
--
-- ---------------------------------------------------------------- what stays ---
--   public.artists           who they are, their rates, their services
--   public.service_tiers     the bookable things and their Acuity URLs
--   public.piercing_prices   the printed menu
--   public.profiles          the portal logins and their artist_key mapping
--   auth.users               the accounts themselves
--
-- That split is the point: this wipes the TRANSACTIONAL data and leaves the
-- REFERENCE data alone. Truncating artists would cascade into service_tiers
-- and null out every profile's artist_key, and you would be rebuilding the
-- portal's configuration by hand afterwards.
--
-- ---------------------------------------------------------------- before you run ---
-- 1. Take a backup. On a hosted project:
--
--      npx supabase db dump --data-only -f pre-import-backup.sql
--
--    This is the only thing standing between a mistyped WHERE and a support
--    ticket to Supabase. Take it even though the data being deleted is test
--    data — the point is that you find out afterwards if it wasn't.
--
-- 2. Confirm you are pointed at the right project:
--
--      npx supabase projects list        -- which one is linked
--      select current_database(), now(); -- in the SQL editor you are about to use
--
--    ⚠ The repo carries settings for a UAT project AND a local stack on
--    :54321. Nothing in this file knows which one you have open.
--
-- 3. Know that requests submitted during the changeover are lost. They are
--    being manually re-entered afterwards, which is the agreed plan — but the
--    window starts the moment you run this, not when you finish.
--
-- ---------------------------------------------------------------- why TRUNCATE ---
-- `truncate ... restart identity cascade` rather than `delete from`:
--
--   · cascade follows the two foreign keys, so images and events go with their
--     request rather than blocking on the constraint.
--   · restart identity resets request_events.id, so the audit trail's bigserial
--     starts from 1 rather than from wherever the test data left it.
--   · it is one statement, so there is no half-cleared state to reason about.
--
-- The transaction is real: if the truncate fails, nothing is removed. It will
-- not save you from a successful truncate of the wrong database.
-- ==========================================================================

-- 🔴 RUN 00-preflight.sql FIRST AND READ IT.
--
-- There are no counts printed before the truncate in this file, deliberately.
-- The Supabase SQL Editor commits a whole file as one batch, so a "look before
-- you leap" select sitting above the truncate would print its reassuring
-- numbers *after* the table was already empty, and there is no prompt in
-- between to stop at. A safety check that cannot fail in time is worse than
-- none, because it reads like one that can.
--
-- The looking lives in 00-preflight.sql. This file only does.

begin;

truncate table public.requests restart identity cascade;

-- Should all be zero.
select 'requests'       as table_name, count(*) as rows_remaining from public.requests
union all
select 'request_images', count(*) from public.request_images
union all
select 'request_events', count(*) from public.request_events;

-- Reference data, untouched. Confirm before committing: if any of these read
-- zero, something cascaded that should not have and you want `rollback;`.
select 'artists'         as table_name, count(*) as rows_kept from public.artists
union all
select 'service_tiers',   count(*) from public.service_tiers
union all
select 'piercing_prices', count(*) from public.piercing_prices
union all
select 'profiles',        count(*) from public.profiles;

commit;


-- ==========================================================================
-- The uploaded reference images — DELIBERATELY NOT RUN
-- ==========================================================================
-- Truncating public.requests removes the request_images ROWS but not the FILES
-- they pointed at. Those are orphaned in the bucket now: nothing references
-- them, the portal cannot reach them, and they still count against storage.
--
-- Left commented because it is the one step here with no undo at all — a
-- database restore brings rows back, and nothing brings these back. Uncomment
-- only once the import is verified and you are sure the bucket holds nothing
-- but test uploads.
--
-- ⚠ This does NOT touch Drive. The images belonging to the 40 imported
-- requests live there, are unaffected by anything in this file, and remain the
-- only copy — see the migrated event's `drive_folder` on each row.
--
--   delete from storage.objects where bucket_id = 'request-refs';
--
-- To look before leaping:
--
--   select count(*), pg_size_pretty(sum((metadata->>'size')::bigint))
--   from storage.objects where bucket_id = 'request-refs';
